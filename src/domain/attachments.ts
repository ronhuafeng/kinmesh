import { z } from 'zod';

export const AttachmentId = z.uuid().brand<'AttachmentId'>();
export type AttachmentId = z.infer<typeof AttachmentId>;
/** The most one file may hold. */
export const ATTACHMENT_MOST_BYTES = 200 * 1024 * 1024;
/** The most files one message carries. */
export const ATTACHMENTS_PER_MESSAGE = 10;
/** How long an upload no message took is kept. */
export const UNBOUND_KEEP_MS = 24 * 60 * 60 * 1000;
/** The types a browser may show inline; everything else downloads. */
export const INLINE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;
/** A file attached to a message, as everyone joined sees it. */
export const Attachment = z.strictObject({
  id: AttachmentId,
  name: z.string().min(1).max(255),
  /** Decided by the server from the content, never the client's claim. */
  type: z.string().min(1).max(100),
  size: z.number().int().nonnegative().max(ATTACHMENT_MOST_BYTES),
  /** An image's pixels, so it takes its place before it loads. */
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
});
export type Attachment = z.infer<typeof Attachment>;
/**
 * A file name as kept and offered for download: the last path segment, no
 * control characters, at most 255 characters with its extension kept.
 */
export function cleanName(name: string) {
  const last = name.split(/[/\\]/).at(-1) ?? '';
  const plain = last.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const kept = plain === '' || plain === '.' || plain === '..' ? 'file' : plain;
  if (kept.length <= 255) return kept;
  const dot = kept.lastIndexOf('.');
  const extension = dot > 0 && kept.length - dot <= 16 ? kept.slice(dot) : '';
  return kept.slice(0, 255 - extension.length) + extension;
}
const uint16 = (b: Uint8Array, at: number, little = false) =>
  little
    ? (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8)
    : ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
const uint24le = (b: Uint8Array, at: number) =>
  (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16);
const uint32 = (b: Uint8Array, at: number) =>
  uint16(b, at) * 0x10000 + uint16(b, at + 2);
const ascii = (b: Uint8Array, at: number, length: number) =>
  String.fromCharCode(...b.subarray(at, at + length));
const size = (width: number, height: number) =>
  width > 0 && height > 0 ? { width, height } : { width: null, height: null };
/** A JPEG's size, from its first start-of-frame marker. */
function jpegSize(b: Uint8Array) {
  let at = 2;
  while (at + 9 < b.length) {
    if (b[at] !== 0xff) return size(0, 0);
    const marker = b[at + 1] ?? 0;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    const length = uint16(b, at + 2);
    // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      ![0xc4, 0xc8, 0xcc].includes(marker)
    )
      return size(uint16(b, at + 7), uint16(b, at + 5));
    at += 2 + length;
  }
  return size(0, 0);
}
function webpSize(b: Uint8Array) {
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8X') return size(uint24le(b, 24) + 1, uint24le(b, 27) + 1);
  if (chunk === 'VP8L') {
    const bits =
      (b[21] ?? 0) |
      ((b[22] ?? 0) << 8) |
      ((b[23] ?? 0) << 16) |
      ((b[24] ?? 0) << 24);
    return size((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (chunk === 'VP8 ')
    return size(uint16(b, 26, true) & 0x3fff, uint16(b, 28, true) & 0x3fff);
  return size(0, 0);
}
/**
 * What a file is, from its first bytes: the raster images a browser may
 * show (with their size), PDF, or bytes to download. A name or a claimed
 * type never decides it, so HTML or SVG named `.png` is never an image.
 */
export function sniff(b: Uint8Array): {
  type: string;
  width: number | null;
  height: number | null;
} {
  const starts = (...bytes: number[]) => bytes.every((v, i) => b[i] === v);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
    return { type: 'image/png', ...size(uint32(b, 16), uint32(b, 20)) };
  if (starts(0xff, 0xd8, 0xff)) return { type: 'image/jpeg', ...jpegSize(b) };
  if (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')
    return {
      type: 'image/gif',
      ...size(uint16(b, 6, true), uint16(b, 8, true)),
    };
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP')
    return { type: 'image/webp', ...webpSize(b) };
  if (ascii(b, 0, 5) === '%PDF-')
    return { type: 'application/pdf', width: null, height: null };
  return { type: 'application/octet-stream', width: null, height: null };
}
/** What stands for a message with no text: its files' names. */
export const filesText = (names: string[]) => names.join('、');
/** 2.4 MB, 380 KB, 12 B: one decimal under ten, none above. */
export function fileSize(bytes: number) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const shown =
    unit === 0 || value >= 10 ? Math.round(value) : value.toFixed(1);
  return `${String(shown)} ${units[unit] ?? 'B'}`;
}
