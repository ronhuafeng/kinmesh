import { useContext, useEffect, useRef, useState } from 'react';
import { MutationPermission, type Pending, api, HttpError } from './api.js';

/**
 * A lost response keeps the exact command/key in memory for an explicit
 * retry. Never auto-resend. `messages` says a refusal in the terms of the
 * thing being done ("That name is taken"), by HTTP status.
 */
export function useAction(messages: Partial<Record<number, string>> = {}) {
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
        setError(messages[cause.status] ?? cause.message);
      } else {
        pending.current = command;
        setUncertain(true);
        setError('可能没有成功。');
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
      setError('请检查填写的内容后再试。');
    },
    paused() {
      pausedNotice.current = true;
      setError('连不上 Kinmesh，没有发送。你写的内容还在。');
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
