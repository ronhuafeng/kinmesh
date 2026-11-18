import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { Endpoint, loadCredential } from '../src/adapters/t3/oauth.js';
import { SdkWire } from '../src/adapters/t3/sdk.js';
import { readSmoke } from '../src/adapters/t3/smoke.js';
import { issuedCredential } from '../src/server/provision.js';
let wire: SdkWire | undefined;
try {
  // A person's sign-in (`npm run t3:auth`), or a session T3 issued, as the
  // deployment gives the hub.
  const config = z
    .object({
      KINMESH_T3_ENDPOINT: Endpoint,
      KINMESH_T3_AUTH_FILE: z.string().min(1).optional(),
      KINMESH_T3_CREDENTIAL_FILE: z.string().min(1).optional(),
    })
    .refine(
      (c) =>
        (c.KINMESH_T3_AUTH_FILE === undefined) !==
        (c.KINMESH_T3_CREDENTIAL_FILE === undefined),
    )
    .parse(process.env);
  const credential =
    config.KINMESH_T3_CREDENTIAL_FILE === undefined
      ? loadCredential(
          config.KINMESH_T3_AUTH_FILE ?? '',
          config.KINMESH_T3_ENDPOINT,
        )
      : await issuedCredential(
          readFileSync(config.KINMESH_T3_CREDENTIAL_FILE, 'utf8'),
          config.KINMESH_T3_ENDPOINT,
        );
  wire = new SdkWire(credential);
  const result = await readSmoke(wire, credential);
  await wire.close();
  wire = undefined;
  const modes = result.modes.map((m) => `${m.providerId} ${m.mode}`).join(', ');
  console.info(
    result.operate
      ? `T3_SDK_SMOKE PASS: reads verified; operate scope present, ceiling ${result.ceiling}, runs launch in: ${modes || 'none'}; mutations NOT exercised.`
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
