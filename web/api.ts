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
export const value = (form: FormData, key: string) => {
  const entry = form.get(key);
  return typeof entry === 'string' ? entry : '';
};
interface Pending {
  path: string;
  body: string;
  headers: Record<string, string>;
  onSuccess?: () => void;
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
    try {
      await api(command.path, {
        method: 'POST',
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
        'Sending is paused while the workspace refreshes or reconnects. Nothing was sent.',
      );
    },
    async send(
      path: string,
      body: Record<string, unknown>,
      keyed = true,
      extraHeaders: Record<string, string> = {},
      onSuccess?: () => void,
    ) {
      if (pending.current) return false;
      return perform({
        path,
        body: JSON.stringify(
          keyed ? { ...body, operationKey: crypto.randomUUID() } : body,
        ),
        headers: { 'content-type': 'application/json', ...extraHeaders },
        ...(onSuccess ? { onSuccess } : {}),
      });
    },
    async retry() {
      return pending.current ? perform(pending.current) : false;
    },
  };
}
