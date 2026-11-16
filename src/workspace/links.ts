import type { Reference } from '../domain/execution.js';

/** A link to T3 is shown only on the team's T3 origin. */
export const trustedLinkOrigin = (link: string, t3Origin: string) =>
  new URL(link).origin === t3Origin;
/**
 * Where T3's web UI, served on its endpoint's origin, opens this thread:
 * `<origin>/<environment>/<thread>`, each ID one encoded path segment.
 */
export const threadLink = (origin: string, reference: Reference) =>
  nativeThreadUrl(
    `${origin}/${encodeURIComponent(reference.environmentId)}/${encodeURIComponent(reference.threadId)}`,
    reference,
  );
/** Validate a browser link to exactly this thread (`/<environment>/<thread>`). */
export function nativeThreadUrl(
  candidate: unknown,
  reference: Reference,
): string | null {
  if (typeof candidate !== 'string' || candidate.length > 4096) return null;
  try {
    const url = new URL(candidate);
    if (
      url.href !== candidate ||
      /[\\?#\s]/u.test(candidate) ||
      url.username !== '' ||
      url.password !== '' ||
      !(
        url.protocol === 'https:' ||
        (url.protocol === 'http:' &&
          ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
      )
    )
      return null;
    const segments = url.pathname.split('/').slice(1);
    if (segments.length !== 2) return null;
    const ids = segments.map((segment) => decodeURIComponent(segment));
    if (
      ids.some((id) => id === '.' || id === '..' || /[/\\\s\p{Cc}]/u.test(id))
    )
      return null;
    return ids[0] === reference.environmentId && ids[1] === reference.threadId
      ? url.href
      : null;
  } catch {
    return null;
  }
}
