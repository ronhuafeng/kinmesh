import { loadWorkerConfig } from './config.js';
import { runWorker } from './worker.js';
import { t3Factory } from './t3.js';
import { openStore } from '../persistence/store.js';
import { once } from 'node:events';
import {
  databaseIdentity,
  Initialize,
  Run,
  WORKER_SHUTDOWN_MS,
  type WorkerEvent,
} from './lifecycle.js';
process.umask(0o077);
let store: ReturnType<typeof openStore> | undefined;
const stopping = new AbortController();
const supervised = process.send !== undefined;
let orphanDeadline: NodeJS.Timeout | undefined;
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, () => {
    stopping.abort();
  });
if (supervised)
  process.once('disconnect', () => {
    stopping.abort();
    orphanDeadline = setTimeout(() => {
      process.exit(1);
    }, WORKER_SHUTDOWN_MS);
    orphanDeadline.unref();
  });
if (supervised && !process.connected) stopping.abort();
async function notify(message: WorkerEvent) {
  await new Promise<void>((done, reject) => {
    if (!process.send || !process.connected) {
      reject(new Error('Parent unavailable'));
      return;
    }
    process.send(message, (error: Error | null) => {
      if (error) reject(new Error('Parent unavailable'));
      else done();
    });
  });
}
try {
  const initialize = supervised
    ? Initialize.parse(
        (await once(process, 'message', { signal: stopping.signal }))[0],
      )
    : undefined;
  const path = process.env.KINMESH_INBOX_CONFIG;
  if (!initialize && !path) throw new Error('Missing configuration');
  const config = initialize?.config ?? loadWorkerConfig(path ?? '');
  if (initialize) {
    const identity = databaseIdentity(config.database);
    if (
      JSON.stringify(identity.identity) !== JSON.stringify(initialize.identity)
    )
      throw new Error('Database changed');
  }
  stopping.signal.throwIfAborted();
  store = openStore(config.database);
  if (initialize) {
    const identity = databaseIdentity(config.database).identity;
    if (JSON.stringify(identity) !== JSON.stringify(initialize.identity))
      throw new Error('Database changed');
    // Install the command listener before notifying the parent; no claims before HTTP bind.
    const [run] = await Promise.all([
      once(process, 'message', { signal: stopping.signal }),
      notify({ type: 'inbox.prepared', identity }),
    ]);
    Run.parse(run[0]);
    stopping.signal.throwIfAborted();
  }
  if (process.argv[2] === 'status')
    console.info(JSON.stringify(store.inbox.status()));
  else if (process.argv[2] === 'resume' && process.argv[3]) {
    store.inbox.resume(process.argv[3]);
    console.info('Inbox delivery resumed with its existing intent.');
  } else if (process.argv.length === 2) {
    console.info('Kinmesh Inbox worker ready.');
    await runWorker(
      store,
      config,
      t3Factory(store),
      stopping.signal,
      initialize
        ? () => notify({ type: 'inbox.running', identity: initialize.identity })
        : undefined,
    );
    console.info('Kinmesh Inbox worker stopped.');
  } else throw new Error('Invalid command');
} catch {
  if (!stopping.signal.aborted) {
    console.error(
      'Inbox worker failed. Check private configuration, credentials and database availability.',
    );
    process.exitCode = 1;
  }
} finally {
  store?.close();
  clearTimeout(orphanDeadline);
  if (supervised && process.connected) process.disconnect();
}
