import Database from 'better-sqlite3';
import { openStore } from '../../src/persistence/store.js';
const path = process.argv[2];
if (path === undefined) throw new Error('Missing fixture path');
const store = openStore(path);
store.bootstrap('owner', 'fixture-only-hash', 'Committed team');
store.close();
const db = new Database(path);
db.exec("BEGIN IMMEDIATE; UPDATE teams SET name = 'Uncommitted team';");
process.send?.('uncommitted');
// Parent deliberately kills this process without COMMIT/close to test real WAL recovery.
setInterval(() => {
  /* Hold the transaction until SIGKILL. */
}, 1000);
