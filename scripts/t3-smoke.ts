import { z } from 'zod';
import { Endpoint, loadCredential } from '../src/adapters/t3/oauth.js';
import { SdkWire } from '../src/adapters/t3/sdk.js';
import { readSmoke } from '../src/adapters/t3/smoke.js';
let wire: SdkWire | undefined;
try {
  const config = z
    .object({
      KINMESH_T3_ENDPOINT: Endpoint,
      KINMESH_T3_AUTH_FILE: z.string().min(1),
    })
    .parse(process.env);
  const credential = loadCredential(
    config.KINMESH_T3_AUTH_FILE,
    config.KINMESH_T3_ENDPOINT,
  );
  wire = new SdkWire(credential);
  const result = await readSmoke(wire, credential);
  await wire.close();
  wire = undefined;
  console.info(
    result.operate
      ? 'T3_SDK_SMOKE PASS: reads verified; Supervised operate scope present, mutations NOT exercised.'
      : 'T3_SDK_SMOKE PASS: reads verified; read-only grant, no operate scope.',
  );
} catch {
  console.error(
    'T3_SDK_SMOKE FAIL: approved private credential, matching environment and supported capabilities required. No model was invoked.',
  );
  process.exitCode = 1;
} finally {
  try {
    await wire?.close();
  } catch {
    process.exitCode = 1;
  }
}
