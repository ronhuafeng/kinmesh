import type { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  ATTACHMENT_MOST_BYTES,
  AttachmentId,
  INLINE_TYPES,
  cleanName,
  sniff,
} from '../domain/attachments.js';
import { ChannelId, TeamId } from '../domain/contracts.js';
import type { FileRemover } from '../inbox/space.js';
import { OperationKey } from '../domain/communication.js';
import { DomainError } from '../domain/errors.js';
import type { Store } from '../persistence/store.js';
import type { AttachmentStore } from '../persistence/attachment-store.js';
import { principal } from './principals.js';

const ChannelPath = z.object({ teamId: TeamId, channelId: ChannelId });
const FilePath = ChannelPath.extend({ attachmentId: AttachmentId });
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const Upload = z.strictObject({
  sha256: Sha256,
  size: z.number().int().nonnegative(),
});
const Register = z.strictObject({
  operationKey: OperationKey,
  name: z.string().min(1).max(1000),
  sha256: Sha256,
});
/** `filename*` for any name, and a plain fallback for old clients. */
const disposition = (kind: 'inline' | 'attachment', name: string) =>
  `${kind}; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;
/**
 * A person uploads a file to a joined channel, then posts a message with it:
 * the browser hashes it, asks where to put it, puts it in the store itself
 * and registers it here, so its bytes never pass through the hub.
 */
export function registerAttachments(
  app: FastifyInstance,
  store: Store,
  files: AttachmentStore,
  room: number,
) {
  const base = '/api/teams/:teamId/channels/:channelId/attachments';
  app.post(base + '/uploads', async (request) => {
    const { teamId, channelId } = ChannelPath.parse(request.params);
    const file = Upload.parse(request.body);
    if (file.size > ATTACHMENT_MOST_BYTES) throw new DomainError('too-large');
    await store.communication.mayUpload(
      principal(request),
      teamId,
      channelId,
      file,
      room,
    );
    return { url: await files.uploadUrl(file.sha256, file.size) };
  });
  app.post(base, async (request, reply) => {
    const { teamId, channelId } = ChannelPath.parse(request.params);
    const { operationKey, name, sha256 } = Register.parse(request.body);
    const attachment = await store.communication.upload(
      principal(request),
      teamId,
      channelId,
      { operationKey, name: cleanName(name), sha256 },
      room,
      {
        // What the store holds, never what the browser said.
        describe: async () => {
          const found = await files.find(sha256);
          if (found === null) throw new DomainError('invalid');
          if (found.size > ATTACHMENT_MOST_BYTES)
            throw new DomainError('too-large');
          return { size: found.size, ...sniff(found.head) };
        },
        keep: () => files.keep(sha256),
      },
    );
    return reply.code(201).send(attachment);
  });
  // A person joined to the channel removes a file from its message.
  app.post(base + '/:attachmentId/remove', async (request) => {
    const { teamId, channelId, attachmentId } = FilePath.parse(request.params);
    const { sha256, ...removal } = await store.communication.removeAttachment(
      principal(request),
      teamId,
      channelId,
      attachmentId,
      z.strictObject({ operationKey: OperationKey }).parse(request.body),
    );
    await store.communication.release(sha256, () => files.remove(sha256));
    return removal;
  });
  // The files of every channel the person is in, newest first.
  app.get('/api/teams/:teamId/files', async (request) => {
    const { teamId } = z.object({ teamId: TeamId }).parse(request.params);
    const { before, channelId } = z
      .strictObject({
        before: z.coerce.number().int().positive().optional(),
        channelId: ChannelId.optional(),
      })
      .parse(request.query);
    return store.communication.files(
      principal(request),
      teamId,
      before ?? null,
      50,
      channelId ?? null,
    );
  });
  /**
   * What a person types in search, found in the channels they are in:
   * messages whose text holds it and files whose name does, newest first.
   */
  app.get('/api/teams/:teamId/search', async (request) => {
    const { teamId } = z.object({ teamId: TeamId }).parse(request.params);
    const { q } = z
      .strictObject({ q: z.string().trim().min(2).max(100) })
      .parse(request.query);
    const p = principal(request);
    const [messages, files] = await Promise.all([
      store.communication.searchMessages(p, teamId, q),
      store.communication.files(p, teamId, null, 10, null, q),
    ]);
    return { messages, files: files.items };
  });
  app.get(base + '/:attachmentId', async (request, reply) => {
    const { teamId, channelId, attachmentId } = FilePath.parse(request.params);
    const { attachment, sha256 } = await store.communication.attachment(
      principal(request),
      teamId,
      channelId,
      attachmentId,
    );
    const range = byteRange(request.headers.range, attachment.size);
    if (range === 'unsatisfiable')
      return reply
        .code(416)
        .header('content-range', `bytes */${String(attachment.size)}`)
        .send();
    const body = await files.read(sha256, range ?? undefined);
    if (range !== null)
      reply
        .code(206)
        .header(
          'content-range',
          `bytes ${String(range.start)}-${String(range.end)}/${String(attachment.size)}`,
        );
    const length =
      range === null ? attachment.size : range.end - range.start + 1;
    return serve(reply, attachment, body, length);
  });
}
/**
 * The part of a file a `Range` header asks for: one range of bytes, inclusive.
 * Null is the whole file (no header, or one this does not serve, such as
 * several ranges); past the end is unsatisfiable.
 */
export function byteRange(header: string | undefined, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
  if (!match) return null;
  const [, first = '', last = ''] = match;
  if (first === '' && last === '') return null;
  if (size === 0) return 'unsatisfiable';
  const range =
    first === ''
      ? { start: Math.max(0, size - Number(last)), end: size - 1 }
      : {
          start: Number(first),
          end: Math.min(size - 1, last === '' ? size - 1 : Number(last)),
        };
  if (range.start >= size || range.end < range.start) return 'unsatisfiable';
  return range;
}
function serve(
  reply: FastifyReply,
  file: { name: string; type: string },
  body: Readable,
  length: number,
) {
  const inline = (INLINE_TYPES as readonly string[]).includes(file.type);
  return (
    reply
      .header('content-type', file.type)
      .header('content-length', length)
      .header('accept-ranges', 'bytes')
      .header(
        'content-disposition',
        disposition(inline ? 'inline' : 'attachment', file.name),
      )
      .header('x-content-type-options', 'nosniff')
      // Opened on its own, it can run nothing and reach nothing.
      .header('content-security-policy', "default-src 'none'; sandbox")
      // An attachment's bytes never change.
      .header('cache-control', 'private, max-age=31536000, immutable')
      .send(body)
  );
}
/**
 * Uploads no message took within a day go, and bytes nothing refers to any
 * more with them. Every hour, and once at start.
 */
export function sweepAttachments(
  store: Store,
  files: AttachmentStore,
  failed: (error: unknown) => void,
) {
  const sweep = async () => {
    try {
      for (const sha256 of await store.communication.sweepUnbound(Date.now()))
        await store.communication.release(sha256, () => files.remove(sha256));
    } catch (error) {
      failed(error);
    }
  };
  void sweep();
  const timer = setInterval(() => void sweep(), 60 * 60 * 1000);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
}
/**
 * Removed files' copies leave their channels' folders: asked of the
 * provisioner every minute until it has removed each.
 */
export function unplaceAttachments(
  store: Store,
  remove: FileRemover,
  failed: (error: unknown) => void,
) {
  const stopping = new AbortController();
  const round = async () => {
    try {
      await unplaceOnce(store, remove, stopping.signal);
    } catch (error) {
      if (!stopping.signal.aborted) failed(error);
    }
  };
  void round();
  const timer = setInterval(() => void round(), 60_000);
  timer.unref();
  return () => {
    clearInterval(timer);
    stopping.abort();
  };
}
/** One round: each queued copy, removed and then forgotten. */
export async function unplaceOnce(
  store: Store,
  remove: FileRemover,
  signal: AbortSignal,
) {
  for (const row of await store.communication.unplacings()) {
    await remove(row.directory, row.attachmentId, signal);
    await store.communication.unplaced(row.attachmentId);
  }
}
