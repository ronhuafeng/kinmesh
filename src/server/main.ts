import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openStore } from '../persistence/store.js';

process.umask(0o077);
try {
  const config = loadConfig(process.env);
  const store = openStore(config.database);
  const app = await createApp(config, store);
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
  console.info('Kinmesh Team Hub ready on configured loopback port.');
} catch {
  console.error(
    'Kinmesh startup failed. Check local configuration and database availability.',
  );
  process.exitCode = 1;
}
