import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { connectTeam, call } from '../team-mcp-helpers.js';
import { TaskResult } from '../../src/domain/tasks.js';
const c = z
  .object({
    TEAM_TEST_ENDPOINT: z.url(),
    TEAM_TEST_TOKEN: z.string(),
    TEAM_TEST_CHANNEL: z.uuid(),
    TEAM_TEST_TASK: z.uuid(),
  })
  .parse(process.env);
try {
  const { client } = await connectTeam(c.TEAM_TEST_ENDPOINT, c.TEAM_TEST_TOKEN);
  process.on('message', (message: unknown) => {
    if (message !== 'go') return;
    void (async () => {
      let outcome = 'failed';
      try {
        const result = await call(
          client,
          'team_task_claim',
          {
            channelId: c.TEAM_TEST_CHANNEL,
            taskId: c.TEAM_TEST_TASK,
            expectedVersion: 1,
            operationKey: randomUUID(),
          },
          TaskResult,
        );
        outcome = result.ok ? 'won' : result.error.code;
      } finally {
        await client.close();
        process.send?.({ outcome }, () => {
          process.disconnect();
        });
      }
    })().catch(() => {
      process.send?.({ outcome: 'failed' }, () => {
        process.disconnect();
      });
    });
  });
  process.send?.({ ready: true });
} catch {
  process.send?.({ outcome: 'failed' }, () => {
    process.disconnect();
  });
}
