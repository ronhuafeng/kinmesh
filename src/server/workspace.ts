import type { FastifyInstance } from 'fastify';
import { DomainError } from '../domain/errors.js';
import { WorkspaceQuery } from '../workspace/contracts.js';

import type { WorkspaceReader } from './workspace-reader.js';

/**
 * The workspace a person reads; any write through this hub forgets the
 * snapshots shared until then, as its announcement may still be on its way.
 */
export function registerWorkspace(
  app: FastifyInstance,
  reader: WorkspaceReader,
) {
  const { snapshot, forget } = reader;
  app.addHook('onSend', (request, _reply, payload, done) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') forget();
    done(null, payload);
  });
  app.get('/api/workspace', (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const principal = request.principal;
    if (principal?.kind !== 'human') throw new DomainError('forbidden');
    return snapshot(principal, WorkspaceQuery.parse(request.query), true);
  });
}
