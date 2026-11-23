import type { Database } from './database.js';
import { messageText } from './attachments.js';
import { ChannelLevel } from '../domain/notify.js';
import { transactional } from './transactional.js';
import { randomUUID } from 'node:crypto';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  max,
  sql,
} from 'drizzle-orm';
import type { z } from 'zod';
import * as s from './schema.js';
import type { agentRepository } from './agents.js';
import {
  AgentId,
  HumanId,
  type ChannelId,
  type TeamId,
} from '../domain/contracts.js';
import type { Principal } from '../domain/agents.js';
import { DomainError } from '../domain/errors.js';
import { principalMember as member } from '../domain/tasks.js';
import type { Member, TopicId } from '../domain/communication.js';
import {
  ChannelInput,
  ChannelLatest,
  ChannelView,
  DirectChannel,
  DirectInput,
  MessageId,
  Mutation,
  type PageInput,
  Participant,
  ParticipantInput,
  VisibilityInput,
  ArchiveInput,
  ReadInput,
  RenameInput,
  memberKey,
} from '../domain/communication.js';
import { decode, notMine, page, highest } from './channel-values.js';
import type { ChannelAccess } from './channel-access.js';
import type { Facts } from './facts.js';

type ChannelId = z.infer<typeof ChannelId>;
/**
 * Channels and who is in them: made, named, opened up or archived, two
 * people's own conversations, joining, leaving and invitations, read
 * positions and how loud each is.
 */
