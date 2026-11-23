import { useLayoutEffect, useRef, useState, useEffect } from 'react';
import { request, useRequest } from '../shared/api.js';
import { Notice } from '../shared/forms.js';
import { composing } from '../shared/keys.js';

/**
 * A message of yours said again, in place: its text in a field, saved with
 * Enter or 保存 and left as it was with Esc or 取消. Text may be emptied
 * only when the message has files.
 */
export function EditMessage({
  path,
  body,
  hasFiles,
  onClose,
  onSaved,
}: {
  /** The message's address, `…/messages/<id>`. */
  path: string;
  body: string;
  hasFiles: boolean;
  onClose: () => void;
  /** With the message as saved. */
  onSaved: (message: unknown) => void;
}) {
  const [text, setText] = useState(body);
  const field = useRef<HTMLTextAreaElement>(null);
  const action = useRequest();
  // Opened with the cursor at the end, sized to what it says.
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = String(el.scrollHeight + 2) + 'px';
  }, [text]);
  const next = text.trim();
  const empty = next === '' && !hasFiles;
  const save = () => {
    if (next === body) {
      onClose();
      return;
    }
    if (empty) return;
    void action
      .run(() =>
        request(path + '/edit', {
          operationKey: crypto.randomUUID(),
          body: next,
        }),
      )
      .then((saved) => {
        if (saved === undefined) return;
        onSaved(saved);
        onClose();
      });
  };
  return (
    <form
      className="message-edit"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <textarea
        ref={field}
        aria-label="编辑消息"
        value={text}
        maxLength={8000}
        rows={1}
        onChange={(event) => {
          setText(event.target.value);
        }}
        onKeyDown={(event) => {
          if (composing(event)) return;
          if (event.key === 'Escape') {
            // Esc leaves the message as it was, not the page.
            event.preventDefault();
            onClose();
          } else if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            save();
          }
        }}
      />
      <div className="message-edit-actions">
        <button type="button" className="quiet" onClick={onClose}>
          取消
        </button>
        <button type="submit" disabled={action.disabled || empty}>
          保存
        </button>
      </div>
      {action.error && <Notice>{action.error}</Notice>}
    </form>
  );
}
/**
 * 撤回, pressed twice: the first press asks, and the question goes back
 * after a moment or when focus leaves.
 */
export function WithdrawButton({
  path,
  permitted,
  onSaved,
}: {
  path: string;
  permitted: boolean;
  /** With the message as withdrawn. */
  onSaved: (message: unknown) => void;
}) {
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (!asking) return;
    const back = setTimeout(() => {
      setAsking(false);
    }, 4000);
    return () => {
      clearTimeout(back);
    };
  }, [asking]);
  return (
    <button
      type="button"
      className={asking ? 'quiet subtle-danger' : 'quiet'}
      disabled={!permitted}
      onBlur={() => {
        setAsking(false);
      }}
      onClick={() => {
        if (!asking) {
          setAsking(true);
          return;
        }
        setAsking(false);
        void request(path + '/withdraw', {
          operationKey: crypto.randomUUID(),
        }).then(onSaved, () => undefined);
      }}
    >
      {asking ? '确认撤回' : '撤回'}
    </button>
  );
}
