import { z } from 'zod';

export const HumanId = z.uuid().brand<'HumanId'>();
export const TeamId = z.uuid().brand<'TeamId'>();
export const ChannelId = z.uuid().brand<'ChannelId'>();
export const AgentId = z.uuid().brand<'AgentId'>();
export const TaskId = z.uuid().brand<'TaskId'>();
export type HumanId = z.infer<typeof HumanId>;
export type TeamId = z.infer<typeof TeamId>;
export type AgentId = z.infer<typeof AgentId>;
export type TaskId = z.infer<typeof TaskId>;
export type TransportCapability =
  { kind: 'external-mcp'; oauth: true } | { kind: 'host-cli'; localOnly: true };
export const Human = z.strictObject({
  id: HumanId,
  username: z.string().min(3).max(64),
});
export const Team = z.strictObject({
  id: TeamId,
  name: z.string().min(1).max(80),
});
export const Channel = z.strictObject({
  id: ChannelId,
  teamId: TeamId,
  name: z.string().min(1).max(80),
});
export const Membership = z.strictObject({
  humanId: HumanId,
  teamId: TeamId,
  role: z.enum(['owner', 'member']),
});
export const Credentials = z.strictObject({
  username: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,63}$/),
  password: z.string().min(15).max(128),
});
export const BootstrapInput = Credentials.extend({
  teamName: z.string().trim().min(1).max(80),
});
