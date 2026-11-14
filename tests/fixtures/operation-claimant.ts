import { openStore } from '../../src/persistence/store.js';
const path = process.argv[2];
const id = process.argv[3];
if (path === undefined || id === undefined)
  throw new Error('Missing fixture arguments');
const store = await openStore(path);
process.once('message', () => {
  void store.operations.claim(id, true).then((claimed) => {
    process.send?.(claimed === undefined ? 'busy' : 'claimed');
  });
});
process.send?.('ready');
// Parent kills the process to exercise abandoned durable lease recovery.
setInterval(() => {
  /* Hold the fixture process until SIGKILL. */
}, 1000);
