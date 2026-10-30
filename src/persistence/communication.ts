import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, gt, lte, max } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { z } from 'zod';
import * as s from './schema.js';
import type { agentRepository } from './agents.js';
import type { ChannelId, TeamId } from '../domain/contracts.js';
import { Author, IdentityError, type Principal } from '../domain/agents.js';
import {
  ChannelInput,
  ChannelView,
  CommunicationFact,
  Event,
  Member,
  Message,
  MessageId,
  Mutation,
  PageInput,
  Participant,
  ParticipantInput,
  PostInput,
  Topic,
  TopicId,
  TopicInput,
  memberKey,
  pageOf,
} from '../domain/communication.js';
type ChannelId = z.infer<typeof ChannelId>;
const decode = (value: string): unknown => JSON.parse(value);
const now = () => new Date().toISOString();
const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const Cursor = z
  .strictObject({
    v: z.literal(1),
    context: z.string().max(1024),
    after: z.number().int().nonnegative(),
    max: z.number().int().nonnegative(),
  })
  .refine((v) => v.after <= v.max);
function member(p: Principal): Member {
  return p.kind === 'human'
    ? { kind: 'human', id: p.humanId }
    : { kind: 'agent', id: p.agentId };
}
function author(p: Principal) {
  return Author.parse(
    p.kind === 'human'
      ? { kind: 'human', humanId: p.humanId }
      : { kind: 'agent', agentId: p.agentId, grantId: p.grantId },
  );
}
export function communicationRepository(
  db: BetterSQLite3Database<typeof s>,
  agents: ReturnType<typeof agentRepository>,
) {
  function atomic<T>(action: () => T) {
    try {
      return db.transaction(action, { behavior: 'immediate' });
    } catch (error) {
      const code = z.object({ code: z.string() }).safeParse(error);
      if (code.success && code.data.code.startsWith('SQLITE_CONSTRAINT'))
        throw new IdentityError(409);
      throw error;
    }
  }
  function team(p: Principal, teamId: TeamId, write = false) {
    agents.teamAccess(p, teamId, 'channels:read');
    return agents.teamAccess(
      p,
      teamId,
      write ? 'channels:write' : 'channels:read',
    );
  }
  function access(
    p: Principal,
    teamId: TeamId,
    channelId: ChannelId,
    write = false,
    inactive = false,
  ) {
    const role = team(p, teamId, write);
    const channel = db
      .select()
      .from(s.channels)
      .where(and(eq(s.channels.teamId, teamId), eq(s.channels.id, channelId)))
      .get();
    const participant = db
      .select()
      .from(s.channelParticipants)
      .where(
        and(
          eq(s.channelParticipants.channelId, channelId),
          eq(s.channelParticipants.memberKey, memberKey(member(p))),
        ),
      )
      .get();
    if (
      channel === undefined ||
      participant === undefined ||
      participant.state === 'removed' ||
      (!inactive && participant.state !== 'joined')
    )
      throw new IdentityError(404);
    return {
      channel: ChannelView.parse(channel),
      participant,
      role: role.role,
    };
  }
  function owner(p: Principal, teamId: TeamId, channelId?: ChannelId) {
    const role =
      channelId === undefined
        ? team(p, teamId, true).role
        : access(p, teamId, channelId, true).role;
    if (role !== 'owner' || p.kind !== 'human') throw new IdentityError(403);
  }
  function participantView(
    teamId: TeamId,
    channelId: ChannelId,
    target: Member,
  ) {
    const row = db
      .select()
      .from(s.channelParticipants)
      .where(
        and(
          eq(s.channelParticipants.channelId, channelId),
          eq(s.channelParticipants.memberKey, memberKey(target)),
        ),
      )
      .get();
    if (row === undefined) throw new IdentityError(404);
    return Participant.parse({
      channelId,
      teamId,
      member: target,
      state: row.state,
    });
  }
  function validTarget(
    teamId: TeamId,
    channelId: ChannelId,
    target: Member,
    joined: boolean,
  ) {
    Member.parse(target);
    if (target.kind === 'human') {
      if (
        db
          .select()
          .from(s.memberships)
          .where(
            and(
              eq(s.memberships.teamId, teamId),
              eq(s.memberships.humanId, target.id),
            ),
          )
          .get() === undefined
      )
        throw new IdentityError(404);
    } else {
      const agent = db
        .select()
        .from(s.agents)
        .where(and(eq(s.agents.id, target.id), eq(s.agents.teamId, teamId)))
        .get();
      if (agent?.lifecycle !== 'active') throw new IdentityError(404);
    }
    if (joined && participantView(teamId, channelId, target).state !== 'joined')
      throw new IdentityError(404);
  }
  function mutation<T>(
    p: Principal,
    teamId: TeamId,
    target: string,
    kind: string,
    input: z.infer<typeof Mutation>,
    schema: z.ZodType<T>,
    effect: () => T,
  ) {
    Mutation.parse({ operationKey: input.operationKey });
    const scope = JSON.stringify([teamId, memberKey(member(p)), target, kind]);
    const fingerprint = hash(input);
    const old = db
      .select()
      .from(s.communicationOperations)
      .where(
        and(
          eq(s.communicationOperations.scope, scope),
          eq(s.communicationOperations.operationKey, input.operationKey),
        ),
      )
      .get();
    if (old !== undefined) {
      if (old.fingerprint !== fingerprint) throw new IdentityError(409);
      return schema.parse(decode(old.result));
    }
    const result = schema.parse(effect());
    db.insert(s.communicationOperations)
      .values({
        scope,
        operationKey: input.operationKey,
        fingerprint,
        result: JSON.stringify(result),
      })
      .run();
    return result;
  }
  function fact(
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
    db.insert(s.communicationOutbox)
      .values({ id: value.id, channelId, fact: JSON.stringify(value) })
      .run();
  }
  function topic(channelId: ChannelId, id: TopicId) {
    const row = db
      .select()
      .from(s.topics)
      .where(and(eq(s.topics.id, id), eq(s.topics.channelId, channelId)))
      .get();
    if (row === undefined) throw new IdentityError(404);
    return Topic.parse({ ...row, author: decode(row.author) });
  }
  function message(channelId: ChannelId, id: MessageId) {
    const row = db
      .select()
      .from(s.messages)
      .where(and(eq(s.messages.id, id), eq(s.messages.channelId, channelId)))
      .get();
    if (row === undefined) throw new IdentityError(404);
    const mentions = db
      .select()
      .from(s.messageMentions)
      .where(eq(s.messageMentions.messageId, id))
      .orderBy(asc(s.messageMentions.memberKey))
      .all()
      .map((r) => Member.parse(decode(r.target)));
    return Message.parse({ ...row, author: decode(row.author), mentions });
  }
  function page<T extends { position: number }>(
    input: PageInput,
    context: unknown,
    schema: z.ZodType<T>,
    high: () => number,
    select: (after: number, max: number, limit: number) => T[],
  ) {
    const parsed = PageInput.parse(input);
    const binding = JSON.stringify(context);
    let after = 0;
    let maximum: number;
    if (parsed.cursor === undefined) maximum = high();
    else {
      try {
        const cursor = Cursor.parse(
          decode(Buffer.from(parsed.cursor, 'base64url').toString('utf8')),
        );
        if (cursor.context !== binding) throw new Error('Wrong cursor');
        after = cursor.after;
        maximum = cursor.max;
      } catch {
        throw new IdentityError(400);
      }
    }
    const rows = select(after, maximum, parsed.limit + 1);
    const items = rows.slice(0, parsed.limit);
    const last = items.at(-1);
    const nextCursor =
      rows.length > parsed.limit && last !== undefined
        ? Buffer.from(
            JSON.stringify({
              v: 1,
              context: binding,
              after: last.position,
              max: maximum,
            }),
          ).toString('base64url')
        : null;
    return pageOf(schema).parse({ items, nextCursor });
  }
  const highest = (value: number | null | undefined) => value ?? 0;
  return {
    createChannel(
      p: Principal,
      teamId: TeamId,
      input: z.infer<typeof ChannelInput>,
    ) {
      return atomic(() => {
        owner(p, teamId);
        const data = ChannelInput.parse(input);
        return mutation(
          p,
          teamId,
          teamId,
          'channel.create',
          data,
          ChannelView,
          () => {
            const position =
              highest(
                db
                  .select({ value: max(s.channels.position) })
                  .from(s.channels)
                  .get()?.value,
              ) + 1;
            const channel = ChannelView.parse({
              id: randomUUID(),
              teamId,
              name: data.name,
              position,
            });
            db.insert(s.channels).values(channel).run();
            const target = member(p);
            db.insert(s.channelParticipants)
              .values({
                channelId: channel.id,
                teamId,
                memberKey: memberKey(target),
                humanId: p.kind === 'human' ? p.humanId : null,
                agentId: null,
                state: 'joined',
              })
              .run();
            fact(p, teamId, channel.id, data.operationKey, 'channel.created');
            return channel;
          },
        );
      });
    },
    channels(p: Principal, teamId: TeamId, input: PageInput = {}) {
      return atomic(() => {
        team(p, teamId);
        const condition = and(
          eq(s.channels.teamId, teamId),
          eq(s.channelParticipants.memberKey, memberKey(member(p))),
          eq(s.channelParticipants.state, 'joined'),
        );
        return page(
          input,
          ['channels', teamId, memberKey(member(p))],
          ChannelView,
          () =>
            highest(
              db
                .select({ value: max(s.channels.position) })
                .from(s.channels)
                .innerJoin(
                  s.channelParticipants,
                  eq(s.channels.id, s.channelParticipants.channelId),
                )
                .where(condition)
                .get()?.value,
            ),
          (after, maximum, limit) =>
            db
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
              .all()
              .map((r) => ChannelView.parse(r)),
        );
      });
    },
    channel(p: Principal, teamId: TeamId, channelId: ChannelId) {
      return atomic(() => access(p, teamId, channelId).channel);
    },
    participant(p: Principal, teamId: TeamId, channelId: ChannelId) {
      return atomic(() => {
        access(p, teamId, channelId);
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
      return atomic(() => {
        access(p, teamId, channelId, true, true);
        const data = Mutation.parse(input);
        return mutation(p, teamId, channelId, action, data, Participant, () => {
          const target = member(p);
          const state = action === 'subscribe' ? 'joined' : 'left';
          db.update(s.channelParticipants)
            .set({ state })
            .where(
              and(
                eq(s.channelParticipants.channelId, channelId),
                eq(s.channelParticipants.memberKey, memberKey(target)),
              ),
            )
            .run();
          fact(p, teamId, channelId, data.operationKey, 'participant.changed', {
            participant: target,
            participantState: state,
          });
          return participantView(teamId, channelId, target);
        });
      });
    },
    enroll(
      p: Principal,
      teamId: TeamId,
      channelId: ChannelId,
      input: z.infer<typeof ParticipantInput>,
      action: 'invite' | 'remove',
    ) {
      return atomic(() => {
        owner(p, teamId, channelId);
        const data = ParticipantInput.parse(input);
        if (
          action === 'remove' &&
          memberKey(data.member) === memberKey(member(p))
        )
          throw new IdentityError(400);
        return mutation(p, teamId, channelId, action, data, Participant, () => {
          if (action === 'invite')
            validTarget(teamId, channelId, data.member, false);
          else participantView(teamId, channelId, data.member);
          const target = data.member;
          const state = action === 'invite' ? 'joined' : 'removed';
          db.insert(s.channelParticipants)
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
            })
            .run();
          fact(p, teamId, channelId, data.operationKey, 'participant.changed', {
            participant: target,
            participantState: state,
          });
          return participantView(teamId, channelId, target);
        });
      });
    },
    createTopic(
      p: Principal,
      teamId: TeamId,
      channelId: ChannelId,
      input: z.infer<typeof TopicInput>,
    ) {
      return atomic(() => {
        access(p, teamId, channelId, true);
        const data = TopicInput.parse(input);
        return mutation(
          p,
          teamId,
          channelId,
          'topic.create',
          data,
          Topic,
          () => {
            const id = TopicId.parse(randomUUID());
            db.insert(s.topics)
              .values({
                id,
                channelId,
                title: data.title,
                author: JSON.stringify(author(p)),
                createdAt: now(),
              })
              .run();
            fact(p, teamId, channelId, data.operationKey, 'topic.created', {
              topicId: id,
            });
            return topic(channelId, id);
          },
        );
      });
    },
    topic(p: Principal, teamId: TeamId, channelId: ChannelId, id: TopicId) {
      return atomic(() => {
        access(p, teamId, channelId);
        return topic(channelId, id);
      });
    },
    topics(
      p: Principal,
      teamId: TeamId,
      channelId: ChannelId,
      input: PageInput = {},
    ) {
      return atomic(() => {
        access(p, teamId, channelId);
        return page(
          input,
          ['topics', teamId, channelId, memberKey(member(p))],
          Topic,
          () =>
            highest(
              db
                .select({ value: max(s.topics.position) })
                .from(s.topics)
                .where(eq(s.topics.channelId, channelId))
                .get()?.value,
            ),
          (after, maximum, limit) =>
            db
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
              .all()
              .map((r) => topic(channelId, TopicId.parse(r.id))),
        );
      });
    },
    post(p: Principal, teamId: TeamId, channelId: ChannelId, input: PostInput) {
      return atomic(() => {
        access(p, teamId, channelId, true);
        const data = PostInput.parse(input);
        return mutation(
          p,
          teamId,
          channelId,
          'message.post',
          data,
          Message,
          () => {
            if (data.topicId !== null) topic(channelId, data.topicId);
            for (const target of data.mentions)
              validTarget(teamId, channelId, target, true);
            if (data.sourceMessageId !== null)
              message(channelId, data.sourceMessageId);
            if (
              data.sourceEventId !== null &&
              db
                .select()
                .from(s.communicationOutbox)
                .where(
                  and(
                    eq(s.communicationOutbox.id, data.sourceEventId),
                    eq(s.communicationOutbox.channelId, channelId),
                  ),
                )
                .get() === undefined
            )
              throw new IdentityError(404);
            const id = MessageId.parse(randomUUID());
            db.insert(s.messages)
              .values({
                id,
                channelId,
                topicId: data.topicId,
                body: data.body,
                author: JSON.stringify(author(p)),
                createdAt: now(),
                sourceMessageId: data.sourceMessageId,
                sourceEventId: data.sourceEventId,
              })
              .run();
            for (const target of data.mentions)
              db.insert(s.messageMentions)
                .values({
                  messageId: id,
                  channelId,
                  memberKey: memberKey(target),
                  target: JSON.stringify(target),
                })
                .run();
            fact(p, teamId, channelId, data.operationKey, 'message.posted', {
              messageId: id,
              topicId: data.topicId,
              mentions: data.mentions,
              sourceMessageId: data.sourceMessageId,
              sourceEventId: data.sourceEventId,
            });
            return message(channelId, id);
          },
        );
      });
    },
    message(p: Principal, teamId: TeamId, channelId: ChannelId, id: MessageId) {
      return atomic(() => {
        access(p, teamId, channelId);
        return message(channelId, id);
      });
    },
    history(
      p: Principal,
      teamId: TeamId,
      channelId: ChannelId,
      input: PageInput = {},
      topicId: TopicId | null = null,
    ) {
      return atomic(() => {
        access(p, teamId, channelId);
        if (topicId !== null) topic(channelId, topicId);
        const condition = and(
          eq(s.messages.channelId, channelId),
          topicId === null ? undefined : eq(s.messages.topicId, topicId),
        );
        return page(
          input,
          ['messages', teamId, channelId, topicId, memberKey(member(p))],
          Message,
          () =>
            highest(
              db
                .select({ value: max(s.messages.position) })
                .from(s.messages)
                .where(condition)
                .get()?.value,
            ),
          (after, maximum, limit) =>
            db
              .select({ id: s.messages.id })
              .from(s.messages)
              .where(
                and(
                  condition,
                  gt(s.messages.position, after),
                  lte(s.messages.position, maximum),
                ),
              )
              .orderBy(asc(s.messages.position))
              .limit(limit)
              .all()
              .map((r) => message(channelId, MessageId.parse(r.id))),
        );
      });
    },
    events(
      p: Principal,
      teamId: TeamId,
      channelId: ChannelId,
      input: PageInput = {},
    ) {
      return atomic(() => {
        access(p, teamId, channelId);
        return page(
          input,
          ['events', teamId, channelId, memberKey(member(p))],
          Event,
          () =>
            highest(
              db
                .select({ value: max(s.communicationOutbox.position) })
                .from(s.communicationOutbox)
                .where(eq(s.communicationOutbox.channelId, channelId))
                .get()?.value,
            ),
          (after, maximum, limit) =>
            db
              .select()
              .from(s.communicationOutbox)
              .where(
                and(
                  eq(s.communicationOutbox.channelId, channelId),
                  gt(s.communicationOutbox.position, after),
                  lte(s.communicationOutbox.position, maximum),
                ),
              )
              .orderBy(asc(s.communicationOutbox.position))
              .limit(limit)
              .all()
              .map((r) =>
                Event.parse({ position: r.position, fact: decode(r.fact) }),
              ),
        );
      });
    },
  };
}
