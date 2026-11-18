import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Attachment, sniff } from '../src/domain/attachments.js';
import { Message, TeamFile } from '../src/domain/communication.js';
import { z } from 'zod';
import { byteRange, unplaceOnce } from '../src/server/attachments.js';
import { attachmentStore } from '../src/persistence/attachment-store.js';
import {
  communicationFixture,
  key,
  postInput,
  uploadFile,
} from './communication-helpers.js';
import { feishuPerson, signInAs } from './feishu.js';
import { rawDatabase } from './raw.js';

/** A 3 × 2 PNG: the signature and the header chunk are all sniffing reads. */
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0, 0, 0, 13]),
  Buffer.from('IHDR'),
  Buffer.from([0, 0, 0, 3, 0, 0, 0, 2, 8, 6, 0, 0, 0]),
]);
const sha = (bytes: Buffer | string) =>
  createHash('sha256').update(bytes).digest('hex');

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
    const upload = (body: Buffer, name: string, operationKey = key()) =>
      uploadFile(f.app, f.channelPath, f.cookies, body, name, operationKey);
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
    // Kept already: nothing to send again.
    const asked = await f.app.inject({
      method: 'POST',
      url: `${f.channelPath}/attachments/uploads`,
      cookies: f.cookies,
      payload: { sha256: sha(png), size: png.length },
    });
    assert.deepEqual(asked.json<unknown>(), { url: null });

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
    assert.equal(opened.headers['accept-ranges'], 'bytes');
    // A part of it, as a viewer asks for one.
    const part = await f.app.inject({
      url: `${f.channelPath}/attachments/${image.id}`,
      cookies: grace,
      headers: { range: 'bytes=1-3' },
    });
    assert.equal(part.statusCode, 206);
    assert.equal(
      part.headers['content-range'],
      `bytes 1-3/${String(png.length)}`,
    );
    assert.deepEqual(part.rawPayload, png.subarray(1, 4));
    const past = await f.app.inject({
      url: `${f.channelPath}/attachments/${image.id}`,
      cookies: grace,
      headers: { range: `bytes=${String(png.length)}-` },
    });
    assert.equal(past.statusCode, 416);

    // In a channel she isn't joined to, its files are not there for her.
    const other = await f.app.inject({
      method: 'POST',
      url: f.channelsPath,
      cookies: f.cookies,
      payload: { operationKey: key(), name: 'private' },
    });
    const privatePath = `${f.channelsPath}/${other.json<{ id: string }>().id}`;
    const room = await uploadFile(f.app, privatePath, f.cookies, png, 'a.png');
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
  const files = attachmentStore(f.config.files);
  try {
    const left = Buffer.from('never sent');
    const uploaded = await uploadFile(
      f.app,
      f.channelPath,
      f.cookies,
      left,
      'left.txt',
    );
    assert.equal(uploaded.statusCode, 201);
    assert.notEqual(await files.find(sha(left)), null);
    await raw
      .prepare('UPDATE attachments SET created_at = created_at - 86400001')
      .run();
    for (const sha256 of await f.store.communication.sweepUnbound(Date.now()))
      await f.store.communication.release(sha256, () => files.remove(sha256));
    assert.equal(
      Number(
        await raw.prepare('SELECT count(*) FROM attachments').pluck().get(),
      ),
      0,
    );
    assert.equal(await files.find(sha(left)), null);
  } finally {
    await raw.close();
    await f.dispose();
  }
});

await test('the store takes only the bytes the hub was told of, and the hub registers only what the store has', async () => {
  const f = await communicationFixture();
  try {
    const ask = (sha256: string, size: number) =>
      f.app.inject({
        method: 'POST',
        url: `${f.channelPath}/attachments/uploads`,
        cookies: f.cookies,
        payload: { sha256, size },
      });
    // Larger than allowed: refused before anything is sent.
    assert.equal(
      (await ask(sha('big'), 200 * 1024 * 1024 + 1)).statusCode,
      413,
    );
    // Other bytes, or more of them, than the upload was given for.
    const told = Buffer.from('the bytes told of');
    const { url } = z
      .object({ url: z.string() })
      .parse((await ask(sha(told), told.length)).json<unknown>());
    const checksum = Buffer.from(sha(told), 'hex').toString('base64');
    for (const body of [
      Buffer.from('the bytes TOLD of'),
      Buffer.from('the bytes told of, and more'),
    ]) {
      const put = await fetch(url, {
        method: 'PUT',
        body: new Uint8Array(body),
        headers: { 'x-amz-checksum-sha256': checksum },
      });
      assert.ok(put.status >= 400, String(put.status));
    }
    // Nothing the store has: nothing to register.
    const register = await f.app.inject({
      method: 'POST',
      url: `${f.channelPath}/attachments`,
      cookies: f.cookies,
      payload: { operationKey: key(), name: 'told.txt', sha256: sha(told) },
    });
    assert.equal(register.statusCode, 400);
  } finally {
    await f.dispose();
  }
});

