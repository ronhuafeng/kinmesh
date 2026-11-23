import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { ChannelView, Participant } from '../src/domain/communication.js';
import { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { communicationFixture, key } from './communication-helpers.js';
import { feishuPerson, signInAs } from './feishu.js';

/**
 * Proves two people's own conversation is one private channel per pair,
 * made the first time from either side and found after, that it keeps its
 * two people and its kind, takes agents, and is called by the other person.
 */
await test('two people open their own conversation: one private channel for the pair', async () => {
  const f = await communicationFixture();
  try {
    const graceCookies = await signInAs(f.app, 'grace@example.com');
    const grace = await f.store.signIn(feishuPerson('grace@example.com'));
    const open = (humanId: string, cookies = f.cookies) =>
      f.app.inject({
        method: 'POST',
        url: `/api/teams/${f.teamId}/direct`,
        cookies,
        payload: { operationKey: key(), humanId },
      });
    const made = await open(grace.id);
    assert.equal(made.statusCode, 200);
    const channel = ChannelView.parse(made.json<unknown>());
    assert.equal(channel.visibility, 'private');
    // The same one, from either side; never with yourself.
    assert.equal(
      ChannelView.parse((await open(grace.id)).json<unknown>()).id,
      channel.id,
    );
    assert.equal(
      ChannelView.parse((await open(f.owner.id, graceCookies)).json<unknown>())
        .id,
      channel.id,
    );
    assert.equal((await open(f.owner.id)).statusCode, 400);
    const path = `${f.channelsPath}/${channel.id}`;
    // Both are in it; each sees it as the other.
    for (const [cookies, other] of [
      [f.cookies, grace.id],
      [graceCookies, f.owner.id],
    ] as const) {
      const seen = WorkspaceSnapshot.parse(
        (
          await f.app.inject({
            url: '/api/workspace?channelId=' + channel.id,
            cookies,
          })
        ).json<unknown>(),
      );
      assert.deepEqual(
        seen.direct.find((d) => d.channelId === channel.id)?.humanId,
        other,
      );
      // Called by the other person, as they are called now.
      assert.equal(
        seen.channel?.name,
        seen.people.find((person) => person.id === other)?.name,
      );
      assert.equal(seen.joinedHumanIds.length, 2);
    }
    // It keeps its kind: no rename, no opening up, no archive.
    const post = (
      action: string,
      payload: Record<string, unknown>,
      cookies = f.cookies,
    ) =>
      f.app.inject({
        method: 'POST',
        url: `${path}/${action}`,
        cookies,
        payload: { operationKey: key(), ...payload },
      });
    assert.equal((await post('rename', { name: 'ours' })).statusCode, 409);
    assert.equal(
      (await post('visibility', { visibility: 'public' })).statusCode,
      409,
    );
    assert.equal((await post('archive', { archived: true })).statusCode, 409);
    // It takes an agent, never a third person, and loses neither of the two.
    const linus = await f.store.signIn(feishuPerson('linus@example.com'));
    assert.equal(
      (
        await post('participants/invite', {
          member: { kind: 'human', id: linus.id },
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await post('participants/remove', {
          member: { kind: 'human', id: grace.id },
        })
      ).statusCode,
      409,
    );
    const agent = await post('participants/invite', {
      member: { kind: 'agent', id: f.agent.id },
    });
    assert.equal(agent.statusCode, 200);
    assert.equal(Participant.parse(agent.json<unknown>()).state, 'joined');
    // One who left comes back by opening it again.
    assert.equal(
      (await post('leave', {}, graceCookies)).statusCode < 300,
      true,
    );
    assert.equal((await open(f.owner.id, graceCookies)).statusCode, 200);
    const back = await f.app.inject({
      url: '/api/workspace?channelId=' + channel.id,
      cookies: f.cookies,
    });
    assert.ok(
      z
        .object({ joinedHumanIds: z.array(z.string()) })
        .parse(back.json<unknown>())
        .joinedHumanIds.includes(grace.id),
    );
  } finally {
    await f.dispose();
  }
});
