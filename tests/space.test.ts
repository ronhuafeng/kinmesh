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
