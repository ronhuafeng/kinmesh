import { fork, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadWorkerConfig } from '../inbox/config.js';
import {
  databaseIdentity,
  WorkerEvent,
  WORKER_SHUTDOWN_MS,
  type WorkerCommand,
} from '../inbox/lifecycle.js';

const STARTUP_MS = 10_000;
const RESTART_DELAYS = [250, 500, 1000] as const;
interface Child {
  process: ChildProcess;
  closed: Promise<void>;
  identity: ReturnType<typeof databaseIdentity>['identity'];
  stopping?: Promise<void>;
}

/** Process supervision only. Delivery policy and native execution stay in the worker/adapter. */
export class InboxSupervisor {
  private readonly stopping = new AbortController();
  private child: Child | undefined;
  private monitor: Promise<void> | undefined;
  private stopped: Promise<void> | undefined;
  private running = false;
  private databaseState: ReturnType<typeof databaseIdentity> | undefined;

  constructor(
    private readonly path: string,
    private readonly database: string,
    private readonly fatal: () => void,
  ) {
    this.configuration(); // Opt-in errors fail before a listener or child exists.
  }

  ready() {
    return this.running && !this.stopping.signal.aborted;
  }

  private isStopping() {
    return this.stopping.signal.aborted;
  }

  private configuration() {
    const config = loadWorkerConfig(this.path);
    if (resolve(config.database) !== resolve(this.database))
      throw new Error('Worker must use the hub database path');
    return config;
  }

  private async launch() {
    this.stopping.signal.throwIfAborted();
    const config = this.configuration();
    const currentDatabase = databaseIdentity(this.database);
    this.databaseState ??= currentDatabase;
    if (
      currentDatabase.database !== this.databaseState.database ||
      currentDatabase.identity.device !== this.databaseState.identity.device ||
      currentDatabase.identity.inode !== this.databaseState.identity.inode
    )
      throw new Error('Hub database identity changed');
    const { database, identity } = this.databaseState;
    const env = { ...process.env };
    delete env.KINMESH_SETUP_TOKEN;
    delete env.KINMESH_SESSION_KEY;
    delete env.NODE_OPTIONS;
    const source = import.meta.url.endsWith('.ts');
    const child = fork(
      new URL(
        source ? '../inbox/main.ts' : '../inbox/main.js',
        import.meta.url,
      ),
      [],
      {
        execArgv: source ? ['--import', 'tsx'] : [],
        env,
        // Child output is deliberately not forwarded: only validated IPC state is logged.
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      },
    );
    const record: Child = {
      process: child,
      identity,
      closed: new Promise<void>((done) => {
        child.once('close', () => {
          this.running = false;
          done();
        });
      }),
    };
    child.once('exit', () => {
      this.running = false;
    });
    // Always consume spawn/send errors, including outside a handshake.
    child.on('error', () => {
      /* Handshake/close handling owns the fixed diagnostic. */
    });
    this.child = record;
    await Promise.all([
      this.reply(record, 'inbox.prepared'),
      this.send(record, {
        type: 'inbox.initialize',
        config: { ...config, database },
        identity,
      }),
    ]);
    return record;
  }

  private send(record: Child, message: WorkerCommand) {
    return new Promise<void>((done, reject) => {
      record.process.send(message, (error) => {
        if (error) reject(new Error('Worker IPC unavailable'));
        else done();
      });
    });
  }

  private reply(record: Child, expected: WorkerEvent['type']) {
    return new Promise<void>((done, reject) => {
      const child = record.process;
      const finish = (ok: boolean) => {
        clearTimeout(timer);
        child.off('message', message);
        child.off('close', unavailable);
        child.off('error', unavailable);
        this.stopping.signal.removeEventListener('abort', unavailable);
        if (ok) done();
        else reject(new Error('Worker readiness unavailable'));
      };
      const unavailable = () => {
        finish(false);
      };
      const message = (value: unknown) => {
        const event = WorkerEvent.safeParse(value);
        finish(
          event.success &&
            event.data.type === expected &&
            event.data.identity.device === record.identity.device &&
            event.data.identity.inode === record.identity.inode,
        );
      };
      const timer = setTimeout(unavailable, STARTUP_MS);
      child.on('message', message);
      child.once('close', unavailable);
      child.once('error', unavailable);
      this.stopping.signal.addEventListener('abort', unavailable, {
        once: true,
      });
      if (
        this.stopping.signal.aborted ||
        child.exitCode !== null ||
        child.signalCode !== null
      )
        unavailable();
    });
  }

  async prepare() {
    await this.launch();
  }

  private async run(record: Child) {
    await Promise.all([
      this.reply(record, 'inbox.running'),
      this.send(record, { type: 'inbox.run' }),
    ]);
    this.stopping.signal.throwIfAborted();
    this.running = true;
    console.info('Kinmesh supervised Inbox worker running.');
  }

  async activate() {
    const child = this.child;
    if (!child) throw new Error('Worker was not prepared');
    await this.run(child);
    this.monitor = this.watch(child).catch(() => {
      this.running = false;
      if (!this.isStopping()) {
        console.error('Kinmesh Inbox supervision failed; hub stopping.');
        this.fatal();
      }
    });
  }

  private async watch(initial: Child) {
    let child = initial;
    let restarts = 0;
    while (!this.isStopping()) {
      await child.closed;
      if (this.isStopping()) return;
      console.error(
        'Kinmesh Inbox worker unavailable; bounded restart pending.',
      );
      let recovered = false;
      while (restarts < RESTART_DELAYS.length && !this.isStopping()) {
        const wait = RESTART_DELAYS[restarts++];
        try {
          await delay(wait, undefined, { signal: this.stopping.signal });
          child = await this.launch();
          await this.run(child);
          recovered = true;
          break;
        } catch {
          if (this.child) await this.stopChild(this.child);
        }
      }
      if (!recovered && !this.isStopping()) {
        console.error('Kinmesh Inbox restart budget exhausted; hub stopping.');
        this.fatal();
        return;
      }
    }
  }

  private async closedWithin(child: Child, ms: number) {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        child.closed.then(() => true),
        new Promise<false>((done) => {
          timer = setTimeout(() => {
            done(false);
          }, ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private stopChild(child: Child) {
    child.stopping ??= (async () => {
      child.process.kill('SIGTERM');
      if (await this.closedWithin(child, WORKER_SHUTDOWN_MS)) return;
      child.process.kill('SIGKILL');
      if (await this.closedWithin(child, 5000)) return;
      // Release IPC so the worker's own orphan deadline applies even if the OS kill failed.
      if (child.process.connected) child.process.disconnect();
      child.process.unref();
      throw new Error('Worker forced shutdown unavailable');
    })();
    return child.stopping;
  }

  stop() {
    this.stopped ??= (async () => {
      this.running = false;
      this.stopping.abort();
      if (this.child) await this.stopChild(this.child);
      await this.monitor;
    })();
    return this.stopped;
  }
}
