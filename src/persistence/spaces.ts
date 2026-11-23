import type { inboxRepository } from './inbox.js';
import { eq } from 'drizzle-orm';
import * as s from './schema.js';
import { transactional } from './transactional.js';
import { type Database } from './database.js';
import { DomainError } from '../domain/errors.js';
import type { Claim } from '../domain/inbox.js';

/** Each channel's folder in the space, named once by the first delivery that needs it. */
export function spaceRepository(
  d: Database,
  inbox: ReturnType<typeof inboxRepository>,
) {
  const { q, atomic } = transactional(d);

  return {
    /**
     * The delivery's channel's folder in the space: `named` the first time,
     * the same folder ever after.
     */
    async space(c: Claim, named: string) {
      return atomic(async () => {
        await inbox.owned(c);
        await q()
          .insert(s.channelSpaces)
          .values({
            channelId: c.channelId,
            teamId: c.teamId,
            directory: named,
          })
          .onConflictDoNothing();
        const row = (
          await q()
            .select({ directory: s.channelSpaces.directory })
            .from(s.channelSpaces)
            .where(eq(s.channelSpaces.channelId, c.channelId))
            .limit(1)
        )[0];
        if (!row) throw new DomainError('conflict');
        return row.directory;
      });
    },
  };
}
