import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/domain/agents.js';
import {
  agentFixture,
  grantInput,
  Issued,
  profileInput,
} from './agent-helpers.js';

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
]);
const webp = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.alloc(4),
  Buffer.from('WEBP'),
  Buffer.alloc(32, 1),
]);

await test('an agent picture is a small raster image set by the owner or the agent itself', async () => {
  const f = await agentFixture();
  try {
    const url = f.path + '/avatar';
    const put = (body: Buffer, type: string, auth: object) =>
      f.app.inject({
        method: 'PUT',
        url,
        headers: { 'content-type': type },
        payload: body,
        ...auth,
      });
    // Nothing yet, and nothing without a session.
    assert.equal(
      (await f.app.inject({ url, cookies: f.cookies })).statusCode,
      404,
    );
    assert.equal((await f.app.inject({ url })).statusCode, 401);

    // The owner sets a PNG; it comes back as itself, never sniffed.
    const set = await put(png, 'image/png', { cookies: f.cookies });
    assert.equal(set.statusCode, 200);
    const got = await f.app.inject({ url, cookies: f.cookies });
    assert.equal(got.statusCode, 200);
    assert.equal(got.headers['content-type'], 'image/png');
    assert.equal(got.headers['x-content-type-options'], 'nosniff');
    assert.deepEqual(got.rawPayload, png);

    // The type is read from the bytes: a mislabelled or SVG body is refused.
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
    assert.equal(
      (await put(svg, 'image/png', { cookies: f.cookies })).statusCode,
      400,
    );
    assert.equal(
      (await put(svg, 'image/svg+xml', { cookies: f.cookies })).statusCode,
      415,
    );
    // Too large for a picture.
    const huge = Buffer.concat([png, Buffer.alloc(130 * 1024)]);
    assert.equal(
      (await put(huge, 'image/png', { cookies: f.cookies })).statusCode,
      413,
    );

    // The agent sets its own picture with its own credential.
    assert.equal(
      (await put(webp, 'image/webp', { headers: f.headers })).statusCode,
      200,
    );
    const mine = await f.app.inject({ url, cookies: f.cookies });
    assert.equal(mine.headers['content-type'], 'image/webp');

    // Another agent cannot touch it.
    const other = Agent.parse(
      (
        await f.app.inject({
          method: 'POST',
          url: f.base,
          cookies: f.cookies,
          payload: { ...profileInput, name: 'Other' },
        })
      ).json<unknown>(),
    );
    const issued = Issued.parse(
      (
        await f.app.inject({
          method: 'POST',
          url: f.base + '/' + other.id + '/grants',
          cookies: f.cookies,
          payload: grantInput,
        })
      ).json<unknown>(),
    );
    const stranger = { authorization: 'Bearer ' + issued.token };
    assert.equal(
      (await put(png, 'image/png', { headers: stranger })).statusCode,
      403,
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'DELETE',
          url,
          headers: stranger,
        })
      ).statusCode,
      403,
    );

    // Each change is in the agent's audit trail.
    const audit = await f.app.inject({
      url: f.path + '/audit',
      cookies: f.cookies,
    });
    assert.equal(audit.statusCode, 200);
    const kinds = JSON.stringify(audit.json<unknown>());
    assert.ok(kinds.includes('"avatar-set"'));

    // Removing it leaves the initial again.
    assert.equal(
      (await f.app.inject({ method: 'DELETE', url, cookies: f.cookies }))
        .statusCode,
      204,
    );
    assert.equal(
      (await f.app.inject({ url, cookies: f.cookies })).statusCode,
      404,
    );
  } finally {
    await f.dispose();
  }
});
