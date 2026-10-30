import { once } from 'node:events';
import open from 'open';
import { z } from 'zod';
import {
  Endpoint,
  credentialDestination,
  saveCredential,
} from '../src/adapters/t3/oauth.js';
import {
  authorize,
  callbackReceiver,
  AUTH_TIMEOUT_MS,
  type AuthorizationInteraction,
} from '../src/adapters/t3/authorization.js';
import { manualTerminal, requireManualTerminal } from './t3-auth-terminal.js';

process.umask(0o077);
const stopping = new AbortController();
const timer = setTimeout(() => {
  stopping.abort();
}, AUTH_TIMEOUT_MS);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    stopping.abort();
  });
let receiver: ReturnType<typeof callbackReceiver> | undefined;
let terminal: ReturnType<typeof manualTerminal> | undefined;
try {
  const config = z
    .object({
      KINMESH_T3_ENDPOINT: Endpoint,
      KINMESH_T3_AUTH_FILE: z.string().min(1),
      KINMESH_T3_AUTH_MODE: z.enum(['browser', 'manual']).default('browser'),
    })
    .parse(process.env);
  if (process.argv.length !== 2) throw new Error('Unexpected arguments');
  if (config.KINMESH_T3_AUTH_MODE === 'manual') requireManualTerminal();
  // Refuse existing targets before any registration/consent. Never rotate a shared grant implicitly.
  credentialDestination(config.KINMESH_T3_AUTH_FILE);
  let interaction: AuthorizationInteraction;
  if (config.KINMESH_T3_AUTH_MODE === 'manual') {
    terminal = manualTerminal();
    interaction = terminal.interaction;
  } else
    interaction = {
      async prepare(state, issuer, signal) {
        receiver = callbackReceiver(state, issuer, signal);
        receiver.server.listen(49871, '127.0.0.1');
        await once(receiver.server, 'listening', { signal });
        return { code: receiver.code };
      },
      async redirect(url, signal) {
        signal.throwIfAborted();
        await open(url.href, { wait: false });
        console.info(
          'Approve in your local browser. Choose Read only or Supervised, NEVER Full access.',
        );
      },
    };
  const credential = await authorize(
    config.KINMESH_T3_ENDPOINT,
    interaction,
    stopping.signal,
  );
  saveCredential(config.KINMESH_T3_AUTH_FILE, credential, { replace: false });
  console.info(
    'T3_AUTH PASS: new private OAuth credential saved; no model was invoked.',
  );
} catch (error) {
  console.error(
    error instanceof Error &&
      error.message === 'Private interactive terminal required'
      ? 'T3_AUTH FAIL: manual mode requires an owner-run private interactive terminal; no sign-in started.'
      : 'T3_AUTH FAIL: private interactive browser/terminal, new private destination and timely owner approval required. Restart fresh after failure; no URL or credential is logged.',
  );
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  stopping.abort();
  terminal?.close();
  receiver?.server.closeAllConnections();
  receiver?.server.close();
}
