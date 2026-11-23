import { z } from 'zod';
import { useAction } from './use-action.js';
import { value } from './api.js';
import { composing } from './keys.js';

/**
 * One field typed in place: Enter creates, Esc or leaving it empty closes.
 * For things that need only a name (a topic, a channel); what it made is
 * handed on by ID, so the caller can open it.
 */
export function InlineField({
  name,
  label,
  placeholder,
  maxLength,
  path,
  className = '',
  taken,
  onClose,
  onCreated,
  extra = {},
  initial = '',
}: {
  name: string;
  label: string;
  placeholder: string;
  maxLength: number;
  path: string;
  /** What the field starts as, when it names something again. */
  initial?: string;
  className?: string;
  /** What to say when the name is already in use. */
  taken?: string;
  onClose: () => void;
  onCreated: (id: string) => void;
  /** Sent along with the field, as what a new thing starts as. */
  extra?: Record<string, unknown>;
}) {
  const action = useAction(taken ? { 409: taken } : {});
  return (
    <form
      className={'inline-field ' + className}
      onSubmit={(event) => {
        event.preventDefault();
        const text = value(new FormData(event.currentTarget), name).trim();
        if (!text || action.disabled) return;
        let created = '';
        void action
          .send(
            path,
            { ...extra, [name]: text },
            true,
            {},
            undefined,
            'POST',
            (raw) => {
              created = z.object({ id: z.string() }).parse(raw).id;
            },
          )
          .then((ok) => {
            if (!ok) return;
            onClose();
            onCreated(created);
          });
      }}
    >
      <input
        name={name}
        aria-label={label}
        placeholder={placeholder}
        maxLength={maxLength}
        defaultValue={initial}
        required
        autoFocus
        onFocus={(event) => {
          event.currentTarget.select();
        }}
        // Held, not disabled, while it sends: a refused name stays in the
        // field with the caret, ready to be corrected.
        readOnly={action.busy}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || composing(event)) return;
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
