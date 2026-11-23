/**
 * The page while the workspace opens: a skeleton of the board, or, when the
 * hub can't be reached, the one thing to do.
 */
export function Opening({
  failed,
  onRetry,
}: {
  failed: boolean;
  onRetry: () => void;
}) {
  return (
    <main className="initial-state" aria-busy={!failed}>
      <a className="brand" href="/">
        <span className="brand-mark" aria-hidden="true">
          k
        </span>
        <span>kinmesh</span>
      </a>
      <h1>{failed ? '工作区打不开' : '正在打开工作区…'}</h1>
      {!failed && (
        <div className="skeleton-board" aria-hidden="true">
          {[3, 2, 1].map((cards, column) => (
            <div className="skeleton-column" key={column}>
              {Array.from({ length: cards }, (_, card) => (
                <span className="skeleton-card" key={card} />
              ))}
            </div>
          ))}
        </div>
      )}
      {/* Only a failure offers anything to do. */}
      {failed && <button onClick={onRetry}>再试一次</button>}
    </main>
  );
}
