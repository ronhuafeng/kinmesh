import type { Database } from './database.js';
import { eq, and, gt, lte } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import * as tables from './schema.js';
import { digest } from './database.js';
import { LOGIN_STATE_MS } from '../domain/contracts.js';

/**
 * Sign-ins under way. The state travels to Feishu and back; the database
 * keeps its digest, and it is good for one return within ten minutes.
 */
export function loginRepository(d: Database) {
  const { q } = d;
  return {
    async begin(now: number) {
      const state = randomBytes(32).toString('base64url');
      await q()
        .delete(tables.loginStates)
        .where(lte(tables.loginStates.expiresAt, now));
      await q()
        .insert(tables.loginStates)
        .values({
          stateHash: digest(state),
          expiresAt: now + LOGIN_STATE_MS,
        });
      return state;
    },
    async finish(state: unknown, now: number) {
      if (typeof state !== 'string' || state === '') return false;
      return (
        (
          await q()
            .delete(tables.loginStates)
            .where(
              and(
                eq(tables.loginStates.stateHash, digest(state)),
                gt(tables.loginStates.expiresAt, now),
              ),
            )
        ).count === 1
      );
    },
  };
}
