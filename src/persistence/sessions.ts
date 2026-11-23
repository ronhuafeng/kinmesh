import type { Database } from './database.js';
import { eq, and, gt, isNull } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import * as tables from './schema.js';
import { digest } from './database.js';
import {
  HumanId,
  SESSION_IDLE_MS,
  SESSION_LIFETIME_MS,
  SESSION_TOUCH_MS,
} from '../domain/contracts.js';

/**
 * Signed-in browsers. A session is a random token held only in the
 * encrypted cookie; the database keeps its digest.
 */
export function sessionRepository(d: Database) {
  const { q } = d;
  return {
    async open(humanId: HumanId, now: number) {
      const token = randomBytes(32).toString('base64url');
      await q()
        .insert(tables.sessions)
        .values({
          tokenHash: digest(token),
          humanId,
          createdAt: now,
          lastSeenAt: now,
        });
      return token;
    },
    /** The person a live session belongs to; undefined once it has ended. */
    async resolve(token: unknown, now: number) {
      if (typeof token !== 'string' || token === '') return undefined;
      const row = (
        await q()
          .select()
          .from(tables.sessions)
          .where(eq(tables.sessions.tokenHash, digest(token)))
          .limit(1)
      )[0];
      if (row === undefined) return undefined;
      if (
        row.revokedAt !== null ||
        now - row.lastSeenAt > SESSION_IDLE_MS ||
        now - row.createdAt > SESSION_LIFETIME_MS
      )
        return undefined;
      if (now - row.lastSeenAt >= SESSION_TOUCH_MS)
        await q()
          .update(tables.sessions)
          .set({ lastSeenAt: now })
          .where(eq(tables.sessions.tokenHash, row.tokenHash));
      return HumanId.parse(row.humanId);
    },
    async revoke(token: unknown, now: number) {
      if (typeof token !== 'string' || token === '') return;
      await q()
        .update(tables.sessions)
        .set({ revokedAt: now })
        .where(eq(tables.sessions.tokenHash, digest(token)));
    },
    /**
     * A person's sessions that still let them in, newest use first,
     * each named by a short id made from its stored hash (never the
     * token or the hash itself), and whether it is the one asking.
     */
    async list(humanId: HumanId, token: unknown, now: number) {
      const rows = await q()
        .select()
        .from(tables.sessions)
        .where(
          and(
            eq(tables.sessions.humanId, humanId),
            isNull(tables.sessions.revokedAt),
            gt(tables.sessions.lastSeenAt, now - SESSION_IDLE_MS),
            gt(tables.sessions.createdAt, now - SESSION_LIFETIME_MS),
          ),
        );
      const current =
        typeof token === 'string' && token !== '' ? digest(token) : null;
      return rows
        .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
        .map((row) => ({
          id: digest(row.tokenHash).slice(0, 16),
          current: row.tokenHash === current,
          createdAt: new Date(row.createdAt).toISOString(),
          lastSeenAt: new Date(row.lastSeenAt).toISOString(),
        }));
    },
    /** Ends one of a person's sessions, by the id `list` gave it. */
    async end(humanId: HumanId, id: string, now: number) {
      const rows = await q()
        .select({ tokenHash: tables.sessions.tokenHash })
        .from(tables.sessions)
        .where(
          and(
            eq(tables.sessions.humanId, humanId),
            isNull(tables.sessions.revokedAt),
          ),
        );
      const row = rows.find((r) => digest(r.tokenHash).slice(0, 16) === id);
      if (!row) return false;
      await q()
        .update(tables.sessions)
        .set({ revokedAt: now })
        .where(eq(tables.sessions.tokenHash, row.tokenHash));
      return true;
    },
    /** What a person's own page shows of them, from Feishu. */
    async profile(humanId: HumanId) {
      const row = (
        await q()
          .select({
            username: tables.humans.username,
            name: tables.humans.name,
            email: tables.humans.email,
          })
          .from(tables.humans)
          .where(eq(tables.humans.id, humanId))
          .limit(1)
      )[0];
      return row ?? null;
    },
    /** Every session of one person, as on "Sign out everywhere". */
    async revokeAll(humanId: HumanId, now: number) {
      await q()
        .update(tables.sessions)
        .set({ revokedAt: now })
        .where(
          and(
            eq(tables.sessions.humanId, humanId),
            isNull(tables.sessions.revokedAt),
          ),
        );
    },
  };
}
