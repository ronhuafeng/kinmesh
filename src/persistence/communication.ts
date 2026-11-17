import type { Database } from './database.js';
import { enqueueFact } from './inbox-enqueue.js';
import { notifyFact } from './notify.js';
import { ChannelLevel } from '../domain/notify.js';
import { transactional, snapshotPage, latestPage } from './transactional.js';
import { randomUUID } from 'node:crypto';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  getTableColumns,
  gte,
  inArray,
  isNotNull,
  lt,
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
import {
  principalAuthor as author,
  principalMember as member,
} from '../domain/tasks.js';
import {
  ChannelInput,
  ChannelLatest,
  ChannelView,
  CommunicationFact,
  Event,
  OutboxFact,
  Member,
  Message,
  MessageId,
  Mutation,
  type PageInput,
  Participant,
  ParticipantInput,
  PostInput,
  ReadInput,
  Topic,
  TopicId,
  TopicInput,
  memberKey,
} from '../domain/communication.js';
type ChannelId = z.infer<typeof ChannelId>;
const decode = (value: string): unknown => JSON.parse(value);
/** A message someone other than this person wrote. */
const notMine = (humanId: string) =>
  sql`NOT (${s.messages.author}::jsonb @> ${JSON.stringify({ kind: 'human', humanId })}::jsonb)`;
