import type { Store } from '../persistence/store.js';
import { attachmentStore } from '../persistence/attachment-store.js';
import type { TeamConfig } from './config.js';
import { registerErrors } from './errors.js';
import { registerGuards } from './guards.js';
import { createTeamHttp } from './http.js';
import { registerMcp } from './mcp-route.js';
import { registerShutdown } from './shutdown.js';

/** Team MCP's server, composed. */
export async function createTeamApp(config: TeamConfig, store: Store) {
  const files = attachmentStore(config.files);
  const app = await createTeamHttp();
  registerErrors(app);
  registerGuards(app, store, config);
  registerMcp(app, store, config, files);
  registerShutdown(app, store);
  await app.ready();
  return app;
}
