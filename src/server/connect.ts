import { once } from 'node:events';
import { existsSync } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AgentId, TeamId } from '../domain/contracts.js';
import { IdentityError, type Scope } from '../domain/agents.js';
import {
  AUTH_TIMEOUT_MS,
  authorize,
  callbackReceiver,
  type AuthorizationInteraction,
} from '../adapters/t3/authorization.js';
import {
  Endpoint,
  loadCredential,
  saveCredential,
} from '../adapters/t3/oauth.js';
import { t3Providers, type T3Providers } from '../adapters/t3/providers.js';
import { Descriptor } from '../adapters/t3/contracts.js';
import {
  privateDirectory,
  removeAgentToken,
  t3AuthFile,
  writeAgentToken,
} from '../inbox/managed.js';
import type { Store } from '../persistence/store.js';

/** What the hub does on the owner's behalf; replaceable in tests. */
export interface Hub {
  /** Private directory for managed secrets (ADR 0007). */
  directory: string;
  /** Start the hub's own Inbox worker if it is not running. */
  ensureWorker: () => Promise<void>;
  authorize: typeof authorize;
  providers: T3Providers;
  /** The local T3 MCP endpoint, when T3 runs on this machine. */
  discover: () => Promise<string | null>;
}
/** T3 desktop's fixed loopback address; only this one address is probed. */
const LOCAL_T3 = 'http://127.0.0.1:3773';
async function discoverLocal() {
  try {
    const response = await fetch(LOCAL_T3 + '/.well-known/t3/environment', {
      redirect: 'error',
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return null;
    Descriptor.parse(await response.json());
    return LOCAL_T3 + '/mcp';
  } catch {
    return null;
  }
}
export const defaultHub = (directory: string): Hub => ({
  directory,
  ensureWorker: () => Promise.resolve(),
  authorize,
  providers: t3Providers,
  discover: discoverLocal,
});
/** Scopes the worker uses (docs/agent-inbox.md, step 2), for 90 days. */
export const WORKER_GRANT = {
  label: 'Inbox worker (managed)',
  scopes: [
    'channels:read',
    'channels:write',
    'tasks:read',
    'tasks:write',
    'tasks:review',
    'executions:read',
    'executions:write',
  ] satisfies Scope[],
  lifetimeSeconds: 90 * 86400,
};
const TeamPath = z.object({ teamId: TeamId });
const AgentPath = TeamPath.extend({ agentId: AgentId });
function principal(request: FastifyRequest) {
  if (request.principal === null) throw new IdentityError(401);
  return request.principal;
}

/**
 * Connect T3 and agents from the workspace: the owner approves T3 in their
 * browser and picks a provider; the hub keeps the secrets and runs the worker.
 */
export function registerConnect(app: FastifyInstance, store: Store, hub: Hub) {
  // One sign-in at a time: the OAuth callback port is fixed.
  let flow:
    | { teamId: string; state: 'waiting' | 'failed'; stop: AbortController }
    | undefined;
  const credentialFile = t3AuthFile(hub.directory);
  app.get('/api/teams/:teamId/t3', (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { teamId } = TeamPath.parse(request.params);
    const connection = store.managed.connection(principal(request), teamId);
    // Whether T3 let agents run, or only read: a read-only approval looks
    // connected but every wake would be refused.
    let access: 'operate' | 'read' | null = null;
    if (connection)
      try {
        const scopes =
          loadCredential(
            credentialFile,
            connection.endpoint,
          ).tokens.scope?.split(/\s+/) ?? [];
        access = scopes.includes('orchestration:operate') ? 'operate' : 'read';
      } catch {
        access = null;
      }
    return {
      connection: connection && {
        endpoint: connection.endpoint,
        environmentId: connection.environmentId,
        connectedAt: new Date(connection.connectedAt).toISOString(),
        access,
      },
      signIn: flow?.teamId === teamId ? flow.state : null,
    };
  });
  /** The T3 desktop app on this machine, if one is running: no URL to find. */
  app.get('/api/teams/:teamId/t3/local', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { teamId } = TeamPath.parse(request.params);
    store.managed.connection(principal(request), teamId);
    return { endpoint: await hub.discover() };
  });
  app.post('/api/teams/:teamId/t3/connect', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const p = principal(request);
    const { teamId } = TeamPath.parse(request.params);
    const { endpoint, replace } = z
      .strictObject({ endpoint: Endpoint, replace: z.boolean() })
      .parse(request.body);
    // Owner check before any file or network access.
    store.managed.connection(p, teamId);
    if (flow?.state === 'waiting') throw new IdentityError(409);
    // Never replace an approved credential without being asked to.
    if (existsSync(credentialFile) && !replace) throw new IdentityError(409);
    privateDirectory(hub.directory);
    flow?.stop.abort();
    const stop = new AbortController();
    const current = { teamId, state: 'waiting' as const, stop };
    flow = current;
    const signal = AbortSignal.any([
      stop.signal,
      AbortSignal.timeout(AUTH_TIMEOUT_MS),
    ]);
    let shown: (url: string) => void = () => undefined;
    const url = new Promise<string>((done) => {
      shown = done;
    });
    let receiver: ReturnType<typeof callbackReceiver> | undefined;
    const interaction: AuthorizationInteraction = {
      async prepare(state, issuer, s) {
        receiver = callbackReceiver(state, issuer, s);
        receiver.server.listen(49871, '127.0.0.1');
        await once(receiver.server, 'listening', { signal: s });
        return { code: receiver.code };
      },
      redirect(location, s) {
        s.throwIfAborted();
        shown(location.href);
        return Promise.resolve();
      },
    };
    const done = hub
      .authorize(endpoint, interaction, signal)
      .then((credential) => {
        saveCredential(credentialFile, credential, { replace });
        store.managed.saveConnection(
          p,
          teamId,
          endpoint,
          credential.environmentId,
        );
        if (flow === current) flow = undefined;
        return { outcome: 'connected' as const };
      })
      .catch(() => {
        if (flow === current) flow = { ...current, state: 'failed' };
        return { outcome: 'failed' as const };
      })
      .finally(() => {
        receiver?.server.close();
      });
    // The browser opens the approval page itself; nothing is logged.
    const location = await Promise.race([url, done]);
    if (typeof location === 'string') return { authorizationUrl: location };
    return location.outcome === 'failed'
      ? reply.code(502).send({ error: 'T3 sign-in could not start' })
      : { authorizationUrl: null };
  });
  app.get('/api/teams/:teamId/t3/providers', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { teamId } = TeamPath.parse(request.params);
    const connection = store.managed.connection(principal(request), teamId);
    if (connection === null) throw new IdentityError(409);
    try {
      const credential = loadCredential(credentialFile, connection.endpoint);
      return {
        providers: await hub.providers(credential, AbortSignal.timeout(8000)),
      };
    } catch {
      return reply.code(503).send({ error: 'T3 providers unavailable' });
    }
  });
  app.post(
    '/api/teams/:teamId/agents/:agentId/connect',
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const p = principal(request);
      const { teamId, agentId } = AgentPath.parse(request.params);
      const choice = z
        .strictObject({
          providerId: z.string().trim().min(1).max(256),
          modelId: z.string().trim().min(1).max(256),
        })
        .parse(request.body);
      const { token } = store.managed.connect(
        p,
        teamId,
        agentId,
        choice,
        WORKER_GRANT,
      );
      try {
        writeAgentToken(hub.directory, agentId, token);
      } catch {
        store.managed.disconnect(p, teamId, agentId);
        return reply.code(500).send({ error: 'Could not store credential' });
      }
      try {
        await hub.ensureWorker();
      } catch {
        return reply
          .code(503)
          .send({ error: 'Connected; the worker will start with the hub' });
      }
      return { connected: true };
    },
  );
  app.post(
    '/api/teams/:teamId/agents/:agentId/disconnect',
    (request, reply) => {
      const { teamId, agentId } = AgentPath.parse(request.params);
      store.managed.disconnect(principal(request), teamId, agentId);
      removeAgentToken(hub.directory, agentId);
      return reply.code(204).send();
    },
  );
}
