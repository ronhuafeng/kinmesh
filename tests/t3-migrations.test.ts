import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { migrateTo } from './migration-helpers.js';
import { fixture } from './helpers.js';
import { reference } from './t3-helpers.js';

await test('execution lease migration preserves populated legacy journal, keys, authority fingerprint and provisional/terminal outcomes', () => {
  const f = fixture();
  const rows = (
    ['prepared', 'dispatching', 'uncertain', 'known', 'rejected'] as const
  ).map((phase) => ({
    id: randomUUID(),
    scope: 'legacy-scope',
    actor: 'trusted-owner',
    operationKey: phase,
    requestId: randomUUID(),
    fingerprint: 'persisted-payload-and-authority-hash',
    tool: 't3_thread_launch',
    payload: '{"scratch":true}',
    phase,
    reference: ['dispatching', 'known'].includes(phase)
      ? JSON.stringify(reference)
      : null,
    rejection: phase === 'rejected' ? 'permission' : null,
  }));
  const raw = new Database(f.path);
  try {
    migrateTo(raw, f.directory, 5);
    for (const r of rows)
      raw
        .prepare(
          'INSERT INTO execution_operations (id,scope,actor,operation_key,request_id,fingerprint,tool,payload,phase,reference,rejection) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          r.id,
          r.scope,
          r.actor,
          r.operationKey,
          r.requestId,
          r.fingerprint,
          r.tool,
          r.payload,
          r.phase,
          r.reference,
          r.rejection,
        );
  } finally {
    raw.close();
  }
  let store = f.open();
  try {
    for (const r of rows) {
      assert.deepEqual(store.operations.get(r.id), {
        ...r,
        generation: 0,
        claimToken: null,
        leaseUntil: 0,
      });
      const claim = store.operations.claim(r.id, true);
      if (r.phase === 'known' || r.phase === 'rejected')
        assert.equal(claim, undefined);
      else {
        assert.ok(claim);
        assert.equal(claim.generation, 1);
        assert.equal(claim.requestId, r.requestId);
        assert.equal(claim.fingerprint, r.fingerprint);
        assert.equal(claim.reference, r.reference);
      }
    }
    store.close();
    store = f.open();
    for (const r of rows) {
      assert.equal(store.operations.get(r.id).requestId, r.requestId);
      assert.equal(
        store.operations.claim(r.id, true),
        undefined,
        'Active and terminal claims survive reopen',
      );
    }
  } finally {
    store.close();
    f.cleanup();
  }
});
