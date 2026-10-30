import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ChannelId, TeamId } from '../domain/contracts.js';
import { IdentityError } from '../domain/agents.js';
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
const TeamPath = z.object({ teamId: TeamId });
const ChannelPath = TeamPath.extend({ channelId: ChannelId });
const TopicPath = ChannelPath.extend({ topicId: TopicId });
const MessagePath = ChannelPath.extend({ messageId: MessageId });
function principal(request: FastifyRequest) {
  if (request.principal === null) throw new IdentityError(401);
  return request.principal;
}
export function registerCommunication(app: FastifyInstance, store: Store) {
  const base = '/api/teams/:teamId/channels';
  const channel = base + '/:channelId';
  app.post(base, (request, reply) =>
    reply
      .code(201)
      .send(
        store.communication.createChannel(
          principal(request),
          TeamPath.parse(request.params).teamId,
          ChannelInput.parse(request.body),
        ),
      ),
  );
  app.get(base, (request) =>
    store.communication.channels(
      principal(request),
      TeamPath.parse(request.params).teamId,
      PageInput.parse(request.query),
    ),
  );
  app.get(channel, (request) => {
    const { teamId, channelId } = ChannelPath.parse(request.params);
    return store.communication.channel(principal(request), teamId, channelId);
  });
  app.get(channel + '/membership', (request) => {
    const { teamId, channelId } = ChannelPath.parse(request.params);
    return store.communication.participant(
      principal(request),
      teamId,
      channelId,
    );
  });
  for (const action of ['subscribe', 'leave'] as const)
    app.post(channel + '/' + action, (request) => {
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
    app.post(channel + '/participants/' + action, (request) => {
      const { teamId, channelId } = ChannelPath.parse(request.params);
      return store.communication.enroll(
        principal(request),
        teamId,
        channelId,
        ParticipantInput.parse(request.body),
        action,
      );
    });
  app.post(channel + '/topics', (request, reply) => {
    const { teamId, channelId } = ChannelPath.parse(request.params);
    return reply
      .code(201)
      .send(
        store.communication.createTopic(
          principal(request),
          teamId,
          channelId,
          TopicInput.parse(request.body),
        ),
      );
  });
  app.get(channel + '/topics', (request) => {
    const { teamId, channelId } = ChannelPath.parse(request.params);
    return store.communication.topics(
      principal(request),
      teamId,
      channelId,
      PageInput.parse(request.query),
    );
  });
  app.get(channel + '/topics/:topicId', (request) => {
    const { teamId, channelId, topicId } = TopicPath.parse(request.params);
    return store.communication.topic(
      principal(request),
      teamId,
      channelId,
      topicId,
    );
  });
  app.get(channel + '/topics/:topicId/messages', (request) => {
    const { teamId, channelId, topicId } = TopicPath.parse(request.params);
    return store.communication.history(
      principal(request),
      teamId,
      channelId,
      PageInput.parse(request.query),
      topicId,
    );
  });
  app.post(channel + '/messages', (request, reply) => {
    const { teamId, channelId } = ChannelPath.parse(request.params);
    return reply
      .code(201)
      .send(
        store.communication.post(
          principal(request),
          teamId,
          channelId,
          PostInput.parse(request.body),
        ),
      );
  });
  app.get(channel + '/messages', (request) => {
    const { teamId, channelId } = ChannelPath.parse(request.params);
    return store.communication.history(
      principal(request),
      teamId,
      channelId,
      PageInput.parse(request.query),
    );
  });
  app.get(channel + '/messages/:messageId', (request) => {
    const { teamId, channelId, messageId } = MessagePath.parse(request.params);
    return store.communication.message(
      principal(request),
      teamId,
      channelId,
      messageId,
    );
  });
  app.get(channel + '/messages/:messageId/mentions', (request) => {
    const { teamId, channelId, messageId } = MessagePath.parse(request.params);
    return store.communication.message(
      principal(request),
      teamId,
      channelId,
      messageId,
    ).mentions;
  });
  app.get(channel + '/events', (request) => {
    const { teamId, channelId } = ChannelPath.parse(request.params);
    return store.communication.events(
      principal(request),
      teamId,
      channelId,
      PageInput.parse(request.query),
    );
  });
}
