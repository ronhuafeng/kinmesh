import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { AgentId } from '../domain/contracts.js';

/**
 * Secrets the hub manages for its own worker live in one private directory
 * beside the database (ADR 0007): never in SQLite, logs or responses.
 */
export function managedDirectory(database: string) {
  // Anchor at the real path, so a symlinked ancestor (macOS /var) is not
  // mistaken for a symlinked private directory.
  const parent = dirname(resolve(database));
  return join(existsSync(parent) ? realpathSync(parent) : parent, 'managed');
}
export const t3AuthFile = (directory: string) =>
  join(directory, 't3-oauth.json');
export const agentTokenFile = (directory: string, agentId: string) =>
  join(directory, 'agents', AgentId.parse(agentId) + '.json');

/** Create (0700) or verify a directory only this OS user can enter. */
export function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    (process.getuid !== undefined && stat.uid !== process.getuid()) ||
    (stat.mode & 0o077) !== 0 ||
    realpathSync(path) !== resolve(path)
  )
    throw new Error('Private directory required');
}
/** Atomically replace a 0600 file; the old content is never half-written. */
function writePrivate(path: string, content: string) {
  privateDirectory(dirname(dirname(path)));
  privateDirectory(dirname(path));
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
export function writeAgentToken(
  directory: string,
  agentId: string,
  token: string,
) {
  writePrivate(agentTokenFile(directory, agentId), JSON.stringify({ token }));
}
export function removeAgentToken(directory: string, agentId: string) {
  rmSync(agentTokenFile(directory, agentId), { force: true });
}
