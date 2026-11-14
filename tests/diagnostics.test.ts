import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { z } from 'zod';
import { createApp } from '../src/server/app.js';
import { describeFailure } from '../src/diagnostics.js';
import { feishuEnv, fixture } from './helpers.js';
import { feishuPerson, signInAs, standInFeishu } from './feishu.js';

const Line = z.looseObject({
  msg: z.string(),
  reqId: z.string().optional(),
  route: z.string().optional(),
  method: z.string().optional(),
  status: z.number().optional(),
  error: z.string().optional(),
  code: z.string().optional(),
  constraint: z.string().optional(),
});

await test('a failure leaves one record to diagnose it, and nothing private', async () => {
  const f = await fixture();
  const store = await f.open();
  const lines: string[] = [];
  const logStream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(...chunk.toString().split('\n').filter(Boolean));
      done();
    },
  });
  const app = await createApp(
    f.config,
    store,
    undefined,
    undefined,
    {},
    { logStream, feishu: standInFeishu },
  );
  try {
    const cookies = await signInAs(app, 'owner@example.com');
    const team = await store.teamFor(
      (await store.signIn(feishuPerson('owner@example.com'))).id,
    );
    assert.ok(team);
    const url = `/api/teams/${team.team.id}/channels`;
    const marker = 'private-body-' + randomUUID();

    // An unknown failure: the response says nothing, the log says what failed.
    const create = store.communication.createChannel.bind(store.communication);
    store.communication.createChannel = () => {
      throw Object.assign(new Error('disk I/O error'), {
        code: 'SQLITE_IOERR',
      });
    };
    const failed = await app.inject({
      method: 'POST',
      url,
      cookies,
      payload: { operationKey: randomUUID(), name: marker },
    });
    assert.equal(failed.statusCode, 500);
    assert.deepEqual(failed.json(), { error: 'Internal service error' });
    const records = lines.map((l) => Line.parse(JSON.parse(l)));
    const failures = records.filter((r) => r.msg === 'failed');
    assert.equal(failures.length, 1);
    const [failure] = failures;
    assert.ok(failure);
    assert.equal(failure.route, '/api/teams/:teamId/channels');
    assert.equal(failure.method, 'POST');
    assert.equal(failure.status, 500);
    assert.equal(failure.error, 'Error');
    assert.equal(failure.code, 'SQLITE_IOERR');
    assert.match(failure.reqId ?? '', /^[0-9a-f-]{36}$/);
    const written = lines.join('\n');
    for (const secret of [
      marker,
      ...Object.values(cookies),
      f.config.feishu.appSecret,
    ])
      assert.equal(written.includes(secret), false);

    // A refusal caused by a constraint keeps the constraint's name.
    store.communication.createChannel = create;
    for (const expected of [201, 409]) {
      const made = await app.inject({
        method: 'POST',
        url,
        cookies,
        payload: { operationKey: randomUUID(), name: 'twice' },
      });
      assert.equal(made.statusCode, expected);
    }
    const refused = lines
      .map((l) => Line.parse(JSON.parse(l)))
      .filter((r) => r.msg === 'refused');
    assert.equal(refused.length, 1);
    const [refusal] = refused;
    assert.ok(refusal);
    assert.equal(refusal.status, 409);
    assert.match(refusal.constraint ?? '', /channels\./);

    // Feishu refusing a sign-in is recorded, without the code it was given.
    const begin = await app.inject({ url: '/login' });
    const state = new URL(String(begin.headers.location)).searchParams.get(
      'state',
    );
    const login = begin.cookies.find((c) => c.name === 'kinmesh-login');
    assert.ok(state && login);
    const code = 'fail-' + randomUUID();
    await app.inject({
      url: `/login/callback?code=${code}&state=${state}`,
      cookies: { [login.name]: login.value },
    });
    const turnedBack = lines
      .map((l) => Line.parse(JSON.parse(l)))
      .filter((r) => r.route === '/login/callback');
    assert.equal(turnedBack.length, 1);
    assert.equal(lines.join('\n').includes(code), false);
  } finally {
    await app.close();
    await store.close();
    await f.cleanup();
  }
});

await test('a failure is described by name, code and constraint, not by request data', () => {
  const unique = Object.assign(
    new Error('UNIQUE constraint failed: channels.team_id, channels.name'),
    { name: 'SqliteError', code: 'SQLITE_CONSTRAINT_UNIQUE' },
  );
  const described = describeFailure(unique);
  assert.equal(described.error, 'SqliteError');
  assert.equal(described.code, 'SQLITE_CONSTRAINT_UNIQUE');
  assert.equal(described.constraint, 'channels.team_id, channels.name');
  const wrapped = new Error('Listener unavailable', {
    cause: Object.assign(new Error('listen EADDRINUSE'), {
      code: 'EADDRINUSE',
    }),
  });
  assert.deepEqual(describeFailure(wrapped).cause, {
    error: 'Error',
    code: 'EADDRINUSE',
  });
});

await test('a hub that cannot start says what failed', () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kinmesh-boot-')));
  const run = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/server/main.ts'],
    {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        PATH: process.env.PATH,
        // Nothing listens there: the database cannot be reached.
        KINMESH_DATABASE_URL: 'postgres://kinmesh:unused@127.0.0.1:1/kinmesh',
        KINMESH_STATE: directory,
        KINMESH_SESSION_KEY: 'b'.repeat(64),
        ...feishuEnv,
      },
    },
  );
  assert.equal(run.status, 1);
  const report = run.stderr
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => z.looseObject({ event: z.string() }).parse(JSON.parse(l)))
    .find((r) => r.event === 'hub_startup_failed');
  assert.ok(report);
  const failure = z
    .object({ error: z.string().min(1), code: z.string().min(1) })
    .safeParse(report);
  assert.ok(failure.success, run.stderr);
});
