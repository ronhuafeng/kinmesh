import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { brotliDecompressSync } from 'node:zlib';
import { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { agentFixture } from './agent-helpers.js';

/**
 * Answers travel compressed to a browser that takes it; the event stream
 * goes as it is, so each event arrives at once.
 */
await test('answers are compressed, the event stream is not', async () => {
  const f = await agentFixture();
  try {
    const read = await f.app.inject({
      url: '/api/workspace',
      cookies: f.cookies,
      headers: { 'accept-encoding': 'br, gzip' },
    });
    assert.equal(read.statusCode, 200);
    assert.equal(read.headers['content-encoding'], 'br');
    WorkspaceSnapshot.parse(
      JSON.parse(brotliDecompressSync(read.rawPayload).toString('utf8')),
    );
    await f.app.listen({ host: '127.0.0.1', port: 0 });
    const address = f.app.server.address();
    assert.ok(address && typeof address === 'object');
    const cookie = Object.entries(f.cookies)
      .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
      .join('; ');
    const controller = new AbortController();
    const stream = await fetch(
      `http://127.0.0.1:${String(address.port)}/api/events`,
      {
        headers: { cookie, 'accept-encoding': 'br, gzip' },
        signal: controller.signal,
      },
    );
    assert.equal(stream.status, 200);
    assert.equal(stream.headers.get('content-encoding'), null);
    // The workspace arrives as plain text, without the stream ending.
    assert.ok(stream.body);
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('event: workspace')) {
      const { value, done } = await reader.read();
      assert.equal(done, false);
      text += decoder.decode(value, { stream: true });
    }
    await reader.cancel();
  } finally {
    await f.dispose();
  }
});

const assets = new URL('../web-dist/assets/', import.meta.url);
await test(
  'the web’s files go as they were compressed when built',
  // The web is built before the tests run (`npm run build`).
  { skip: !existsSync(assets) && 'web not built' },
  async () => {
    const name = readdirSync(assets).find(
      (file) =>
        file.endsWith('.js') && existsSync(new URL(file + '.br', assets)),
    );
    assert.ok(name, 'no script was compressed when built');
    const f = await agentFixture();
    try {
      const compressed = await f.app.inject({
        url: '/assets/' + name,
        headers: { 'accept-encoding': 'br, gzip' },
      });
      assert.equal(compressed.statusCode, 200);
      assert.equal(compressed.headers['content-encoding'], 'br');
      // Exactly the file, once taken apart.
      assert.ok(
        brotliDecompressSync(compressed.rawPayload).equals(
          readFileSync(new URL(name, assets)),
        ),
      );
      // A client that takes no compression gets the file as it is.
      const plain = await f.app.inject({ url: '/assets/' + name });
      assert.equal(plain.headers['content-encoding'], undefined);
      assert.ok(plain.rawPayload.equals(readFileSync(new URL(name, assets))));
    } finally {
      await f.dispose();
    }
  },
);
