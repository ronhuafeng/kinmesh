import { transactional } from './transactional.js';
import { and, eq, gt, sql } from 'drizzle-orm';
import { type HumanId } from '../domain/contracts.js';
import { NotifyHours, ChannelLevel } from '../domain/notify.js';
import * as s from './schema.js';
import { dbNow, together, type Database } from './database.js';

/**
 * How a person set Kinmesh to reach them: channels muted or followed, their
 * hours, their pause, and how soon what stays unread goes to Feishu.
 */
export function quietRepository(d: Database) {
  const { q, atomic } = transactional(d);

  return {
    /**
     * How the person set Kinmesh to reach them: channels they muted or
     * follow, how fast Feishu finds them, their hours and their pause.
     */
    async quiet(humanId: HumanId, teamId: string) {
      const [channels, member] = await together([
        q()
          .select({
            id: s.channelParticipants.channelId,
            level: s.channelParticipants.level,
          })
          .from(s.channelParticipants)
          .where(
            and(
              eq(s.channelParticipants.teamId, teamId),
              eq(s.channelParticipants.memberKey, 'human:' + humanId),
              eq(s.channelParticipants.state, 'joined'),
              sql`${s.channelParticipants.level} <> 'default'`,
            ),
          ),
        q()
          .select({
            pausedUntil: s.memberships.pausedUntil,
            forwardAfterMs: s.memberships.forwardAfterMs,
            notifyHours: s.memberships.notifyHours,
            now: dbNow,
          })
          .from(s.memberships)
          .where(
            and(
              eq(s.memberships.humanId, humanId),
              eq(s.memberships.teamId, teamId),
            ),
          )
          .limit(1),
      ]);
      const until = member[0]?.pausedUntil ?? null;
      const forward = member[0]?.forwardAfterMs ?? null;
      return {
        forwardAfter: forward === null ? null : forward / 60_000,
        hours: member[0]?.notifyHours
          ? NotifyHours.parse(JSON.parse(member[0].notifyHours))
          : null,
        levels: channels
          .map((c) => ({ channelId: c.id, level: ChannelLevel.parse(c.level) }))
          .sort((a, b) => (a.channelId < b.channelId ? -1 : 1)),
        pausedUntil:
          until !== null && until > Number(member[0]?.now)
            ? new Date(until).toISOString()
            : null,
      };
    },
    /** The hours notifications may reach the person; null: any time. */
    hours(humanId: HumanId, teamId: string, hours: NotifyHours | null) {
      return atomic(async () => {
        await q()
          .update(s.memberships)
          .set({ notifyHours: hours === null ? null : JSON.stringify(hours) })
          .where(
            and(
              eq(s.memberships.humanId, humanId),
              eq(s.memberships.teamId, teamId),
            ),
          );
      });
    },
    async hoursOf(humanId: string) {
      const row = (
        await q()
          .select({ hours: s.memberships.notifyHours })
          .from(s.memberships)
          .where(eq(s.memberships.humanId, humanId))
          .limit(1)
      )[0];
      return row?.hours ? NotifyHours.parse(JSON.parse(row.hours)) : null;
    },
    /** Until when a person paused, if they did and it hasn't ended. */
    async pausedUntilOf(humanId: string) {
      const row = (
        await q()
          .select({ until: s.memberships.pausedUntil })
          .from(s.memberships)
          .where(
            and(
              eq(s.memberships.humanId, humanId),
              gt(s.memberships.pausedUntil, dbNow),
            ),
          )
          .limit(1)
      )[0];
      return row?.until ?? null;
    },
    /** How long a notification may stay unread before it goes to Feishu. */
    forwardAfter(humanId: HumanId, teamId: string, minutes: number | null) {
      return atomic(async () => {
        await q()
          .update(s.memberships)
          .set({ forwardAfterMs: minutes === null ? null : minutes * 60_000 })
          .where(
            and(
              eq(s.memberships.humanId, humanId),
              eq(s.memberships.teamId, teamId),
            ),
          );
      });
    },
    /** Whether what stays unread goes to the person in Feishu. */
    async forwardsTo(humanId: string) {
      const row = (
        await q()
          .select({ after: s.memberships.forwardAfterMs })
          .from(s.memberships)
          .where(eq(s.memberships.humanId, humanId))
          .limit(1)
      )[0];
      return row?.after !== null && row?.after !== undefined;
    },
    /** Nothing notifies the person until `until` (null: from now on again). */
    pause(humanId: HumanId, teamId: string, until: number | null) {
      return atomic(async () => {
        await q()
          .update(s.memberships)
          .set({ pausedUntil: until })
          .where(
            and(
              eq(s.memberships.humanId, humanId),
              eq(s.memberships.teamId, teamId),
            ),
          );
      });
    },
  };
}
