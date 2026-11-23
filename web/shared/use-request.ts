import { useContext, useRef, useState } from 'react';
import { FAILED, MutationPermission, HttpError, request } from './api.js';

/**
 * Unkeyed requests, one at a time, with what went wrong in the person's
 * terms (by HTTP status, else the fallback). Each resolves to the server's
 * answer (null for no content), or undefined when it failed or wasn't sent;
 * the caller decides what follows.
 */
export function useRequest(
  messages: Partial<Record<number, string>> = {},
  fallback = FAILED,
) {
  const permitted = useContext(MutationPermission);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const running = useRef(false);
  async function run<T>(work: () => Promise<T>): Promise<T | undefined> {
    if (!permitted || running.current) return undefined;
    running.current = true;
    setBusy(true);
    setError('');
    try {
      return await work();
    } catch (cause) {
      setError(
        (cause instanceof HttpError ? messages[cause.status] : undefined) ??
          fallback,
      );
      return undefined;
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return {
    busy,
    error,
    setError,
    permitted,
    disabled: !permitted || busy,
    run,
    send: (...args: Parameters<typeof request>) => run(() => request(...args)),
  };
}
