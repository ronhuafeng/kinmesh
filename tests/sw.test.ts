import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The service worker's offline shell, run against stand-ins for the worker
 * global, its caches and the network: a page opened in a tab that isn't the
 * workspace (a file, a sign-in step) must never become what an offline launch
 * shows.
 */
type Listener = (event: unknown) => void;
const listeners = new Map<string, Listener>();
const kept = new Map<string, Response>();
const keyOf = (request: Request | string) =>
  typeof request === 'string'
    ? request
    : new URL(request.url).pathname + new URL(request.url).search;
const cache = {
  put: (request: Request | string, response: Response) => {
    kept.set(keyOf(request), response);
    return Promise.resolve();
  },
  keys: () => Promise.resolve([...kept.keys()]),
  delete: (key: string) => Promise.resolve(kept.delete(key)),
  match: (request: Request | string) =>
    Promise.resolve(kept.get(keyOf(request))),
};
let online = true;
Object.assign(globalThis, {
  self: {
    location: new URL('https://kinmesh.test/'),
    addEventListener: (type: string, listener: Listener) =>
      listeners.set(type, listener),
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve() },
  },
  caches: {
    open: () => Promise.resolve(cache),
    match: (request: Request | string) => cache.match(request),
    keys: () => Promise.resolve([]),
    delete: () => Promise.resolve(true),
  },
  fetch: (request: { url: string }) =>
    online
      ? Promise.resolve(
          new Response('page at ' + new URL(request.url).pathname, {
            status: 200,
          }),
        )
      : Promise.reject(new TypeError('offline')),
});
// Response.type is 'default' for a constructed response; the worker keeps
// only same-origin ('basic') answers, as a browser's fetch gives them.
Object.defineProperty(Response.prototype, 'type', { get: () => 'basic' });
await import('../web/sw.js');

/** Opens a page in a tab, as the browser asks the worker. */
async function navigate(path: string) {
  const got: { answer?: Promise<Response> } = {};
  listeners.get('fetch')?.({
    request: {
      method: 'GET',
      mode: 'navigate',
      url: 'https://kinmesh.test' + path,
    },
    respondWith: (response: Response | Promise<Response>) => {
      got.answer = Promise.resolve(response);
    },
  });
  return got.answer ? await got.answer : null;
}

await test('only the workspace page becomes the offline shell; a file opened in a tab never does', async () => {
  await navigate('/?channel=c1');
  assert.equal(await kept.get('/')?.clone().text(), 'page at /');
  // A file and a sign-in step, opened in tabs, go to the hub untouched.
  assert.equal(await navigate('/api/teams/t/channels/c/attachments/a'), null);
  assert.equal(await navigate('/login/callback?code=x'), null);
  assert.equal(await kept.get('/')?.clone().text(), 'page at /');
  // Offline, the workspace opens from what was kept.
  online = false;
  const offline = await navigate('/');
  assert.equal(await offline?.text(), 'page at /');
});
