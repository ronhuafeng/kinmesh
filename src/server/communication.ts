import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ChannelId, TeamId } from '../domain/contracts.js';
import {
  ChannelInput,
  MessageId,
  Mutation,
  PageInput,
  ParticipantInput,
  PostInput,
  TopicId,
  TopicInput,
} from '../domain/communication.js';
import type { Store } from '../persistence/store.js';
import { principal } from './principals.js';
const TeamPath = z.object({ teamId: TeamId });
const ChannelPath = TeamPath.extend({ channelId: ChannelId });
const TopicPath = ChannelPath.extend({ topicId: TopicId });
const MessagePath = ChannelPath.extend({ messageId: MessageId });
export function registerCommunication(app: FastifyInstance, store: Store) {
  const base = '/api/teams/:teamId/channels';
  const channel = base + '/:channelId';
  app.post(base, async (request, reply) =>
    reply
      .code(201)
      .send(
        await store.communication.createChannel(
          principal(request),
          TeamPath.parse(request.params).teamId,
          ChannelInput.parse(request.body),
        ),
      ),
  );
  app.get(base, async (request) => {
    const { teamId } = TeamPath.parse(request.params);
    const { membership, ...page } = PageInput.extend({
      membership: z.enum(['joined', 'left']).optional(),
    }).parse(request.query);
    // "left" lists only the caller's own left memberships; removed never return.
    return membership === 'left'
      ? {
          items: await store.communication.leftChannels(
            principal(request),
            teamId,
          ),
          nextCursor: null,
        }
      : await store.communication.channels(principal(request), teamId, page);
  });
  // Recovery of a blocked delivery by any person; agents never reach it (resumeByPerson).
  app.post(
    '/api/teams/:teamId/deliveries/:deliveryId/resume',
    async (request) => {
      const { teamId, deliveryId } = TeamPath.extend({
        deliveryId: z.uuid(),
      }).parse(request.params);
      return store.inbox.resumeByPerson(
        principal(request),
        teamId,
        deliveryId,
        Mutation.parse(request.body).operationKey,
      );
    },
  );
  app.get(channel, async (request) => {
    const { teamId, channelId } = ChannelPath.parse(request.params);
    return store.communication.channel(principal(request), teamId, channelId);
  });
  app.get(channel + '/membership', async (request) => {
    const { teamId, channelId } = ChannelPath.parse(request.params);
    return store.communication.participant(
      principal(request),
      teamId,
      channelId,
    );
  });
  for (const action of ['subscribe', 'leave'] as const)
    app.post(channel + '/' + action, async (request) => {
      const { teamId, channelId } = ChannelPath.parse(request.params);
      return store.communication.membership(
        principal(request),
        teamId,
        channelId,
        Mutation.parse(request.body),
        action,
      );
    });
  for (const action of ['invite', 'remove'] as const)
    app.post(channel + '/participants/' + action, async (request) => {
      const { teamId, channelId } = ChannelPath.parse(request.params);
      return store.communication.enroll(
        principal(request),
        teamId,
        channelId,
        ParticipantInput.parse(request.body),
        action,
      );
    });
  app.post(channel + '/topics', async (request, reply) => {
    const { teamId, channelId } = ChannelPath.parse(request.params);
    return reply
      .code(201)
      .send(
        await store.communication.createTopic(
          principal(request),
          teamId,
          channelId,
          TopicInput.parse(request.body),
        ),
      );
  });
  app.get(channel + '/topics', async (request) => {
    const { teamId, channelId } = ChannelPath.parse(request.params);
    return store.communication.topics(
      principal(request),
      teamId,
      channelId,
      PageInput.parse(request.query),
    );
  });
  app.get(channel + '/topics/:topicId', async (request) => {
    const { teamId, channelId, topicId } = TopicPath.parse(request.params);
    return store.communication.topic(
      principal(request),
      teamId,
      channelId,
      topicId,
    );
  });
  app.get(channel + '/topics/:topicId/messages', async (request) => {
    const { teamId, channelId, topicId } = TopicPath.parse(request.params);
    return store.communication.history(
      principal(request),
      teamId,
      channelId,
      PageInput.parse(request.query),
      topicId,
    );
  });
  app.post(channel + '/messages', async (request, reply) => {
    const { teamId, channelId } = ChannelPath.parse(request.params);
    return reply
      .code(201)
      .send(
        await store.communication.post(
          principal(request),
          teamId,
          channelId,
          PostInput.parse(request.body),
        ),
      );
  });
  app.get(channel + '/messages', async (request) => {
    const { teamId, channelId } = ChannelPath.parse(request.params);
    return store.communication.history(
      principal(request),
      teamId,
      channelId,
      PageInput.parse(request.query),
    );
  });
  app.get(channel + '/messages/:messageId', async (request) => {
    const { teamId, channelId, messageId } = MessagePath.parse(request.params);
    return store.communication.message(
      principal(request),
      teamId,
      channelId,
      messageId,
    );
  });
  app.get(channel + '/messages/:messageId/mentions', async (request) => {
    const { teamId, channelId, messageId } = MessagePath.parse(request.params);
    return (
      await store.communication.message(
        principal(request),
        teamId,
        channelId,
        messageId,
      )
    ).mentions;
  });
  app.get(channel + '/events', async (request) => {
    const { teamId, channelId } = ChannelPath.parse(request.params);
    return store.communication.events(
      principal(request),
      teamId,
      channelId,
      PageInput.parse(request.query),
    );
  });
}
