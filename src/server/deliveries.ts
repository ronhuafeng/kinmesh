import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TeamId } from '../domain/contracts.js';
import { DomainError } from '../domain/errors.js';
import type { Store } from '../persistence/store.js';

import { Mutation } from '../domain/communication.js';
import { principal } from './principals.js';
import type { ReadRun } from './run-reader.js';

const TeamPath = z.strictObject({ teamId: TeamId });
/**
 * A delivery a person acts on: where T3 shows its run, resuming one that is
 * blocked, and ending one.
 */
export function registerDeliveries(
  app: FastifyInstance,
  store: Store,
  readRun: ReadRun,
) {
  /**
   * Where T3 shows a delivery's run, for going there to approve what it waits
   * for: its thread on the team's T3 origin, or null before it is in T3.
   */
  app.get(
    '/api/teams/:teamId/deliveries/:deliveryId/link',
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const principal = request.principal;
      if (principal?.kind !== 'human') throw new DomainError('forbidden');
      const { teamId, deliveryId } = z
        .strictObject({ teamId: TeamId, deliveryId: z.uuid() })
        .parse(request.params);
      z.strictObject({}).parse(request.query);
      const run = await store.inbox.runOf(principal, teamId, deliveryId);
      if (run === null) return { url: null };
      try {
        const { verifiedUrl } = await readRun(principal, teamId, run);
        // Access may have changed while T3 was read.
        await store.inbox.runOf(principal, teamId, deliveryId);
        return { url: verifiedUrl };
      } catch (error) {
        if (error instanceof DomainError) throw error;
        await store.inbox.runOf(principal, teamId, deliveryId);
        return reply.code(503).send({ error: 'Native T3 status unavailable' });
      }
    },
  );
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
}
