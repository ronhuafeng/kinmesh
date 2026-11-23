import { useActions } from './contexts.js';

/**
 * One live region, always there, says each toast once; a notice inside it
 * stays a button that opens what it is about.
 */
export function Toasts() {
  const { toast, setToast } = useActions();
  return (
    <div className="toast-region" role="status">
      {toast &&
        (toast.url ? (
          <button
            type="button"
            className="toast toast-notice"
            key={toast.id}
            onClick={() => {
              const url = toast.url;
              setToast(null);
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
