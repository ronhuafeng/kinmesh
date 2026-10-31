import { useContext, useId, useRef, isValidElement, cloneElement } from 'react';
import type { ReactNode } from 'react';
import { MutationPermission, useAction } from './api.js';
export function Field({
  label,
  hint,
  children,
}: {
  label: ReactNode;
  hint?: string;
  children: ReactNode;
}) {
  const id = useId();
  if (!isValidElement<{ id?: string; 'aria-describedby'?: string }>(children))
    throw new Error('Field requires one input');
  return (
    <div className="field">
      <div className="field-label">
        <label htmlFor={id}>{label}</label>
        {hint && (
          <small className="hint" id={id + '-hint'}>
            {hint}
          </small>
        )}
      </div>
      {cloneElement(children, {
        id,
        ...(hint ? { 'aria-describedby': id + '-hint' } : {}),
      })}
    </div>
  );
}
/** Groups submit buttons supplied by a caller so they pause with the workspace. */
export function SubmitGroup({
  className,
  children,
  held = false,
}: {
  className?: string;
  children: ReactNode;
  /** Keeps buttons down while the caller waits for its own result to arrive. */
  held?: boolean;
}) {
  const permitted = useContext(MutationPermission);
  return (
    <fieldset className={className} disabled={!permitted || held}>
      {children}
    </fieldset>
  );
}
export function Notice({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="notice">
      {children}
    </p>
  );
}
export function ActionForm({
  title,
  path,
  build,
  onDone,
  children,
  submit,
  keyed = true,
  method = 'POST',
}: {
  title: string;
  /** A function path lets one form route each submit button to its own endpoint. */
  path: string | ((form: FormData) => string);
  build: (form: FormData) => Record<string, unknown>;
  onDone: () => void;
  children?: ReactNode;
  /** Omit when the children supply their own submit buttons. */
  submit?: string;
  keyed?: boolean;
  /** PUT replaces a whole resource, such as an agent profile. */
  method?: 'POST' | 'PUT';
}) {
  const action = useAction();
  const id = useId();
  const formRef = useRef<HTMLFormElement>(null);
  return (
    <form
      ref={formRef}
      aria-labelledby={id}
      className="action-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (action.disabled) {
          action.paused();
          return;
        }
        const form = event.currentTarget;
        try {
          // Include the clicked button so one form can carry several decisions.
          const submitter =
            event.nativeEvent instanceof SubmitEvent
              ? event.nativeEvent.submitter
              : null;
          const data = new FormData(form, submitter);
          const body = build(data);
          const target = typeof path === 'string' ? path : path(data);
          void action
            .send(target, body, keyed, {}, undefined, method)
            .then((ok) => {
              if (ok) {
                form.reset();
                onDone();
              }
            });
        } catch {
          action.invalid();
        }
      }}
    >
      <h3 id={id}>{title}</h3>
      {/* Inputs stay editable during a background refresh; only sending is paused. */}
      <fieldset disabled={action.busy || action.uncertain}>
        {children}
        {submit && (
          <button type="submit" disabled={action.disabled}>
            {action.busy ? 'Saving…' : submit}
          </button>
        )}
      </fieldset>
      {action.error && <Notice>{action.error}</Notice>}
      {action.uncertain && (
        <button
          type="button"
          disabled={action.disabled || action.busy}
          onClick={() => {
            void action.retry().then((ok) => {
              if (ok) {
                formRef.current?.reset();
                onDone();
              }
            });
          }}
        >
          Retry same action
        </button>
      )}
    </form>
  );
}