await test('a Range header asks for one part of a file', () => {
  assert.equal(byteRange(undefined, 10), null);
  assert.deepEqual(byteRange('bytes=2-4', 10), { start: 2, end: 4 });
  assert.deepEqual(byteRange('bytes=7-', 10), { start: 7, end: 9 });
  assert.deepEqual(byteRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.deepEqual(byteRange('bytes=5-99', 10), { start: 5, end: 9 });
  // Several ranges, or something else: the whole file.
  assert.equal(byteRange('bytes=0-1,4-5', 10), null);
  assert.equal(byteRange('items=0-1', 10), null);
  assert.equal(byteRange('bytes=10-', 10), 'unsatisfiable');
  assert.equal(byteRange('bytes=4-2', 10), 'unsatisfiable');
  assert.equal(byteRange('bytes=0-', 0), 'unsatisfiable');
});

await test('anyone joined removes a file: it is gone everywhere, the message says who and when, and the audit keeps it', async () => {
  const f = await communicationFixture();
  const raw = rawDatabase(f.dbPath);
  try {
    // The channel has a folder in the space, where the file was placed.
    await raw
      .prepare(
        'INSERT INTO channel_spaces (channel_id, team_id, directory) VALUES (?, ?, ?)',
      )
      .run(f.channelId, f.teamId, 'general-12345678');
    const uploaded = await uploadFile(
      f.app,
      f.channelPath,
      f.cookies,
      png,
      'secret.png',
    );
    const file = Attachment.parse(uploaded.json<unknown>());
    const posted = Message.parse(
      (
        await f.app.inject({
          method: 'POST',
          url: f.channelPath + '/messages',
          cookies: f.cookies,
          payload: { ...postInput({ body: 'Oops' }), attachments: [file.id] },
        })
      ).json<unknown>(),
    );
    const files = async (cookies: Record<string, string>) =>
      z.object({ items: z.array(TeamFile) }).parse(
        (
          await f.app.inject({
            url: `/api/teams/${f.teamId}/files`,
            cookies,
          })
        ).json<unknown>(),
      ).items;
    const grace = await signInAs(f.app, 'grace@example.com');
    assert.deepEqual(
      (await files(grace)).map((x) => x.attachment.id),
      [file.id],
    );
    const remove = (
      options: {
        cookies?: Record<string, string>;
        headers?: Record<string, string>;
      },
      path = f.channelPath,
    ) =>
      f.app.inject({
        method: 'POST',
        url: `${path}/attachments/${file.id}/remove`,
        ...options,
        payload: { operationKey: key() },
      });
    // Not through a channel she isn't in.
    const other = await f.app.inject({
      method: 'POST',
      url: f.channelsPath,
      cookies: f.cookies,
      payload: { operationKey: key(), name: 'private' },
    });
    assert.equal(
      (
        await remove(
          { cookies: grace },
          `${f.channelsPath}/${other.json<{ id: string }>().id}`,
        )
      ).statusCode,
      404,
    );
    // An agent never removes one, even joined.
    await f.invite();
    assert.equal((await remove({ headers: f.headers })).statusCode, 403);
    // Someone joined does; she isn't the uploader.
    const removed = await remove({ cookies: grace });
    assert.equal(removed.statusCode, 200);
    // Gone by every route, its bytes with it, its folder copy queued.
    assert.equal(
      (
        await f.app.inject({
          url: `${f.channelPath}/attachments/${file.id}`,
          cookies: f.cookies,
        })
      ).statusCode,
      404,
    );
    assert.equal(await attachmentStore(f.config.files).find(sha(png)), null);
    assert.deepEqual(await files(f.cookies), []);
    assert.equal((await remove({ cookies: f.cookies })).statusCode, 404);
    // The message keeps its text and says who removed a file, and when.
    const message = await f.comm.message(
      f.principal,
      f.teamId,
      f.channelId,
      posted.id,
    );
    assert.equal(message.body, 'Oops');
    assert.deepEqual(message.attachments, []);
    const grace0 = await f.store.signIn(feishuPerson('grace@example.com'));
    assert.equal(message.removedAttachments[0]?.removedBy, grace0.id);
    // The audit holds who and when, never the file, and never changes.
    const audit = await raw.prepare('SELECT * FROM attachment_removals').all();
    assert.equal(audit.length, 1);
    assert.ok(!JSON.stringify(audit).includes('secret.png'));
    await assert.rejects(raw.prepare('DELETE FROM attachment_removals').run());
    // The provisioner is asked to remove the folder's copy until it has.
    const asked: string[] = [];
    const remover = (directory: string, id: string) => {
      asked.push(`${directory}/${id}`);
      return Promise.resolve();
    };
    await unplaceOnce(f.store, remover, new AbortController().signal);
    await unplaceOnce(f.store, remover, new AbortController().signal);
    assert.deepEqual(asked, [`general-12345678/${file.id}`]);
  } finally {
    await raw.close();
    await f.dispose();
  }
});
