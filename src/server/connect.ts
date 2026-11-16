import { once } from 'node:events';
import { existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AgentId, TeamId } from '../domain/contracts.js';
import { IdentityError, type Principal, type Scope } from '../domain/agents.js';
import {
  AUTH_TIMEOUT_MS,
  PASTED_AUTH_TIMEOUT_MS,
  authorize,
  callbackReceiver,
  type AuthorizationInteraction,
} from '../adapters/t3/authorization.js';
import {
  Endpoint,
  RENEW_BEFORE_MS,
  loadCredential,
  saveCredential,
  signInEnded,
  type Credential,
} from '../adapters/t3/oauth.js';
import {
  t3Ceiling,
  t3Providers,
  type T3Ceiling,
  type T3Providers,
} from '../adapters/t3/providers.js';
import { Descriptor } from '../adapters/t3/contracts.js';
import {
  privateDirectory,
  removeAgentToken,
  t3AuthFile,
  writeAgentToken,
} from '../inbox/managed.js';
import type { Changes } from './changes.js';
import type { Store } from '../persistence/store.js';
import { fingerprint } from '../persistence/transactional.js';
import { principal } from './principals.js';

/** What the hub does on a person's behalf; replaceable in tests. */
export interface Hub {
  /** Private directory for managed secrets. */
  directory: string;
  /** Start the hub's own Inbox worker if it is not running. */
  ensureWorker: () => Promise<void>;
  authorize: typeof authorize;
  providers: T3Providers;
  /** The grant's ceiling, read once at sign-in. */
  ceiling: T3Ceiling;
  /** The local T3 MCP endpoint, when T3 runs on this machine. */
  discover: () => Promise<string | null>;
  /**
   * Team mode: the hub is reached over HTTPS, so the browser approving T3 is
   * on another computer. T3 is reached over HTTPS too, and its approval
   * returns to that computer's loopback, whose address the person pastes.
   */
  pasteCallback: boolean;
  /** The deployment connects T3 (KINMESH_T3_ENDPOINT); nobody signs in. */
  provisioned: boolean;
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
export const defaultHub = (
  directory: string,
  team: boolean,
  provisioned: boolean,
): Hub => ({
  directory,
  ensureWorker: () => Promise.resolve(),
  authorize,
  providers: t3Providers,
  ceiling: t3Ceiling,
  discover: discoverLocal,
  pasteCallback: team,
  provisioned,
});
/**
 * Scopes the worker uses (docs/collaboration.md, Grants and scopes). It ends
 * 90 days after the hub last renewed it, which the hub does while it serves
 * the agent (docs/security.md, Hub-held worker secrets).
 */
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

/**
 * Connect T3 and agents from the workspace: a person approves T3 in their
 * browser and picks a provider; the hub keeps the secrets and runs the worker.
 */
export function registerConnect(
  app: FastifyInstance,
  store: Store,
  hub: Hub,
  changes: Changes,
) {
  // One sign-in at a time: the OAuth callback port is fixed.
  let flow:
    | {
        teamId: string;
        state: 'waiting' | 'failed';
        stop: AbortController;
        /** Takes the approval's callback URL, pasted by the person. */
        submit?: (url: string) => boolean;
      }
    | undefined;
  const credentialFile = t3AuthFile(hub.directory);
  const credentialFor = (endpoint: string): Credential | null => {
    try {
      return loadCredential(credentialFile, endpoint);
    } catch {
      return null;
    }
  };
  /** The team's T3 connection and any sign-in under way. */
  const t3Status = async (caller: Principal, teamId: TeamId) => {
    const connection = await store.managed.connection(caller, teamId);
    const credential = connection && credentialFor(connection.endpoint);
    // Whether T3 let agents run, or only read: a read-only approval looks
    // connected but every wake would be refused.
    const scopes = credential?.tokens.scope?.split(/\s+/) ?? [];
    const status = {
      connection: connection && {
        endpoint: connection.endpoint,
        environmentId: connection.environmentId,
        connectedAt: new Date(connection.connectedAt).toISOString(),
        access: credential
          ? scopes.includes('orchestration:operate')
            ? ('operate' as const)
            : ('read' as const)
          : null,
        // The mode the person chose on T3's approval page: runs launch in it,
        // or the broadest below it their provider runs. Null when unknown.
        ceiling: credential?.ceiling ?? null,
        // T3 no longer honours the sign-in: agents wait until it is renewed.
        expired: credential !== null && signInEnded(credential),
      },
      signIn: flow?.teamId === teamId ? flow.state : null,
      pasteCallback: hub.pasteCallback,
      provisioned: hub.provisioned,
    };
    return { ...status, revision: fingerprint(status) };
  };
  /**
   * T3's sign-in as it waits on every person of the team: from a week
   * before it ends, until someone signs in again. The deployment renews
   * its own session, so nobody is asked then.
   */
  const renewal = async (caller: Principal, teamId: TeamId) => {
    if (hub.provisioned) return null;
    const connection = await store.managed.connection(caller, teamId);
    const credential = connection && credentialFor(connection.endpoint);
    if (!connection || credential?.expiresAt === undefined) return null;
    const now = Date.now();
    if (Date.parse(credential.expiresAt) - now > RENEW_BEFORE_MS) return null;
    return {
      endpoint: connection.endpoint,
      expiresAt: credential.expiresAt,
      expired: signInEnded(credential, now),
      pasteCallback: hub.pasteCallback,
      signIn: flow?.teamId === teamId ? flow.state : null,
    };
  };
  app.get('/api/teams/:teamId/t3', (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { teamId } = TeamPath.parse(request.params);
    return t3Status(principal(request), teamId);
  });
  /** The T3 desktop app on this machine, if one is running: no URL to find. */
  app.get('/api/teams/:teamId/t3/local', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { teamId } = TeamPath.parse(request.params);
    await store.managed.connection(principal(request), teamId);
    // A T3 on the hub's loopback is out of reach of a browser elsewhere.
    return {
      endpoint:
        hub.pasteCallback || hub.provisioned ? null : await hub.discover(),
    };
  });
  app.post('/api/teams/:teamId/t3/connect', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const p = principal(request);
    const { teamId } = TeamPath.parse(request.params);
    const { endpoint, replace } = z
      .strictObject({ endpoint: Endpoint, replace: z.boolean() })
      .parse(request.body);
    // A person of the team, checked before any file or network access.
    await store.managed.connection(p, teamId);
    if (hub.provisioned)
      return reply
        .code(409)
        .send({ error: 'T3 is connected by the deployment' });
    if (hub.pasteCallback && new URL(endpoint).protocol !== 'https:')
      return reply.code(400).send({ error: 'T3 must be reached over HTTPS' });
    if (flow?.state === 'waiting') throw new IdentityError(409);
    // Never replace an approved credential without being asked to.
    if (existsSync(credentialFile) && !replace) throw new IdentityError(409);
    privateDirectory(hub.directory);
    flow?.stop.abort();
    const stop = new AbortController();
    const current: NonNullable<typeof flow> = {
      teamId,
      state: 'waiting',
      stop,
    };
    flow = current;
    changes.emit();
    const signal = AbortSignal.any([
      stop.signal,
      AbortSignal.timeout(
        hub.pasteCallback ? PASTED_AUTH_TIMEOUT_MS : AUTH_TIMEOUT_MS,
      ),
    ]);
    let shown: (url: string) => void = () => undefined;
    const url = new Promise<string>((done) => {
      shown = done;
    });
    let receiver: ReturnType<typeof callbackReceiver> | undefined;
    const interaction: AuthorizationInteraction = {
      async prepare(state, issuer, s) {
        receiver = callbackReceiver(state, issuer, s);
        current.submit = receiver.submit;
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
      .then(async (credential) => {
        // What the person chose on T3's approval page, so the workspace says
        // how agents run; a sign-in stands without it.
        const ceiling = await hub
          .ceiling(credential, AbortSignal.timeout(3000))
          .catch(() => undefined);
        saveCredential(
          credentialFile,
          ceiling === undefined ? credential : { ...credential, ceiling },
          { replace },
        );
        await store.managed.saveConnection(
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
        changes.emit();
      });
    // The browser opens the approval page itself; nothing is logged.
    const location = await Promise.race([url, done]);
    if (typeof location === 'string') return { authorizationUrl: location };
    return location.outcome === 'failed'
      ? reply.code(502).send({ error: 'T3 sign-in could not start' })
      : { authorizationUrl: null };
  });
  /** The approval's callback URL, pasted from the person's address bar. */
  app.post('/api/teams/:teamId/t3/callback', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { teamId } = TeamPath.parse(request.params);
    const { url } = z
      .strictObject({ url: z.string().max(8192) })
      .parse(request.body);
    await store.managed.connection(principal(request), teamId);
    const current = flow;
    if (current?.teamId !== teamId || current.state !== 'waiting')
      throw new IdentityError(409);
    if (!current.submit?.(url.trim()))
      return reply.code(400).send({ error: 'Not this sign-in’s address' });
    return reply.code(204).send();
  });
  app.get('/api/teams/:teamId/t3/providers', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { teamId } = TeamPath.parse(request.params);
    const connection = await store.managed.connection(
      principal(request),
      teamId,
    );
    if (connection === null) throw new IdentityError(409);
    try {
      const credential = loadCredential(credentialFile, connection.endpoint);
      return {
        // A healthy T3 answers in well under a second; a failed read is
        // simply read again, so nobody waits long on one that is down.
        providers: await hub.providers(credential, AbortSignal.timeout(3000)),
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
      const issued = await store.managed.connect(
        p,
        teamId,
        agentId,
        choice,
        WORKER_GRANT,
      );
      if (issued !== null)
        try {
          writeAgentToken(hub.directory, agentId, issued.token);
        } catch {
          await store.managed.disconnect(p, teamId, agentId);
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
    async (request, reply) => {
      const { teamId, agentId } = AgentPath.parse(request.params);
      await store.managed.disconnect(principal(request), teamId, agentId);
      removeAgentToken(hub.directory, agentId);
      return reply.code(204).send();
    },
  );
  return { t3Status, renewal };
}
