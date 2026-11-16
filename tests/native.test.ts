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

/**
 * Proves the link to a thread is built on the endpoint's own origin, where
 * T3's web UI opens it as `/<environment>/<thread>` with each ID one encoded
 * segment, and that no link is made for an endpoint or IDs it can't be.
 */
await test('native link is the thread on the endpoint’s own origin', () => {
  assert.equal(verifiedNativeLink(endpoint, reference), url);
  const launched = { ...reference, threadId: 'mcp:launch:0c75' };
  assert.equal(
    verifiedNativeLink('https://t3.self.example/mcp', launched),
    `https://t3.self.example/${reference.environmentId}/mcp%3Alaunch%3A0c75`,
  );
  assert.equal(
    verifiedNativeLink('http://127.0.0.1:3773/mcp', reference),
    `http://127.0.0.1:3773/${reference.environmentId}/${reference.threadId}`,
  );
  for (const wrong of [
    'https://t3.example/wrong',
    'http://t3.example/mcp',
    'https://owner:secret@t3.example/mcp',
  ])
    assert.equal(verifiedNativeLink(wrong, reference), null, wrong);
  for (const threadId of ['..', 'a/b', 'a b', 'a\nb'])
    assert.equal(
      verifiedNativeLink(endpoint, { ...reference, threadId }),
      null,
      threadId,
    );
});

/**
 * Proves a link the server sends is accepted only for exactly the run's
 * thread on the team's T3 origin: never on T3's hosted app, another origin
 * or a path that isn't the thread's.
 */
await test('native link is refused anywhere but the thread on the team’s T3 origin', () => {
  const observation = projectNativeRead(
    captured.t3_thread_read,
    reference,
    endpoint,
  );
  assert.equal(observation.verifiedUrl, url);
  for (const verifiedUrl of [
    url.replace('t3.example', 'evil.example'),
    url.replace('t3.example', 't3.example.evil.test'),
    `https://app.t3.codes/${reference.environmentId}/${reference.threadId}`,
  ])
    assert.throws(
      () =>
        decodeNativeObservation(
          { ...observation, verifiedUrl },
          reference,
          'https://t3.example',
        ),
      verifiedUrl,
    );
  for (const verifiedUrl of [
    `https://app.t3.codes/threads/${reference.environmentId}/${reference.threadId}`,
    url.replace('.example/', '.example/threads/'),
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
    url.replace(reference.threadId, '%FF'),
    url.replace(reference.threadId, '%zz'),
    url.replace(reference.threadId, '%'),
    url.replace(reference.threadId, 'x/../' + reference.threadId),
    url.replace(reference.threadId, '%2F' + reference.threadId),
  ])
    assert.equal(
      NativeObservation.safeParse({ ...observation, verifiedUrl }).success,
      false,
      verifiedUrl,
    );
});

await test('captured v0.1.5 Run1 completed and Run2 interrupted remain distinct from latest thread state', () => {
  const raw = Read.parse(captured.t3_thread_read);
  const run1 = projectNativeRead(raw, reference, endpoint);
  assert.equal(run1.status, 'completed');
  assert.equal(run1.terminal, true);
  // T3 supplied no link; the thread's is on the endpoint's origin.
  assert.equal(run1.verifiedUrl, url);
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
  // T3 still reports the thread's model when the run is outside the window.
  assert.equal(missing.providerId, raw.thread.providerInstanceId);
  assert.equal(missing.modelId, raw.thread.model);
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
  // Whatever T3 links, the thread's link is on the endpoint's origin.
  for (const link of [
    'https://evil.example/env/thread',
    `https://app.t3.codes/threads/${reference.environmentId}/${reference.threadId}`,
  ]) {
    raw.thread.link = link;
    assert.equal(projectNativeRead(raw, reference, endpoint).verifiedUrl, url);
  }
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
