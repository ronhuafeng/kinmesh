import { z } from 'zod';
import {
  TeamId,
  ChannelId,
  AgentId,
  HumanId,
  TaskId,
} from '../domain/contracts.js';
import { MessageId } from '../domain/communication.js';
import { TeamEndpoint } from './client.js';
/** Private disposable fixture metadata, not an authentication source for MCP requests. */
export const LiveContext = z.strictObject({
  version: z.literal(1),
  database: z.string(),
  endpoint: TeamEndpoint,
  humanId: HumanId,
  teamId: TeamId,
  channelId: ChannelId,
  agentId: AgentId,
  reviewerId: AgentId,
  taskId: TaskId,
  sourceMessageId: MessageId,
  tokenFile: z.string(),
});
