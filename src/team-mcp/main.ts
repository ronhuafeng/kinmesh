import { teamConfig } from './config.js';
import { createTeamApp } from './app.js';
import { openStore } from '../persistence/store.js';
process.umask(0o077);
try {
  const config = teamConfig(process.env);
  const app = await createTeamApp(config, openStore(config.database));
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.once(signal, () => {
      void app.close();
    });
  try {
    await app.listen({ host: '127.0.0.1', port: config.port });
  } catch {
    await app.close();
    throw new Error('Listener unavailable');
  }
  console.info('Kinmesh Team MCP ready on configured loopback port.');
} catch {
  console.error(
    'Team MCP startup failed. Check private configuration and listener availability.',
  );
  process.exitCode = 1;
}
