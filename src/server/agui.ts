import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AgentId, TeamId } from '../domain/contracts.js';
import { DomainError } from '../domain/errors.js';
import { executionEvent } from '../workspace/contracts.js';

import type { WorkspaceReader } from './workspace-reader.js';

/** An agent's runs as an AG-UI execution event, for a person of the team. */
export function registerAgui(app: FastifyInstance, reader: WorkspaceReader) {
  const { runs } = reader;
  app.get('/api/agui/:teamId/:memberId', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    z.strictObject({}).parse(request.query);
    const { teamId, memberId } = z
      .strictObject({ teamId: TeamId, memberId: AgentId })
      .parse(request.params);
    const principal = request.principal;
    if (principal?.kind !== 'human') throw new DomainError('forbidden');
    return executionEvent(await runs(principal, teamId, memberId));
  });
}
