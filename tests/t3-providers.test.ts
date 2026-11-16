import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchMode, runnable } from '../src/adapters/t3/contracts.js';

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

/**
 * Agents run in the mode the person chose for the grant, or the broadest
 * mode below it that the provider runs; never above the ceiling.
 */
await test('a launch runs in the grant’s ceiling when the provider runs it, and never above it', () => {
  const every = provider({
    runtimeModes: [
      'approval-required',
      'auto-accept-edits',
      'auto',
      'full-access',
    ],
  });
  // Full access: nothing waits for an approval.
  assert.equal(launchMode(every, 'full-access'), 'full-access');
  assert.equal(launchMode(every, 'auto'), 'auto');
  assert.equal(launchMode(every, 'auto-accept-edits'), 'auto-accept-edits');
  assert.equal(launchMode(every, 'approval-required'), 'approval-required');
  // T3 naming no modes for a provider: the ceiling.
  assert.equal(launchMode(provider(), 'full-access'), 'full-access');
  assert.equal(
    launchMode(provider(), 'approval-required'),
    'approval-required',
  );
  // A provider without Auto (pi): the broadest below it that it runs.
  const pi = provider({
    runtimeModes: ['approval-required', 'auto-accept-edits', 'full-access'],
  });
  assert.equal(launchMode(pi, 'full-access'), 'full-access');
  assert.equal(launchMode(pi, 'auto'), 'auto-accept-edits');
  // Nothing at or below the ceiling: the provider is not offered.
  assert.equal(
    launchMode(provider({ runtimeModes: ['full-access'] }), 'auto'),
    null,
  );
  assert.equal(
    launchMode(provider({ runtimeModes: ['auto'] }), 'approval-required'),
    null,
  );
  assert.equal(
    launchMode(
      provider({ constraints: ['Provider instance is disabled.'] }),
      'auto',
    ),
    null,
  );
});
