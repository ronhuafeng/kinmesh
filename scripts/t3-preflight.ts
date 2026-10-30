import { preflight } from '../src/adapters/t3/preflight.js';

try {
  if (process.argv.length !== 2) throw new Error('Unexpected arguments');
  await preflight(process.env.KINMESH_T3_ENDPOINT ?? '');
  console.info(
    'T3_PREFLIGHT PASS: public network, issuer and capability readiness only; OAuth authentication not verified.',
  );
} catch {
  console.error(
    'T3_PREFLIGHT FAIL: public readiness not verified; no OAuth authentication attempted.',
  );
  process.exitCode = 1;
}
