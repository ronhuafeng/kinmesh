import { openStore } from '../../src/persistence/store.js';
const path = process.argv[2];
const id = process.argv[3];
if (path === undefined || id === undefined)
  throw new Error('Missing fixture arguments');
const store = openStore(path);
process.once('message', () => {
  process.send?.(
    store.operations.claim(id, true) === undefined ? 'busy' : 'claimed',
  );
});
process.send?.('ready');
// Parent kills the process to exercise abandoned durable lease recovery.
setInterval(() => {
  /* Hold the fixture process until SIGKILL. */
}, 1000);
