import assert from 'node:assert/strict';
import { z } from 'zod';
import type { Config } from '../src/server/config.js';
import { createApp } from '../src/server/app.js';
import {
  Agent,
  Correlation,
  Grant,
  ProfileInput,
  type Principal,
  type GrantInput,
} from '../src/domain/agents.js';
import { fixture } from './helpers.js';
export const profileInput = ProfileInput.parse({
  name: 'Developer',
  role: 'developer',
  capabilities: ['coding', 'review'],
  preferences: {
    environmentId: 'env-one',
    providerId: 'codex',
    modelId: 'model-one',
  },
  memoryLocation: 'file:///private/agent-notes',
});
export const grantInput = {
  label: 'test-only',
  scopes: ['agents:read', 'executions:read', 'executions:write'],
  lifetimeSeconds: 3600,
} satisfies GrantInput;
export const correlationInput = {
  reference: {
    backend: 't3',
    environmentId: 'env-one',
    threadId: 'thread-one',
    runId: 'run-one',
  },
  providerSessionId: 'provider-session-one',
  invocationId: 'invocation-one',
} as const;
export const Issued = z.strictObject({ grant: Grant, token: z.string() });
export async function agentFixture(overrides: Partial<Config> = {}) {
  const f = fixture();
  f.config = { ...f.config, ...overrides };
  const store = f.open();
  const app = await createApp(f.config, store);
  const input = {
    username: 'owner',
    password: 'a long owner test password',
    teamName: 'Team',
  };
  const setup = await app.inject({
    method: 'POST',
    url: '/api/setup',
    headers: { authorization: `Bearer ${f.config.setupToken}` },
    payload: input,
  });
  assert.equal(setup.statusCode, 201);
  const owner = store.credentials('owner');
  assert.ok(owner);
  const team = store.teamFor(owner.id);
  assert.ok(team);
  const principal: Principal = { kind: 'human', humanId: owner.id };
  const login = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { username: input.username, password: input.password },
  });
  const cookie = login.cookies[0];
  assert.ok(cookie);
  const cookies = { [cookie.name]: cookie.value };
  const base = `/api/teams/${team.team.id}/agents`;
  const created = await app.inject({
    method: 'POST',
    url: base,
    cookies,
    payload: profileInput,
  });
  assert.equal(created.statusCode, 201);
  const agent = Agent.parse(created.json<unknown>());
  const path = base + '/' + agent.id;
  const issued = await app.inject({
    method: 'POST',
    url: path + '/grants',
    cookies,
    payload: grantInput,
  });
  assert.equal(issued.statusCode, 201);
  const grant = Issued.parse(issued.json<unknown>());
  const headers = { authorization: 'Bearer ' + grant.token };
  return {
    ...f,
    dbPath: f.path,
    store,
    app,
    owner,
    teamId: team.team.id,
    principal,
    cookies,
    base,
    agent,
    path,
    grant,
    headers,
    async execution() {
      const response = await app.inject({
        method: 'POST',
        url: path + '/executions',
        headers,
        payload: correlationInput,
      });
      assert.equal(response.statusCode, 201);
      return Correlation.parse(response.json<unknown>());
    },
    async dispose() {
      await app.close();
      f.cleanup();
    },
  };
}
