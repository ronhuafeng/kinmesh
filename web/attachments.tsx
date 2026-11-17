import {
  ATTACHMENT_MOST_BYTES,
  ATTACHMENTS_PER_MESSAGE,
  Attachment,
  INLINE_TYPES,
  fileSize,
} from '../src/domain/attachments.js';

export { fileSize };
import { HttpError, api } from './api.js';
import { FileIcon } from './icons.js';

export const inline = (type: string) =>
  (INLINE_TYPES as readonly string[]).includes(type);
/** A file on its way into the composer, then attached to what is sent. */
export interface Pending {
  key: string;
  file: File;
  /** Whether it looks like an image, to hold an image's square for it. */
  image: boolean;
  state: 'uploading' | 'ready' | 'failed';
  /** Why it can't be attached, in the person's words. */
  problem: string | null;
  attachment: Attachment | null;
}
const TOO_LARGE = '超过 25 MB';
/** Files dropped, pasted or chosen, as many as a message may still carry. */
export function pendingOf(files: Iterable<File>, already: number): Pending[] {
  return [...files]
    .slice(0, Math.max(0, ATTACHMENTS_PER_MESSAGE - already))
    .map((file) => ({
      key: crypto.randomUUID(),
      file,
      image: file.type.startsWith('image/'),
      state: file.size > ATTACHMENT_MOST_BYTES ? 'failed' : 'uploading',
      problem: file.size > ATTACHMENT_MOST_BYTES ? TOO_LARGE : null,
      attachment: null,
    }));
}
/** Uploads one file to the channel; its key makes a retry the same upload. */
export async function upload(channelPath: string, pending: Pending) {
  const query = new URLSearchParams({
    operationKey: pending.key,
    name: pending.file.name || 'file',
  });
  try {
    return Attachment.parse(
      await api(`${channelPath}/attachments?${query.toString()}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: pending.file,
        signal: AbortSignal.timeout(120_000),
      }),
    );
  } catch (cause) {
    throw cause instanceof HttpError && cause.status === 413
      ? new Error('团队的文件空间已满')
      : cause;
  }
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
