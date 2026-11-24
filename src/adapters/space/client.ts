import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { ExecutionFailure } from '../../domain/execution.js';
import type { SpaceProvisioner } from './provisioner.js';

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
/**
 * Places a message's file in a channel's folder (its `attachments/`) and
 * answers where, on the T3 machine. Placing the same file again is safe.
 */
export type FilePlacer = (
  directory: string,
  file: { id: string; name: string },
  bytes: { body: Readable; size: number; sha256: string },
  signal: AbortSignal,
) => Promise<string>;
const Placed = z.object({ path: z.string().min(1).max(4096) });
/**
 * A streamed PUT (`fetch` takes no Node stream): its status and the start of
 * what it answered.
 */
function put(
  url: URL,
  headers: Record<string, string>,
  body: Readable,
  signal: AbortSignal,
) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const sent = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      { method: 'PUT', headers, signal },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size <= 65536) chunks.push(chunk);
        });
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        response.on('error', reject);
      },
    );
    sent.on('error', reject);
    pipeline(body, sent).catch(reject);
  });
}
/** The provisioner's `PUT /projects/:directory/attachments/:id`, streamed. */
export function spacePlacer(space: SpaceProvisioner): FilePlacer {
  return async (directory, file, { body, size, sha256 }, signal) => {
    let token = '';
    try {
      token = readFileSync(space.tokenFile, 'utf8').trim();
    } catch {
      // Not there yet: the deployment writes it.
    }
    if (token === '') {
      body.destroy();
      throw new ExecutionFailure('unavailable');
    }
    let response: { status: number; body: string };
    try {
      response = await put(
        new URL(
          `/projects/${encodeURIComponent(directory)}/attachments/${encodeURIComponent(file.id)}`,
          space.endpoint,
        ),
        {
          authorization: `Bearer ${token}`,
          'content-type': 'application/octet-stream',
          'content-length': String(size),
          'x-kinmesh-name': encodeURIComponent(file.name),
          'x-kinmesh-sha256': sha256,
        },
        body,
        // A minute, and a second more for each megabyte.
        AbortSignal.any([signal, AbortSignal.timeout(60_000 + size / 1000)]),
      );
    } catch {
      body.destroy();
      throw new ExecutionFailure(signal.aborted ? 'cancelled' : 'unavailable');
    }
    if (response.status === 401 || response.status === 403)
      throw new ExecutionFailure('permission');
    // Refused (another file under its ID, a name or folder it won't take):
    // placing again won't change it.
    if (response.status >= 400 && response.status < 500)
      throw new ExecutionFailure('incompatible');
    if (response.status < 200 || response.status >= 300)
      throw new ExecutionFailure('unavailable');
    let answer: unknown = null;
    try {
      answer = JSON.parse(response.body);
    } catch {
      // Not JSON: not an answer.
    }
    const placed = Placed.safeParse(answer);
    if (!placed.success) throw new ExecutionFailure('incompatible');
    return placed.data.path;
  };
}
/** Removes a removed file's copy from a channel's folder; gone already is done. */
export type FileRemover = (
  directory: string,
  attachmentId: string,
  signal: AbortSignal,
) => Promise<void>;
/** The provisioner's `DELETE /projects/:directory/attachments/:id`. */
export function spaceRemover(space: SpaceProvisioner): FileRemover {
  return async (directory, attachmentId, signal) => {
    const token = readFileSync(space.tokenFile, 'utf8').trim();
    const response = await fetch(
      new URL(
        `/projects/${encodeURIComponent(directory)}/attachments/${encodeURIComponent(attachmentId)}`,
        space.endpoint,
      ),
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      },
    );
    // A folder it never made holds no copy to remove.
    if (!response.ok && response.status !== 404)
      throw new Error(`provisioner ${String(response.status)}`);
  };
}
/** A pairing code for a browser to reach T3, from beside it. */
export type Pairer = (
  label: string,
  signal: AbortSignal,
) => Promise<{ token: string; expiresAt: string }>;
const Paired = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{4,128}$/),
  expiresAt: z.iso.datetime(),
});
/** The provisioner's `POST /pair`. */
export function spacePairer(space: SpaceProvisioner): Pairer {
  return async (label, signal) => {
    const token = readFileSync(space.tokenFile, 'utf8').trim();
    const response = await fetch(new URL('/pair', space.endpoint), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ label }),
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    if (!response.ok) throw new Error(`provisioner ${String(response.status)}`);
    return Paired.parse(await response.json());
  };
}
/**
 * Each agent's own Codex home beside T3, kept by the provisioner: where it
 * is, and its Kinmesh configuration written there.
 */
export interface CodexHomes {
  home: (agentId: string, signal: AbortSignal) => Promise<string>;
  write: (
    agentId: string,
    teamMcp: { url: string; token: string },
    signal: AbortSignal,
  ) => Promise<string>;
}
const Home = z.object({ home: z.string().min(1).max(4096) });
/** The provisioner's `GET` and `PUT /agents/:agentId/codex`. */
export function spaceCodexHomes(space: SpaceProvisioner): CodexHomes {
  const ask = async (agentId: string, signal: AbortSignal, body?: object) => {
    const token = readFileSync(space.tokenFile, 'utf8').trim();
    const response = await fetch(
      new URL(`/agents/${encodeURIComponent(agentId)}/codex`, space.endpoint),
      {
        method: body === undefined ? 'GET' : 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      },
    );
    if (!response.ok) throw new Error(`provisioner ${String(response.status)}`);
    return Home.parse(await response.json()).home;
  };
  return {
    home: (agentId, signal) => ask(agentId, signal),
    write: (agentId, teamMcp, signal) => ask(agentId, signal, teamMcp),
  };
}