export function channelRepository(
  d: Database,
  agents: ReturnType<typeof agentRepository>,
  gate: ChannelAccess,
  facts: Facts,
) {
  const { q, atomic } = transactional(d);
  const { team, access, person, participantView, validTarget, mutation } = gate;
  const { fact } = facts;

  return {
    /** A newcomer joins the team's #general, as their own act. */
    async welcome(humanId: HumanId, teamId: TeamId) {
      const general = (
        await q()
          .select({
            id: s.channels.id,
            teamId: s.channels.teamId,
            name: s.channels.name,
            visibility: s.channels.visibility,
            position: s.channels.position,
          })
          .from(s.channels)
          .where(
            and(eq(s.channels.teamId, teamId), eq(s.channels.name, 'general')),
          )
          .limit(1)
      )[0];
      if (general === undefined) return;
      const channelId = ChannelView.parse(general).id;
      const target = { kind: 'human' as const, id: humanId };
      await q()
        .insert(s.channelParticipants)
        .values({
          channelId,
          teamId,
          memberKey: memberKey(target),
          humanId,
          agentId: null,
          state: 'joined',
        })
        .onConflictDoNothing();
      await fact(
        { kind: 'human', humanId },
        teamId,
        channelId,
        `welcome.${humanId}`,
        'participant.changed',
        { participant: target, participantState: 'joined' },
      );
    },
    async validateParticipant(
      p: Principal,
      teamId: TeamId,
      channelId: ChannelId,
      target: Member,
    ) {
      await access(p, teamId, channelId);
      await validTarget(teamId, channelId, target, true);
    },
    /**
     * Two people's own conversation, opened by one of them from the other's
     * face: a private channel the two start in, made the first time and
     * found ever after. Opening it brings back the opener if they left.
     */
    direct(p: Principal, teamId: TeamId, input: z.infer<typeof DirectInput>) {
      return atomic(async () => {
        await person(p, teamId);
        if (p.kind !== 'human') throw new DomainError('forbidden');
        const data = DirectInput.parse(input);
        if (data.humanId === p.humanId) throw new DomainError('invalid');
        return mutation(
          p,
          teamId,
          'direct:' + data.humanId,
          'direct',
          data,
          ChannelView,
          async () => {
            const pair = [p.humanId, data.humanId];
            const people = await q()
              .select({
                id: s.humans.id,
                name: s.humans.name,
                username: s.humans.username,
              })
              .from(s.humans)
              .innerJoin(s.memberships, eq(s.memberships.humanId, s.humans.id))
              .where(
                and(
                  eq(s.memberships.teamId, teamId),
                  inArray(s.humans.id, pair),
                ),
              );
            if (people.length !== 2) throw new DomainError('not-found');
            const key = [...pair].sort().join(' ');
            const opener = { kind: 'human' as const, id: p.humanId };
            const join = async (channelId: ChannelId, target: Member) => {
              await q()
                .insert(s.channelParticipants)
                .values({
                  channelId,
                  teamId,
                  memberKey: memberKey(target),
                  humanId: target.id,
                  agentId: null,
                  state: 'joined',
                })
                .onConflictDoUpdate({
                  target: [
                    s.channelParticipants.channelId,
                    s.channelParticipants.memberKey,
                  ],
                  set: { state: 'joined' },
                });
              await fact(
                p,
                teamId,
                channelId,
                data.operationKey,
                'participant.changed',
                { participant: target, participantState: 'joined' },
              );
            };
            const [found] = await q()
              .select({
                id: s.channels.id,
                teamId: s.channels.teamId,
                name: s.channels.name,
                visibility: s.channels.visibility,
                position: s.channels.position,
              })
              .from(s.channels)
              .where(
                and(
                  eq(s.channels.teamId, teamId),
                  eq(s.channels.directKey, key),
                ),
              )
              .limit(1);
            if (found !== undefined) {
              const channel = ChannelView.parse(found);
              const mine = await participantView(teamId, channel.id, opener);
              if (mine.state !== 'joined') await join(channel.id, opener);
              return channel;
            }
            // Named for the two, as they are called now; the conversation
            // shows the other by their name as it changes.
            const called = people
              .sort((a, b) =>
                a.id === p.humanId ? -1 : b.id === p.humanId ? 1 : 0,
              )
              .map((h) => (h.name ?? h.username).slice(0, 38))
              .join('、');
            let name = called;
            for (let n = 2; ; n++) {
              const [taken] = await q()
                .select({ id: s.channels.id })
                .from(s.channels)
                .where(
                  and(eq(s.channels.teamId, teamId), eq(s.channels.name, name)),
                )
                .limit(1);
              if (taken === undefined) break;
              name = called + ' ' + String(n);
            }
            const position =
              highest(
                (
                  await q()
                    .select({ value: max(s.channels.position) })
                    .from(s.channels)
                    .limit(1)
                )[0]?.value,
              ) + 1;
            const channel = ChannelView.parse({
              id: randomUUID(),
              teamId,
              name,
              position,
              visibility: 'private',
            });
            await q()
              .insert(s.channels)
              .values({ ...channel, directKey: key });
            await q()
              .insert(s.channelParticipants)
              .values({
                channelId: channel.id,
                teamId,
                memberKey: memberKey(opener),
                humanId: p.humanId,
                agentId: null,
                state: 'joined',
              });
            await fact(
              p,
              teamId,
              channel.id,
              data.operationKey,
              'channel.created',
            );
            await join(channel.id, { kind: 'human', id: data.humanId });
            return channel;
          },
        );
      });
    },
    /** A person's own conversations with others, and who each is with. */
    directChannels(p: Principal, teamId: TeamId) {
      return atomic(async () => {
        await team(p, teamId);
        if (p.kind !== 'human') return [];
        const rows = await q()
          .select({ id: s.channels.id, key: s.channels.directKey })
          .from(s.channels)
          .innerJoin(
            s.channelParticipants,
            eq(s.channelParticipants.channelId, s.channels.id),
          )
          .where(
            and(
              eq(s.channels.teamId, teamId),
              isNotNull(s.channels.directKey),
              eq(s.channelParticipants.memberKey, memberKey(member(p))),
            ),
          )
          .limit(500);
        return rows.flatMap(({ id, key }) => {
          const other = key?.split(' ').find((h) => h !== p.humanId);
          return other === undefined
            ? []
            : [DirectChannel.parse({ channelId: id, humanId: other })];
        });
      });
    },
    createChannel(
      p: Principal,
      teamId: TeamId,
      input: z.input<typeof ChannelInput>,
    ) {
      return atomic(async () => {
        await person(p, teamId);
        const data = ChannelInput.parse(input);
        return mutation(
          p,
          teamId,
          teamId,
          'channel.create',
          data,
          ChannelView,
          async () => {
            const position =
              highest(
                (
                  await q()
                    .select({ value: max(s.channels.position) })
                    .from(s.channels)
                    .limit(1)
                )[0]?.value,
              ) + 1;
            const channel = ChannelView.parse({
              id: randomUUID(),
              teamId,
              name: data.name,
              position,
              visibility: data.visibility,
            });
            await q().insert(s.channels).values(channel);
            const target = member(p);
            await q()
              .insert(s.channelParticipants)
              .values({
                channelId: channel.id,
                teamId,
                memberKey: memberKey(target),
                humanId: p.kind === 'human' ? p.humanId : null,
                agentId: null,
                state: 'joined',
              });
            await fact(
              p,
              teamId,
              channel.id,
              data.operationKey,
              'channel.created',
            );
            return channel;
          },
        );
      });
    },
    /** The people joined to a channel the caller can read. */
    joinedHumans(p: Principal, teamId: TeamId, channelId: ChannelId) {
      return atomic(async () => {
        await access(p, teamId, channelId);
        return (
          await q()
            .select({ id: s.channelParticipants.humanId })
            .from(s.channelParticipants)
            .where(
              and(
                eq(s.channelParticipants.channelId, channelId),
                eq(s.channelParticipants.state, 'joined'),
                isNotNull(s.channelParticipants.humanId),
              ),
            )
            .limit(100)
        ).flatMap((row) => (row.id === null ? [] : [HumanId.parse(row.id)]));
      });
    },
    /** The active agents of the team joined to a channel the caller can read. */
    joinedAgents(p: Principal, teamId: TeamId, channelId: ChannelId) {
      return atomic(async () => {
        await access(p, teamId, channelId);
        return (
          await q()
            .select({ id: s.agents.id })
            .from(s.channelParticipants)
            .innerJoin(s.agents, eq(s.agents.id, s.channelParticipants.agentId))
            .where(
              and(
                eq(s.channelParticipants.channelId, channelId),
                eq(s.channelParticipants.state, 'joined'),
                eq(s.agents.teamId, teamId),
                eq(s.agents.lifecycle, 'active'),
              ),
            )
            .orderBy(asc(s.agents.id))
        ).map((row) => AgentId.parse(row.id));
      });
    },
    /** Channels the caller left themselves (never removed ones), to rejoin. */
    leftChannels(p: Principal, teamId: TeamId) {
      return atomic(async () => {
        await team(p, teamId);
        return (
          await q()
            .select({
              id: s.channels.id,
              teamId: s.channels.teamId,
              name: s.channels.name,
              visibility: s.channels.visibility,
              position: s.channels.position,
            })
            .from(s.channels)
            .innerJoin(
              s.channelParticipants,
              eq(s.channels.id, s.channelParticipants.channelId),
            )
            .where(
              and(
                eq(s.channels.teamId, teamId),
                eq(s.channelParticipants.memberKey, memberKey(member(p))),
                eq(s.channelParticipants.state, 'left'),
                isNull(s.channels.archivedAt),
              ),
            )
            .orderBy(asc(s.channels.position))
            .limit(100)
        ).map((row) => ChannelView.parse(row));
      });
    },
    /** Public channels the person has never joined, to look in and join. */
    publicChannels(p: Principal, teamId: TeamId) {
      return atomic(async () => {
        await team(p, teamId);
        if (p.kind !== 'human') return [];
        return (
          await q()
            .select({
              id: s.channels.id,
              teamId: s.channels.teamId,
              name: s.channels.name,
              visibility: s.channels.visibility,
              position: s.channels.position,
            })
            .from(s.channels)
            .leftJoin(
              s.channelParticipants,
              and(
                eq(s.channels.id, s.channelParticipants.channelId),
                eq(s.channelParticipants.memberKey, memberKey(member(p))),
              ),
            )
            .where(
              and(
                eq(s.channels.teamId, teamId),
                eq(s.channels.visibility, 'public'),
                isNull(s.channelParticipants.channelId),
                isNull(s.channels.archivedAt),
              ),
            )
            .orderBy(asc(s.channels.position))
            .limit(100)
        ).map((row) => ChannelView.parse(row));
      });
    },
    /**
     * A person in a channel names it again, on the record. Its folder in the
     * space keeps the name it was given first.
     */
    rename(
      p: Principal,
      teamId: TeamId,
      channelId: ChannelId,
      input: z.infer<typeof RenameInput>,
    ) {
      return atomic(async () => {
        await person(p, teamId, channelId);
        const data = RenameInput.parse(input);
        return mutation(
          p,
          teamId,
          channelId,
          'rename',
          data,
          ChannelView,
          async () => {
            const { channel, direct } = await access(
              p,
              teamId,
              channelId,
              true,
            );
            // Two people's own conversation is named by who it is with.
            if (direct !== null) throw new DomainError('conflict');
            if (channel.name === data.name) return channel;
            const taken = (
              await q()
                .select({ id: s.channels.id })
                .from(s.channels)
                .where(
                  and(
                    eq(s.channels.teamId, teamId),
                    eq(s.channels.name, data.name),
                  ),
                )
                .limit(1)
            )[0];
            if (taken) throw new DomainError('conflict');
            await q()
              .update(s.channels)
              .set({ name: data.name })
              .where(eq(s.channels.id, channelId));
            await fact(
              p,
              teamId,
              channelId,
              data.operationKey,
              'channel.changed',
              { name: data.name },
            );
            return ChannelView.parse({ ...channel, name: data.name });
          },
        );
      });
    },
    /**
     * A person in a channel archives it, or brings it back, on the record.
     * Archived, it leaves everyone's lists and takes nothing new; it is
     * still read and searched.
     */
    archive(
      p: Principal,
      teamId: TeamId,
      channelId: ChannelId,
      input: z.infer<typeof ArchiveInput>,
    ) {
      return atomic(async () => {
        await agents.person(p, teamId);
        const data = ArchiveInput.parse(input);
        return mutation(
          p,
          teamId,
          channelId,
          'archive',
          data,
          ChannelView,
          async () => {
            const { channel, participant, archived, direct } = await access(
              p,
              teamId,
              channelId,
            );
            if (participant?.state !== 'joined')
              throw new DomainError('not-found');
            if (direct !== null) throw new DomainError('conflict');
            if (archived !== data.archived) {
              await q()
                .update(s.channels)
                .set({ archivedAt: data.archived ? Date.now() : null })
                .where(eq(s.channels.id, channelId));
              await fact(
                p,
                teamId,
                channelId,
                data.operationKey,
                'channel.changed',
                { archived: data.archived },
              );
            }
            return channel;
          },
        );
      });
    },
    /** The archived channels the person is in, to open or bring back. */
    archivedChannels(p: Principal, teamId: TeamId) {
      return atomic(async () => {
        await team(p, teamId);
        return (
          await q()
            .select({
              id: s.channels.id,
              teamId: s.channels.teamId,
              name: s.channels.name,
              visibility: s.channels.visibility,
              position: s.channels.position,
            })
            .from(s.channels)
            .innerJoin(
              s.channelParticipants,
              eq(s.channels.id, s.channelParticipants.channelId),
            )
            .where(
              and(
                eq(s.channels.teamId, teamId),
                eq(s.channelParticipants.memberKey, memberKey(member(p))),
                eq(s.channelParticipants.state, 'joined'),
                isNotNull(s.channels.archivedAt),
              ),
            )
            .orderBy(asc(s.channels.position))
            .limit(100)
        ).map((row) => ChannelView.parse(row));
      });
    },
    /** Whether a channel the person can read is archived. */
    isArchived(p: Principal, teamId: TeamId, channelId: ChannelId) {
      return atomic(async () => (await access(p, teamId, channelId)).archived);
    },
    /** A person in a channel makes it public or private, on the record. */
    setVisibility(
      p: Principal,
      teamId: TeamId,
      channelId: ChannelId,
      input: z.infer<typeof VisibilityInput>,
    ) {
      return atomic(async () => {
        await person(p, teamId, channelId);
        const data = VisibilityInput.parse(input);
        return mutation(
          p,
          teamId,
          channelId,
          'visibility',
          data,
          ChannelView,
          async () => {
            const { channel, direct } = await access(
              p,
              teamId,
              channelId,
              true,
            );
            if (direct !== null) throw new DomainError('conflict');
            if (channel.visibility !== data.visibility) {
              await q()
                .update(s.channels)
                .set({ visibility: data.visibility })
                .where(eq(s.channels.id, channelId));
              await fact(
                p,
                teamId,
                channelId,
                data.operationKey,
                'channel.changed',
                { visibility: data.visibility },
              );
            }
            return ChannelView.parse({
              ...channel,
              visibility: data.visibility,
            });
          },
        );
      });
    },
    channels(p: Principal, teamId: TeamId, input: PageInput = {}) {
      return atomic(async () => {
        await team(p, teamId);
        const condition = and(
          eq(s.channels.teamId, teamId),
          eq(s.channelParticipants.memberKey, memberKey(member(p))),
          eq(s.channelParticipants.state, 'joined'),
          isNull(s.channels.archivedAt),
        );
        return page(
          input,
          ['channels', teamId, memberKey(member(p))],
          ChannelView,
          async () =>
            highest(
              (
                await q()
                  .select({ value: max(s.channels.position) })
                  .from(s.channels)
                  .innerJoin(
                    s.channelParticipants,
                    eq(s.channels.id, s.channelParticipants.channelId),
                  )
                  .where(condition)
                  .limit(1)
              )[0]?.value,
            ),
          async (after, maximum, limit) =>
            (
              await q()
                .select({
                  id: s.channels.id,
                  teamId: s.channels.teamId,
                  name: s.channels.name,
                  visibility: s.channels.visibility,
                  position: s.channels.position,
                })
                .from(s.channels)
                .innerJoin(
                  s.channelParticipants,
                  eq(s.channels.id, s.channelParticipants.channelId),
                )
                .where(
                  and(
                    condition,
                    gt(s.channels.position, after),
                    lte(s.channels.position, maximum),
                  ),
                )
                .orderBy(asc(s.channels.position))
                .limit(limit)
            ).map((r) => ChannelView.parse(r)),
        );
      });
    },
    /**
     * A person has seen the channel up to `messageId`. Reading the whole
     * channel moves their read position there; reading a topic moves it only
     * as far as everything unread before it is in that topic, so what they
     * haven't seen elsewhere stays unread. It never moves back, and moving
     * nowhere writes nothing (and so announces nothing).
     */
    read(
      p: Principal,
      teamId: TeamId,
      channelId: ChannelId,
      input: z.infer<typeof ReadInput>,
    ) {
      const { messageId, topicId } = ReadInput.parse(input);
      return atomic(async () => {
        if (p.kind !== 'human') throw new DomainError('forbidden');
        const { participant } = await access(p, teamId, channelId);
        // Read positions are for those who joined, not those looking in.
        if (participant?.state !== 'joined') throw new DomainError('not-found');
        const seen = (
          await q()
            .select({ position: s.messages.position })
            .from(s.messages)
            .where(
              and(
                eq(s.messages.channelId, channelId),
                eq(s.messages.id, messageId),
                topicId === null ? undefined : eq(s.messages.topicId, topicId),
              ),
            )
            .limit(1)
        )[0];
        if (seen === undefined) throw new DomainError('not-found');
        const from = participant.readPosition ?? 0;
        let to = seen.position;
        if (topicId !== null && to > from) {
          // The first message after the position, up to this one, that
          // someone else wrote outside the topic: reading stops before it.
          const elsewhere = (
            await q()
              .select({ position: s.messages.position })
              .from(s.messages)
              .where(
                and(
                  eq(s.messages.channelId, channelId),
                  gt(s.messages.position, from),
                  lte(s.messages.position, to),
                  sql`${s.messages.topicId} IS DISTINCT FROM ${topicId}`,
                  notMine(p.humanId),
                ),
              )
              .orderBy(asc(s.messages.position))
              .limit(1)
          )[0];
          if (elsewhere !== undefined) to = elsewhere.position - 1;
        }
        if (to <= from) return;
        await q()
          .update(s.channelParticipants)
          .set({ readPosition: to })
          .where(
            and(
              eq(s.channelParticipants.channelId, channelId),
              eq(s.channelParticipants.memberKey, memberKey(member(p))),
            ),
          );
      });
    },
    /** A person sets how loud a channel they are joined to is for them. */
    level(
      p: Principal,
      teamId: TeamId,
      channelId: ChannelId,
      level: ChannelLevel,
    ) {
      return atomic(async () => {
        if (p.kind !== 'human') throw new DomainError('forbidden');
        await access(p, teamId, channelId, true);
        await q()
          .update(s.channelParticipants)
          .set({ level: ChannelLevel.parse(level) })
          .where(
            and(
              eq(s.channelParticipants.channelId, channelId),
              eq(s.channelParticipants.memberKey, memberKey(member(p))),
            ),
          );
      });
    },
    /**
     * Where a person stopped reading a channel they joined: the first message
     * someone else wrote after their read position, in a topic or the whole
     * channel; null when nothing is unread, the channel is muted, or they
     * only look in.
     */
    firstUnread(
      p: Principal,
      teamId: TeamId,
      channelId: ChannelId,
      topicId: TopicId | null = null,
    ) {
      return atomic(async () => {
        if (p.kind !== 'human') return null;
        const { participant } = await access(p, teamId, channelId);
        if (participant?.state !== 'joined' || participant.level === 'mute')
          return null;
        const row = (
          await q()
            .select({ id: s.messages.id })
            .from(s.messages)
            .where(
              and(
                eq(s.messages.channelId, channelId),
                topicId === null ? undefined : eq(s.messages.topicId, topicId),
                gt(s.messages.position, participant.readPosition ?? 0),
                notMine(p.humanId),
              ),
            )
            .orderBy(asc(s.messages.position))
            .limit(1)
        )[0];
        return row ? MessageId.parse(row.id) : null;
      });
    },
    /** The newest message of each channel the person has joined. */
    latest(p: Principal, teamId: TeamId) {
      return atomic(async () => {
        await team(p, teamId);
        // Per joined channel, its newest message along its timeline index.
        const newest = q()
          .select({
            id: s.messages.id,
            author: s.messages.author,
            body: s.messages.body,
            createdAt: s.messages.createdAt,
          })
          .from(s.messages)
          .where(
            and(
              eq(s.messages.channelId, s.channels.id),
              isNull(s.messages.withdrawnAt),
            ),
          )
          .orderBy(desc(s.messages.position))
          .limit(1)
          .as('newest');
        // Someone else wrote after the person's read position.
        // A channel muted, or a message from an agent muted, never is.
        const unread =
          p.kind === 'human'
            ? sql<boolean>`(${s.channelParticipants.level} <> 'mute' AND EXISTS (SELECT 1 FROM ${s.messages} WHERE ${and(
                eq(s.messages.channelId, s.channels.id),
                sql`${s.messages.position} > COALESCE(${s.channelParticipants.readPosition}, 0)`,
                notMine(p.humanId),
              )}))`
            : sql<boolean>`false`;
        const rows = await q()
          .select({
            channelId: s.channels.id,
            id: newest.id,
            author: newest.author,
            body: newest.body,
            createdAt: newest.createdAt,
            unread,
          })
          .from(s.channels)
          .innerJoin(
            s.channelParticipants,
            eq(s.channelParticipants.channelId, s.channels.id),
          )
          .innerJoinLateral(newest, sql`true`)
          .where(
            and(
              eq(s.channels.teamId, teamId),
              eq(s.channelParticipants.memberKey, memberKey(member(p))),
              eq(s.channelParticipants.state, 'joined'),
            ),
          )
          .orderBy(s.channels.id);
        const latest = [];
        for (const r of rows)
          latest.push(
            ChannelLatest.parse({
              channelId: r.channelId,
              messageId: r.id,
              author: decode(r.author),
              excerpt: (await messageText(q(), r.id, r.body)).slice(0, 200),
              createdAt: r.createdAt,
              unread: r.unread,
            }),
          );
        return latest;
      });
    },
    channel(p: Principal, teamId: TeamId, channelId: ChannelId) {
      return atomic(async () => (await access(p, teamId, channelId)).channel);
    },
    /** A channel the caller is joined to, as anything written there needs. */
    joinedChannel(p: Principal, teamId: TeamId, channelId: ChannelId) {
      return atomic(async () => {
        // Read access, plus being in it: a task grant needs no channels:write.
        const { channel, participant } = await access(p, teamId, channelId);
        if (participant === null) throw new DomainError('not-found');
        return channel;
      });
    },
    participant(p: Principal, teamId: TeamId, channelId: ChannelId) {
      return atomic(async () => {
        await access(p, teamId, channelId);
        return participantView(teamId, channelId, member(p));
      });
    },
    membership(
      p: Principal,
      teamId: TeamId,
      channelId: ChannelId,
      input: z.infer<typeof Mutation>,
      action: 'subscribe' | 'leave',
    ) {
      return atomic(async () => {
        // Joining needs only seeing the channel: a channel you left, or a
        // public one you never joined. Leaving needs belonging to it.
        await access(p, teamId, channelId, action === 'leave', true);
        const data = Mutation.parse(input);
        return mutation(
          p,
          teamId,
          channelId,
          action,
          data,
          Participant,
          async () => {
            const target = member(p);
            const state = action === 'subscribe' ? 'joined' : 'left';
            await q()
              .insert(s.channelParticipants)
              .values({
                channelId,
                teamId,
                memberKey: memberKey(target),
                humanId: p.kind === 'human' ? p.humanId : null,
                agentId: p.kind === 'agent' ? p.agentId : null,
                state,
              })
              .onConflictDoUpdate({
                target: [
                  s.channelParticipants.channelId,
                  s.channelParticipants.memberKey,
                ],
                set: { state },
              });
            await fact(
              p,
              teamId,
              channelId,
              data.operationKey,
              'participant.changed',
              {
                participant: target,
                participantState: state,
              },
            );
            return participantView(teamId, channelId, target);
          },
        );
      });
    },
    enroll(
      p: Principal,
      teamId: TeamId,
      channelId: ChannelId,
      input: z.infer<typeof ParticipantInput>,
      action: 'invite' | 'remove',
    ) {
      return atomic(async () => {
        await person(p, teamId, channelId);
        const data = ParticipantInput.parse(input);
        if (
          action === 'remove' &&
          memberKey(data.member) === memberKey(member(p))
        )
          throw new DomainError('invalid');
        return mutation(
          p,
          teamId,
          channelId,
          action,
          data,
          Participant,
          async () => {
            // Two people's own conversation takes agents, never a third
            // person, and loses neither of the two.
            const { direct } = await access(p, teamId, channelId, true);
            if (
              direct !== null &&
              data.member.kind === 'human' &&
              (action === 'remove' || !direct.includes(data.member.id))
            )
              throw new DomainError('conflict');
            if (action === 'invite')
              await validTarget(teamId, channelId, data.member, false);
            else await participantView(teamId, channelId, data.member);
            const target = data.member;
            const state = action === 'invite' ? 'joined' : 'removed';
            await q()
              .insert(s.channelParticipants)
              .values({
                channelId,
                teamId,
                memberKey: memberKey(target),
                humanId: target.kind === 'human' ? target.id : null,
                agentId: target.kind === 'agent' ? target.id : null,
                state,
              })
              .onConflictDoUpdate({
                target: [
                  s.channelParticipants.channelId,
                  s.channelParticipants.memberKey,
                ],
                set: { state },
              });
            await fact(
              p,
              teamId,
              channelId,
              data.operationKey,
              'participant.changed',
              {
                participant: target,
                participantState: state,
              },
            );
            return participantView(teamId, channelId, target);
          },
        );
      });
    },
  };
}
