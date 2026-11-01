import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openStore } from '../persistence/store.js';
import { InboxSupervisor } from './inbox-supervisor.js';
import { once } from 'node:events';

process.umask(0o077);
const stopping = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, () => {
    stopping.abort();
  });
let store: ReturnType<typeof openStore> | undefined;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let supervisor: InboxSupervisor | undefined;
stopping.signal.addEventListener(
  'abort',
  () => {
    void supervisor?.stop().catch(() => {
      process.exitCode = 1;
    });
  },
  { once: true },
);
try {
  const config = loadConfig(process.env);
  const path = process.env.KINMESH_INBOX_CONFIG;
  const fatal = () => {
    process.exitCode = 1;
    stopping.abort();
  };
  if (path !== undefined)
    supervisor = new InboxSupervisor(path, config.database, fatal);
  store = openStore(config.database);
  // Agents connected from the workspace need the hub's worker even without
  // an operator configuration; with none, no worker runs (ADR 0007).
  if (supervisor === undefined && store.managed.workerBindings().length > 0)
    supervisor = new InboxSupervisor(undefined, config.database, fatal);
  let starting: Promise<void> | undefined;
  const ensureWorker = () => {
    if (supervisor !== undefined || stopping.signal.aborted)
      return Promise.resolve();
    starting ??= (async () => {
      const started = new InboxSupervisor(undefined, config.database, fatal);
      // Visible to shutdown at once, so a stop during start cannot orphan it.
      supervisor = started;
      try {
        await started.prepare();
        await started.activate();
      } catch (error) {
        supervisor = undefined;
        await started.stop();
        starting = undefined;
        throw error;
      }
    })();
    return starting;
  };
  app = await createApp(
    config,
    store,
    () => !stopping.signal.aborted && (supervisor?.ready() ?? true),
    async () => {
      await supervisor?.stop();
    },
    { ensureWorker },
  );
  stopping.signal.throwIfAborted();
  await supervisor?.prepare();
  stopping.signal.throwIfAborted();
  await app.listen({ host: '127.0.0.1', port: config.port });
  stopping.signal.throwIfAborted();
  await supervisor?.activate();
  stopping.signal.throwIfAborted();
  console.info('Kinmesh Team Hub ready on configured loopback port.');
  await once(stopping.signal, 'abort');
} catch {
  if (!stopping.signal.aborted) {
    console.error(
      'Kinmesh startup failed. Check local configuration and database availability.',
    );
    process.exitCode = 1;
  }
} finally {
  try {
    // Abort pending startup handshakes/backoff immediately on a shutdown signal.
    await supervisor?.stop();
    await app?.close();
  } catch {
    console.error('Kinmesh shutdown failed. Check local process supervision.');
    process.exitCode = 1;
  } finally {
    store?.close();
  }
}
