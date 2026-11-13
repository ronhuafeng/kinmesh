import { useContext, useId, useRef, isValidElement, cloneElement } from 'react';
import type { ReactNode } from 'react';
import { MutationPermission, useAction, value } from './api.js';
import { PlusIcon } from './icons.js';
/** A labelled input; a hint is said in the input itself, as its placeholder. */
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
  if (!isValidElement<{ id?: string; placeholder?: string }>(children))
    throw new Error('Field requires one input');
  return (
    <div className="field">
      <div className="field-label">
        <label htmlFor={id}>{label}</label>
      </div>
      {cloneElement(children, {
        id,
        ...(hint && !children.props.placeholder ? { placeholder: hint } : {}),
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
/** A form that sends one action; its title names it for screen readers. */
export function ActionForm({
  title,
  path,
  build,
  onDone,
  children,
  submit,
  keyed = true,
  method = 'POST',
  onResult,
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
  /** The server's answer, for a form that goes on to show what it made. */
  onResult?: (raw: unknown) => void;
}) {
  const action = useAction();
  const formRef = useRef<HTMLFormElement>(null);
  return (
    <form
      ref={formRef}
      aria-label={title}
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
            .send(target, body, keyed, {}, undefined, method, onResult)
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
/** A "+" that starts something new beside the list it belongs to. */
export function AddButton({
  label,
  onClick,
  className = '',
}: {
  label: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={'quiet icon-button add-button ' + className}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <PlusIcon />
    </button>
  );
}
/**
 * One field typed in place: Enter creates, Esc or leaving it empty closes.
 * For things that need only a name (a topic, a channel).
 */
export function InlineField({
  name,
  label,
  placeholder,
  maxLength,
  path,
  className = '',
  onClose,
  onDone,
}: {
  name: string;
  label: string;
  placeholder: string;
  maxLength: number;
  path: string;
  className?: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const action = useAction();
  return (
    <form
      className={'inline-field ' + className}
      onSubmit={(event) => {
        event.preventDefault();
        const text = value(new FormData(event.currentTarget), name).trim();
        if (!text || action.disabled) return;
        void action.send(path, { [name]: text }).then((ok) => {
          if (!ok) return;
          onClose();
          onDone();
        });
      }}
    >
      <input
        name={name}
        aria-label={label}
        placeholder={placeholder}
        maxLength={maxLength}
        required
        autoFocus
        disabled={action.busy}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          onClose();
        }}
        onBlur={(event) => {
          if (!event.currentTarget.value.trim() && !action.error) onClose();
        }}
      />
      {action.error && (
        <span className="inline-error" role="alert">
          {action.error}
        </span>
      )}
    </form>
  );
}
