import { releasePlanFromEnvironment } from './release-live-config.js';
import { preflightStage, runRelease, runStage } from './release-live-runner.js';

process.umask(0o077);
try {
  const stages = releasePlanFromEnvironment(process.env);
  await runRelease(
    stages,
    { preflight: preflightStage, run: runStage },
    process.env,
  );
  console.info(
    'RELEASE_NATIVE_GATES PASS: all three independent native stages passed.',
  );
} catch {
  console.error(
    'RELEASE_NATIVE_GATES FAIL: private independent fixtures, grants, capabilities and all native stages are mandatory. Retain reserved fixtures for owner reconciliation; no live acceptance claimed.',
  );
  process.exitCode = 1;
}
