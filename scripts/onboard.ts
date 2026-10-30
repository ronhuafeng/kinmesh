import { input, password } from '@inquirer/prompts';
import { BootstrapInput } from '../src/domain/contracts.js';
import { loadConfig } from '../src/server/config.js';
// Interactive local setup: masked password, no credentials in arguments, logs, or source.
try {
  const config = loadConfig(process.env);
  const values = BootstrapInput.parse({
    username: await input({
      message: 'Owner username (lowercase, 3–64 characters):',
    }),
    password: await password({
      message: 'Owner password (15–128 characters):',
      mask: '*',
    }),
    teamName: await input({ message: 'Team name:' }),
  });
  const response = await fetch(
    `http://127.0.0.1:${String(config.port)}/api/setup`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.setupToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(values),
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!response.ok) throw new Error('Setup rejected');
  console.info(
    'Owner, team and general channel created. Sign in using the owner credentials.',
  );
} catch {
  console.error(
    'Onboarding failed or cancelled. Check input, server availability and one-time setup status.',
  );
  process.exitCode = 1;
}
