import { startTestDatabase, startTestStore } from '../database.js';

/** Playwright: one PostgreSQL and one store for the whole run, stopped by the returned teardown. */
export default async function globalSetup() {
  const [database, store] = await Promise.all([
    startTestDatabase(),
    startTestStore(),
  ]);
  return async () => {
    await Promise.all([database.stop(), store.stop()]);
  };
}
