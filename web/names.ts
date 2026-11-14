import type { z } from 'zod';
import type { Author } from '../src/domain/agents.js';
import type { WorkspaceSnapshot } from '../src/workspace/contracts.js';

/** A member of the team by kind and ID, however a record writes it. */
export interface Someone {
  kind: 'human' | 'agent';
  id: string;
}
export function someoneOf(who: Someone | z.infer<typeof Author>): Someone {
  if ('id' in who) return who;
  return who.kind === 'human'
    ? { kind: 'human', id: who.humanId }
    : { kind: 'agent', id: who.agentId };
}
/** A member's name: yours, an agent's, or the plain word for its kind. */
export function memberName(
  who: Someone | z.infer<typeof Author> | null,
  data: WorkspaceSnapshot,
): string {
  if (!who) return 'Unassigned';
  const { kind, id } = someoneOf(who);
  if (kind === 'human')
    return (
      data.people.find((person) => person.id === id)?.username ?? 'Human member'
    );
  return data.agents.find((agent) => agent.id === id)?.name ?? 'Agent member';
}
/**
 * The other people: in the open channel when there is one, otherwise the
 * whole team. You are not among them.
 */
export function otherPeople(data: WorkspaceSnapshot) {
  return data.people.filter(
    (person) =>
      person.id !== data.human.id &&
      (data.channel === null || data.joinedHumanIds.includes(person.id)),
  );
}
/** The agents in the open channel. */
export function joinedAgents(data: WorkspaceSnapshot) {
  return data.agents.filter((agent) => data.joinedAgentIds.includes(agent.id));
}
