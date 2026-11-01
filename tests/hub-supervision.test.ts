import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
  rmSync,
  existsSync,
  renameSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { inboxFixture } from './inbox-helpers.js';
import { WORKER_GRANT } from '../src/server/connect.js';
import { managedDirectory, writeAgentToken } from '../src/inbox/managed.js';
import { postInput } from './communication-helpers.js';
import { Message } from '../src/domain/communication.js';
import { WORKER_SHUTDOWN_MS } from '../src/inbox/lifecycle.js';

const root = fileURLToPath(new URL('../', import.meta.url));
async function until<T>(
  get: () => T | Promise<T>,
  accept: (value: T) => boolean,
  ms = 15000,
) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await get();
    if (accept(value)) return value;
    await delay(40);
  }
  throw new Error('Subprocess fixture deadline');
}
async function freePort() {
  const server = createServer();
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((done) => {
    server.close(() => {
      done();
    });
  });
  return address.port;
}
// Only descendants of our disposable test process are inspected; no production PID claims.
function descendants(pid: number): number[] {
  try {
    if (process.platform === 'darwin') {
      const rows = execFileSync('ps', ['-axo', 'pid=,ppid='], {
        encoding: 'utf8',
      })
        .trim()
        .split('\n')
        .map((line) => line.trim().split(/\s+/).map(Number));
      const collect = (parent: number): number[] =>
        rows.flatMap(([child, owner]) =>
          child !== undefined && owner === parent
            ? [child, ...collect(child)]
            : [],
        );
      return collect(pid);
    }
    const children = readFileSync(
      `/proc/${String(pid)}/task/${String(pid)}/children`,
      'utf8',
    )
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);
    return children.flatMap((id) => [id, ...descendants(id)]);
  } catch {
    return [];
  }
}
function command(pid: number) {
  try {
    if (process.platform === 'darwin')
      return execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
        encoding: 'utf8',
      })
        .trim()
        .split(/\s+/);
    return readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8').split('\0');
  } catch {
    return [];
  }
}
function alive(pid: number) {
  try {
    if (process.platform === 'darwin')
      return !execFileSync('ps', ['-p', String(pid), '-o', 'stat='], {
        encoding: 'utf8',
      })
        .trim()
        .startsWith('Z');
    // A zombie has already exited and cannot hold a database or launch work.
    return !/^\d+ \(.*\) Z /.test(
      readFileSync(`/proc/${String(pid)}/stat`, 'utf8'),
    );
  } catch {
    return false;
  }
}
async function fixture(database?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'kinmesh-hub-supervision-'));
  const dbPath = database ?? join(directory, 'team.sqlite');
  const configPath = join(directory, 'inbox.json');
  writeFileSync(
    configPath,
    JSON.stringify({ database: dbPath, pollMs: 100, bindings: [] }),
    { mode: 0o600 },
  );
  // Run the repository's exact npm start script with a disposable .env, never the user's .env.
  const manifest = z
    .object({ scripts: z.object({ start: z.string() }) })
    .parse(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')));
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      scripts: { start: manifest.scripts.start },
    }),
  );
  for (const name of ['src', 'node_modules', 'drizzle'])
    symlinkSync(join(root, name), join(directory, name));
  const port = await freePort();
  const endpoint = `http://127.0.0.1:${String(port)}`;
  const setupToken = randomBytes(32).toString('hex');
  const sessionKey = randomBytes(32).toString('hex');
  writeFileSync(
    join(directory, '.env'),
    [
      'KINMESH_DATABASE=' + dbPath,
      'KINMESH_SETUP_TOKEN=' + setupToken,
      'KINMESH_SESSION_KEY=' + sessionKey,
      'KINMESH_PORT=' + String(port),
      'KINMESH_ORIGIN=' + endpoint,
    ].join('\n'),
    { mode: 0o600 },
  );
  const processes: {
    child: ChildProcess;
    closed: Promise<number | null>;
    output: () => string;
  }[] = [];
  function start(optIn = true, override?: string, fromProcessEnv = false) {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith('KINMESH_') && key !== 'NODE_OPTIONS',
      ),
    );
    if (optIn) env.KINMESH_INBOX_CONFIG = override ?? configPath;
    if (fromProcessEnv)
      Object.assign(env, {
        KINMESH_DATABASE: dbPath,
        KINMESH_SETUP_TOKEN: setupToken,
        KINMESH_SESSION_KEY: sessionKey,
        KINMESH_PORT: String(port),
        KINMESH_ORIGIN: endpoint,
      });
    const child = spawn('npm', ['--silent', 'start'], {
      cwd: directory,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-65536);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-65536);
    });
    const closed = new Promise<number | null>((done, reject) => {
      child.once('error', reject);
      child.once('close', (code) => {
        done(code);
      });
    });
    const runner = {
      child,
      closed,
      output: () => output,
      async ready() {
        await until(
          () => output,
          (s) => s.includes('Kinmesh Team Hub ready'),
        );
        assert.equal(await health(), 200);
      },
      hub() {
        assert.ok(child.pid);
        const found = descendants(child.pid).find((id) =>
          command(id).includes('src/server/main.ts'),
        );
        assert.ok(found, 'actual Node hub child exists');
        return found;
      },
      workers() {
        assert.ok(child.pid);
        return descendants(child.pid).filter((id) =>
          command(id).some((arg) => arg.endsWith('/src/inbox/main.ts')),
        );
      },
      async stop(signal: NodeJS.Signals = 'SIGTERM') {
        process.kill(this.hub(), signal);
        return await deadline(closed, WORKER_SHUTDOWN_MS + 12000);
      },
    };
    processes.push(runner);
    return runner;
  }
  async function health() {
    try {
      return (
        await fetch(endpoint + '/health', { signal: AbortSignal.timeout(1000) })
      ).status;
    } catch {
      return 0;
    }
  }
  return {
    directory,
    dbPath,
    configPath,
    endpoint,
    setupToken,
    sessionKey,
    port,
    start,
    health,
    async dispose() {
      for (const p of processes) {
        if (
          p.child.exitCode === null &&
          p.child.signalCode === null &&
          p.child.pid
        ) {
          try {
            process.kill(-p.child.pid, 'SIGKILL');
          } catch {
            /* Already exited. */
          }
        }
        await deadline(p.closed, 5000);
      }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
async function deadline<T>(promise: Promise<T>, ms: number) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_done, reject) => {
        timer = setTimeout(() => {
          reject(new Error('Process close deadline'));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

await test(
  'normal npm start without opt-in retains HTTP health/auth and creates no worker',
  { timeout: 25000 },
  async () => {
    const f = await fixture();
    try {
      const p = f.start(false);
      await p.ready();
      assert.deepEqual(p.workers(), []);
      assert.equal(p.output().includes('supervised Inbox'), false);
      assert.equal((await fetch(f.endpoint + '/api/me')).status, 401);
      assert.equal(
        (
          await fetch(f.endpoint + '/api/setup', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
        ).status,
        401,
      );
      assert.equal(await p.stop(), 0);
      assert.equal(await f.health(), 0);
    } finally {
      await f.dispose();
    }
  },
);

await test(
  'normal npm start uses validated process env without .env; missing secrets still fail closed',
  { timeout: 35000 },
  async () => {
    const f = await fixture();
    try {
      rmSync(join(f.directory, '.env'));
      const p = f.start(true, undefined, true);
      await p.ready();
      assert.ok(!p.output().includes(f.setupToken));
      assert.ok(!p.output().includes(f.sessionKey));
      assert.equal(p.workers().length, 1);
      assert.equal(await p.stop(), 0);
      assert.equal(await f.health(), 0);
      const invalid = f.start(false);
      assert.equal(await deadline(invalid.closed, 10000), 1);
      assert.equal(await f.health(), 0);
    } finally {
      await f.dispose();
    }
  },
);

await test(
  'without opt-in, a hub with agents connected from the workspace supervises its own worker for them',
  { timeout: 40000 },
  async () => {
    const seed = await inboxFixture();
    seed.store.managed.saveConnection(
      seed.principal,
      seed.teamId,
      'https://t3.test/mcp',
      'env-live',
    );
    const { token } = seed.store.managed.connect(
      seed.principal,
      seed.teamId,
      seed.agent.id,
      { providerId: 'isolated-dev', modelId: 'model-a' },
      WORKER_GRANT,
    );
    writeAgentToken(managedDirectory(seed.dbPath), seed.agent.id, token);
    const f = await fixture(seed.dbPath);
    try {
      const p = f.start(false);
      await p.ready();
      assert.equal(p.workers().length, 1);
      // The worker serves the connected agent: it reports liveness for it.
      await until(
        () => seed.store.inbox.liveness(seed.teamId).map((r) => r.agentId),
        (ids) => ids.includes(seed.agent.id),
      );
      assert.equal(await p.stop(), 0);
    } finally {
      await f.dispose();
      await seed.dispose();
    }
  },
);

await test(
  'opt-in npm start supervises actual worker; HTTP mention persists across child and parent restarts without T3',
  { timeout: 40000 },
  async () => {
    const seed = await inboxFixture();
    const f = await fixture(seed.dbPath);
    try {
      const p = f.start();
      await p.ready();
      assert.ok(
        p.output().includes('Kinmesh supervised Inbox worker running.'),
      );
      const workers = p.workers();
      assert.equal(workers.length, 1);
      const original = workers[0];
      assert.ok(original);
      const login = await fetch(f.endpoint + '/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: 'owner',
          password: 'a long owner test password',
        }),
      });
      assert.equal(login.status, 200);
      const cookie = login.headers.get('set-cookie')?.split(';')[0];
      assert.ok(cookie);
      const response = await fetch(
        f.endpoint + seed.channelPath + '/messages',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify(
            postInput({ mentions: [{ kind: 'agent', id: seed.agent.id }] }),
          ),
        },
      );
      assert.equal(response.status, 201);
      const message = Message.parse(await response.json());
      const row = seed.rows()[0];
      assert.ok(row);
      assert.equal(row.messageId, message.id);
      assert.equal(row.agentId, seed.agent.id);
      assert.equal(row.state, 'ready');
      assert.equal(row.generation, 0, 'empty bindings never dispatch');
      const killedAt = Date.now();
      process.kill(original, 'SIGKILL');
      await until(f.health, (status) => status === 503);
      const replacement = await until(
        () => p.workers(),
        (ids) => ids.length === 1 && ids[0] !== original,
      );
      assert.ok(
        Date.now() - killedAt >= 200,
        'bounded restart backoff is applied',
      );
      await until(
        () =>
          p.output().match(/supervised Inbox worker running\./g)?.length ?? 0,
        (count) => count === 2,
      );
      assert.equal(await f.health(), 200);
      assert.deepEqual(
        seed.rows()[0],
        row,
        'restart retains the exact pending Inbox delivery',
      );
      assert.equal(await p.stop(), 0);
      for (const id of replacement)
        await until(
          () => alive(id),
          (live) => !live,
        );
      const restarted = f.start();
      await restarted.ready();
      assert.deepEqual(
        seed.rows()[0],
        row,
        'normal parent restart retains pending delivery',
      );
      const nextWorker = restarted.workers()[0];
      assert.ok(nextWorker);
      assert.equal(await restarted.stop('SIGINT'), 0);
      await until(
        () => alive(nextWorker),
        (live) => !live,
      );
      assert.equal(seed.store.ready(), true);
    } finally {
      await f.dispose();
      await seed.dispose();
    }
  },
);

await test(
  'restart budget is finite even when each worker briefly becomes healthy',
  { timeout: 30000 },
  async () => {
    const f = await fixture();
    try {
      const p = f.start();
      await p.ready();
      for (let attempt = 0; attempt < 4; attempt++) {
        const id = p.workers()[0];
        assert.ok(id);
        process.kill(id, 'SIGKILL');
        if (attempt < 3) {
          await until(
            () =>
              p.output().match(/supervised Inbox worker running\./g)?.length ??
              0,
            (count) => count === attempt + 2,
          );
        }
      }
      assert.equal(await deadline(p.closed, 15000), 1);
      assert.ok(p.output().includes('restart budget exhausted'));
      assert.equal(await f.health(), 0);
      assert.deepEqual(p.workers(), []);
    } finally {
      await f.dispose();
    }
  },
);

await test(
  'invalid opt-in configuration fails before HTTP ready or child spawn and does not leak private input',
  { timeout: 40000 },
  async () => {
    const f = await fixture();
    try {
      const variants = [
        'missing',
        'public',
        'executable',
        'symlink',
        'wrong-db',
        'malformed',
        'fifo',
      ] as const;
      for (const variant of variants) {
        const path = join(f.directory, variant + '.json');
        if (variant === 'symlink') symlinkSync(f.configPath, path);
        else if (variant === 'fifo')
          execFileSync('mkfifo', ['-m', '600', path]);
        else if (variant !== 'missing')
          writeFileSync(
            path,
            variant === 'wrong-db'
              ? JSON.stringify({
                  database: join(f.directory, 'other.sqlite'),
                  bindings: [],
                })
              : variant === 'malformed'
                ? '{"private-fixture-marker":'
                : readFileSync(f.configPath),
            {
              mode:
                variant === 'public'
                  ? 0o644
                  : variant === 'executable'
                    ? 0o700
                    : 0o600,
            },
          );
        // File creation is filtered by umask; enforce the public-mode rejection case.
        if (variant === 'public') chmodSync(path, 0o644);
        const p = f.start(true, path);
        assert.equal(await deadline(p.closed, 10000), 1);
        assert.equal(p.output().includes('Team Hub ready'), false);
        assert.equal(p.output().includes('worker running'), false);
        assert.equal(p.output().includes('private-fixture-marker'), false);
        assert.equal(await f.health(), 0);
        assert.deepEqual(p.workers(), []);
      }
      assert.equal(
        existsSync(f.dbPath),
        false,
        'configuration rejected before database creation',
      );
      assert.equal(existsSync(join(f.directory, 'other.sqlite')), false);
    } finally {
      await f.dispose();
    }
  },
);

await test(
  'configuration is revalidated on restart; changed database never starts a replacement',
  { timeout: 25000 },
  async () => {
    const f = await fixture();
    try {
      const p = f.start();
      await p.ready();
      writeFileSync(
        f.configPath,
        JSON.stringify({
          database: join(f.directory, 'other.sqlite'),
          bindings: [],
        }),
      );
      const id = p.workers()[0];
      assert.ok(id);
      process.kill(id, 'SIGKILL');
      assert.equal(await deadline(p.closed, 15000), 1);
      assert.equal(
        p.output().match(/supervised Inbox worker running\./g)?.length,
        1,
      );
      assert.equal(existsSync(join(f.directory, 'other.sqlite')), false);
    } finally {
      await f.dispose();
    }
  },
);

await test(
  'HTTP bind failure cleans up the prepared worker before it can claim work',
  { timeout: 25000 },
  async () => {
    const seed = await inboxFixture();
    seed.comm.post(
      seed.principal,
      seed.teamId,
      seed.channelId,
      postInput({ mentions: [{ kind: 'agent', id: seed.agent.id }] }),
    );
    const original = seed.rows()[0];
    assert.ok(original);
    const f = await fixture(seed.dbPath);
    writeFileSync(f.configPath, JSON.stringify(seed.workerConfig));
    const listener = createServer();
    try {
      await new Promise<void>((done) => {
        listener.listen(f.port, '127.0.0.1', done);
      });
      const p = f.start();
      const seen = new Set<number>();
      const scanning = setInterval(() => {
        for (const id of p.workers()) seen.add(id);
      }, 20);
      try {
        assert.equal(await deadline(p.closed, 15000), 1);
        assert.equal(p.output().includes('Team Hub ready'), false);
        assert.equal(p.output().includes('worker running'), false);
        assert.ok(
          seen.size > 0,
          'real worker prepared before the occupied bind failed',
        );
        for (const id of seen)
          await until(
            () => alive(id),
            (live) => !live,
          );
        assert.deepEqual(
          seed.rows()[0],
          original,
          'not even a claim is allowed before bind',
        );
      } finally {
        clearInterval(scanning);
      }
    } finally {
      await new Promise<void>((done) => {
        listener.close(() => {
          done();
        });
      });
      await f.dispose();
      await seed.dispose();
    }
  },
);

await test(
  'shutdown forces a stopped worker after bounded grace; parent SIGKILL disconnect also stops its worker',
  { timeout: 40000 },
  async () => {
    const f = await fixture();
    const remaining = new Set<number>();
    try {
      const p = f.start();
      await p.ready();
      const worker = p.workers()[0];
      assert.ok(worker);
      remaining.add(worker);
      process.kill(worker, 'SIGSTOP');
      const began = Date.now();
      assert.equal(await p.stop(), 0);
      assert.ok(Date.now() - began >= WORKER_SHUTDOWN_MS - 100);
      await until(
        () => alive(worker),
        (live) => !live,
      );
      remaining.delete(worker);
      const restarted = f.start();
      await restarted.ready();
      const orphan = restarted.workers()[0];
      assert.ok(orphan);
      remaining.add(orphan);
      process.kill(restarted.hub(), 'SIGKILL');
      await deadline(restarted.closed, 15000);
      await until(
        () => alive(orphan),
        (live) => !live,
      );
      remaining.delete(orphan);
    } finally {
      for (const id of remaining) {
        try {
          process.kill(id, 'SIGKILL');
        } catch {
          /* Exited. */
        }
      }
      await f.dispose();
    }
  },
);

await test(
  'database inode is pinned across worker restarts, not just the configured pathname',
  { timeout: 25000 },
  async () => {
    const f = await fixture();
    try {
      const p = f.start();
      await p.ready();
      renameSync(f.dbPath, f.dbPath + '.retired');
      writeFileSync(f.dbPath, '', { mode: 0o600 });
      const id = p.workers()[0];
      assert.ok(id);
      process.kill(id, 'SIGKILL');
      assert.equal(await deadline(p.closed, 15000), 1);
      assert.equal(
        p.output().match(/supervised Inbox worker running\./g)?.length,
        1,
      );
      assert.equal(
        statSync(f.dbPath).size,
        0,
        'replacement database was never opened or migrated',
      );
    } finally {
      await f.dispose();
    }
  },
);

await test(
  'a child that cannot acknowledge readiness times out without HTTP readiness or an orphan',
  { timeout: 35000 },
  async () => {
    const f = await fixture();
    let stoppedWorker: number | undefined;
    try {
      const p = f.start();
      const ids = await until(
        () => p.workers(),
        (workers) => workers.length === 1,
      );
      stoppedWorker = ids[0];
      assert.ok(stoppedWorker);
      process.kill(stoppedWorker, 'SIGSTOP');
      assert.equal(await deadline(p.closed, 27000), 1);
      assert.equal(p.output().includes('Team Hub ready'), false);
      assert.equal(p.output().includes('worker running'), false);
      assert.equal(await f.health(), 0);
      await until(
        () => alive(stoppedWorker ?? 0),
        (live) => !live,
      );
      stoppedWorker = undefined;
    } finally {
      if (stoppedWorker !== undefined) {
        try {
          process.kill(stoppedWorker, 'SIGKILL');
        } catch {
          /* Exited. */
        }
      }
      await f.dispose();
    }
  },
);
