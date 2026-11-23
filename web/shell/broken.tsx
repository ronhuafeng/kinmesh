const RELOADED = 'kinmesh:reloaded';
/**
 * Reloads the page to the hub's current version, at most once a minute:
 * true when it did. A page left open across an update can't read what the
 * new hub sends, and the new page can; a second failure soon after is a
 * real fault, which reloading again would only repeat.
 */
export function reloadOnce() {
  let last = 0;
  try {
    last = Number(sessionStorage.getItem(RELOADED) ?? 0);
  } catch {
    // Storage refused: reload anyway, once in this page's life.
  }
  if (Date.now() - last < 60_000) return false;
  try {
    sessionStorage.setItem(RELOADED, String(Date.now()));
  } catch {
    // As above.
  }
  window.location.reload();
  return true;
}
/** The way back from a page that can't go on: one sentence and a reload. */
export function Broken() {
  return (
    <main className="initial-state">
      <a className="brand" href="/">
        <span className="brand-mark" aria-hidden="true">
          k
        </span>
        <span>kinmesh</span>
      </a>
      <h1>页面出了问题</h1>
      <button
        type="button"
        onClick={() => {
          window.location.reload();
        }}
      >
        重新加载
      </button>
    </main>
  );
}
