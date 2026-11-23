import { createContext } from 'react';
import type { z } from 'zod';
import { pageOf } from '../../src/domain/communication.js';

export const MutationPermission = createContext(true);
/** True only while disconnected, as opposed to a brief background refresh. */
export const Offline = createContext(false);
/** What went wrong, in the person's words; a status code is never shown. */
export const FAILED = '没有成功，什么都没改，请再试一次。';
const said: Partial<Record<number, string>> = {
  401: '请重新登录。',
  403: '你没有权限这样做。',
  409: '情况已经变了，页面上是最新的内容。',
  413: '文件太大，或团队的文件空间已满。',
  429: '操作太频繁，请稍等一分钟再试。',
};
export class HttpError extends Error {
  constructor(readonly status: number) {
    super(said[status] ?? FAILED);
  }
}
/**
 * A request to the hub. It always ends: at `timeout` (10 seconds unless the
 * caller knows the hub takes longer), or sooner when the caller's own signal
 * aborts it.
 */
export async function api(
  path: string,
  { timeout = 10000, ...options }: RequestInit & { timeout?: number } = {},
): Promise<unknown> {
  const limit = AbortSignal.timeout(timeout);
  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    cache: 'no-store',
    signal: options.signal ? AbortSignal.any([options.signal, limit]) : limit,
  });
  if (!response.ok) throw new HttpError(response.status);
  return response.status === 204 ? null : response.json();
}
/**
 * Every page of a list, following its cursor: a task's whole history, not
 * only its first page.
 */
export async function everyPage<T extends z.ZodType>(
  path: string,
  item: T,
  signal: AbortSignal,
) {
  const items: z.infer<T>[] = [];
  let cursor: string | null = null;
  // At most 50 pages of 100: far past any task's history, never a loop.
  for (let page = 0; page < 50; page++) {
    const raw = await api(
      path +
        '?limit=100' +
        (cursor === null ? '' : '&cursor=' + encodeURIComponent(cursor)),
      { signal },
    );
    const read = pageOf(item).parse(raw);
    items.push(...read.items);
    cursor = read.nextCursor;
    if (cursor === null) break;
  }
  return items;
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
export interface Pending {
  path: string;
  body: string;
  headers: Record<string, string>;
  method: 'POST' | 'PUT';
  onSuccess?: () => void;
  /** The server's answer, for a caller that goes on to show what it made. */
  onResult?: (raw: unknown) => void;
}
