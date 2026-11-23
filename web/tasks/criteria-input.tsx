import { useEffect, useRef, useState } from 'react';
import { composing } from '../shared/keys.js';
import { PlusIcon } from '../shared/icons.js';

/**
 * "Done when", written as the checklist it becomes: one condition per row,
 * Enter starts the next, Backspace on an empty row removes it.
 */
export function CriteriaInput({ initial }: { initial: string[] }) {
  const [rows, setRows] = useState(initial.length > 0 ? initial : ['']);
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  const focus = useRef<number | null>(null);
  const list = useRef<HTMLUListElement>(null);
  // A row added or removed changes what the form holds without typing: the
  // draft kept from each input hears of it too.
  const changed = useRef(false);
  useEffect(() => {
    if (changed.current) {
      changed.current = false;
      list.current?.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (focus.current === null) return;
    inputs.current[focus.current]?.focus();
    focus.current = null;
  }, [rows.length]);
  const placeholders = ['测试通过', '文档已更新'];
  return (
    <ul className="criteria-input" ref={list}>
      {rows.map((row, index) => (
        <li key={index}>
          <input
            ref={(el) => {
              inputs.current[index] = el;
            }}
            name="criteria"
            aria-label={
              index === 0 ? '完成标准' : `完成标准 ${String(index + 1)}`
            }
            required={index === 0}
            maxLength={500}
            placeholder={placeholders[index] ?? ''}
            value={row}
            onChange={(e) => {
              const next = e.target.value;
              setRows((old) => old.map((v, i) => (i === index ? next : v)));
            }}
            onKeyDown={(e) => {
              if (composing(e)) return;
              if (e.key === 'Enter') {
                e.preventDefault();
                focus.current = index + 1;
                setRows((old) => [
                  ...old.slice(0, index + 1),
                  '',
                  ...old.slice(index + 1),
                ]);
              } else if (
                e.key === 'Backspace' &&
                row === '' &&
                rows.length > 1
              ) {
                e.preventDefault();
                focus.current = Math.max(0, index - 1);
                changed.current = true;
                setRows((old) => old.filter((_, i) => i !== index));
              }
            }}
          />
        </li>
      ))}
      <li>
        <button
          type="button"
          className="quiet add-criterion"
          aria-label="添加一条标准"
          onClick={() => {
            focus.current = rows.length;
            setRows((old) => [...old, '']);
          }}
        >
          <PlusIcon />
        </button>
      </li>
    </ul>
  );
}
