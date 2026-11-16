import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Credential,
  authority,
  endCredential,
  loadCredential,
  saveCredential,
  signInEnded,
} from '../src/adapters/t3/oauth.js';
import { ExecutionFailure } from '../src/domain/execution.js';
import { runCredential } from '../src/inbox/t3.js';
import { SignInEnded } from '../src/inbox/worker.js';
import { WorkerBinding } from '../src/inbox/config.js';

const endpoint = 'https://t3.test/mcp';
const DAY = 86400_000;
const OPERATE = 'orchestration:read orchestration:operate';
const credential = (
  token: string,
  ceiling: Credential['ceiling'],
  after = 30 * DAY,
  scope = OPERATE,
) =>
  Credential.parse({
    endpoint,
    environmentId: 'env-live',
    tokens: { access_token: token, token_type: 'Bearer', scope },
    expiresAt: new Date(Date.now() + after).toISOString(),
    ...(ceiling === undefined ? {} : { ceiling }),
  });
/** The deployment's session, which T3 issues Supervised. */
const deployment = credential('deployment', 'approval-required');

/**
 * Proves which credential agents' runs use when the hub holds a person's
 * sign-in and the deployment's session: the broadest T3 still honours, the
 * person's when equal; the deployment's whenever the person's has ended or
 * only reads, so nothing waits while either is honoured; and a run already
 * in T3 keeps the one it launched under while that one is honoured.
 */
await test('runs use the broadest credential T3 honours, and fall back when one ends', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kinmesh-credentials-'));
  try {
    const binding = WorkerBinding.parse({
      agentId: '00000000-0000-4000-8000-000000000001',
      tokenFile: join(dir, 'agent.json'),
      t3Endpoint: endpoint,
      t3AuthFile: join(dir, 'managed', 'person.json'),
      t3FallbackAuthFile: join(dir, 'managed', 'deployment.json'),
      isolatedProviderId: 'pi',
    });
    const person = (c: Credential) => {
      saveCredential(binding.t3AuthFile, c);
    };
    const chosen = (pinned?: string) =>
      runCredential(binding, pinned).credential.tokens.access_token;
    // Nothing held: T3 can't be reached at all.
    assert.throws(
      () => runCredential(binding),
      (e: unknown) =>
        e instanceof ExecutionFailure && e.kind === 'authentication',
    );
    // The deployment's session alone: Supervised.
    saveCredential(binding.t3FallbackAuthFile ?? '', deployment);
    assert.equal(chosen(), 'deployment');
    assert.equal(
      runCredential(binding).credential.ceiling,
      'approval-required',
    );
    // A person's Full access sign-in is broader: runs use it.
    person(credential('full', 'full-access'));
    assert.equal(chosen(), 'full');
    // Equal to the deployment's, or of a mode T3 didn't report: the person's.
    person(credential('supervised', 'approval-required'));
    assert.equal(chosen(), 'supervised');
    person(credential('unknown', undefined));
    assert.equal(chosen(), 'unknown');
    // One that only reads can't run anything: the deployment's.
    person(credential('read', 'full-access', 30 * DAY, 'orchestration:read'));
    assert.equal(chosen(), 'deployment');
    // Ended: the deployment's at once, with no waiting.
    person(credential('ended', 'full-access', -1000));
    assert.equal(chosen(), 'deployment');

    // A run already in T3 keeps the credential it launched under while T3
    // honours it, whichever is broader now; once that one has ended, the
    // choice is as for any run (and the run itself can't post under it).
    const full = credential(
      'full',
      'full-access',
      30 * DAY,
      OPERATE + ' settings:write source-control:write',
    );
    person(full);
    assert.equal(chosen(authority(deployment)), 'deployment');
    assert.equal(chosen(authority(full)), 'full');
    person({ ...full, expiresAt: new Date(Date.now() - 1000).toISOString() });
    assert.equal(chosen(authority(full)), 'deployment');

    // Neither honoured: deliveries wait for a sign-in.
    saveCredential(binding.t3FallbackAuthFile ?? '', {
      ...deployment,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    assert.throws(() => runCredential(binding), SignInEnded);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Proves a credential T3 refused (revoked) reads as ended from then on, so
 * runs fall back to the other one and the workspace invites a new sign-in;
 * a newer sign-in saved meanwhile is never ended in its place.
 */
await test('a credential T3 refused ends, unless a newer one replaced it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kinmesh-credentials-'));
  try {
    const file = join(dir, 'managed', 'person.json');
    const revoked = credential('revoked', 'full-access');
    saveCredential(file, revoked);
    const now = Date.now();
    assert.equal(endCredential(file, revoked, now), true);
    assert.equal(signInEnded(loadCredential(file, endpoint), now), true);
    assert.equal(endCredential(file, revoked, now), false);
    const renewed = credential('renewed', 'full-access');
    saveCredential(file, renewed);
    assert.equal(endCredential(file, revoked, now), false);
    assert.equal(signInEnded(loadCredential(file, endpoint), now), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
