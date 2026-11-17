/**
 * Kinmesh's service worker, served as `/sw.js`: it shows what the hub
 * pushes, and opens its place when one is clicked. It caches nothing and sees
 * no other request.
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
}
// In this module `self` is the worker, not a page's window.
declare const self: Worker;
const worker = self;
export {};

worker.addEventListener('install', () => {
  void worker.skipWaiting();
});
worker.addEventListener('activate', (event) => {
  event.waitUntil(worker.clients.claim());
});
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
