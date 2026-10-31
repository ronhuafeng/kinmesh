import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Process, port, ready } from './live/processes.js';

await test('live service cleanup stops the actual parent and descendant listeners', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kinmesh-cleanup-'));
  const first = await port(),
    second = await port();
  const child = `require('node:http').createServer((q,s)=>s.end('child')).listen(${String(second)},'127.0.0.1')`;
  const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'});require('node:http').createServer((q,s)=>s.end('parent')).listen(${String(first)},'127.0.0.1')`;
  const service = new Process(
    process.execPath,
    ['-e', parent],
    { PATH: process.env.PATH },
    join(root, 'service.log'),
  );
  try {
    service.start();
    await ready(`http://127.0.0.1:${String(first)}`);
    await ready(`http://127.0.0.1:${String(second)}`);
    await service.stop();
    for (const listener of [first, second])
      await assert.rejects(
        fetch(`http://127.0.0.1:${String(listener)}`, {
          signal: AbortSignal.timeout(1000),
        }),
      );
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
