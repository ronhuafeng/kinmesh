import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';

/** A loopback port that was free a moment ago. */
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Port unavailable');
  await new Promise<void>((resolve, reject) =>
    server.close((e) => {
      if (e) reject(e);
      else resolve();
    }),
  );
  return address.port;
}

export function running(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

/** Signal a child and wait for it to exit, escalating to SIGKILL after the grace period. */
export async function stop(
  child: ChildProcess,
  signal: NodeJS.Signals = 'SIGTERM',
  graceMs = 5000,
): Promise<void> {
  if (!running(child)) return;
  const exited = once(child, 'exit');
  child.kill(signal);
  const graceful = await Promise.race([
    exited.then(() => true),
    delay(graceMs).then(() => false),
  ]);
  if (graceful) return;
  child.kill('SIGKILL');
  await exited;
}

/** Reject with `label` when `promise` does not settle within `ms`. */
export async function deadline<T>(
  promise: Promise<T>,
  ms: number,
  label = 'Process deadline',
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(label));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Fork a TypeScript fixture with only an IPC channel (its output is discarded). */
export function forkWorker(
  script: URL,
  args: string[] = [],
  env?: NodeJS.ProcessEnv,
): ChildProcess {
  return fork(script, args, {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    ...(env === undefined ? {} : { env }),
  });
}

/** The child's next IPC message; rejects if it exits first or the deadline passes. */
export function message(child: ChildProcess, ms = 10000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const settle = () => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
    };
    const onMessage = (value: unknown) => {
      settle();
      resolve(value);
    };
    const onExit = () => {
      settle();
      reject(new Error('Worker exited before its message'));
    };
    const timer = setTimeout(() => {
      settle();
      reject(new Error('Worker message deadline'));
    }, ms);
    child.once('message', onMessage);
    child.once('exit', onExit);
  });
}

/**
 * Drive claim-race workers: each reports `{ ready: true }`, all receive 'go'
 * together, and each replies `{ outcome }` then exits. Returns sorted outcomes.
 */
export async function race(children: ChildProcess[], ms: number) {
  const ready = await Promise.all(children.map((c) => message(c, ms)));
  for (const value of ready) z.object({ ready: z.literal(true) }).parse(value);
  const replies = children.map((c) => once(c, 'message'));
  const exits = children.map((c) => once(c, 'exit'));
  for (const c of children) c.send('go');
  const outcomes = (await deadline(Promise.all(replies), ms))
    .map(([value]: unknown[]) => z.object({ outcome: z.string() }).parse(value))
    .map((r) => r.outcome)
    .sort();
  await deadline(Promise.all(exits), ms);
  return outcomes;
}
