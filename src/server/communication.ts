import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ChannelId, TeamId } from '../domain/contracts.js';
import {
  ChannelInput,
  MessageId,
  Mutation,
  PageInput,
  ParticipantInput,
  PinInput,
  PostInput,
  ReactInput,
  ReadInput,
  TopicId,
  TopicInput,
  VisibilityInput,
} from '../domain/communication.js';
import { LevelInput } from '../domain/notify.js';
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
      membership: z.enum(['joined', 'left', 'public']).optional(),
    }).parse(request.query);
    // "left" lists only the caller's own left memberships; removed never return.
    // "public" lists public channels the caller has never been in.
    return membership === 'left' || membership === 'public'
      ? {
          items: await (membership === 'left'
            ? store.communication.leftChannels(principal(request), teamId)
            : store.communication.publicChannels(principal(request), teamId)),
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
  // Ending a delivery, by the same people as resuming one (stopByPerson).
  app.post(
    '/api/teams/:teamId/deliveries/:deliveryId/stop',
    async (request) => {
      const { teamId, deliveryId } = TeamPath.extend({
        deliveryId: z.uuid(),
      }).parse(request.params);
      return store.inbox.stopByPerson(
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
  app.post(channel + '/visibility', async (request) => {
    const { teamId, channelId } = ChannelPath.parse(request.params);
    return store.communication.setVisibility(
      principal(request),
      teamId,
      channelId,
      VisibilityInput.parse(request.body),
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
  app.post(channel + '/level', async (request, reply) => {
    const { teamId, channelId } = ChannelPath.parse(request.params);
    await store.communication.level(
      principal(request),
      teamId,
      channelId,
      LevelInput.parse(request.body).level,
    );
    return reply.code(204).send();
  });
  app.post(channel + '/read', async (request, reply) => {
    const { teamId, channelId } = ChannelPath.parse(request.params);
    await store.communication.read(
      principal(request),
      teamId,
      channelId,
      ReadInput.parse(request.body),
    );
    return reply.code(204).send();
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
  /** A person pins a message in the channel or unpins it; the answer is its pins. */
  app.post(channel + '/messages/:messageId/pin', async (request) => {
    const { teamId, channelId, messageId } = MessagePath.parse(request.params);
    return store.communication.pin(
      principal(request),
      teamId,
      channelId,
      messageId,
      PinInput.parse(request.body),
    );
  });
  /** A person adds or takes back a reaction; the answer is the message's reactions. */
  app.post(channel + '/messages/:messageId/reactions', async (request) => {
    const { teamId, channelId, messageId } = MessagePath.parse(request.params);
    return store.communication.react(
      principal(request),
      teamId,
      channelId,
      messageId,
      ReactInput.parse(request.body),
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
