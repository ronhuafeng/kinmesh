import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { ExecutionFailure } from '../domain/execution.js';
import type { SpaceProvisioner } from './config.js';

/**
 * Makes `directory` in the space a T3 project, if it isn't one, and answers
 * its folder on the T3 machine. Asking again for the same directory is safe.
 */
export type Provisioner = (
  directory: string,
  title: string,
  signal: AbortSignal,
) => Promise<string>;
const Provisioned = z.object({ workspaceRoot: z.string().min(1).max(4096) });
/**
 * The deployment's provisioner beside T3 (operations.md#the-space). Its
 * token is read for every request, so a renewed one takes effect at once.
 */
export function spaceProvisioner(space: SpaceProvisioner): Provisioner {
  return async (directory, title, signal) => {
    let token = '';
    try {
      token = readFileSync(space.tokenFile, 'utf8').trim();
    } catch {
      // Not there yet: the deployment writes it.
    }
    if (token === '') throw new ExecutionFailure('unavailable');
    let response: Response;
    try {
      response = await fetch(new URL('/projects', space.endpoint), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ directory, title: title.slice(0, 80) }),
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });
    } catch {
      throw new ExecutionFailure(signal.aborted ? 'cancelled' : 'unavailable');
    }
    if (response.status === 401 || response.status === 403)
      throw new ExecutionFailure('permission');
    if (!response.ok) throw new ExecutionFailure('unavailable');
    const provisioned = Provisioned.safeParse(
      await response.json().catch(() => null),
    );
    if (!provisioned.success) throw new ExecutionFailure('incompatible');
    return provisioned.data.workspaceRoot;
  };
}
