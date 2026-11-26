import { useActions } from './contexts.js';

/**
 * One live region, always there, says each toast once; a notice inside it
 * stays a button that opens what it is about. It waits while pointed at
 * or focused.
 */
export function Toasts() {
  const { toast, dismiss, hold } = useActions();
  return (
    <div
      className="toast-region"
      role="status"
      onPointerEnter={() => {
        hold('pointer', true);
      }}
      onPointerLeave={() => {
        hold('pointer', false);
      }}
      onFocus={() => {
        hold('focus', true);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          hold('focus', false);
      }}
    >
      {toast &&
        (toast.url ? (
          <button
            type="button"
            className="toast toast-notice"
            key={toast.id}
            onClick={() => {
              const url = toast.url;
              dismiss();
              if (!url) return;
              window.history.pushState(null, '', url);
              window.dispatchEvent(new PopStateEvent('popstate'));
            }}
          >
            <strong>{toast.message}</strong>
            {toast.detail && <span>{toast.detail}</span>}
          </button>
        ) : (
          <div className="toast" key={toast.id}>
            {toast.message}
          </div>
        ))}
    </div>
  );
}
