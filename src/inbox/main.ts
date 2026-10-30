import { loadWorkerConfig } from './config.js';
import { runWorker } from './worker.js';
import { t3Factory } from './t3.js';
import { openStore } from '../persistence/store.js';
process.umask(0o077);
let store: ReturnType<typeof openStore> | undefined;
try {
  const path = process.env.KINMESH_INBOX_CONFIG;
  if (!path) throw new Error('Missing configuration');
  const config = loadWorkerConfig(path);
  store = openStore(config.database);
  const stopping = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.once(signal, () => {
      stopping.abort();
    });
  if (process.argv[2] === 'status')
    console.info(JSON.stringify(store.inbox.status()));
  else if (process.argv[2] === 'resume' && process.argv[3]) {
    store.inbox.resume(process.argv[3]);
    console.info('Inbox delivery resumed with its existing intent.');
  } else if (process.argv.length === 2) {
    console.info('Kinmesh Inbox worker ready.');
    await runWorker(store, config, t3Factory(store), stopping.signal);
    console.info('Kinmesh Inbox worker stopped.');
  } else throw new Error('Invalid command');
} catch {
  console.error(
    'Inbox worker failed. Check private configuration, credentials and database availability.',
  );
  process.exitCode = 1;
} finally {
  store?.close();
}
