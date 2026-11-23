import {
  ForwardInput,
  HoursInput,
  PAUSE_MOST_MS,
  PauseInput,
} from '../domain/notify.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DomainError } from '../domain/errors.js';
import type { Store } from '../persistence/store.js';
import { humanOf } from './principals.js';

const Id = z.strictObject({ id: z.string().regex(/^[\w-]{16}$/) });
/**
 * What a person's own settings read and do about themselves: their profile
 * as Feishu gives it, their sessions, the browsers notifying them, and a
 * message from the team's Feishu bot to see that it reaches them.
 */
export function registerMe(app: FastifyInstance, store: Store) {
  app.get('/api/me/profile', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const humanId = humanOf(request);
    const [profile, team] = await Promise.all([
      store.sessions.profile(humanId),
      store.teamFor(humanId),
    ]);
    if (!profile || !team) throw new DomainError('forbidden');
    return { ...profile, team: team.team.name };
  });
  app.get('/api/me/sessions', (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return store.sessions.list(
      humanOf(request),
      request.session.get('session'),
      Date.now(),
    );
  });
  app.post('/api/me/session/end', async (request, reply) => {
    const ended = await store.sessions.end(
      humanOf(request),
      Id.parse(request.body).id,
      Date.now(),
    );
    return reply.code(ended ? 204 : 404).send();
  });
  // Sign out everywhere: every session of yours ends, this one included.
  app.post('/api/me/sessions/end', async (request, reply) => {
    const principal = request.principal;
    if (principal?.kind !== 'human') throw new DomainError('forbidden');
    await store.browsers.signedOutEverywhere(principal.humanId);
    await store.sessions.revokeAll(principal.humanId, Date.now());
    request.session.delete();
    return reply.code(204).send();
  });
  app.put('/api/me/pause', async (request, reply) => {
    const humanId = humanOf(request);
    const { until } = PauseInput.parse(request.body);
    const at = until === null ? null : Date.parse(until);
    if (at !== null && (at <= Date.now() || at > Date.now() + PAUSE_MOST_MS))
      throw new DomainError('invalid');
    const team = await store.teamFor(humanId);
    if (!team) throw new DomainError('forbidden');
    await store.quiet.pause(humanId, team.team.id, at);
    return reply.code(204).send();
  });
  app.put('/api/me/hours', async (request, reply) => {
    const humanId = humanOf(request);
    const { hours } = HoursInput.parse(request.body);
    const team = await store.teamFor(humanId);
    if (!team) throw new DomainError('forbidden');
    await store.quiet.hours(humanId, team.team.id, hours);
    return reply.code(204).send();
  });
  app.put('/api/me/forward', async (request, reply) => {
    const humanId = humanOf(request);
    const { minutes } = ForwardInput.parse(request.body);
    const team = await store.teamFor(humanId);
    if (!team) throw new DomainError('forbidden');
    await store.quiet.forwardAfter(humanId, team.team.id, minutes);
    return reply.code(204).send();
  });
}
