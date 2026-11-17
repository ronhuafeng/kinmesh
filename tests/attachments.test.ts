import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Attachment, sniff } from '../src/domain/attachments.js';
import { Message } from '../src/domain/communication.js';
import {
  communicationFixture,
  key,
  postInput,
} from './communication-helpers.js';
import { signInAs } from './feishu.js';
import { directoryBytes } from '../src/persistence/attachment-bytes.js';
import { rawDatabase } from './raw.js';

/** A 3 × 2 PNG: the signature and the header chunk are all sniffing reads. */
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0, 0, 0, 13]),
  Buffer.from('IHDR'),
  Buffer.from([0, 0, 0, 3, 0, 0, 0, 2, 8, 6, 0, 0, 0]),
]);
const kept = (directory: string) =>
  existsSync(join(directory, 'attachments'))
    ? readdirSync(join(directory, 'attachments'), { recursive: true }).filter(
        (name) => String(name).length > 3,
      ).length
    : 0;

await test('the server decides what a file is from its content, never its name', () => {
  assert.deepEqual(sniff(png), { type: 'image/png', width: 3, height: 2 });
  for (const disguised of [
    '<html><script>alert(1)</script></html>',
    '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
  ])
    assert.equal(
      sniff(Buffer.from(disguised)).type,
      'application/octet-stream',
    );
  assert.equal(sniff(Buffer.from('%PDF-1.7')).type, 'application/pdf');
});

await test('a person attaches files to a message, and everyone joined, and only they, opens them', async () => {
  const f = await communicationFixture({
    attachmentsRoom: png.length + 10,
  });
  try {
    const upload = (
      body: Buffer,
      name: string,
      operationKey = key(),
      cookies = f.cookies,
      path = f.channelPath,
    ) =>
      f.app.inject({
        method: 'POST',
        url: `${path}/attachments?operationKey=${operationKey}&name=${encodeURIComponent(name)}`,
        cookies,
        headers: { 'content-type': 'image/png' },
        payload: body,
      });
    // The same upload again is the same file; the same bytes are kept once.
    const again = key();
    const first = await upload(png, '设计稿.png', again);
    assert.equal(first.statusCode, 201);
    const image = Attachment.parse(first.json<unknown>());
    assert.deepEqual(
      { type: image.type, width: image.width, height: image.height },
      { type: 'image/png', width: 3, height: 2 },
    );
    assert.equal(
      Attachment.parse((await upload(png, '设计稿.png', again)).json<unknown>())
        .id,
      image.id,
    );
    const copy = Attachment.parse(
      (await upload(png, 'copy.png')).json<unknown>(),
    );
    assert.equal(kept(f.directory), 1);

    // Past the team's room, refused before anything is kept.
    assert.equal(
      (await upload(Buffer.from('eleven byte'), 'x.txt')).statusCode,
      413,
    );

    // Files alone are a message; another's or a sent upload is not theirs to send.
    const posted = await f.app.inject({
      method: 'POST',
      url: f.channelPath + '/messages',
      cookies: f.cookies,
      payload: { ...postInput({ body: '' }), attachments: [image.id, copy.id] },
    });
    assert.equal(posted.statusCode, 201);
    const message = Message.parse(posted.json<unknown>());
    assert.deepEqual(
      message.attachments.map((a) => a.id),
      [image.id, copy.id],
    );
    const reused = await f.app.inject({
      method: 'POST',
      url: f.channelPath + '/messages',
      cookies: f.cookies,
      payload: { ...postInput(), attachments: [image.id] },
    });
    assert.equal(reused.statusCode, 400);
    const empty = await f.app.inject({
      method: 'POST',
      url: f.channelPath + '/messages',
      cookies: f.cookies,
      payload: postInput({ body: '' }),
    });
    assert.equal(empty.statusCode, 400, 'no text and no files');

    // Everyone joined opens it; an image shows inline and runs nothing.
    const grace = await signInAs(f.app, 'grace@example.com');
    const opened = await f.app.inject({
      url: `${f.channelPath}/attachments/${image.id}`,
      cookies: grace,
    });
    assert.equal(opened.statusCode, 200);
    assert.deepEqual(opened.rawPayload, png);
    assert.equal(opened.headers['content-type'], 'image/png');
    assert.match(String(opened.headers['content-disposition']), /^inline;/);
    assert.equal(opened.headers['x-content-type-options'], 'nosniff');
    assert.match(String(opened.headers['content-security-policy']), /sandbox/);

    // In a channel she isn't joined to, its files are not there for her.
    const other = await f.app.inject({
      method: 'POST',
      url: f.channelsPath,
      cookies: f.cookies,
      payload: { operationKey: key(), name: 'private' },
    });
    const privatePath = `${f.channelsPath}/${other.json<{ id: string }>().id}`;
    const room = await f.app.inject({
      method: 'POST',
      url: `${privatePath}/attachments?operationKey=${key()}&name=a.png`,
      cookies: f.cookies,
      headers: { 'content-type': 'image/png' },
      payload: png,
    });
    assert.equal(room.statusCode, 201, 'the same bytes take no more room');
    const hidden = Attachment.parse(room.json<unknown>());
    assert.equal(
      (
        await f.app.inject({
          url: `${privatePath}/attachments/${hidden.id}`,
          cookies: grace,
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await f.app.inject({
          url: `${f.channelPath}/attachments/${hidden.id}`,
          cookies: grace,
        })
      ).statusCode,
      404,
      'nor through a channel she is in',
    );
  } finally {
    await f.dispose();
  }
});

await test('an upload no message took is gone after a day, and its bytes with it', async () => {
  const f = await communicationFixture();
  const raw = rawDatabase(f.dbPath);
  try {
    const uploaded = await f.app.inject({
      method: 'POST',
      url: `${f.channelPath}/attachments?operationKey=${key()}&name=left.txt`,
      cookies: f.cookies,
      headers: { 'content-type': 'text/plain' },
      payload: 'never sent',
    });
    assert.equal(uploaded.statusCode, 201);
    assert.equal(kept(f.directory), 1);
    await raw
      .prepare('UPDATE attachments SET created_at = created_at - 86400001')
      .run();
    for (const sha256 of await f.store.communication.sweepUnbound(Date.now()))
      await f.store.communication.release(sha256, () =>
        directoryBytes(f.directory).remove(sha256),
      );
    assert.equal(
      Number(
        await raw.prepare('SELECT count(*) FROM attachments').pluck().get(),
      ),
      0,
    );
    assert.equal(kept(f.directory), 0);
  } finally {
    await raw.close();
    await f.dispose();
  }
});

await test('a file larger than allowed is refused from what the request says', async () => {
  const f = await communicationFixture();
  try {
    const refused = await f.app.inject({
      method: 'POST',
      url: `${f.channelPath}/attachments?operationKey=${key()}&name=big.bin`,
      cookies: f.cookies,
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(25 * 1024 * 1024 + 1),
    });
    assert.equal(refused.statusCode, 413);
    assert.equal(kept(f.directory), 0);
  } finally {
    await f.dispose();
  }
});
