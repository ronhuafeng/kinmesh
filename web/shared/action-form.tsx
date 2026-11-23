import { useRef } from 'react';
import type { ReactNode } from 'react';
import { useAction } from './use-action.js';
import { Sending } from './submit-group.js';
import { Notice } from './notice.js';

/** A form that sends one action; its title names it for screen readers. */
export function ActionForm({
  title,
  path,
  build,
  onDone,
  children,
  submit,
  submitName,
  keyed = true,
  method = 'POST',
  onResult,
  icon,
  ready = true,
  handOff,
}: {
  title: string;
  /** A function path lets one form route each submit button to its own endpoint. */
  path: string | ((form: FormData) => string);
  build: (form: FormData) => Record<string, unknown>;
  onDone: () => void;
  children?: ReactNode;
  /** Omit when the children supply their own submit buttons. */
  submit?: string;
  /** The button's full name when its words lean on what is around it. */
  submitName?: string;
  keyed?: boolean;
  /** PUT replaces a whole resource, such as an agent profile. */
  method?: 'POST' | 'PUT';
  /** The server's answer, for a form that goes on to show what it made. */
  onResult?: (raw: unknown) => void;
  /**
   * Submits with the shared round confirm button showing this icon; `submit`
   * is then its accessible name.
   */
  icon?: ReactNode;
  /** False while there is nothing to confirm yet, as in an empty field. */
  ready?: boolean;
  /**
   * Takes over sending, for what is written one after another (a message):
   * the form hands on what it built and is free at once, and `onDone`
   * clears it. While the workspace is paused nothing is handed on.
   */
  handOff?: (path: string, body: Record<string, unknown>) => void;
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
        // What the confirm button can't send yet, a key can't either: a
        // message waits for the files still uploading.
        if (!ready) return;
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
          if (handOff) {
            handOff(target, body);
            onDone();
            return;
          }
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
      {/* Inputs stay editable, and keep the keyboard, during a refresh and
          while sending: only the buttons wait. An uncertain send holds
          exactly what was sent. */}
      <fieldset disabled={action.uncertain}>
        <Sending value={action.busy}>{children}</Sending>
        {submit &&
          (icon ? (
            <button
              type="submit"
              className="icon-button confirm"
              aria-label={submit}
              title={submit}
              disabled={action.disabled || action.busy || !ready}
              // Handed on, the next one is written at once: pressing Send
              // leaves the focus, and a touch keyboard, where they were.
              onMouseDown={
                handOff
                  ? (event) => {
                      event.preventDefault();
                    }
                  : undefined
              }
            >
              {icon}
            </button>
          ) : (
            <button
              type="submit"
              aria-label={submitName}
              title={submitName}
              disabled={action.disabled || action.busy}
            >
              {submit}
            </button>
          ))}
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
          重试同一操作
        </button>
      )}
    </form>
  );
}
