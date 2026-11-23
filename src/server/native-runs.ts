import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AgentId, TeamId } from '../domain/contracts.js';
import { DomainError } from '../domain/errors.js';
import type { Store } from '../persistence/store.js';

import type { ReadRun } from './run-reader.js';

/** What T3 says of an agent's run, read for a person of the team. */
export function registerNativeRuns(
  app: FastifyInstance,
  store: Store,
  readRun: ReadRun,
) {
  app.get(
    '/api/teams/:teamId/agents/:agentId/executions/:executionId/native',
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const principal = request.principal;
      if (principal?.kind !== 'human') throw new DomainError('forbidden');
      const { teamId, agentId, executionId } = z
        .strictObject({
          teamId: TeamId,
          agentId: AgentId,
          executionId: z.uuid(),
        })
        .parse(request.params);
      z.strictObject({}).parse(request.query);
      // Do not mask Kinmesh authorization denials as external-service outages.
      const correlation = await store.agents.getCorrelation(
        principal,
        teamId,
        agentId,
        executionId,
      );
      try {
        const observation = await readRun(
          principal,
          teamId,
          correlation.reference,
        );
        // Access may have changed while the external read was in flight.
        await store.agents.getCorrelation(
          principal,
          teamId,
          agentId,
          executionId,
        );
        return observation;
      } catch (error) {
        if (error instanceof DomainError) throw error;
        // A concurrent Kinmesh access loss still takes precedence over an upstream outage.
        await store.agents.getCorrelation(
          principal,
          teamId,
          agentId,
          executionId,
        );
        // External OAuth/permission failures are never Kinmesh session expiry.
        return reply.code(503).send({ error: 'Native T3 status unavailable' });
      }
    },
  );
}
