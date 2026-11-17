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
