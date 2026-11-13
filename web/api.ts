import { createContext, useContext, useEffect, useRef, useState } from 'react';

export const MutationPermission = createContext(true);
/** True only while disconnected, as opposed to a brief background refresh. */
export const Offline = createContext(false);
export class HttpError extends Error {
  constructor(readonly status: number) {
    super(
      status === 409
        ? 'HTTP 409: State changed or duplicate action. Refresh and inspect before continuing.'
        : status === 403
          ? 'HTTP 403: You are not authorized for this action.'
          : status === 401
            ? 'HTTP 401: Sign in again.'
            : status === 429
              ? 'HTTP 429: Too many requests. Wait a minute, then reconnect.'
              : `HTTP ${String(status)}: Request rejected.`,
    );
  }
}
export async function api(
  path: string,
  options: RequestInit = {},
): Promise<unknown> {
  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    cache: 'no-store',
    signal: options.signal ?? AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new HttpError(response.status);
  return response.status === 204 ? null : response.json();
}
/** A form field's text, or '' when it is missing or a file. */
export const value = (form: FormData, key: string) => {
  const entry = form.get(key);
  return typeof entry === 'string' ? entry : '';
};
/**
 * One request without an operation key: JSON by default, a picture as its
 * own bytes, and nothing at all for a DELETE.
 */
export function request(
  path: string,
  body: unknown = {},
  method: 'POST' | 'PUT' | 'DELETE' = 'POST',
) {
  return api(
    path,
    body instanceof Blob
      ? { method, headers: { 'content-type': body.type }, body }
      : method === 'DELETE'
        ? { method }
        : {
            method,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          },
  );
}
/**
 * Unkeyed requests, one at a time, with what went wrong in the person's
 * terms (by HTTP status, else the fallback). Each resolves to the server's
 * answer (null for no content), or undefined when it failed or wasn't sent;
 * the caller decides what follows.
 */
export function useRequest(
  messages: Partial<Record<number, string>> = {},
  fallback = 'That did not go through. Nothing was changed; try again.',
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
interface Pending {
  path: string;
  body: string;
  headers: Record<string, string>;
  method: 'POST' | 'PUT';
  onSuccess?: () => void;
  /** The server's answer, for a caller that goes on to show what it made. */
  onResult?: (raw: unknown) => void;
}
/** A lost response keeps the exact command/key in memory for an explicit retry. Never auto-resend. */
export function useAction() {
  const permitted = useContext(MutationPermission);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const pending = useRef<Pending | null>(null);
  const running = useRef(false);
  const pausedNotice = useRef(false);
  // The "paused" explanation is only true until sending is allowed again.
  useEffect(() => {
    if (permitted && pausedNotice.current) {
      pausedNotice.current = false;
      setError('');
    }
  }, [permitted]);
  async function perform(command: Pending): Promise<boolean> {
    if (!permitted || running.current) return false;
    running.current = true;
    setBusy(true);
    setError('');
    let result: unknown;
    try {
      result = await api(command.path, {
        method: command.method,
        body: command.body,
        headers: command.headers,
      });
      pending.current = null;
      setUncertain(false);
    } catch (cause) {
      if (
        cause instanceof HttpError &&
        cause.status < 500 &&
        cause.status !== 408
      ) {
        pending.current = null;
        setUncertain(false);
        setError(cause.message);
      } else {
        pending.current = command;
        setUncertain(true);
        setError(
          'Connection lost. The action may have committed. Retry the same action or reconnect to inspect; no automatic retry.',
        );
      }
      return false;
    } finally {
      running.current = false;
      setBusy(false);
    }
    command.onSuccess?.();
    command.onResult?.(result);
    return true;
  }
  return {
    busy,
    disabled: !permitted,
    error,
    uncertain,
    invalid() {
      setError('Check the form fields and try again.');
    },
    paused() {
      pausedNotice.current = true;
      setError(
        'Not sent: the workspace is reconnecting. Your text is still here.',
      );
    },
    async send(
      path: string,
      body: Record<string, unknown>,
      keyed = true,
      extraHeaders: Record<string, string> = {},
      onSuccess?: () => void,
      method: 'POST' | 'PUT' = 'POST',
      onResult?: (raw: unknown) => void,
    ) {
      if (pending.current) return false;
      return perform({
        path,
        method,
        body: JSON.stringify(
          keyed ? { ...body, operationKey: crypto.randomUUID() } : body,
        ),
        headers: { 'content-type': 'application/json', ...extraHeaders },
        ...(onSuccess ? { onSuccess } : {}),
        ...(onResult ? { onResult } : {}),
      });
    },
    async retry() {
      return pending.current ? perform(pending.current) : false;
    },
  };
}
