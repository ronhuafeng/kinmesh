import { randomUUID } from 'node:crypto';
import { and, eq, gt, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { OutboxFact } from '../domain/communication.js';
import { Author } from '../domain/agents.js';
import { SESSION_LIFETIME_MS, type HumanId } from '../domain/contracts.js';
import {
  NOTIFY_DELAY_MS,
  NotifyHours,
  PushSubscriptionInput,
  ChannelLevel,
  interrupts,
  type NotificationKind,
} from '../domain/notify.js';
import { actingMember } from '../domain/tasks.js';
import * as s from './schema.js';
import {
  dbNow,
  digest,
  together,
  type Database,
  type Query,
} from './database.js';

/** The person whose act started a causal chain, if a person's did. */
async function rootPerson(db: Query, eventId: string | null) {
  if (eventId === null) return null;
  const row = (
    await db
      .select({ fact: s.communicationOutbox.fact })
      .from(s.inboxCauses)
      .innerJoin(
        s.communicationOutbox,
        eq(s.communicationOutbox.id, s.inboxCauses.rootId),
      )
      .where(eq(s.inboxCauses.eventId, eventId))
      .limit(1)
  )[0];
  if (row === undefined) return null;
  const author = OutboxFact.parse(JSON.parse(row.fact)).author;
  return author.kind === 'human' ? author.humanId : null;
}
/** The people joined to a channel, with what notifies each. */
async function joinedPeople(db: Query, teamId: string, channelId: string) {
  return await db
    .select({
      humanId: s.channelParticipants.humanId,
      level: s.channelParticipants.level,
      forwardAfterMs: s.memberships.forwardAfterMs,
    })
    .from(s.channelParticipants)
    .innerJoin(
      s.memberships,
      and(
        eq(s.memberships.humanId, s.channelParticipants.humanId),
        eq(s.memberships.teamId, s.channelParticipants.teamId),
      ),
    )
    .where(
      and(
        eq(s.channelParticipants.teamId, teamId),
        eq(s.channelParticipants.channelId, channelId),
        eq(s.channelParticipants.state, 'joined'),
      ),
    );
}
async function record(
  db: Query,
  values: {
    humanId: string;
    teamId: string;
    kind: NotificationKind;
    source: string;
    channelId: string;
    topicId: string | null;
    messageId?: string | null;
    taskId?: string | null;
    taskVersion?: number | null;
    deliveryId?: string | null;
    /** How long unread before it also goes to Feishu; null: never. */
    forwardAfterMs: number | null;
  },
) {
  const { forwardAfterMs, ...rest } = values;
  // One reading of the clock, so the delays are exact.
  const now = Number(
    (await db.select({ now: dbNow }).from(sql`(select 1) as clock`))[0]?.now,
  );
  await db
    .insert(s.notifications)
    .values({
      id: randomUUID(),
      messageId: null,
      taskId: null,
      taskVersion: null,
      deliveryId: null,
      ...rest,
      state: 'pending',
      dueAt: now + NOTIFY_DELAY_MS,
      forwardAt:
        forwardAfterMs === null ? null : now + NOTIFY_DELAY_MS + forwardAfterMs,
      createdAt: now,
    })
    .onConflictDoNothing();
}
/**
 * Records, in the fact's own transaction, whom it concerns: a message notifies
 * the people it mentions, the person whose request an agent answers, and, for
 * those who want everything, everyone else in the channel; a task notifies the
 * person it is now theirs to work on or review, and its acceptor once it waits
 * on their sign-off. Nobody is notified of their own act.
 */
export async function notifyFact(db: Query, input: unknown) {
  const fact = OutboxFact.parse(input);
  if (fact.kind !== 'message.posted' && fact.kind !== 'task.changed') return;
  const author = fact.author.kind === 'human' ? fact.author.humanId : null;
  const people = (await joinedPeople(db, fact.teamId, fact.channelId)).flatMap(
    (p) =>
      p.humanId === null || p.humanId === author
        ? []
        : [
            {
              humanId: p.humanId,
              level: ChannelLevel.parse(p.level),
              forwardAfterMs: p.forwardAfterMs,
            },
          ],
  );
  if (people.length === 0) return;
  const heard = (p: (typeof people)[number], kind: NotificationKind) =>
    interrupts(p.level, kind);
  if (fact.kind === 'message.posted') {
    const asker =
      fact.author.kind === 'agent'
        ? await rootPerson(db, fact.sourceEventId)
        : null;
    for (const person of people) {
      const { humanId } = person;
      const kind: NotificationKind = fact.mentions.some(
        (m) => m.kind === 'human' && m.id === humanId,
      )
        ? 'mention'
        : humanId === asker
          ? 'reply'
          : 'message';
      if (!heard(person, kind)) continue;
      await record(db, {
        humanId,
        teamId: fact.teamId,
        kind,
        source: fact.id,
        channelId: fact.channelId,
        topicId: fact.topicId,
        messageId: fact.messageId,
        forwardAfterMs: person.forwardAfterMs,
      });
    }
    return;
  }
  if (!('taskId' in fact)) return;
  const task = (
    await db
      .select({ acceptor: s.tasks.acceptorHumanId })
      .from(s.tasks)
      .where(eq(s.tasks.id, fact.taskId))
      .limit(1)
  )[0];
  const acting = actingMember(fact.taskStatus, fact.owner, fact.reviewer);
  // Handed to you, or back to you: not your own progress or links.
  const handed = [
    'create',
    'handoff',
    'request-review',
    'review',
    'rework',
  ].includes(fact.taskAction);
  for (const person of people) {
    const { humanId } = person;
    const kind: NotificationKind | null =
      fact.taskStatus === 'awaiting-human' && task?.acceptor === humanId
        ? 'decide'
        : handed && acting?.kind === 'human' && acting.id === humanId
          ? 'task'
          : null;
    if (kind === null || !heard(person, kind)) continue;
    await record(db, {
      humanId,
      teamId: fact.teamId,
      kind,
      source: fact.id,
      channelId: fact.channelId,
      topicId: fact.topicId,
      taskId: fact.taskId,
      taskVersion: fact.taskVersion,
      forwardAfterMs: person.forwardAfterMs,
    });
  }
}
/**
 * A delivery has just become stuck: the person whose act started it is told,
 * once each time it gets stuck.
 */
export async function notifyBlocked(
  db: Query,
  delivery: {
    id: string;
    eventId: string;
    teamId: string;
    channelId: string;
    topicId: string | null;
  },
) {
  const humanId = await rootPerson(db, delivery.eventId);
  if (humanId === null) return;
  const person = (
    await joinedPeople(db, delivery.teamId, delivery.channelId)
  ).find((p) => p.humanId === humanId);
  if (!person || !interrupts(ChannelLevel.parse(person.level), 'blocked'))
    return;
  await record(db, {
    humanId,
    teamId: delivery.teamId,
    kind: 'blocked',
    source: 'blocked:' + delivery.id + ':' + randomUUID(),
    channelId: delivery.channelId,
    topicId: delivery.topicId,
    deliveryId: delivery.id,
    forwardAfterMs: person.forwardAfterMs,
  });
}

/** Notification settings, browsers and sending. */
export function notificationRepository(d: Database) {
  const { q, atomic } = d;
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
    /**
     * In the person's quiet time a notification is held, to be summed up
     * once it ends; one going to Feishu then is left to that summary.
     */
    async hold(id: string, what: 'push' | 'forward') {
      await q()
        .update(s.notifications)
        .set(what === 'push' ? { state: 'held' } : { forwardAt: null })
        .where(eq(s.notifications.id, id));
    },
    /** The person was in Kinmesh: an in-page notice instead of a push. */
    async shownInApp(id: string) {
      await q()
        .update(s.notifications)
        .set({ state: 'inapp', forwardAt: null })
        .where(eq(s.notifications.id, id));
    },
    /** The people with notifications held in their quiet time. */
    async heldPeople() {
      return (
        await q()
          .selectDistinct({ humanId: s.notifications.humanId })
          .from(s.notifications)
          .where(eq(s.notifications.state, 'held'))
      ).map((r) => r.humanId);
    },
    /** Takes a person's held notifications, each once, to be summed up. */
    takeHeld(humanId: string) {
      return atomic(async () => {
        const held = await q()
          .select()
          .from(s.notifications)
          .where(
            and(
              eq(s.notifications.humanId, humanId),
              eq(s.notifications.state, 'held'),
            ),
          )
          .for('update', { skipLocked: true });
        if (held.length === 0) return [];
        await q()
          .update(s.notifications)
          .set({ state: 'sent', forwardAt: null })
          .where(
            inArray(
              s.notifications.id,
              held.map((n) => n.id),
            ),
          );
        return held;
      });
    },
    /** In-page notices for a person: shown to them in Kinmesh just now. */
    async recentInApp(humanId: string, withinMs: number) {
      return await q()
        .select()
        .from(s.notifications)
        .where(
          and(
            eq(s.notifications.humanId, humanId),
            eq(s.notifications.state, 'inapp'),
            gt(s.notifications.createdAt, sql`${dbNow} - ${withinMs}`),
          ),
        )
        .orderBy(s.notifications.createdAt)
        .limit(5);
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
    /**
     * Takes up to `limit` notifications whose time to go to Feishu has come,
     * each once, with the person's Feishu identity: the caller sends or drops
     * each.
     */
    takeForwards(limit: number) {
      return atomic(async () => {
        const due = await q()
          .select({
            notification: s.notifications,
            union: s.humans.feishuId,
            // Turned off since it was recorded: then it isn't sent.
            forwarding: isNotNull(s.memberships.forwardAfterMs),
          })
          .from(s.notifications)
          .innerJoin(s.humans, eq(s.humans.id, s.notifications.humanId))
          .innerJoin(
            s.memberships,
            and(
              eq(s.memberships.humanId, s.notifications.humanId),
              eq(s.memberships.teamId, s.notifications.teamId),
            ),
          )
          .where(lte(s.notifications.forwardAt, dbNow))
          .orderBy(s.notifications.forwardAt)
          .limit(limit)
          .for('update', { of: s.notifications, skipLocked: true });
        if (due.length === 0) return [];
        await q()
          .update(s.notifications)
          .set({ forwardAt: null })
          .where(
            inArray(
              s.notifications.id,
              due.map((d) => d.notification.id),
            ),
          );
        return due;
      });
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
    /** A person's Feishu identity, once they signed in with Feishu. */
    async unionOf(humanId: string) {
      const row = (
        await q()
          .select({ union: s.humans.feishuId })
          .from(s.humans)
          .where(eq(s.humans.id, humanId))
          .limit(1)
      )[0];
      return row?.union ?? null;
    },
    /** A browser its push service no longer knows. */
    async gone(endpoint: string) {
      await q()
        .delete(s.pushSubscriptions)
        .where(eq(s.pushSubscriptions.endpoint, endpoint));
    },
    /**
     * Takes up to `limit` notifications that are due, each once: the caller
     * sends or drops it.
     */
    take(limit: number) {
      return atomic(async () => {
        const due = await q()
          .select()
          .from(s.notifications)
          .where(
            and(
              eq(s.notifications.state, 'pending'),
              lte(s.notifications.dueAt, dbNow),
            ),
          )
          .orderBy(s.notifications.dueAt)
          .limit(limit)
          .for('update', { skipLocked: true });
        if (due.length === 0) return [];
        await q()
          .update(s.notifications)
          .set({ state: 'sent' })
          .where(
            inArray(
              s.notifications.id,
              due.map((n) => n.id),
            ),
          );
        return due;
      });
    },
    /** Whether anything waits to be sent, now or soon. */
    async pending() {
      const row = (
        await q()
          .select({ id: s.notifications.id })
          .from(s.notifications)
          .where(eq(s.notifications.state, 'pending'))
          .limit(1)
      )[0];
      return row !== undefined;
    },
    /**
     * What a notification is about, read when it is sent, or null when it no
     * longer concerns the person: they read it, left the channel, or the task
     * or delivery moved on.
     */
    async describe(n: typeof s.notifications.$inferSelect) {
      const [place] = await q()
        .select({
          channelName: s.channels.name,
          readPosition: s.channelParticipants.readPosition,
        })
        .from(s.channelParticipants)
        .innerJoin(
          s.channels,
          eq(s.channels.id, s.channelParticipants.channelId),
        )
        .where(
          and(
            eq(s.channelParticipants.channelId, n.channelId),
            eq(s.channelParticipants.memberKey, 'human:' + n.humanId),
            eq(s.channelParticipants.state, 'joined'),
          ),
        )
        .limit(1);
      if (place === undefined) return null;
      const topicTitle =
        n.topicId === null
          ? null
          : ((
              await q()
                .select({ title: s.topics.title })
                .from(s.topics)
                .where(eq(s.topics.id, n.topicId))
                .limit(1)
            )[0]?.title ?? null);
      const where = {
        channelName: place.channelName,
        topicTitle,
        status: null as string | null,
      };
      if (n.messageId !== null) {
        const [message] = await q()
          .select({
            position: s.messages.position,
            author: s.messages.author,
            body: s.messages.body,
          })
          .from(s.messages)
          .where(eq(s.messages.id, n.messageId))
          .limit(1);
        if (message === undefined) return null;
        if (message.position <= (place.readPosition ?? 0)) return null;
        const author = Author.parse(JSON.parse(message.author));
        return {
          ...where,
          author:
            author.kind === 'human'
              ? await nameOf('human', author.humanId)
              : await nameOf('agent', author.agentId),
          text: message.body,
        };
      }
      if (n.taskId !== null) {
        const [task] = await q()
          .select({
            title: s.tasks.title,
            version: s.tasks.version,
            status: s.tasks.status,
          })
          .from(s.tasks)
          .where(eq(s.tasks.id, n.taskId))
          .limit(1);
        if (task?.version !== n.taskVersion) return null;
        return {
          ...where,
          status: task.status,
          author: null,
          text: task.title,
        };
      }
      if (n.deliveryId !== null) {
        const [delivery] = await q()
          .select({
            state: s.agentInbox.state,
            agentId: s.agentInbox.agentId,
            messageId: s.agentInbox.messageId,
          })
          .from(s.agentInbox)
          .where(eq(s.agentInbox.id, n.deliveryId))
          .limit(1);
        if (delivery?.state !== 'blocked') return null;
        const asked =
          delivery.messageId === null
            ? ''
            : ((
                await q()
                  .select({ body: s.messages.body })
                  .from(s.messages)
                  .where(eq(s.messages.id, delivery.messageId))
                  .limit(1)
              )[0]?.body ?? '');
        return {
          ...where,
          author: await nameOf('agent', delivery.agentId),
          text: asked,
        };
      }
      return null;
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
  /** A person or agent by the name the workspace shows. */
  async function nameOf(kind: 'human' | 'agent', id: string) {
    if (kind === 'human') {
      const row = (
        await q()
          .select({ name: s.humans.name, username: s.humans.username })
          .from(s.humans)
          .where(eq(s.humans.id, id))
          .limit(1)
      )[0];
      return row ? (row.name ?? row.username) : null;
    }
    return (
      (
        await q()
          .select({ name: s.agents.name })
          .from(s.agents)
          .where(eq(s.agents.id, id))
          .limit(1)
      )[0]?.name ?? null
    );
  }
}
