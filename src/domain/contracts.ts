import { z } from 'zod';

export const HumanId = z.uuid().brand<'HumanId'>();
export const TeamId = z.uuid().brand<'TeamId'>();
export const ChannelId = z.uuid().brand<'ChannelId'>();
export const AgentId = z.uuid().brand<'AgentId'>();
export const TaskId = z.uuid().brand<'TaskId'>();
export type HumanId = z.infer<typeof HumanId>;
/** A session ends after 8 hours unused, and 7 days after sign-in regardless. */
export const SESSION_IDLE_MS = 8 * 60 * 60 * 1000;
export const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
/** Last-seen is written at most this often, so a request costs one lookup. */
export const SESSION_TOUCH_MS = 60 * 1000;
/**
 * A person is online while a session of theirs was used this recently; an
 * open workspace uses it at least every minute.
 */
export const PRESENCE_MS = 90 * 1000;
export type TeamId = z.infer<typeof TeamId>;
export type AgentId = z.infer<typeof AgentId>;
export type TaskId = z.infer<typeof TaskId>;
export const Human = z.strictObject({
  id: HumanId,
  username: z.string().min(3).max(64),
});
/**
 * A person as the workspace shows them: their name from Feishu, or their
 * handle until a sign-in brings one, and when their picture last changed.
 */
export const Person = Human.extend({
  name: z.string().min(1).max(80),
  avatar: z.iso.datetime().nullable(),
});
/** A name as Feishu gives it, as Kinmesh keeps it; null when there is none. */
export function personName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  // At most 80 UTF-16 units, never half of a character.
  const name = clean
    .slice(0, 80)
    .replace(/[\ud800-\udbff]$/, '')
    .trim();
  return name === '' ? null : name;
}
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
});
export const TeamName = z.string().trim().min(1).max(80);
/** A sign-in must come back from Feishu within ten minutes. */
export const LOGIN_STATE_MS = 10 * 60 * 1000;
