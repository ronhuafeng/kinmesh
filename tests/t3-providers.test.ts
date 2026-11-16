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
 * Agents run in T3's Auto when the grant allows it, else in the broadest
 * mode below it that the grant and provider allow; never above either.
 */
await test('a launch runs in Auto when the ceiling allows it, and never above the ceiling or Auto', () => {
  const every = provider({
    runtimeModes: [
      'approval-required',
      'auto-accept-edits',
      'auto',
      'full-access',
    ],
  });
  assert.equal(launchMode(every, 'auto'), 'auto');
  // A broader ceiling still launches in Auto, not Full access.
  assert.equal(launchMode(every, 'full-access'), 'auto');
  // A lower ceiling: the broadest mode it allows.
  assert.equal(launchMode(every, 'auto-accept-edits'), 'auto-accept-edits');
  assert.equal(launchMode(every, 'approval-required'), 'approval-required');
  // T3 naming no modes for a provider: the ceiling, up to Auto.
  assert.equal(launchMode(provider(), 'auto'), 'auto');
  assert.equal(
    launchMode(provider(), 'approval-required'),
    'approval-required',
  );
  // A provider without Auto (pi): the broadest below it that it runs.
  const pi = provider({
    runtimeModes: ['approval-required', 'auto-accept-edits', 'full-access'],
  });
  assert.equal(launchMode(pi, 'auto'), 'auto-accept-edits');
  assert.equal(launchMode(pi, 'full-access'), 'auto-accept-edits');
  // Nothing at or below the ceiling and Auto: the provider is not offered.
  assert.equal(
    launchMode(provider({ runtimeModes: ['full-access'] }), 'full-access'),
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
