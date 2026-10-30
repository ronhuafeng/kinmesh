import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  projectNativeRead,
  verifiedNativeLink,
} from '../src/workspace/native.js';
import {
  NativeObservation,
  decodeNativeObservation,
} from '../src/workspace/contracts.js';
import { Read, Status } from '../src/adapters/t3/contracts.js';
import { captured, reference } from './t3-helpers.js';

const endpoint = 'https://t3.example/mcp';
const url = `https://t3.example/${reference.environmentId}/${reference.threadId}`;

await test('native link accepts only supplied exact origin/environment/thread browser URLs', () => {
  assert.equal(verifiedNativeLink(url, endpoint, reference), url);
  assert.equal(
    verifiedNativeLink(
      url.replace(reference.threadId, '%66' + reference.threadId.slice(1)),
      endpoint,
      reference,
    ),
    url.replace(reference.threadId, '%66' + reference.threadId.slice(1)),
  );
  for (const candidate of [
    undefined,
    null,
    '',
    'x'.repeat(4097),
    url.replace('t3.example', 'evil.example'),
    url.replace('t3.example', 't3.example.evil.test'),
    url.replace('https:', 'http:'),
    url.replace('https:', 'javascript:'),
    url.replace('https://', 'https://owner:secret@'),
    url + '?token=secret',
    url + '?',
    url + '#redirect',
    url + '#',
    url + '/',
    url + '/extra',
    url.replace(reference.threadId, 'wrong-thread'),
    url.replace(reference.environmentId, 'wrong-env'),
    't3-thread://' + reference.threadId,
    '/' + reference.threadId,
    url.replace(reference.threadId, '%FF'),
    url.replace(reference.threadId, '%zz'),
    url.replace(reference.threadId, '%'),
    url + '\n',
    url.replace(reference.threadId, 'x/../' + reference.threadId),
    url.replace(reference.threadId, '%2F' + reference.threadId),
  ])
    assert.equal(
      verifiedNativeLink(candidate, endpoint, reference),
      null,
      String(candidate),
    );
  assert.equal(
    verifiedNativeLink(url, 'https://t3.example/wrong', reference),
    null,
  );
});

await test('captured v0.1.5 Run1 completed and Run2 interrupted remain distinct from latest thread state', () => {
  const raw = Read.parse(captured.t3_thread_read);
  const run1 = projectNativeRead(raw, reference, endpoint);
  assert.equal(run1.status, 'completed');
  assert.equal(run1.terminal, true);
  assert.equal(run1.verifiedUrl, null); // Captured response did not supply a link.
  const run2 = projectNativeRead(
    raw,
    { ...reference, runId: raw.recentRuns[0]?.runId },
    endpoint,
  );
  assert.equal(run2.status, 'interrupted');
  assert.equal(run2.terminal, true);
  const missing = projectNativeRead(
    raw,
    { ...reference, runId: 'outside-recent-window' },
    endpoint,
  );
  assert.equal(missing.status, 'unobserved');
  assert.equal(missing.terminal, false);
  assert.equal(missing.providerId, null);
  assert.equal(missing.modelId, null);
  assert.throws(() =>
    projectNativeRead(
      raw,
      { ...reference, threadId: 'other-thread' },
      endpoint,
    ),
  );
});

await test('MOCK projection: native status is exact, pending requests remain thread-scoped and links are validated', () => {
  const raw = Read.parse(captured.t3_thread_read);
  raw.thread.link = url;
  raw.thread.pendingRequestCount = 3;
  for (const status of Status.options) {
    const run = raw.recentRuns.find((r) => r.runId === reference.runId);
    assert.ok(run);
    run.status = status;
    const result = projectNativeRead(
      raw,
      reference,
      endpoint,
      '2026-10-30T12:00:00.000Z',
    );
    assert.equal(result.status, status);
    assert.equal(result.threadPendingRequests, 3);
    assert.equal(result.verifiedUrl, url);
    assert.equal(result.observedAt, '2026-10-30T12:00:00.000Z');
    assert.equal(
      result.terminal,
      [
        'completed',
        'failed',
        'cancelled',
        'interrupted',
        'rolled_back',
      ].includes(status),
    );
  }
  raw.thread.link = 'https://evil.example/env/thread';
  assert.equal(projectNativeRead(raw, reference, endpoint).verifiedUrl, null);
  const threadReference = {
    backend: reference.backend,
    environmentId: reference.environmentId,
    threadId: reference.threadId,
  };
  assert.equal(
    projectNativeRead(raw, threadReference, endpoint).status,
    raw.thread.status,
  );
});

await test('MOCK DTO decoding rejects unsafe/mismatched links, identities, terminal claims and extra data', () => {
  const observation = projectNativeRead(
    captured.t3_thread_read,
    reference,
    endpoint,
  );
  assert.deepEqual(
    decodeNativeObservation(observation, reference, 'https://t3.example'),
    observation,
  );
  for (const verifiedUrl of [
    'javascript:alert(1)',
    't3-thread://thread',
    'https://evil.example/wrong/path',
    url + '?token=secret',
    url + '#x',
    url + '%FF',
  ])
    assert.equal(
      NativeObservation.safeParse({ ...observation, verifiedUrl }).success,
      false,
    );
  assert.throws(() =>
    decodeNativeObservation(
      observation,
      { ...reference, runId: 'other' },
      'https://t3.example',
    ),
  );
  assert.throws(() =>
    decodeNativeObservation(
      {
        ...observation,
        verifiedUrl: url.replace('t3.example', 'evil.example'),
      },
      reference,
      'https://t3.example',
    ),
  );
  assert.throws(() =>
    decodeNativeObservation(
      { ...observation, verifiedUrl: url },
      reference,
      null,
    ),
  );
  assert.equal(
    NativeObservation.safeParse({ ...observation, terminal: false }).success,
    false,
  );
  assert.equal(
    NativeObservation.safeParse({ ...observation, token: 'never-allowed' })
      .success,
    false,
  );
  assert.equal(
    NativeObservation.safeParse({ ...observation, source: 'mock' }).success,
    false,
  );
});