const now = () => new Date().toISOString();
export function communicationRepository(
  d: Database,
  agents: ReturnType<typeof agentRepository>,
) {
  const { q, atomic, receipt } = transactional(d);
  async function team(p: Principal, teamId: TeamId, write = false) {
    return write
      ? await agents.teamAccess(p, teamId, 'channels:read', 'channels:write')
      : await agents.teamAccess(p, teamId, 'channels:read');
  }
  // Asked once per read (`perRead`): the same caller, channel and need.
  const access = d.perRead(
    (
      p: Principal,
      teamId: TeamId,
      channelId: ChannelId,
      write?: boolean,
      inactive?: boolean,
    ) =>
      JSON.stringify([p, teamId, channelId, write ?? false, inactive ?? false]),
    (
      p: Principal,
      teamId: TeamId,
      channelId: ChannelId,
      write?: boolean,
      inactive?: boolean,
    ) => checkAccess(p, teamId, channelId, write ?? false, inactive ?? false),
  );
  async function checkAccess(
    p: Principal,
    teamId: TeamId,
    channelId: ChannelId,
    write: boolean,
    inactive: boolean,
  ) {
    await team(p, teamId, write);
    const channel = (
      await q()
        .select()
        .from(s.channels)
        .where(and(eq(s.channels.teamId, teamId), eq(s.channels.id, channelId)))
        .limit(1)
    )[0];
    const participant = (
      await q()
        .select()
        .from(s.channelParticipants)
        .where(
          and(
            eq(s.channelParticipants.channelId, channelId),
            eq(s.channelParticipants.memberKey, memberKey(member(p))),
          ),
        )
        .limit(1)
    )[0];
    if (
      channel === undefined ||
      participant === undefined ||
      participant.state === 'removed' ||
      (!inactive && participant.state !== 'joined')
    )
      throw new DomainError('not-found');
    return {
      channel: ChannelView.parse(channel),
      participant,
    };
  }
  /** A person of the team, joined to the channel when one is named. */
  async function person(p: Principal, teamId: TeamId, channelId?: ChannelId) {
    if (channelId !== undefined) await access(p, teamId, channelId, true);
    await agents.person(p, teamId);
  }
  async function participantView(
    teamId: TeamId,
    channelId: ChannelId,
    target: Member,
  ) {
    const row = (
      await q()
        .select()
        .from(s.channelParticipants)
        .where(
          and(
            eq(s.channelParticipants.channelId, channelId),
            eq(s.channelParticipants.memberKey, memberKey(target)),
          ),
        )
        .limit(1)
    )[0];
    if (row === undefined) throw new DomainError('not-found');
    return Participant.parse({
      channelId,
      teamId,
      member: target,
      state: row.state,
    });
  }
  async function validTarget(
    teamId: TeamId,
    channelId: ChannelId,
    target: Member,
    joined: boolean,
  ) {
    Member.parse(target);
    if (target.kind === 'human') {
      if (
        (
          await q()
            .select()
            .from(s.memberships)
            .where(
              and(
                eq(s.memberships.teamId, teamId),
                eq(s.memberships.humanId, target.id),
              ),
            )
            .limit(1)
        )[0] === undefined
      )
        throw new DomainError('not-found');
    } else {
      const agent = (
        await q()
          .select()
          .from(s.agents)
          .where(and(eq(s.agents.id, target.id), eq(s.agents.teamId, teamId)))
          .limit(1)
      )[0];
      if (agent?.lifecycle !== 'active') throw new DomainError('not-found');
    }
    if (
      joined &&
      (await participantView(teamId, channelId, target)).state !== 'joined'
    )
      throw new DomainError('not-found');
  }
  function mutation<T>(
    p: Principal,
    teamId: TeamId,
    target: string,
    kind: string,
    input: z.infer<typeof Mutation>,
    schema: z.ZodType<T>,
    effect: () => Promise<T>,
  ) {
    Mutation.parse({ operationKey: input.operationKey });
    const scope = JSON.stringify([teamId, memberKey(member(p)), target, kind]);
    return receipt(scope, input.operationKey, input, schema, effect);
  }

  async function fact(
    p: Principal,
    teamId: TeamId,
    channelId: ChannelId,
    operationKey: string,
    kind: z.infer<typeof CommunicationFact>['kind'],
    extra: Partial<z.infer<typeof CommunicationFact>> = {},
  ) {
    const value = CommunicationFact.parse({
      version: 1,
      id: randomUUID(),
      teamId,
      channelId,
      createdAt: now(),
      author: author(p),
      kind,
      operationKey,
      topicId: null,
      messageId: null,
      mentions: [],
      participant: null,
      participantState: null,
      sourceMessageId: null,
      sourceEventId: null,
      ...extra,
    });
    await q()
      .insert(s.communicationOutbox)
      .values({ id: value.id, channelId, fact: JSON.stringify(value) });
    await enqueueFact(q(), value);
    await notifyFact(q(), value);
  }
  async function topic(channelId: ChannelId, id: TopicId) {
    const row = (
      await q()
        .select()
        .from(s.topics)
        .where(and(eq(s.topics.id, id), eq(s.topics.channelId, channelId)))
        .limit(1)
    )[0];
    if (row === undefined) throw new DomainError('not-found');
    return topicOf(row);
  }
  /** Messages as read, each with its mentions: one more query for them all. */
  async function withMentions(rows: (typeof s.messages.$inferSelect)[]) {
    const mentions = new Map<string, Member[]>();
    if (rows.length > 0)
      for (const r of await q()
        .select({
          messageId: s.messageMentions.messageId,
          target: s.messageMentions.target,
        })
        .from(s.messageMentions)
        .where(
          inArray(
            s.messageMentions.messageId,
            rows.map((row) => row.id),
          ),
        )
        .orderBy(
          asc(s.messageMentions.messageId),
          asc(s.messageMentions.memberKey),
        ))
        mentions.set(r.messageId, [
          ...(mentions.get(r.messageId) ?? []),
          Member.parse(decode(r.target)),
        ]);
    return rows.map((row) =>
      Message.parse({
        ...row,
        author: decode(row.author),
        mentions: mentions.get(row.id) ?? [],
      }),
    );
  }
  async function message(channelId: ChannelId, id: MessageId) {
    const row = (
      await q()
        .select()
        .from(s.messages)
        .where(and(eq(s.messages.id, id), eq(s.messages.channelId, channelId)))
        .limit(1)
    )[0];
    if (row === undefined) throw new DomainError('not-found');
    const [found] = await withMentions([row]);
    if (found === undefined) throw new DomainError('not-found');
    return found;
  }
  const topicOf = (row: typeof s.topics.$inferSelect) =>
    Topic.parse({ ...row, author: decode(row.author) });
  const page = snapshotPage;
  const highest = (value: number | null | undefined) => value ?? 0;
  async function visibleEvent(
    p: Principal,
    teamId: TeamId,
    channelId: ChannelId,
    eventId: string,
  ) {
    const row = (
      await q()
        .select()
        .from(s.communicationOutbox)
        .where(
          and(
            eq(s.communicationOutbox.id, eventId),
            eq(s.communicationOutbox.channelId, channelId),
          ),
        )
        .limit(1)
    )[0];
    if (row === undefined) throw new DomainError('not-found');
    if (OutboxFact.parse(decode(row.fact)).kind === 'task.changed') {
      try {
        await agents.teamAccess(p, teamId, 'tasks:read');
      } catch (error) {
        if (error instanceof DomainError && error.kind === 'forbidden')
          throw new DomainError('not-found');
        throw error;
      }
    }
  }
  return {
    /** A newcomer joins the team's #general, as their own act. */
    async welcome(humanId: HumanId, teamId: TeamId) {
      const general = (
        await q()
          .select({
            id: s.channels.id,
            teamId: s.channels.teamId,
            name: s.channels.name,
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
    async validateCause(
      p: Principal,
      teamId: TeamId,
      channelId: ChannelId,
      messageId: string | null,
      eventId: string | null,
    ) {
      await access(p, teamId, channelId);
      if (messageId !== null)
        await message(channelId, MessageId.parse(messageId));
      if (eventId !== null) await visibleEvent(p, teamId, channelId, eventId);
    },
    createChannel(
      p: Principal,
      teamId: TeamId,
      input: z.infer<typeof ChannelInput>,
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
              ),
            )
            .orderBy(asc(s.channels.position))
            .limit(100)
        ).map((row) => ChannelView.parse(row));
      });
    },
    channels(p: Principal, teamId: TeamId, input: PageInput = {}) {
      return atomic(async () => {
        await team(p, teamId);
        const condition = and(
          eq(s.channels.teamId, teamId),
          eq(s.channelParticipants.memberKey, memberKey(member(p))),
          eq(s.channelParticipants.state, 'joined'),
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
        await access(p, teamId, channelId);
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
          .where(eq(s.messages.channelId, s.channels.id))
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
        return rows.map((r) =>
          ChannelLatest.parse({
            channelId: r.channelId,
            messageId: r.id,
            author: decode(r.author),
            excerpt: r.body.slice(0, 200),
            createdAt: r.createdAt,
            unread: r.unread,
          }),
        );
      });
    },
    channel(p: Principal, teamId: TeamId, channelId: ChannelId) {
      return atomic(async () => (await access(p, teamId, channelId)).channel);
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
        await access(p, teamId, channelId, true, true);
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
              .update(s.channelParticipants)
              .set({ state })
              .where(
                and(
                  eq(s.channelParticipants.channelId, channelId),
                  eq(s.channelParticipants.memberKey, memberKey(target)),
                ),
              );
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
    createTopic(
      p: Principal,
      teamId: TeamId,
      channelId: ChannelId,
      input: z.infer<typeof TopicInput>,
    ) {
      return atomic(async () => {
        await access(p, teamId, channelId, true);
        const data = TopicInput.parse(input);
        return mutation(
          p,
          teamId,
          channelId,
          'topic.create',
          data,
          Topic,
          async () => {
            const id = TopicId.parse(randomUUID());
            await q()
              .insert(s.topics)
              .values({
                id,
                channelId,
                title: data.title,
                author: JSON.stringify(author(p)),
                createdAt: now(),
              });
            await fact(
              p,
              teamId,
              channelId,
              data.operationKey,
              'topic.created',
              {
                topicId: id,
              },
            );
            return topic(channelId, id);
          },
        );
      });
    },
    topic(p: Principal, teamId: TeamId, channelId: ChannelId, id: TopicId) {
      return atomic(async () => {
        await access(p, teamId, channelId);
        return topic(channelId, id);
      });
    },
    topics(
      p: Principal,
      teamId: TeamId,
      channelId: ChannelId,
      input: PageInput = {},
    ) {
      return atomic(async () => {
        await access(p, teamId, channelId);
        return page(
          input,
          ['topics', teamId, channelId, memberKey(member(p))],
          Topic,
          async () =>
            highest(
              (
                await q()
                  .select({ value: max(s.topics.position) })
                  .from(s.topics)
                  .where(eq(s.topics.channelId, channelId))
                  .limit(1)
              )[0]?.value,
            ),
          async (after, maximum, limit) =>
            (
              await q()
                .select()
                .from(s.topics)
                .where(
                  and(
                    eq(s.topics.channelId, channelId),
                    gt(s.topics.position, after),
                    lte(s.topics.position, maximum),
                  ),
                )
                .orderBy(asc(s.topics.position))
                .limit(limit)
            ).map(topicOf),
        );
      });
    },
    /**
     * A channel's most recently active topics, newest first: the time of its
     * latest message, or of the topic itself before anyone wrote in it.
     */
    activeTopics(
      p: Principal,
      teamId: TeamId,
      channelId: ChannelId,
      limit: number,
    ) {
      return atomic(async () => {
        await access(p, teamId, channelId);
        const active = sql<string>`coalesce(max(${s.messages.createdAt}), ${s.topics.createdAt})`;
        const rows = await q()
          .select(getTableColumns(s.topics))
          .from(s.topics)
          .leftJoin(
            s.messages,
            and(
              eq(s.messages.topicId, s.topics.id),
              eq(s.messages.channelId, s.topics.channelId),
            ),
          )
          .where(eq(s.topics.channelId, channelId))
          // By the key, so every topic column may be read.
          .groupBy(s.topics.position)
          .orderBy(desc(active), desc(s.topics.position))
          .limit(limit + 1);
        return {
          items: rows.slice(0, limit).map(topicOf),
          more: rows.length > limit,
        };
      });
    },
    post(p: Principal, teamId: TeamId, channelId: ChannelId, input: PostInput) {
      return atomic(async () => {
        await access(p, teamId, channelId, true);
        const data = PostInput.parse(input);
        return mutation(
          p,
          teamId,
          channelId,
          'message.post',
          data,
          Message,
          async () => {
            if (data.topicId !== null) await topic(channelId, data.topicId);
            for (const target of data.mentions)
              await validTarget(teamId, channelId, target, true);
            if (data.sourceMessageId !== null)
              await message(channelId, data.sourceMessageId);
            if (data.sourceEventId !== null)
              await visibleEvent(p, teamId, channelId, data.sourceEventId);
            const id = MessageId.parse(randomUUID());
            await q()
              .insert(s.messages)
              .values({
                id,
                channelId,
                topicId: data.topicId,
                body: data.body,
                author: JSON.stringify(author(p)),
                createdAt: now(),
                sourceMessageId: data.sourceMessageId,
                sourceEventId: data.sourceEventId,
              });
            for (const target of data.mentions)
              await q()
                .insert(s.messageMentions)
                .values({
                  messageId: id,
                  channelId,
                  memberKey: memberKey(target),
                  target: JSON.stringify(target),
                });
            await fact(
              p,
              teamId,
              channelId,
              data.operationKey,
              'message.posted',
              {
                messageId: id,
                topicId: data.topicId,
                mentions: data.mentions,
                sourceMessageId: data.sourceMessageId,
                sourceEventId: data.sourceEventId,
              },
            );
            return message(channelId, id);
          },
        );
      });
    },
    message(p: Principal, teamId: TeamId, channelId: ChannelId, id: MessageId) {
      return atomic(async () => {
        await access(p, teamId, channelId);
        return message(channelId, id);
      });
    },
    /**
     * A channel's (or topic's) messages from the newest: the latest page,
     * then older pages by cursor (`latestPage`). `reach` widens the latest
     * page back through an older one, for a view that scrolled back.
     */
    history(
      p: Principal,
      teamId: TeamId,
      channelId: ChannelId,
      input: PageInput = {},
      topicId: TopicId | null = null,
      reach?: string,
    ) {
      return atomic(async () => {
        await access(p, teamId, channelId);
        if (topicId !== null) await topic(channelId, topicId);
        const condition = and(
          eq(s.messages.channelId, channelId),
          topicId === null ? undefined : eq(s.messages.topicId, topicId),
        );
        return latestPage(
          input,
          ['messages', teamId, channelId, topicId, memberKey(member(p))],
          Message,
          async (before, floor, limit) =>
            withMentions(
              await q()
                .select()
                .from(s.messages)
                .where(
                  and(
                    condition,
                    before === null
                      ? undefined
                      : lt(s.messages.position, before),
                    gte(s.messages.position, floor),
                  ),
                )
                .orderBy(desc(s.messages.position))
                .limit(limit),
            ),
          reach,
        );
      });
    },
    events(
      p: Principal,
      teamId: TeamId,
      channelId: ChannelId,
      input: PageInput = {},
    ) {
      return atomic(async () => {
        await access(p, teamId, channelId);
        let taskFacts = true;
        if (p.kind === 'agent') {
          try {
            await agents.teamAccess(p, teamId, 'tasks:read');
          } catch (error) {
            if (error instanceof DomainError && error.kind === 'forbidden')
              taskFacts = false;
            else throw error;
          }
        }
        const condition = and(
          eq(s.communicationOutbox.channelId, channelId),
          taskFacts
            ? undefined
            : sql`(${s.communicationOutbox.fact}::jsonb ->> 'kind') != 'task.changed'`,
        );
        return page(
          input,
          ['events', teamId, channelId, memberKey(member(p)), taskFacts],
          Event,
          async () =>
            highest(
              (
                await q()
                  .select({ value: max(s.communicationOutbox.position) })
                  .from(s.communicationOutbox)
                  .where(condition)
                  .limit(1)
              )[0]?.value,
            ),
          async (after, maximum, limit) =>
            (
              await q()
                .select()
                .from(s.communicationOutbox)
                .where(
                  and(
                    condition,
                    gt(s.communicationOutbox.position, after),
                    lte(s.communicationOutbox.position, maximum),
                  ),
                )
                .orderBy(asc(s.communicationOutbox.position))
                .limit(limit)
            ).map((r) =>
              Event.parse({ position: r.position, fact: decode(r.fact) }),
            ),
        );
      });
    },
  };
}
