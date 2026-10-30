import { randomUUID } from 'node:crypto';
import { ChannelId } from '../src/domain/contracts.js';
import { PostInput } from '../src/domain/communication.js';
import { agentFixture } from './agent-helpers.js';
export const key = () => randomUUID();
export const postInput = (overrides: Partial<PostInput> = {}) =>
  PostInput.parse({
    operationKey: key(),
    body: 'Local test message',
    topicId: null,
    mentions: [],
    sourceMessageId: null,
    sourceEventId: null,
    ...overrides,
  });
export async function communicationFixture() {
  const f = await agentFixture();
  const credential = f.store.agents.issue(f.principal, f.teamId, f.agent.id, {
    label: 'communication test',
    scopes: ['channels:read', 'channels:write'],
    lifetimeSeconds: 3600,
  });
  const agentPrincipal = f.store.agents.resolveToken(credential.token);
  const channelId = ChannelId.parse(
    f.store.teamFor(f.owner.id)?.channels[0]?.id,
  );
  const channelPath = `/api/teams/${f.teamId}/channels/${channelId}`;
  const channelsPath = `/api/teams/${f.teamId}/channels`;
  const headers = { authorization: 'Bearer ' + credential.token };
  const comm = f.store.communication;
  function invite() {
    return comm.enroll(
      f.principal,
      f.teamId,
      channelId,
      { operationKey: key(), member: { kind: 'agent', id: f.agent.id } },
      'invite',
    );
  }
  return {
    ...f,
    credential,
    agentPrincipal,
    channelId,
    channelPath,
    channelsPath,
    headers,
    comm,
    invite,
  };
}
