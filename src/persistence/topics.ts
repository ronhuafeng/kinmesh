import type { Database } from './database.js';
import { transactional } from './transactional.js';
import { randomUUID } from 'node:crypto';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  getTableColumns,
  inArray,
  lte,
  max,
  or,
  sql,
} from 'drizzle-orm';
import { z } from 'zod';
import * as s from './schema.js';
import { type ChannelId, type TeamId } from '../domain/contracts.js';
import type { Principal } from '../domain/agents.js';
import {
  principalAuthor as author,
  principalMember as member,
} from '../domain/tasks.js';
import {
  type PageInput,
  NAMED_TOPICS_MOST,
  REACH,
  Topic,
  TopicId,
  TopicInput,
  memberKey,
} from '../domain/communication.js';
import { now, page, highest } from './channel-values.js';
import type { ChannelAccess } from './channel-access.js';
import type { Facts } from './facts.js';
import type { MessageViews } from './message-views.js';

type ChannelId = z.infer<typeof ChannelId>;
/** A channel's topics: made, and read with the most active first. */
export function topicRepository(
  d: Database,
  gate: ChannelAccess,
  facts: Facts,
  views: MessageViews,
) {
  const { q, atomic } = transactional(d);
  const { access, mutation } = gate;
  const { fact } = facts;
  const { topicOf, topic } = views;

  return {
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
     * The channel's topics that something on screen names: the one open
     * and those of the messages shown (`topicIds`), and those its tasks are
     * in; the newest first, up to `NAMED_TOPICS_MOST`.
     */
    named(
      p: Principal,
      teamId: TeamId,
      channelId: ChannelId,
      topicIds: string[],
    ) {
      return atomic(async () => {
        await access(p, teamId, channelId);
        const ids = z
          .array(z.string())
          .max(REACH + 1)
          .parse(topicIds);
        const ofTasks = q()
          .select({ id: s.tasks.topicId })
          .from(s.tasks)
          .where(eq(s.tasks.channelId, channelId));
        const rows = await q()
          .select()
          .from(s.topics)
          .where(
            and(
              eq(s.topics.channelId, channelId),
              ids.length
                ? or(inArray(s.topics.id, ofTasks), inArray(s.topics.id, ids))
                : inArray(s.topics.id, ofTasks),
            ),
          )
          .orderBy(desc(s.topics.position))
          .limit(NAMED_TOPICS_MOST);
        return rows.map(topicOf);
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
  };
}
