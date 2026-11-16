import { once } from 'node:events';
import { existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AgentId, TeamId } from '../domain/contracts.js';
import type { Principal, Scope } from '../domain/agents.js';
import { DomainError } from '../domain/errors.js';
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
  chooseCredential,
  credentialIn,
  saveCredential,
  signInEnded,
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
  t3DeploymentFile,
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
  /**
   * The deployment connects T3 (KINMESH_T3_ENDPOINT) with a session of its
   * own; a person may still sign in, to that T3, to let runs go further.
   */
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
  // A person's sign-in; the deployment's session is kept apart from it.
  const credentialFile = t3AuthFile(hub.directory);
  const sessions = (endpoint: string) => ({
    person: credentialIn(credentialFile, endpoint),
    deployment: credentialIn(t3DeploymentFile(hub.directory), endpoint),
  });
  /** The credential agents' runs use now (`chooseCredential`), if any. */
  const runCredential = (endpoint: string) => {
    const { person, deployment } = sessions(endpoint);
    return chooseCredential([person, deployment]);
  };
  /** The team's T3 connection and any sign-in under way. */
  const t3Status = async (caller: Principal, teamId: TeamId) => {
    const connection = await store.managed.connection(caller, teamId);
    const held = connection && sessions(connection.endpoint);
    // What runs use; when T3 honours nothing, the sign-in that ended.
    const credential =
      held &&
      (chooseCredential([held.person, held.deployment]) ??
        held.person ??
        held.deployment);
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
        // The mode chosen for the credential runs use: they launch in it, or
        // the broadest below it their provider runs. Null when unknown.
        ceiling: credential?.ceiling ?? null,
        // T3 honours no credential: agents wait until someone signs in.
        expired: credential !== null && signInEnded(credential),
      },
      signIn: flow?.teamId === teamId ? flow.state : null,
      pasteCallback: hub.pasteCallback,
      provisioned: hub.provisioned,
    };
    return { ...status, revision: fingerprint(status) };
  };
  /**
   * A person's T3 sign-in as it waits on every person of the team: from a
   * week before it ends, until someone signs in again, with the mode runs
   * fall back to once it has ended (the deployment's session), if any. The
   * deployment renews its own session, so nobody is asked for that; only a
   * session it no longer provides is.
   */
  const renewal = async (caller: Principal, teamId: TeamId) => {
    const connection = await store.managed.connection(caller, teamId);
    if (!connection) return null;
    const { person, deployment } = sessions(connection.endpoint);
    const now = Date.now();
    const ending = person ?? (hub.provisioned ? null : deployment);
    if (ending?.expiresAt === undefined) return null;
    if (Date.parse(ending.expiresAt) - now > RENEW_BEFORE_MS) return null;
    return {
      endpoint: connection.endpoint,
      expiresAt: ending.expiresAt,
      expired: signInEnded(ending, now),
      fallback:
        ending === person &&
        deployment !== null &&
        !signInEnded(deployment, now)
          ? (deployment.ceiling ?? 'approval-required')
          : null,
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
    const connected = await store.managed.connection(p, teamId);
    // Beside the deployment's session, a person signs in to the same T3.
    if (hub.provisioned && connected?.endpoint !== endpoint)
      return reply
        .code(409)
        .send({ error: 'Sign in to the T3 the deployment connects' });
    if (hub.pasteCallback && new URL(endpoint).protocol !== 'https:')
      return reply.code(400).send({ error: 'T3 must be reached over HTTPS' });
    if (flow?.state === 'waiting') throw new DomainError('conflict');
    // Never replace an approved credential without being asked to.
    if (existsSync(credentialFile) && !replace)
      throw new DomainError('conflict');
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
      throw new DomainError('conflict');
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
    if (connection === null) throw new DomainError('conflict');
    try {
      const credential = runCredential(connection.endpoint);
      if (credential === null) throw new Error('No credential');
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
  return { t3Status, renewal, runCredential };
}
