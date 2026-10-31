import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { tmpdir } from 'node:os';

/** This lane executes only the owner's manual, hosted, exact-main dispatch. */
export function requireLiveDispatch(): void {
  if (!process.env.GITHUB_ACTIONS) return;
  const env = process.env;
  const owner = env.GITHUB_REPOSITORY_OWNER;
  if (
    env.GITHUB_ACTIONS !== 'true' ||
    env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    env.GITHUB_REF !== 'refs/heads/main' ||
    !owner ||
    env.GITHUB_ACTOR !== owner ||
    env.GITHUB_TRIGGERING_ACTOR !== owner ||
    env.RUNNER_ENVIRONMENT !== 'github-hosted'
  )
    throw new Error('OWNER_HOSTED_MAIN_DISPATCH_REQUIRED');
}

/** No shared desktop state or externally supplied directory is eligible. */
export function requireDisposableRoot(root: string): void {
  const stat = lstatSync(root);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realpathSync(root) !== root ||
    dirname(root) !== realpathSync(tmpdir()) ||
    !/^kinmesh-live-[A-Za-z0-9]+$/.test(basename(root)) ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error('PRIVATE_DISPOSABLE_ROOT_REQUIRED');
}
