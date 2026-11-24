import { generateKeyPairSync } from 'node:crypto';
import { managedDirectory, writeGitHubApp } from '../src/runtime/managed.js';
import type { taskFixture } from './task-helpers.js';

/**
 * Connects the team's GitHub as a person would have, on GitHub's pages:
 * the app it created, then the installation it chose, on account `acme`.
 */
export async function connectGitHub(
  f: Awaited<ReturnType<typeof taskFixture>>,
  installation: number,
) {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  writeGitHubApp(managedDirectory(f.config.state), {
    appId: 4242,
    slug: 'kinmesh-test',
    pem: privateKey.export({ type: 'pkcs1', format: 'pem' }),
  });
  await f.store.githubConnections.created(
    f.principal,
    f.teamId,
    'kinmesh-test',
  );
  await f.store.githubConnections.installed(
    f.principal,
    f.teamId,
    installation,
    'acme',
  );
}
