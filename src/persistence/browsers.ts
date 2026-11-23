import { transactional } from './transactional.js';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { SESSION_LIFETIME_MS, type HumanId } from '../domain/contracts.js';
import { PushSubscriptionInput } from '../domain/notify.js';
import * as s from './schema.js';
import { dbNow, digest, type Database } from './database.js';

/**
 * The browsers a person turned notifications on in, each tied to the session
 * it was turned on in: kept, renewed, and gone when the session ends.
 */
export function browserRepository(d: Database) {
  const { q, atomic } = transactional(d);

  /** The browsers a person turned notifications on in, whose session is still within its lifetime. */
  async function browsersOf(humanId: string) {
    return await q()
      .select({
        endpoint: s.pushSubscriptions.endpoint,
        p256dh: s.pushSubscriptions.p256dh,
        auth: s.pushSubscriptions.auth,
      })
      .from(s.pushSubscriptions)
      .innerJoin(
        s.sessions,
        eq(s.sessions.tokenHash, s.pushSubscriptions.sessionHash),
      )
      .where(
        and(
          eq(s.pushSubscriptions.humanId, humanId),
          isNull(s.sessions.revokedAt),
          gt(s.sessions.createdAt, sql`${dbNow} - ${SESSION_LIFETIME_MS}`),
        ),
      );
  }
  return {
    /**
     * This browser now notifies this person, held by the session it was
     * turned on in (taking it over from an earlier one, or from someone who
     * used the browser before).
     */
    subscribe(
      humanId: HumanId,
      session: string,
      input: z.infer<typeof PushSubscriptionInput>,
    ) {
      const { endpoint, keys } = PushSubscriptionInput.parse(input);
      const sessionHash = digest(session);
      return atomic(async () => {
        await q()
          .insert(s.pushSubscriptions)
          .values({
            endpoint,
            humanId,
            sessionHash,
            p256dh: keys.p256dh,
            auth: keys.auth,
            createdAt: dbNow,
          })
          .onConflictDoUpdate({
            target: s.pushSubscriptions.endpoint,
            set: {
              humanId,
              sessionHash,
              p256dh: keys.p256dh,
              auth: keys.auth,
              createdAt: dbNow,
            },
          });
      });
    },
    /**
     * A browser already notifying this person is held by this session now,
     * so it lasts as long as their newest sign-in on it. One that notifies
     * someone else, or nobody, is left as it is.
     */
    renew(humanId: HumanId, session: string, endpoint: string) {
      return atomic(async () => {
        await q()
          .update(s.pushSubscriptions)
          .set({ sessionHash: digest(session) })
          .where(
            and(
              eq(s.pushSubscriptions.endpoint, endpoint),
              eq(s.pushSubscriptions.humanId, humanId),
            ),
          );
      });
    },
    unsubscribe(humanId: HumanId, endpoint: string) {
      return atomic(async () => {
        await q()
          .delete(s.pushSubscriptions)
          .where(
            and(
              eq(s.pushSubscriptions.endpoint, endpoint),
              eq(s.pushSubscriptions.humanId, humanId),
            ),
          );
      });
    },
    /** Signing out of a session ends the notifications it turned on. */
    async signedOut(session: unknown) {
      if (typeof session !== 'string' || session === '') return;
      await q()
        .delete(s.pushSubscriptions)
        .where(eq(s.pushSubscriptions.sessionHash, digest(session)));
    },
    async signedOutEverywhere(humanId: HumanId) {
      await q()
        .delete(s.pushSubscriptions)
        .where(eq(s.pushSubscriptions.humanId, humanId));
    },
    /**
     * A person's browsers receiving notifications: a short id made from the
     * endpoint (which is a credential and never leaves the hub), the push
     * service's host, and when it was turned on.
     */
    async browserList(humanId: HumanId) {
      const rows = await browsersOf(humanId);
      const when = await q()
        .select({
          endpoint: s.pushSubscriptions.endpoint,
          createdAt: s.pushSubscriptions.createdAt,
        })
        .from(s.pushSubscriptions)
        .where(eq(s.pushSubscriptions.humanId, humanId));
      return rows.map((b) => ({
        id: digest(b.endpoint).slice(0, 16),
        service: new URL(b.endpoint).host,
        createdAt: new Date(
          when.find((w) => w.endpoint === b.endpoint)?.createdAt ?? 0,
        ).toISOString(),
      }));
    },
    /** Removes one of a person's browsers, by the id `browserList` gave it. */
    async forgetBrowser(humanId: HumanId, id: string) {
      const rows = await q()
        .select({ endpoint: s.pushSubscriptions.endpoint })
        .from(s.pushSubscriptions)
        .where(eq(s.pushSubscriptions.humanId, humanId));
      const row = rows.find((r) => digest(r.endpoint).slice(0, 16) === id);
      if (!row) return false;
      await q()
        .delete(s.pushSubscriptions)
        .where(eq(s.pushSubscriptions.endpoint, row.endpoint));
      return true;
    },
    /** A browser its push service no longer knows. */
    async gone(endpoint: string) {
      await q()
        .delete(s.pushSubscriptions)
        .where(eq(s.pushSubscriptions.endpoint, endpoint));
    },
    /** One of a person's browsers that receives notifications now, if it is. */
    async browser(humanId: HumanId, endpoint: string) {
      return (
        (await browsersOf(humanId)).find((b) => b.endpoint === endpoint) ?? null
      );
    },
    /** The browsers a person turned notifications on in, whose session is still within its lifetime. */
    browsers: (humanId: string) => browsersOf(humanId),
  };
}
