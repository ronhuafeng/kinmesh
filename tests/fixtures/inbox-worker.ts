// Fixture transport only. The ordinary worker loop, repositories and T3Backend are production code.
import Database from 'better-sqlite3';
import { loadWorkerConfig } from '../../src/inbox/config.js';
import { runWorker } from '../../src/inbox/worker.js';
import { openStore } from '../../src/persistence/store.js';
import { T3Backend } from '../../src/adapters/t3/backend.js';
import { MockWire, envelope, options, reference } from '../t3-helpers.js';
import { assistantRead } from '../inbox-helpers.js';
const config = loadWorkerConfig(process.argv[2] ?? '');
const store = openStore(config.database);
const counter = new Database(config.database);
counter.pragma('busy_timeout = 5000');
counter.exec(
  'CREATE TABLE IF NOT EXISTS fixture_native_launches (request_id TEXT PRIMARY KEY, transmissions INTEGER NOT NULL)',
);
const stopping = new AbortController();
for (const s of ['SIGTERM', 'SIGINT'])
  process.once(s, () => {
    stopping.abort();
  });
process.send?.('ready');
try {
  await runWorker(
    store,
    config,
    async () => {
      const wire = new MockWire();
      wire.values.t3_thread_read = assistantRead();
      wire.handler = async (name, args) => {
        if (name === 't3_thread_launch') {
          const id = args.clientRequestId;
          if (typeof id !== 'string') throw new Error('Missing native key');
          counter
            .prepare(
              'INSERT INTO fixture_native_launches VALUES (?,1) ON CONFLICT(request_id) DO UPDATE SET transmissions=transmissions+1',
            )
            .run(id);
          process.send?.('outbound');
          if (process.argv[3] === 'hold')
            await new Promise<never>(() => {
              /* Simulate native accepted effect with lost response. SIGKILL ends this process. */
            });
        }
        return envelope(wire.values[name]);
      };
      return {
        backend: await T3Backend.connect(wire, store.operations, options),
        identity: {
          endpoint: options.endpoint,
          environmentId: reference.environmentId,
          authority: options.authority,
        },
        close: async () => {
          await wire.close();
          process.send?.('attempt-finished');
        },
      };
    },
    stopping.signal,
  );
} finally {
  counter.close();
  store.close();
}
