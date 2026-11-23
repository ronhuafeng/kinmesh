import type { Database } from './database.js';
import { transactional } from './transactional.js';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import * as s from './schema.js';
import type { agentRepository } from './agents.js';
import { type ChannelId, type TeamId } from '../domain/contracts.js';
import type { Principal } from '../domain/agents.js';
import { DomainError } from '../domain/errors.js';
import { principalMember as member } from '../domain/tasks.js';
import {
  ChannelView,
  Member,
  Mutation,
  Participant,
  memberKey,
} from '../domain/communication.js';

type ChannelId = z.infer<typeof ChannelId>;
/**
 * Who may do what in a channel: the team and the channel as the caller may
 * see them, joined or looking in, and a write recorded once by its key.
 * Made once per store, so a read asks each question once.
 */
export function channelAccess(
  d: Database,
  agents: ReturnType<typeof agentRepository>,
) {
  const { q, receipt } = transactional(d);

  async function team(p: Principal, teamId: TeamId, write = false) {
    return write
      ? await agents.teamAccess(p, teamId, 'channels:read', 'channels:write')
      : await agents.teamAccess(p, teamId, 'channels:read');
  }
  // Asked once per read (`perRead`): the same caller, channel and need.
  const access = d.perRead(
    (
      p: Principal,
      teamId: TeamId,
      channelId: ChannelId,
      write?: boolean,
      inactive?: boolean,
    ) =>
      JSON.stringify([p, teamId, channelId, write ?? false, inactive ?? false]),
    (
      p: Principal,
      teamId: TeamId,
      channelId: ChannelId,
      write?: boolean,
      inactive?: boolean,
    ) => checkAccess(p, teamId, channelId, write ?? false, inactive ?? false),
  );
  async function checkAccess(
    p: Principal,
    teamId: TeamId,
    channelId: ChannelId,
    write: boolean,
    inactive: boolean,
  ) {
    await team(p, teamId, write);
    const channel = (
      await q()
        .select()
        .from(s.channels)
        .where(and(eq(s.channels.teamId, teamId), eq(s.channels.id, channelId)))
        .limit(1)
    )[0];
    const participant = (
      await q()
        .select()
        .from(s.channelParticipants)
        .where(
          and(
            eq(s.channelParticipants.channelId, channelId),
            eq(s.channelParticipants.memberKey, memberKey(member(p))),
          ),
        )
        .limit(1)
    )[0];
    if (channel === undefined) throw new DomainError('not-found');
    const belongs =
      participant !== undefined &&
      participant.state !== 'removed' &&
      (inactive || participant.state === 'joined');
    // A public channel is read by any person of the team, joined or not
    // (not one removed from it); writing, and every agent, needs joining.
    const previewing =
      !write &&
      p.kind === 'human' &&
      channel.visibility === 'public' &&
      participant?.state !== 'removed';
    if (!belongs && !previewing) throw new DomainError('not-found');
    // An archived channel is read, never written to.
    const { archivedAt, directKey, ...kept } = channel;
    if (write && archivedAt !== null) throw new DomainError('conflict');
    return {
      channel: ChannelView.parse(kept),
      participant: belongs ? participant : null,
      archived: archivedAt !== null,
      /** Whose own conversation it is, for two people's; null otherwise. */
      direct: directKey === null ? null : directKey.split(' '),
    };
  }
  /** A person of the team, joined to the channel when one is named. */
  async function person(p: Principal, teamId: TeamId, channelId?: ChannelId) {
    if (channelId !== undefined) await access(p, teamId, channelId, true);
    await agents.person(p, teamId);
  }
  async function participantView(
    teamId: TeamId,
    channelId: ChannelId,
    target: Member,
  ) {
    const row = (
      await q()
        .select()
        .from(s.channelParticipants)
        .where(
          and(
            eq(s.channelParticipants.channelId, channelId),
            eq(s.channelParticipants.memberKey, memberKey(target)),
          ),
        )
        .limit(1)
    )[0];
    if (row === undefined) throw new DomainError('not-found');
    return Participant.parse({
      channelId,
      teamId,
      member: target,
      state: row.state,
    });
  }
  async function validTarget(
    teamId: TeamId,
    channelId: ChannelId,
    target: Member,
    joined: boolean,
  ) {
    Member.parse(target);
    if (target.kind === 'human') {
      if (
        (
          await q()
            .select()
            .from(s.memberships)
            .where(
              and(
                eq(s.memberships.teamId, teamId),
                eq(s.memberships.humanId, target.id),
              ),
            )
            .limit(1)
        )[0] === undefined
      )
        throw new DomainError('not-found');
    } else {
      const agent = (
        await q()
          .select()
          .from(s.agents)
          .where(and(eq(s.agents.id, target.id), eq(s.agents.teamId, teamId)))
          .limit(1)
      )[0];
      if (agent?.lifecycle !== 'active') throw new DomainError('not-found');
    }
    if (
      joined &&
      (await participantView(teamId, channelId, target)).state !== 'joined'
    )
      throw new DomainError('not-found');
  }
  function mutation<T>(
    p: Principal,
    teamId: TeamId,
    target: string,
    kind: string,
    input: z.infer<typeof Mutation>,
    schema: z.ZodType<T>,
    effect: () => Promise<T>,
  ) {
    Mutation.parse({ operationKey: input.operationKey });
    const scope = JSON.stringify([teamId, memberKey(member(p)), target, kind]);
    return receipt(scope, input.operationKey, input, schema, effect);
  }
  return { team, access, person, participantView, validTarget, mutation };
}
export type ChannelAccess = ReturnType<typeof channelAccess>;
