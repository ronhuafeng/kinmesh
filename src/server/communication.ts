import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ChannelId, TeamId } from '../domain/contracts.js';
import {
  ArchiveInput,
  ChannelInput,
  MessageId,
  Mutation,
  PageInput,
  ParticipantInput,
  PinInput,
  EditInput,
  PostInput,
  ReactInput,
  ReadInput,
  RenameInput,
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
        await store.channels.createChannel(
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
            ? store.channels.leftChannels(principal(request), teamId)
            : store.channels.publicChannels(principal(request), teamId)),
          nextCursor: null,
        }
      : await store.channels.channels(principal(request), teamId, page);
  });
  app.get(channel, async (request) => {
    const { teamId, channelId } = ChannelPath.parse(request.params);
    return store.channels.channel(principal(request), teamId, channelId);
  });
  app.get(channel + '/membership', async (request) => {
    const { teamId, channelId } = ChannelPath.parse(request.params);
    return store.channels.participant(principal(request), teamId, channelId);
  });
  for (const action of ['subscribe', 'leave'] as const)
    app.post(channel + '/' + action, async (request) => {
      const { teamId, channelId } = ChannelPath.parse(request.params);
      return store.channels.membership(
        principal(request),
        teamId,
        channelId,
        Mutation.parse(request.body),
        action,
      );
    });
  app.post(channel + '/visibility', async (request) => {
    const { teamId, channelId } = ChannelPath.parse(request.params);
    return store.channels.setVisibility(
      principal(request),
      teamId,
      channelId,
      VisibilityInput.parse(request.body),
    );
  });
  for (const action of ['invite', 'remove'] as const)
    app.post(channel + '/participants/' + action, async (request) => {
      const { teamId, channelId } = ChannelPath.parse(request.params);
      return store.channels.enroll(
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
        await store.topics.createTopic(
          principal(request),
          teamId,
          channelId,
          TopicInput.parse(request.body),
        ),
      );
  });
  app.get(channel + '/topics', async (request) => {
    const { teamId, channelId } = ChannelPath.parse(request.params);
    return store.topics.topics(
      principal(request),
      teamId,
      channelId,
      PageInput.parse(request.query),
    );
  });
  app.get(channel + '/topics/:topicId', async (request) => {
    const { teamId, channelId, topicId } = TopicPath.parse(request.params);
    return store.topics.topic(principal(request), teamId, channelId, topicId);
  });
  app.get(channel + '/topics/:topicId/messages', async (request) => {
    const { teamId, channelId, topicId } = TopicPath.parse(request.params);
    return store.messages.history(
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
        await store.messages.post(
          principal(request),
          teamId,
          channelId,
          PostInput.parse(request.body),
        ),
      );
  });
  app.post(channel + '/level', async (request, reply) => {
    const { teamId, channelId } = ChannelPath.parse(request.params);
    await store.channels.level(
      principal(request),
      teamId,
      channelId,
      LevelInput.parse(request.body).level,
    );
    return reply.code(204).send();
  });
  app.post(channel + '/read', async (request, reply) => {
    const { teamId, channelId } = ChannelPath.parse(request.params);
    await store.channels.read(
      principal(request),
      teamId,
      channelId,
      ReadInput.parse(request.body),
    );
    return reply.code(204).send();
  });
  app.get(channel + '/messages', async (request) => {
    const { teamId, channelId } = ChannelPath.parse(request.params);
    return store.messages.history(
      principal(request),
      teamId,
      channelId,
      PageInput.parse(request.query),
    );
  });
  app.get(channel + '/messages/:messageId', async (request) => {
    const { teamId, channelId, messageId } = MessagePath.parse(request.params);
    return store.messages.message(
      principal(request),
      teamId,
      channelId,
      messageId,
    );
  });
  /** A person in the channel names it again. */
  app.post(channel + '/rename', async (request) => {
    const { teamId, channelId } = ChannelPath.parse(request.params);
    return store.channels.rename(
      principal(request),
      teamId,
      channelId,
      RenameInput.parse(request.body),
    );
  });
  /** A person in the channel archives it, or brings it back. */
  app.post(channel + '/archive', async (request) => {
    const { teamId, channelId } = ChannelPath.parse(request.params);
    return store.channels.archive(
      principal(request),
      teamId,
      channelId,
      ArchiveInput.parse(request.body),
    );
  });
  /** A person pins a message in the channel or unpins it; the answer is its pins. */
  app.post(channel + '/messages/:messageId/pin', async (request) => {
    const { teamId, channelId, messageId } = MessagePath.parse(request.params);
    return store.pins.pin(
      principal(request),
      teamId,
      channelId,
      messageId,
      PinInput.parse(request.body),
    );
  });
  /** Its author says a message again; the answer is the message. */
  app.post(channel + '/messages/:messageId/edit', async (request) => {
    const { teamId, channelId, messageId } = MessagePath.parse(request.params);
    return store.messages.edit(
      principal(request),
      teamId,
      channelId,
      messageId,
      EditInput.parse(request.body),
    );
  });
  /** Its author withdraws a message; the answer is the message, now empty. */
  app.post(channel + '/messages/:messageId/withdraw', async (request) => {
    const { teamId, channelId, messageId } = MessagePath.parse(request.params);
    return store.messages.withdraw(
      principal(request),
      teamId,
      channelId,
      messageId,
      Mutation.parse(request.body),
    );
  });
  /** A person adds or takes back a reaction; the answer is the message's reactions. */
  app.post(channel + '/messages/:messageId/reactions', async (request) => {
    const { teamId, channelId, messageId } = MessagePath.parse(request.params);
    return store.reactions.react(
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
      await store.messages.message(
        principal(request),
        teamId,
        channelId,
        messageId,
      )
    ).mentions;
  });
  app.get(channel + '/events', async (request) => {
    const { teamId, channelId } = ChannelPath.parse(request.params);
    return store.messages.events(
      principal(request),
      teamId,
      channelId,
      PageInput.parse(request.query),
    );
  });
}
