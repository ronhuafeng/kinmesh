import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

export async function port() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('PORT_UNAVAILABLE');
  await new Promise<void>((resolve, reject) =>
    server.close((e) => {
      if (e) reject(e);
      else resolve();
    }),
  );
  return address.port;
}

export class Process {
  child: ChildProcess | undefined;
  constructor(
    readonly command: string,
    readonly args: string[],
    readonly env: NodeJS.ProcessEnv,
    readonly log: string,
    readonly cwd = process.cwd(),
  ) {}
  start() {
    if (this.child?.exitCode === null && this.child.signalCode === null)
      throw new Error('PROCESS_ALREADY_RUNNING');
    const fd = openSync(this.log, 'a', 0o600);
    try {
      this.child = spawn(this.command, this.args, {
        env: this.env,
        cwd: this.cwd,
        detached: true,
        stdio: ['ignore', fd, fd],
      });
      this.child.on('error', () => {
        /* Readiness reports a bounded public failure. */
      });
    } finally {
      closeSync(fd);
    }
  }
  async stop(signal: NodeJS.Signals = 'SIGTERM') {
    const child = this.child;
    if (!child?.pid) return;
    const pid = child.pid;
    const alive = () => {
      // Darwin can return EPERM for signal 0 while a group is exiting.
      // A process table also lets us exclude zombies, which cannot execute.
      const members = execFileSync('ps', ['-axo', 'pgid=,uid=,stat='], {
        encoding: 'utf8',
      })
        .split('\n')
        .map((line) => line.trim().split(/\s+/))
        .filter(
          (fields) => Number(fields[0]) === pid && !fields[2]?.startsWith('Z'),
        );
      if (members.some((fields) => Number(fields[1]) !== process.getuid?.()))
        throw new Error('OWNED_PROCESS_GROUP_OWNER_CHANGED');
      return members.length > 0;
    };
    const kill = (requested: NodeJS.Signals) => {
      if (!alive()) return;
      try {
        process.kill(-pid, requested);
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          ['ESRCH', 'EPERM'].includes(String(error.code)) &&
          !alive()
        )
          return;
        throw new Error('OWNED_PROCESS_SIGNAL_FAILED');
      }
    };
    kill(signal);
    for (let i = 0; i < 100 && alive(); i++) await delay(100);
    kill('SIGKILL');
    await until(() => !alive(), 'OWNED_PROCESS_GROUP_SURVIVED', 5000);
  }
}

export async function until(
  check: () => boolean | Promise<boolean>,
  label: string,
  ms = 30_000,
) {
  const deadline = Date.now() + ms;
  do {
    if (await check()) return;
    await delay(250);
  } while (Date.now() < deadline);
  throw new Error(label);
}

export async function ready(origin: string) {
  await until(async () => {
    try {
      return (await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok;
    } catch {
      return false;
    }
  }, 'SERVICE_NOT_READY');
}
