// Fixture transport only. The ordinary worker loop, repositories and T3Backend are production code.
import Database from 'better-sqlite3';
import { loadWorkerConfig } from '../../src/inbox/config.js';
import { runWorker } from '../../src/inbox/worker.js';
import { openStore } from '../../src/persistence/store.js';
import { T3Backend } from '../../src/adapters/t3/backend.js';
import { MockWire, envelope, options, reference } from '../t3-helpers.js';
import { assistantRead } from '../inbox-helpers.js';
import { loadAgentToken } from '../../src/team-mcp/client.js';
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
        if (name === 't3_thread_read' && process.argv[3] === 'prelinked-hold') {
          const id: unknown = counter
            .prepare(
              'SELECT id FROM agent_inbox WHERE reference IS NOT NULL AND task_id IS NOT NULL',
            )
            .pluck()
            .get();
          if (typeof id === 'string') {
            const row = store.inbox.get(id);
            const binding = config.bindings.find(
              (b) => b.agentId === row.agentId,
            );
            if (!binding || row.taskId === null)
              throw new Error('Missing fixture task');
            const principal = store.agents.resolveToken(
              loadAgentToken(binding.tokenFile),
            );
            const task = store.tasks.get(
              principal,
              row.teamId,
              row.channelId,
              row.taskId,
            );
            store.tasks.command(
              principal,
              row.teamId,
              row.channelId,
              row.taskId,
              {
                type: 'link-execution',
                operationKey: 'fixture-link:' + row.id,
                expectedVersion: task.version,
                reference,
                note: 'MOCK provider linked its current Run before returning',
              },
            );
            process.send?.('prelinked');
            await new Promise<never>(() => {
              /* SIGKILL after committed Team MCP-equivalent evidence, before Inbox ACK. */
            });
          }
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
