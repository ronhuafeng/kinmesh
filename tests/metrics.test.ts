import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/app.js';
import { fixture } from './helpers.js';
import { feishuPerson, signInAs, standInFeishu } from './feishu.js';
import { postInput } from './communication-helpers.js';

const TOKEN = 'metrics-token-for-tests-0123456789abcdef';
async function hub(
  workerReady: () => boolean = () => true,
  rateLimit = 60,
  trustedProxies: string[] = [],
) {
  const f = fixture();
  const store = f.open();
  const app = await createApp(
    { ...f.config, rateLimit, metricsToken: TOKEN, trustedProxies },
    store,
    workerReady,
    undefined,
    {},
    { feishu: standInFeishu },
  );
  return {
    store,
    app,
    async dispose() {
      await app.close();
      f.cleanup();
    },
  };
}

await test('the hub is live while it answers, and ready only with its worker', async () => {
  let worker = false;
  const h = await hub(() => worker);
  try {
    assert.equal((await h.app.inject({ url: '/health/live' })).statusCode, 200);
    assert.equal((await h.app.inject({ url: '/health' })).statusCode, 503);
    worker = true;
    assert.equal((await h.app.inject({ url: '/health' })).statusCode, 200);
    // A database that cannot answer is not ready either; the process lives.
    h.store.close();
    assert.equal((await h.app.inject({ url: '/health' })).statusCode, 503);
    assert.equal((await h.app.inject({ url: '/health/live' })).statusCode, 200);
  } finally {
    await h.dispose();
  }
});

await test('/metrics reports the hub in Prometheus text, and nothing about anyone', async () => {
  const h = await hub(() => true, 8);
  try {
    const mailbox = 'ada.lovelace@example.com';
    const cookies = await signInAs(h.app, mailbox);
    const ada = h.store.signIn(feishuPerson(mailbox));
    const team = h.store.teamFor(ada.id);
    assert.ok(team);
    const channel = team.channels[0];
    assert.ok(channel);
    const marker = 'private-words-' + crypto.randomUUID();
    h.store.communication.post(
      { kind: 'human', humanId: ada.id },
      team.team.id,
      channel.id,
      postInput({ body: marker }),
    );
    await h.app.inject({
      url: `/api/teams/${team.team.id}/channels/${channel.id}/messages`,
      cookies,
    });
    // Over the limit, at least once.
    for (let i = 0; i < 10; i++) await h.app.inject({ url: '/health/live' });
    const metrics = await h.app.inject({ url: '/metrics' });
    assert.equal(metrics.statusCode, 200);
    assert.match(String(metrics.headers['content-type']), /text\/plain/);
    for (const series of [
      'kinmesh_http_requests_total',
      'kinmesh_http_request_duration_seconds_bucket',
      'kinmesh_deliveries',
      'kinmesh_inbox_worker_up 1',
      'kinmesh_agents_awake',
      'kinmesh_event_streams 0',
      'kinmesh_rate_limited_total{route="/health/live"}',
    ])
      assert.ok(metrics.body.includes(series), series);
    // Routes are patterns, never the IDs in a request.
    assert.ok(
      metrics.body.includes(
        'route="/api/teams/:teamId/channels/:channelId/messages"',
      ),
    );
    for (const secret of [
      mailbox,
      'ada-lovelace',
      ada.id,
      team.team.id,
      channel.id,
      marker,
      ...Object.values(cookies),
    ])
      assert.equal(metrics.body.includes(secret), false, secret);
  } finally {
    await h.dispose();
  }
});

await test('/metrics is for this machine, or for whoever holds its token', async () => {
  const h = await hub();
  try {
    const from = (remoteAddress: string, authorization?: string) =>
      h.app.inject({
        url: '/metrics',
        remoteAddress,
        ...(authorization ? { headers: { authorization } } : {}),
      });
    assert.equal((await from('127.0.0.1')).statusCode, 200);
    assert.equal((await from('::1')).statusCode, 200);
    assert.equal((await from('203.0.113.5')).statusCode, 403);
    assert.equal(
      (await from('203.0.113.5', 'Bearer not-the-token')).statusCode,
      403,
    );
    assert.equal((await from('203.0.113.5', TOKEN)).statusCode, 403);
    assert.equal(
      (await from('203.0.113.5', `Bearer ${TOKEN}`)).statusCode,
      200,
    );
  } finally {
    await h.dispose();
  }
});

await test('through the proxy on this machine, a client elsewhere is still refused', async () => {
  const h = await hub(() => true, 60, ['127.0.0.1']);
  try {
    const via = (client: string) =>
      h.app.inject({
        url: '/metrics',
        remoteAddress: '127.0.0.1',
        headers: { 'x-forwarded-for': client },
      });
    assert.equal((await via('203.0.113.5')).statusCode, 403);
    assert.equal((await via('127.0.0.1')).statusCode, 200);
  } finally {
    await h.dispose();
  }
});
