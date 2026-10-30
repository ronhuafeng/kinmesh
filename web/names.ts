import type { z } from 'zod';
import type { Author } from '../src/domain/agents.js';
import type { WorkspaceSnapshot } from '../src/workspace/contracts.js';
export function authorName(
  author: z.infer<typeof Author>,
  data: WorkspaceSnapshot,
) {
  if (author.kind === 'human')
    return author.humanId === data.human.id
      ? data.human.username
      : 'Human member';
  const id = author.agentId;
  return data.agents.find((agent) => agent.id === id)?.name ?? 'Agent member';
}
