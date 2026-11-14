import { startTestDatabase } from '../database.js';

/** Playwright: one PostgreSQL for the whole run, stopped by the returned teardown. */
export default async function globalSetup() {
  const database = await startTestDatabase();
  return database.stop;
}
