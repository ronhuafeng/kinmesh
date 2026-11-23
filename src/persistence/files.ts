import type { Database } from './database.js';
import { transactional } from './transactional.js';
import { randomUUID } from 'node:crypto';
import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  sum,
  lt,
  sql,
} from 'drizzle-orm';
import { z } from 'zod';
import * as s from './schema.js';
import { type ChannelId, type TeamId } from '../domain/contracts.js';
import type { Principal } from '../domain/agents.js';
import { DomainError } from '../domain/errors.js';
import { AttachmentId, UNBOUND_KEEP_MS } from '../domain/attachments.js';
import { principalMember as member } from '../domain/tasks.js';
import {
  AttachmentRemoval,
  TeamFile,
  MessageId,
  Mutation,
  memberKey,
} from '../domain/communication.js';
import { escapeLike } from './channel-values.js';
import type { ChannelAccess } from './channel-access.js';
import type { Facts } from './facts.js';
import type { MessageViews } from './message-views.js';

type ChannelId = z.infer<typeof ChannelId>;
/**
 * Files people put in channels: uploaded within the team's room, read,
 * removed, swept when never posted, and their copies in a channel's folder.
 */
export function fileRepository(
  d: Database,
  gate: ChannelAccess,
  facts: Facts,
  views: MessageViews,
) {
  const { q, atomic } = transactional(d);
  const { team, access, mutation } = gate;
  const { fact } = facts;
  const { attachmentOf } = views;

  /**
   * The team's room counts bytes kept, each once: the same bytes again take
   * none. Refused when these would pass it.
   */
  async function fits(
    teamId: TeamId,
    file: { sha256: string; size: number },
    room: number,
  ) {
    const [known] = await q()
      .select({ id: s.attachments.id })
      .from(s.attachments)
      .where(
        and(
          eq(s.attachments.teamId, teamId),
          eq(s.attachments.sha256, file.sha256),
        ),
      )
      .limit(1);
    if (known !== undefined) return;
    const distinct = q()
      .selectDistinct({
        sha256: s.attachments.sha256,
        size: s.attachments.size,
      })
      .from(s.attachments)
      .where(eq(s.attachments.teamId, teamId))
      .as('kept');
    const used = Number(
      (
        await q()
          .select({ total: sum(distinct.size) })
          .from(distinct)
      )[0]?.total ?? 0,
    );
    if (used + file.size > room) throw new DomainError('too-large');
  }
  /** Only one transaction at a time keeps or lets go of the same bytes. */
  const holdBytes = (sha256: string) =>
    q().execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${sha256}, 0))`,
    );
  return {
    /**
     * Whether a person may upload these bytes to a channel they joined:
     * refused before anything is sent, as `upload` would refuse them.
     */
    mayUpload(
      p: Principal,
      teamId: TeamId,
      channelId: ChannelId,
      file: { sha256: string; size: number },
      room: number,
    ) {
      return atomic(async () => {
        await access(p, teamId, channelId, true);
        if (p.kind !== 'human') throw new DomainError('forbidden');
        await fits(teamId, file, room);
      });
    },
    /**
     * A person's upload to a joined channel: its description, kept once per
     * operation key (a retry gives the same one). Only once they may,
     * `bytes.describe` says what the uploaded bytes are and `bytes.keep`
     * keeps them, while no other transaction may let go of the same ones;
     * `room` is the team's total, refused when the file would pass it.
     */
    upload(
      p: Principal,
      teamId: TeamId,
      channelId: ChannelId,
      file: { operationKey: string; name: string; sha256: string },
      room: number,
      bytes: {
        describe: () => Promise<{
          type: string;
          size: number;
          width: number | null;
          height: number | null;
        }>;
        keep: () => Promise<void>;
      },
    ) {
      return atomic(async () => {
        await access(p, teamId, channelId, true);
        if (p.kind !== 'human') throw new DomainError('forbidden');
        const { operationKey } = Mutation.parse({
          operationKey: file.operationKey,
        });
        const kept = (
          await q()
            .select()
            .from(s.attachments)
            .where(
              and(
                eq(s.attachments.uploader, p.humanId),
                eq(s.attachments.channelId, channelId),
                eq(s.attachments.operationKey, operationKey),
              ),
            )
            .limit(1)
        )[0];
        if (kept !== undefined) {
          if (kept.sha256 !== file.sha256) throw new DomainError('conflict');
          return attachmentOf(kept);
        }
        await holdBytes(file.sha256);
        const described = { ...file, ...(await bytes.describe()) };
        await fits(teamId, described, room);
        const id = AttachmentId.parse(randomUUID());
        await q()
          .insert(s.attachments)
          .values({
            ...described,
            id,
            teamId,
            channelId,
            messageId: null,
            uploader: p.humanId,
            operationKey,
            createdAt: Date.now(),
          });
        await bytes.keep();
        const row = (
          await q()
            .select()
            .from(s.attachments)
            .where(eq(s.attachments.id, id))
            .limit(1)
        )[0];
        if (row === undefined) throw new DomainError('not-found');
        return attachmentOf(row);
      });
    },
    /**
     * A file to read, and where its bytes are: one of a message in a channel
     * the reader is joined to, or the reader's own upload not yet sent.
     * Anything else is not found, the same as unknown.
     */
    attachment(
      p: Principal,
      teamId: TeamId,
      channelId: ChannelId,
      id: AttachmentId,
    ) {
      return atomic(async () => {
        await access(p, teamId, channelId);
        const row = (
          await q()
            .select()
            .from(s.attachments)
            .where(
              and(
                eq(s.attachments.id, id),
                eq(s.attachments.channelId, channelId),
              ),
            )
            .limit(1)
        )[0];
        if (
          row === undefined ||
          (row.messageId === null &&
            !(p.kind === 'human' && p.humanId === row.uploader))
        )
          throw new DomainError('not-found');
        return { attachment: attachmentOf(row), sha256: row.sha256 };
      });
    },
    /**
     * Uploads no message took within a day go. Returns the bytes no
     * attachment refers to any more, to let go of with `release`.
     */
    sweepUnbound(now: number) {
      return atomic(async () => {
        const gone = await q()
          .delete(s.attachments)
          .where(
            and(
              isNull(s.attachments.messageId),
              lt(s.attachments.createdAt, now - UNBOUND_KEEP_MS),
            ),
          )
          .returning({ sha256: s.attachments.sha256 });
        return [...new Set(gone.map((row) => row.sha256))];
      });
    },
    /**
     * A person joined to the channel removes a file from its message: the
     * file goes (its bytes with `release` once nothing refers to them), the
     * audit keeps who and when, its copy in the channel's folder is queued
     * for removal, and a fact tells open views. Agents never can.
     */
    removeAttachment(
      p: Principal,
      teamId: TeamId,
      channelId: ChannelId,
      id: AttachmentId,
      input: { operationKey: string },
    ) {
      return atomic(async () => {
        await access(p, teamId, channelId, true);
        if (p.kind !== 'human') throw new DomainError('forbidden');
        const data = Mutation.parse(input);
        return mutation(
          p,
          teamId,
          `${channelId}/${id}`,
          'attachment.remove',
          data,
          AttachmentRemoval.extend({ sha256: z.string() }),
          async () => {
            const [row] = await q()
              .select()
              .from(s.attachments)
              .where(
                and(
                  eq(s.attachments.id, id),
                  eq(s.attachments.channelId, channelId),
                  isNotNull(s.attachments.messageId),
                ),
              )
              .limit(1);
            if (row?.messageId == null) throw new DomainError('not-found');
            const removedAt = Date.now();
            await q().delete(s.attachments).where(eq(s.attachments.id, id));
            await q().insert(s.attachmentRemovals).values({
              attachmentId: id,
              teamId,
              channelId,
              messageId: row.messageId,
              removedBy: p.humanId,
              removedAt,
            });
            const [space] = await q()
              .select({ directory: s.channelSpaces.directory })
              .from(s.channelSpaces)
              .where(eq(s.channelSpaces.channelId, channelId))
              .limit(1);
            if (space !== undefined)
              await q()
                .insert(s.attachmentUnplacings)
                .values({
                  attachmentId: id,
                  directory: space.directory,
                  createdAt: removedAt,
                })
                .onConflictDoNothing();
            await fact(
              p,
              teamId,
              channelId,
              data.operationKey,
              'attachment.removed',
              {
                messageId: MessageId.parse(row.messageId),
              },
            );
            return {
              attachmentId: id,
              messageId: MessageId.parse(row.messageId),
              removedBy: p.humanId,
              removedAt: new Date(removedAt).toISOString(),
              sha256: row.sha256,
            };
          },
        );
      });
    },
    /**
     * The files of every channel the person is joined to, newest first,
     * a page at a time (`before` is the last one's `createdAt`).
     */
    files(
      p: Principal,
      teamId: TeamId,
      before: number | null,
      limit = 50,
      /** One channel's files only; null for every channel the person is in. */
      channelId: ChannelId | null = null,
      /** Files whose name holds this, any case; null for all. */
      named: string | null = null,
    ) {
      return atomic(async () => {
        await team(p, teamId);
        // One channel's files are for whoever can read it, a public
        // channel's previewers too; every channel's are the person's own.
        if (channelId !== null) await access(p, teamId, channelId);
        const rows = await q()
          .select({ file: s.attachments })
          .from(s.attachments)
          .where(
            and(
              eq(s.attachments.teamId, teamId),
              isNotNull(s.attachments.messageId),
              before === null ? undefined : lt(s.attachments.createdAt, before),
              channelId === null
                ? inArray(
                    s.attachments.channelId,
                    q()
                      .select({ id: s.channelParticipants.channelId })
                      .from(s.channelParticipants)
                      .where(
                        and(
                          eq(
                            s.channelParticipants.memberKey,
                            memberKey(member(p)),
                          ),
                          eq(s.channelParticipants.state, 'joined'),
                        ),
                      ),
                  )
                : eq(s.attachments.channelId, channelId),
              named === null
                ? undefined
                : ilike(s.attachments.name, '%' + escapeLike(named) + '%'),
            ),
          )
          .orderBy(desc(s.attachments.createdAt), desc(s.attachments.id))
          .limit(limit + 1);
        const items = rows.slice(0, limit).map(({ file }) =>
          TeamFile.parse({
            attachment: attachmentOf(file),
            channelId: file.channelId,
            messageId: file.messageId,
            uploader: file.uploader,
            createdAt: new Date(file.createdAt).toISOString(),
          }),
        );
        const last = rows[limit - 1];
        return {
          items,
          next: rows.length > limit && last ? last.file.createdAt : null,
        };
      });
    },
    /** Removed files' copies still in a channel's folder. */
    unplacings(limit = 20) {
      return q()
        .select()
        .from(s.attachmentUnplacings)
        .orderBy(asc(s.attachmentUnplacings.createdAt))
        .limit(limit);
    },
    /** A removed file's copy is gone from its channel's folder. */
    async unplaced(attachmentId: string) {
      await q()
        .delete(s.attachmentUnplacings)
        .where(eq(s.attachmentUnplacings.attachmentId, attachmentId));
    },
    /** Lets go of bytes (`remove`) once no attachment refers to them. */
    release(sha256: string, remove: () => Promise<void>) {
      return atomic(async () => {
        await holdBytes(sha256);
        const [still] = await q()
          .select({ id: s.attachments.id })
          .from(s.attachments)
          .where(eq(s.attachments.sha256, sha256))
          .limit(1);
        if (still === undefined) await remove();
      });
    },
  };
}
