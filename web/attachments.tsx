import {
  ATTACHMENT_MOST_BYTES,
  ATTACHMENTS_PER_MESSAGE,
  Attachment,
  INLINE_TYPES,
  fileSize,
} from '../src/domain/attachments.js';

import { z } from 'zod';
import { HttpError, api, request } from './api.js';
import { FileIcon } from './icons.js';

export const inline = (type: string) =>
  (INLINE_TYPES as readonly string[]).includes(type);
/** A file on its way into the composer, then attached to what is sent. */
export interface Pending {
  key: string;
  file: File;
  /** Whether it looks like an image, to hold an image's square for it. */
  image: boolean;
  /** Queued: waits its turn, files go up one at a time. */
  state: 'queued' | 'uploading' | 'ready' | 'failed';
  /** How much of the file the server has, 0 to 1, while it uploads. */
  progress: number;
  /** Why it can't be attached, in the person's words. */
  problem: string | null;
  attachment: Attachment | null;
}
const TOO_LARGE = '超过 200 MB';
/** Files dropped, pasted or chosen, as many as a message may still carry. */
export function pendingOf(files: Iterable<File>, already: number): Pending[] {
  return [...files]
    .slice(0, Math.max(0, ATTACHMENTS_PER_MESSAGE - already))
    .map((file) => ({
      key: crypto.randomUUID(),
      file,
      image: file.type.startsWith('image/'),
      state: file.size > ATTACHMENT_MOST_BYTES ? 'failed' : 'queued',
      progress: 0,
      problem: file.size > ATTACHMENT_MOST_BYTES ? TOO_LARGE : null,
      attachment: null,
    }));
}
/** An upload that sends nothing for this long has stalled. */
const STALL_MS = 60_000;
const FAILED = '没有传上去';
const Digest = z.object({ hex: z.string(), base64: z.string() });
/**
 * The file's SHA-256 (hex for the hub, base64 for the store), worked out in
 * a worker so a large file never holds up the page.
 */
function digest(file: File, signal: AbortSignal) {
  return new Promise<z.infer<typeof Digest>>((resolve, reject) => {
    const worker = new Worker(new URL('./hash-worker.ts', import.meta.url), {
      type: 'module',
    });
    const done = () => {
      worker.terminate();
      signal.removeEventListener('abort', cancel);
    };
    const cancel = () => {
      done();
      reject(new Error(FAILED));
    };
    worker.onmessage = (event: MessageEvent<unknown>) => {
      done();
      const parsed = Digest.safeParse(event.data);
      if (parsed.success) resolve(parsed.data);
      else reject(new Error(FAILED));
    };
    worker.onerror = cancel;
    signal.addEventListener('abort', cancel, { once: true });
    worker.postMessage(file);
  });
}
/**
 * Uploads one file to the channel, reporting how much of it has gone (0 to 1,
 * whole percents); its key makes a retry the same upload. The browser puts
 * the bytes in the store itself, where the hub said, then registers them.
 */
export async function upload(
  channelPath: string,
  pending: Pending,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<Attachment> {
  const sha256 = await digest(pending.file, signal);
  try {
    const { url } = Upload.parse(
      await request(`${channelPath}/attachments/uploads`, {
        sha256: sha256.hex,
        size: pending.file.size,
      }),
    );
    if (url !== null)
      await put(url, pending.file, sha256.base64, onProgress, signal);
    return Attachment.parse(
      await api(`${channelPath}/attachments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          operationKey: pending.key,
          name: pending.file.name || 'file',
          sha256: sha256.hex,
        }),
        // The store keeps a large file under its hash before this answers.
        signal,
        timeout: 60_000,
      }),
    );
  } catch (cause) {
    throw cause instanceof HttpError && cause.status === 413
      ? new Error('团队的文件空间已满')
      : cause;
  }
}
const Upload = z.object({ url: z.url().nullable() });
/**
 * PUTs the file to the store. `fetch` can't tell how far a request body has
 * gone, so this is the one request that isn't.
 */
function put(
  url: string,
  file: File,
  checksum: string,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
) {
  return new Promise<void>((resolve, reject) => {
    const failed = new Error(FAILED);
    const request = new XMLHttpRequest();
    let stall = 0;
    let percent = -1;
    const arm = () => {
      window.clearTimeout(stall);
      stall = window.setTimeout(() => {
        request.abort();
      }, STALL_MS);
    };
    const cancel = () => {
      request.abort();
    };
    const end = () => {
      window.clearTimeout(stall);
      signal.removeEventListener('abort', cancel);
    };
    request.open('PUT', url);
    // The store checks the bytes against it, and refuses others.
    request.setRequestHeader('x-amz-checksum-sha256', checksum);
    request.upload.onprogress = (event) => {
      arm();
      if (!event.lengthComputable) return;
      const now = Math.floor((event.loaded / event.total) * 100);
      if (now === percent) return;
      percent = now;
      onProgress(now / 100);
    };
    request.onload = () => {
      end();
      if (request.status >= 200 && request.status < 300) resolve();
      else reject(failed);
    };
    request.onerror = request.onabort = () => {
      end();
      reject(failed);
    };
    signal.addEventListener('abort', cancel, { once: true });
    arm();
    request.send(file);
  });
}
/**
 * A message's files: images as they are, at most 240 px tall, each taking
 * its place before it loads; other files as a row with name and size that
 * downloads it.
 */
export function MessageFiles({
  files,
  base,
}: {
  files: Attachment[];
  /** The channel's attachments path. */
  base: string;
}) {
  const images = files.filter((f) => inline(f.type));
  const others = files.filter((f) => !inline(f.type));
  return (
    <>
      {images.length > 0 && (
        <ul className="message-images" aria-label="图片">
          {images.map((f) => (
            <li key={f.id}>
              <a href={`${base}/${f.id}`} target="_blank" rel="noopener">
                <img
                  src={`${base}/${f.id}`}
                  alt={f.name}
                  width={f.width ?? undefined}
                  height={f.height ?? undefined}
                  loading="lazy"
                  decoding="async"
                />
              </a>
            </li>
          ))}
        </ul>
      )}
      {others.length > 0 && (
        <ul className="message-files" aria-label="文件">
          {others.map((f) => (
            <li key={f.id}>
              <a
                className="file-row"
                href={`${base}/${f.id}`}
                download={f.name}
              >
                <FileIcon size={20} />
                <span className="file-name">{f.name}</span>
                <span className="file-size">{fileSize(f.size)}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
