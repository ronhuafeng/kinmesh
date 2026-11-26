// The appearance a person chose here (外观), before anything is drawn.
try {
  const theme = localStorage.getItem('kinmesh-theme');
  if (theme === 'light' || theme === 'dark')
    document.documentElement.dataset.theme = theme;
} catch {
  // Storage refused: the system's choice holds.
}
/**
 * Runs as the page starts, before the workspace's code has arrived: opens
 * the event stream for the place the address names, so the workspace is
 * already on its way when the app starts, which takes the stream over
 * (`takeStream` in `live.ts`). Self-contained: nothing is imported, so it
 * stays a few hundred bytes.
 *
 * The place is read as the app reads it (`readRoute` and `place` in
 * `app.tsx`); an address read differently only costs the app a stream of
 * its own.
 */
const uuid =
  /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
const address = new URLSearchParams(window.location.search);
const id = (key: string) => {
  const value = address.get(key);
  return value !== null && uuid.test(value) ? value : '';
};
const channel = id('channel');
const topic = id('topic');
const worker = id('worker');
const agent = id('agent');
const task = address.get('task');
const openTask = task !== null && task !== 'new' && uuid.test(task);
const query = new URLSearchParams();
if (channel) query.set('channelId', channel);
if (topic) query.set('topicId', topic);
if (openTask) query.set('taskId', task);
if (task !== 'new' && !openTask && worker)
  query.set('page', 'worker:' + worker);
else if (agent && !worker) query.set('page', 'agent:' + agent);
const source = new EventSource('/api/events?' + query.toString());
const early: MessageEvent[] = [];
const keep = (event: Event) => {
  if (event instanceof MessageEvent) early.push(event);
};
const failed = () => {
  if (window.kinmeshStream) window.kinmeshStream.failed = true;
};
source.addEventListener('workspace', keep);
source.addEventListener('revisions', keep);
source.addEventListener('error', failed);
window.kinmeshStream = {
  query: query.toString(),
  source,
  early,
  failed: false,
  release() {
    source.removeEventListener('workspace', keep);
    source.removeEventListener('revisions', keep);
    source.removeEventListener('error', failed);
  },
};
export {};
// The service worker keeps the app's own files, so an installed Kinmesh
// opens at once, and receives what is shared to it (`sw.ts`).
if ('serviceWorker' in navigator)
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .catch(() => undefined);
  });
// Chrome offers to install the app, early, and may offer again later: the
// newest offer is kept for 安装 in settings, which spends it.
const isOffer = (event: Event): event is InstallOffer =>
  'prompt' in event && 'userChoice' in event;
window.addEventListener('beforeinstallprompt', (event) => {
  if (!isOffer(event)) return;
  event.preventDefault();
  window.kinmeshInstall = event;
  window.dispatchEvent(new Event('kinmesh-install'));
});
window.addEventListener('appinstalled', () => {
  window.kinmeshInstall = null;
  window.dispatchEvent(new Event('kinmesh-install'));
});
