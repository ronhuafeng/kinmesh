import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { openStore } from '../../src/persistence/store.js';
import { TeamId, ChannelId, TaskId } from '../../src/domain/contracts.js';
import { IdentityError } from '../../src/domain/agents.js';
const config = z
  .object({
    TASK_TEST_DATABASE: z.string(),
    TASK_TEST_TOKEN: z.string(),
    TASK_TEST_TEAM: TeamId,
    TASK_TEST_CHANNEL: ChannelId,
    TASK_TEST_TASK: TaskId,
  })
  .parse(process.env);
const store = await openStore(config.TASK_TEST_DATABASE);
async function claim() {
  let outcome: 'won' | 'conflict' | 'failed' = 'failed';
  try {
    const p = await store.agents.resolveToken(config.TASK_TEST_TOKEN);
    await store.tasks.command(
      p,
      config.TASK_TEST_TEAM,
      config.TASK_TEST_CHANNEL,
      config.TASK_TEST_TASK,
      { type: 'claim', operationKey: randomUUID(), expectedVersion: 1 },
    );
    outcome = 'won';
  } catch (error) {
    if (error instanceof IdentityError && error.statusCode === 409)
      outcome = 'conflict';
  }
  await store.close();
  process.send?.({ outcome }, () => {
    process.disconnect();
  });
}
process.on('message', (message: unknown) => {
  if (message === 'go') void claim();
});
process.send?.({ ready: true });
