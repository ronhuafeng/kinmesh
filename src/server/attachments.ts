import { createHash } from 'node:crypto';
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
import type { AttachmentBytes } from '../persistence/attachment-bytes.js';
import { principal } from './principals.js';

const ChannelPath = z.object({ teamId: TeamId, channelId: ChannelId });
const FilePath = ChannelPath.extend({ attachmentId: AttachmentId });
const UploadQuery = z.strictObject({
  operationKey: OperationKey,
  name: z.string().min(1).max(1000),
});
/** `filename*` for any name, and a plain fallback for old clients. */
const disposition = (kind: 'inline' | 'attachment', name: string) =>
  `${kind}; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;
/**
 * A person uploads a file to a joined channel, then posts a message with
 * it. Its bytes travel as the request body, its name in the query.
 */
export function registerAttachments(
  app: FastifyInstance,
  store: Store,
  bytes: AttachmentBytes,
  room: number,
) {
  const base = '/api/teams/:teamId/channels/:channelId/attachments';
  // Every type: the server decides what a file is from its content.
  app.register((upload, _options, done) => {
    upload.removeAllContentTypeParsers();
    upload.addContentTypeParser(
      '*',
      { parseAs: 'buffer', bodyLimit: ATTACHMENT_MOST_BYTES },
      (_request, body, parsed) => {
        parsed(null, body);
      },
    );
    upload.post(
      base,
      {
        bodyLimit: ATTACHMENT_MOST_BYTES,
        // Too large is refused from what the request says, before its body.
        onRequest: (request, reply, next) => {
          const length = Number(request.headers['content-length'] ?? NaN);
          if (!Number.isInteger(length))
            return void reply.code(411).send({ error: 'length-required' });
          if (length > ATTACHMENT_MOST_BYTES)
            return void reply.code(413).send({ error: 'too-large' });
          next();
        },
      },
      async (request, reply) => {
        const { teamId, channelId } = ChannelPath.parse(request.params);
        const { operationKey, name } = UploadQuery.parse(request.query);
        const body: unknown = request.body;
        if (!Buffer.isBuffer(body)) throw new DomainError('invalid');
        const sha256 = createHash('sha256').update(body).digest('hex');
        const attachment = await store.communication.upload(
          principal(request),
          teamId,
          channelId,
          {
            operationKey,
            name: cleanName(name),
            size: body.length,
            sha256,
            ...sniff(body),
          },
          room,
          () => bytes.put(sha256, body),
        );
        return reply.code(201).send(attachment);
      },
    );
    done();
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
    await store.communication.release(sha256, () => bytes.remove(sha256));
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
    return serve(reply, attachment, await bytes.get(sha256));
  });
}
function serve(
  reply: FastifyReply,
  file: { name: string; type: string },
  body: Buffer,
) {
  const inline = (INLINE_TYPES as readonly string[]).includes(file.type);
  return (
    reply
      .header('content-type', file.type)
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
  bytes: AttachmentBytes,
  failed: (error: unknown) => void,
) {
  const sweep = async () => {
    try {
      for (const sha256 of await store.communication.sweepUnbound(Date.now()))
        await store.communication.release(sha256, () => bytes.remove(sha256));
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
