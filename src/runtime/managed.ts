import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { AgentId } from '../domain/contracts.js';

/**
 * Secrets the hub manages for its own worker live in one private directory
 * in its state directory: never in the database, logs or responses.
 */
export function managedDirectory(state: string) {
  // Anchor at the real path, so a symlinked ancestor (macOS /var) is not
  // mistaken for a symlinked private directory.
  const parent = resolve(state);
  return join(existsSync(parent) ? realpathSync(parent) : parent, 'managed');
}
/** A person's T3 sign-in, approved from the workspace. */
export const t3AuthFile = (directory: string) =>
  join(directory, 't3-oauth.json');
/** The T3 session the deployment issued for the hub, kept apart from it. */
export const t3DeploymentFile = (directory: string) =>
  join(directory, 't3-deployment.json');
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
/** The hub's Web Push (VAPID) keys: made once, then kept. */
export const pushKeysFile = (directory: string) =>
  join(directory, 'push-keys.json');
const PushKeys = z.strictObject({
  publicKey: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
  privateKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export function pushKeys(
  directory: string,
  make: () => z.infer<typeof PushKeys>,
) {
  privateDirectory(directory);
  const path = pushKeysFile(directory);
  if (!existsSync(path)) {
    const temporary = path + '.' + randomUUID() + '.tmp';
    try {
      writeFileSync(temporary, JSON.stringify(PushKeys.parse(make())), {
        mode: 0o600,
        flag: 'wx',
      });
      // Only if none is there yet: keys once made are never replaced.
      linkSync(temporary, path);
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'EEXIST'
      ))
        throw error;
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  return PushKeys.parse(JSON.parse(readFileSync(path, 'utf8')));
}
