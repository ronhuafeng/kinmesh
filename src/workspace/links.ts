import type { Reference } from '../domain/execution.js';

/**
 * T3's web app, where T3 links a thread whichever endpoint serves it
 * (`https://app.t3.codes/threads/<environment>/<thread>`).
 */
export const T3_APP_ORIGIN = 'https://app.t3.codes';
/** A link T3 gave is shown only on its own origin or T3's web app. */
export const trustedLinkOrigin = (link: string, t3Origin: string) =>
  [t3Origin, T3_APP_ORIGIN].includes(new URL(link).origin);
/**
 * Validate an actually supplied browser link to exactly this thread
 * (`/<environment>/<thread>`, or under `/threads`); never synthesize one
 * from IDs.
 */
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
    if (segments.length === 3 && segments[0] === 'threads') segments.shift();
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
