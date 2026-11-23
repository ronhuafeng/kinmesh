import { teamConfig } from './config.js';
import { createTeamApp } from './app.js';
import { openStore } from '../persistence/store.js';
import { reportFailure } from '../diagnostics.js';

/**
 * Team MCP's process: its configuration and store, listening on loopback,
 * and closed on a signal.
 */
export async function runTeamMcp() {
  try {
    const config = teamConfig(process.env);
    const app = await createTeamApp(config, await openStore(config.database));
    for (const signal of ['SIGTERM', 'SIGINT'])
      process.once(signal, () => {
        void app.close();
      });
    try {
      await app.listen({ host: '127.0.0.1', port: config.port });
    } catch (error) {
      await app.close();
      throw new Error('Listener unavailable', { cause: error });
    }
    console.info('Kinmesh Team MCP ready on configured loopback port.');
  } catch (error) {
    console.error(
      'Team MCP startup failed. Check private configuration and listener availability.',
    );
    reportFailure('team_mcp_startup_failed', error);
    process.exitCode = 1;
  }
}
