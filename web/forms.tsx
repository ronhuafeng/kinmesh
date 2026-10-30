import { useId, useRef, isValidElement, cloneElement } from 'react';
import type { ReactNode } from 'react';
import { useAction } from './api.js';
export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const id = useId();
  if (!isValidElement<{ id?: string }>(children))
    throw new Error('Field requires one input');
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {cloneElement(children, { id })}
    </div>
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
}: {
  title: string;
  path: string;
  build: (form: FormData) => Record<string, unknown>;
  onDone: () => void;
  children?: ReactNode;
  submit: string;
  keyed?: boolean;
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
        const form = event.currentTarget;
        try {
          const body = build(new FormData(form));
          void action.send(path, body, keyed).then((ok) => {
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
      <fieldset disabled={action.busy || action.uncertain}>
        {children}
        <button type="submit">{action.busy ? 'Saving…' : submit}</button>
      </fieldset>
      {action.error && <Notice>{action.error}</Notice>}
      {action.uncertain && (
        <button
          type="button"
          disabled={action.busy}
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
