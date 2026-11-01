import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runnable } from '../src/adapters/t3/contracts.js';

const provider = (overrides: object = {}) => ({
  providerInstanceId: 'p',
  driverKind: 'codex',
  models: [{ id: 'm' }],
  canRunChildTask: true,
  constraints: [] as string[],
  ...overrides,
});

await test('only providers T3 can run a wake on are offered', () => {
  assert.equal(runnable(provider(), 'approval-required'), true);
  // Switched off in T3: listed by T3, but nothing can run there.
  assert.equal(
    runnable(
      provider({ constraints: ['Provider instance is disabled.'] }),
      'approval-required',
    ),
    false,
  );
  assert.equal(
    runnable(provider({ canRunChildTask: false }), 'approval-required'),
    false,
  );
  assert.equal(
    runnable(provider({ runtimeModes: ['auto'] }), 'approval-required'),
    false,
  );
  assert.equal(
    runnable(
      provider({ runtimeModes: ['approval-required', 'auto'] }),
      'approval-required',
    ),
    true,
  );
});
