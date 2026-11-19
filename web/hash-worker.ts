/**
 * A file's SHA-256, off the page: read a part at a time so no copy of it is
 * held, hex for the hub and base64 for the store.
 */
import { sha256 } from '@noble/hashes/sha2.js';

addEventListener('message', (event: MessageEvent<File>) => {
  void (async () => {
    try {
      const hash = sha256.create();
      const reader = event.data.stream().getReader();
      for (
        let part = await reader.read();
        !part.done;
        part = await reader.read()
      )
        hash.update(part.value);
      const bytes = hash.digest();
      postMessage({
        hex: Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''),
        base64: btoa(String.fromCharCode(...bytes)),
      });
    } catch {
      postMessage(null);
    }
  })();
});
