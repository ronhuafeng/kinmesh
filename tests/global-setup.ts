import { startTestDatabase } from './database.js';

/** node --test: one PostgreSQL for the whole run. */
let database: Awaited<ReturnType<typeof startTestDatabase>> | undefined;
export async function globalSetup() {
  database = await startTestDatabase();
}
export async function globalTeardown() {
  await database?.stop();
}
