import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { deliveryScopes, inboxIntent } from '../src/domain/inbox.js';
import { WORKER_GRANT } from '../src/server/connect.js';

await test('inbox launch identity is exactly what the 0009 immutability trigger matches', () => {
  const sql = readFileSync(
    new URL('../drizzle/0009_refreeze_undispatched.sql', import.meta.url),
    'utf8',
  );
  const match =
    /actor = '([^']*)' \|\| OLD\.agent_id AND operation_key = '([^']*)' \|\| OLD\.id/.exec(
      sql,
    );
  assert.ok(match, 'trigger still matches the launch operation identity');
  const [, actor, operationKey] = match;
  const agentId = randomUUID();
  const deliveryId = randomUUID();
  assert.deepEqual(inboxIntent(agentId, deliveryId), {
    actor: (actor ?? '') + agentId,
    operationKey: (operationKey ?? '') + deliveryId,
  });
});

await test('the managed worker grant holds every scope a delivery needs', () => {
  const granted: readonly string[] = WORKER_GRANT.scopes;
  for (const scope of deliveryScopes(true))
    assert.ok(granted.includes(scope), scope);
  assert.ok(
    deliveryScopes(false).every((scope) =>
      deliveryScopes(true).includes(scope),
    ),
  );
});
