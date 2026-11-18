import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
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
export async function communicationFixture(
  overrides: Parameters<typeof agentFixture>[0] = {},
) {
  const f = await agentFixture(overrides);
  const credential = await f.store.agents.issue(
    f.principal,
    f.teamId,
    f.agent.id,
    {
      label: 'communication test',
      scopes: ['channels:read', 'channels:write'],
      lifetimeSeconds: 3600,
    },
  );
  const agentPrincipal = await f.store.agents.resolveToken(credential.token);
  const channelId = ChannelId.parse(
    (await f.store.teamFor(f.owner.id))?.channels[0]?.id,
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

/**
 * Uploads a file as the workspace does: hashed, put in the store where the
 * hub says, then registered. The hub's refusal, if any, is what it answers.
 */
export async function uploadFile(
  app: FastifyInstance,
  channelPath: string,
  cookies: Record<string, string>,
  body: Buffer,
  name: string,
  operationKey = key(),
) {
  const sha256 = createHash('sha256').update(body).digest('hex');
  const asked = await app.inject({
    method: 'POST',
    url: `${channelPath}/attachments/uploads`,
    cookies,
    payload: { sha256, size: body.length },
  });
  if (asked.statusCode !== 200) return asked;
  const { url } = z
    .object({ url: z.string().nullable() })
    .parse(asked.json<unknown>());
  if (url !== null) {
    const put = await fetch(url, {
      method: 'PUT',
      body: new Uint8Array(body),
      headers: {
        'x-amz-checksum-sha256': Buffer.from(sha256, 'hex').toString('base64'),
      },
    });
    if (!put.ok)
      throw new Error(`The store refused the upload: ${String(put.status)}`);
  }
  return app.inject({
    method: 'POST',
    url: `${channelPath}/attachments`,
    cookies,
    payload: { operationKey, name, sha256 },
  });
}
