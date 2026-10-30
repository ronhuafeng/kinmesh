import type { Reference } from '../domain/execution.js';

/** Validate an actually supplied browser link; never synthesize one from IDs. */
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
    const segments = url.pathname.split('/');
    if (segments.length !== 3) return null;
    const ids = segments.slice(1).map((segment) => decodeURIComponent(segment));
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
