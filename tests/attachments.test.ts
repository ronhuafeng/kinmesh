import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Attachment, sniff } from '../src/domain/attachments.js';
import { Message, TeamFile } from '../src/domain/communication.js';
import { z } from 'zod';
import { unplaceOnce } from '../src/server/attachments.js';
import {
  communicationFixture,
  key,
  postInput,
} from './communication-helpers.js';
import { feishuPerson, signInAs } from './feishu.js';
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
      payload: Buffer.alloc(200 * 1024 * 1024 + 1),
    });
    assert.equal(refused.statusCode, 413);
    assert.equal(kept(f.directory), 0);
  } finally {
    await f.dispose();
  }
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
    const uploaded = await f.app.inject({
      method: 'POST',
      url: `${f.channelPath}/attachments?operationKey=${key()}&name=secret.png`,
      cookies: f.cookies,
      headers: { 'content-type': 'image/png' },
      payload: png,
    });
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
    assert.equal(kept(f.directory), 0);
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
