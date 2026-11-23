import type { Attachment } from '../../src/domain/attachments.js';
import { fileSize } from '../../src/domain/attachments.js';
import { FileIcon } from '../shared/icons.js';
import { inline } from '../shared/attachments.js';

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
