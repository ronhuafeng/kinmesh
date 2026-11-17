import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DomainError } from '../domain/errors.js';

/**
 * Where attachments' bytes are kept, by their SHA-256: each is written once,
 * whole or not at all. One interface, so another store (S3-compatible) can
 * stand in without changing the rest.
 */
export interface AttachmentBytes {
  put(sha256: string, bytes: Buffer): Promise<void>;
  get(sha256: string): Promise<Buffer>;
  remove(sha256: string): Promise<void>;
}
/** Bytes in the hub's state directory: `attachments/ab/abcd…`. */
export function directoryBytes(state: string): AttachmentBytes {
  const root = join(state, 'attachments');
  const path = (sha256: string) => {
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new DomainError('invalid');
    return join(root, sha256.slice(0, 2), sha256);
  };
  return {
    async put(sha256, bytes) {
      const target = path(sha256);
      try {
        await stat(target);
        return;
      } catch {
        // Not kept yet.
      }
      await mkdir(join(root, sha256.slice(0, 2)), { recursive: true });
      const partial = target + '.' + randomUUID() + '.partial';
      await writeFile(partial, bytes, { mode: 0o600 });
      await rename(partial, target);
    },
    get: (sha256) => readFile(path(sha256)),
    remove: (sha256) => rm(path(sha256), { force: true }),
  };
}
