/**
 * Kinmesh's service worker, served as `/sw.js`: it shows what the hub
 * pushes and opens its place when one is clicked; it keeps the app's own
 * files (the page and its hashed assets, never anything the hub answers
 * about a team) so an installed Kinmesh opens at once; and it takes what the
 * system shares to Kinmesh, for the page to place in a channel.
 *
 * The page's types (DOM) and a worker's (WebWorker) can't share one program,
 * so the little of the worker's this uses is declared here.
 */
interface Shown {
  data: unknown;
  close(): void;
}
interface Window {
  url: string;
  focus(): Promise<unknown>;
  postMessage(message: unknown): void;
}
interface Waiting extends Event {
  waitUntil(work: Promise<unknown>): void;
}
interface Pushed extends Waiting {
  data: { json(): unknown } | null;
}
interface Clicked extends Waiting {
  notification: Shown;
}
interface Fetching extends Waiting {
  request: Request;
  respondWith(response: Response | Promise<Response>): void;
}
interface Worker {
  location: Location;
  skipWaiting(): Promise<void>;
  registration: {
    showNotification(
      title: string,
      options: {
        body: string;
        tag: string;
        renotify: boolean;
        icon: string;
        data: unknown;
      },
    ): Promise<void>;
  };
  clients: {
    claim(): Promise<void>;
    matchAll(options: {
      type: 'window';
      includeUncontrolled: boolean;
    }): Promise<Window[]>;
    openWindow(url: string): Promise<unknown>;
  };
  addEventListener(type: 'install', listener: () => void): void;
  addEventListener(type: 'activate', listener: (e: Waiting) => void): void;
  addEventListener(type: 'push', listener: (e: Pushed) => void): void;
  addEventListener(
    type: 'notificationclick',
    listener: (e: Clicked) => void,
  ): void;
  addEventListener(type: 'fetch', listener: (e: Fetching) => void): void;
}
// In this module `self` is the worker, not a page's window.
declare const self: Worker;
const worker = self;
export {};

worker.addEventListener('install', () => {
  void worker.skipWaiting();
});
/** The app's own files; what was shared to Kinmesh, until it is placed. */
const SHELL = 'kinmesh-shell';
export const SHARED = 'kinmesh-shared';
worker.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys())
        if (name !== SHELL && name !== SHARED) await caches.delete(name);
      await worker.clients.claim();
    })(),
  );
});
/** The most of the app's files kept; the oldest go first. */
const SHELL_MOST = 300;
async function keep(request: Request | string, response: Response) {
  const cache = await caches.open(SHELL);
  await cache.put(request, response);
  const keys = await cache.keys();
  for (const old of keys.slice(0, Math.max(0, keys.length - SHELL_MOST)))
    await cache.delete(old);
}
/**
 * The page: from the hub when it answers (and kept), else the one kept, so
 * an installed Kinmesh opens even while the hub is out of reach. A hashed
 * asset never changes: kept, it is served at once.
 */
worker.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== worker.location.origin) return;
  if (request.method === 'POST' && url.pathname === '/share') {
    event.respondWith(received(request));
    return;
  }
  if (request.method !== 'GET') return;
  // Only the workspace's own page is the shell. Anything else opened in a
  // tab (a file, a sign-in step) goes to the hub alone and is never kept.
  if (request.mode === 'navigate' && url.pathname === '/') {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          if (response.ok && response.type === 'basic')
            await keep('/', response.clone());
          return response;
        } catch {
          return (await caches.match('/')) ?? Response.error();
        }
      })(),
    );
    return;
  }
  if (
    url.pathname.startsWith('/assets/') ||
    /^\/icon-[\w-]+\.png$/.test(url.pathname)
  )
    event.respondWith(
      (async () => {
        const kept = await caches.match(request);
        if (kept) return kept;
        const response = await fetch(request);
        if (response.ok) await keep(request, response.clone());
        return response;
      })(),
    );
});
/**
 * What the system shared to Kinmesh (files, a link, some text): kept under
 * a new name until the page places it in a channel, and the page opened to
 * do so.
 */
async function received(request: Request) {
  const form = await request.formData();
  const id = crypto.randomUUID();
  const cache = await caches.open(SHARED);
  const files = form
    .getAll('files')
    .filter((entry): entry is File => entry instanceof File && entry.size > 0)
    .slice(0, 10);
  const words = ['title', 'text', 'url']
    .map((key) => form.get(key))
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '');
  await cache.put(
    `/__shared/${id}/meta`,
    new Response(
      JSON.stringify({
        text: [...new Set(words)].join('\n'),
        files: files.map((f, i) => ({ index: i, name: f.name, type: f.type })),
      }),
    ),
  );
  for (const [index, file] of files.entries())
    await cache.put(`/__shared/${id}/${String(index)}`, new Response(file));
  return Response.redirect(`/?share=${id}`, 303);
}
const text = (value: unknown) => (typeof value === 'string' ? value : null);
// A push carries what to show, encrypted for this browser alone.
worker.addEventListener('push', (event) => {
  let pushed: unknown = null;
  try {
    pushed = event.data?.json() ?? null;
  } catch {
    pushed = null;
  }
  if (typeof pushed !== 'object' || pushed === null) return;
  const field = (key: string) => text(Reflect.get(pushed, key));
  const title = field('title');
  if (title === null) return;
  event.waitUntil(
    worker.registration.showNotification(title, {
      body: field('body') ?? '',
      tag: field('tag') ?? 'kinmesh',
      renotify: true,
      icon: '/icon-192.png',
      data: {
        url: field('url') ?? '/',
        kind: field('kind'),
        channelId: field('channelId'),
        taskId: field('taskId'),
        deliveryId: field('deliveryId'),
      },
    }),
  );
});
// A click opens its place: in an open workspace if there is one, else anew.
worker.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data;
  const wanted =
    typeof data === 'object' && data !== null && 'url' in data
      ? text(data.url)
      : null;
  const place = new URL(wanted ?? '/', worker.location.origin);
  const url = place.pathname + place.search;
  event.waitUntil(
    (async () => {
      const open = await worker.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      const workspace = open.find(
        (client) => new URL(client.url).origin === worker.location.origin,
      );
      if (workspace) {
        workspace.postMessage({ kind: 'open', url });
        await workspace.focus();
        return;
      }
      await worker.clients.openWindow(url);
    })(),
  );
});
