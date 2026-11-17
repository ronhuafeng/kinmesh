import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { z } from 'zod';
import { spaceServer } from '../deploy/t3/space.js';

/**
 * The provisioner's contract (docs/operations.md#the-space), with a stand-in
 * for T3's CLI that keeps the projects it was given and refuses one twice,
 * as T3 does.
 */
await test('the provisioner makes a channel folder a git repository and a T3 project, once, and only inside the space', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kinmesh-space-'));
  const space = join(dir, 'space');
  const projects = join(dir, 'projects');
  const t3 = join(dir, 't3');
  writeFileSync(projects, '');
  writeFileSync(
    t3,
    [
      '#!/bin/sh',
      // t3 project add --title <title> <folder>
      `if grep -qxF "$5" "${projects}"; then echo "Project already exists"; exit 1; fi`,
      `echo "$5" >> "${projects}"`,
    ].join('\n'),
  );
  chmodSync(t3, 0o755);
  execFileSync('mkdir', ['-p', space]);
  const server = spaceServer({ space, token: 'right', t3 });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  const { port } = address;
  const ask = (body: unknown, token = 'right') =>
    fetch(`http://127.0.0.1:${String(port)}/projects`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  const commits = (folder: string) =>
    execFileSync('git', ['rev-list', '--count', 'HEAD'], {
      cwd: folder,
      encoding: 'utf8',
    }).trim();
  try {
    const made = await ask({ directory: 'design-3f2a91c0', title: 'design' });
    assert.equal(made.status, 200);
    const root = join(space, 'design-3f2a91c0');
    assert.deepEqual(await made.json(), { workspaceRoot: root });
    assert.equal(commits(root), '1');
    assert.equal(readFileSync(join(root, 'README.md'), 'utf8'), '# design\n');
    assert.equal(readFileSync(projects, 'utf8'), root + '\n');

    // Asked again, the same answer and nothing changed.
    const again = await ask({ directory: 'design-3f2a91c0', title: 'design' });
    assert.equal(again.status, 200);
    assert.deepEqual(await again.json(), { workspaceRoot: root });
    assert.equal(commits(root), '1');
    assert.equal(readFileSync(projects, 'utf8'), root + '\n');

    // A wrong token, a name that is not a folder name, a way out.
    assert.equal(
      (await ask({ directory: 'x', title: 'x' }, 'wrong')).status,
      401,
    );
    for (const directory of [
      '../outside',
      'Design',
      '-x',
      'a/b',
      '',
      'a'.repeat(81),
    ])
      assert.equal(
        (await ask({ directory, title: 'x' })).status,
        400,
        `refuses ${JSON.stringify(directory)}`,
      );
    assert.equal((await ask({ directory: 'ok' })).status, 400, 'needs a title');
    assert.equal(readFileSync(projects, 'utf8'), root + '\n');
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('the provisioner places a message’s file in the channel’s attachments, once, out of git’s sight, and only there', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kinmesh-space-'));
  const space = join(dir, 'space');
  const t3 = join(dir, 't3');
  writeFileSync(t3, '#!/bin/sh\nexit 0\n');
  chmodSync(t3, 0o755);
  execFileSync('mkdir', ['-p', space]);
  const server = spaceServer({ space, token: 'right', t3 });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  const origin = `http://127.0.0.1:${String(address.port)}`;
  const id = randomUUID();
  const bytes = Buffer.from('a screenshot, say');
  const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  const put = (
    body: Buffer,
    name: string,
    options: {
      token?: string;
      sha?: string;
      directory?: string;
      file?: string;
    } = {},
  ) =>
    fetch(
      `${origin}/projects/${options.directory ?? 'design-3f2a91c0'}/attachments/${options.file ?? id}`,
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${options.token ?? 'right'}`,
          'x-kinmesh-name': encodeURIComponent(name),
          'x-kinmesh-sha256': options.sha ?? hash(body),
        },
        body: new Uint8Array(body),
      },
    );
  try {
    const made = await fetch(`${origin}/projects`, {
      method: 'POST',
      headers: { authorization: 'Bearer right' },
      body: JSON.stringify({ directory: 'design-3f2a91c0', title: 'design' }),
    });
    assert.equal(made.status, 200);
    const root = join(space, 'design-3f2a91c0');
    // A name that tries to leave lands inside attachments/, cleaned.
    const placed = await put(bytes, '../../.ssh/authorized keys');
    assert.equal(placed.status, 200);
    const { path } = z.object({ path: z.string() }).parse(await placed.json());
    assert.equal(
      path,
      join(root, 'attachments', `${id.slice(0, 8)}-authorized keys`),
    );
    assert.deepEqual(readFileSync(path), bytes);
    // Placed again, nothing changes; other bytes under its ID conflict.
    assert.equal((await put(bytes, 'again.txt')).status, 200);
    assert.deepEqual(readdirSync(join(root, 'attachments')), [
      `${id.slice(0, 8)}-authorized keys`,
    ]);
    assert.equal((await put(Buffer.from('other'), 'x.txt')).status, 409);
    // Out of git's sight.
    assert.equal(
      execFileSync('git', ['status', '--porcelain'], {
        cwd: root,
        encoding: 'utf8',
      }),
      '',
    );
    // A wrong token, bytes that aren't what they say, a folder it never made.
    assert.equal((await put(bytes, 'x', { token: 'wrong' })).status, 401);
    assert.equal(
      (await put(bytes, 'x', { sha: hash(Buffer.from('no')) })).status,
      400,
    );
    assert.equal((await put(bytes, 'x', { directory: 'unknown' })).status, 404);
    assert.equal((await put(bytes, 'x', { directory: '..' })).status, 404);
    assert.equal((await put(bytes, 'x', { file: 'not-an-id' })).status, 400);
    // Removed, and removing it again is the same.
    for (let i = 0; i < 2; i += 1)
      assert.equal(
        (
          await fetch(`${origin}/projects/design-3f2a91c0/attachments/${id}`, {
            method: 'DELETE',
            headers: { authorization: 'Bearer right' },
          })
        ).status,
        200,
      );
    assert.equal(existsSync(path), false);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('the provisioner mints a five-minute T3 pairing code, labelled, for the hub alone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kinmesh-space-'));
  const space = join(dir, 'space');
  const t3 = join(dir, 't3');
  const asked = join(dir, 'asked');
  // T3's own output, as 0.1.9 prints it.
  writeFileSync(
    t3,
    [
      '#!/bin/sh',
      `echo "$@" > "${asked}"`,
      'echo "Pairing with fixture (http://127.0.0.1:3773)."',
      'echo "Pairing URL: http://10.0.0.1:3773/pair#token=ABCD1234WXYZ"',
      'echo "Token: ABCD1234WXYZ"',
      'echo "Expires: 2026-11-17T22:08:13.101Z"',
    ].join('\n'),
  );
  chmodSync(t3, 0o755);
  execFileSync('mkdir', ['-p', space]);
  const server = spaceServer({ space, token: 'right', t3 });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  const pair = (token: string) =>
    fetch(`http://127.0.0.1:${String(address.port)}/pair`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ label: 'Kinmesh\nforged line' }),
    });
  try {
    assert.equal((await pair('wrong')).status, 401);
    const paired = await pair('right');
    assert.equal(paired.status, 200);
    assert.deepEqual(await paired.json(), {
      token: 'ABCD1234WXYZ',
      expiresAt: '2026-11-17T22:08:13.101Z',
    });
    assert.equal(
      readFileSync(asked, 'utf8').trim(),
      'pair --ttl 5m --label Kinmesh forged line',
    );
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
