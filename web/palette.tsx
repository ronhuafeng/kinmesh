import { useEffect, useId, useRef, useState } from 'react';
import { SearchIcon } from './icons.js';

export interface Command {
  id: string;
  group: string;
  label: string;
  hint?: string | undefined;
  run: () => void;
}
/** Every word typed must appear somewhere in the label, hint or group. */
function matches(command: Command, query: string) {
  const text = `${command.label} ${command.hint ?? ''} ${command.group}`
    .toLowerCase()
    .normalize('NFKD');
  return query
    .toLowerCase()
    .normalize('NFKD')
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => text.includes(word));
}
/**
 * ⌘K / Ctrl+K: jump to any view, channel, task or teammate, or do one of the
 * few actions that have no place on screen (leaving the open channel).
 */
export function CommandPalette({ commands }: { commands: Command[] }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        const el = dialog.current;
        if (!el) return;
        if (el.open) el.close();
        else open();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);
  function open() {
    setQuery('');
    setActive(0);
    dialog.current?.showModal();
    input.current?.focus();
  }
  const results = commands.filter((c) => matches(c, query)).slice(0, 40);
  const current = results[Math.min(active, results.length - 1)];
  function run(command: Command | undefined) {
    if (!command) return;
    dialog.current?.close();
    command.run();
  }
  let lastGroup = '';
  return (
    <>
      <button
        type="button"
        className="palette-trigger secondary"
        aria-label="打开命令面板"
        aria-keyshortcuts="Meta+K Control+K"
        onClick={open}
      >
        <span className="with-icon">
          <SearchIcon />
          跳转到…
        </span>
      </button>
      <dialog
        ref={dialog}
        className="palette"
        aria-label="命令面板"
        onClick={(e) => {
          // A click on the backdrop lands on the dialog element itself.
          if (e.target === e.currentTarget) e.currentTarget.close();
        }}
      >
        <input
          ref={input}
          type="text"
          role="combobox"
          aria-label="搜索频道、任务、成员和视图"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={
            current ? listId + '-' + current.id : undefined
          }
          placeholder="搜索频道、任务、成员和视图"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              if (results.length === 0) return;
              const step = e.key === 'ArrowDown' ? 1 : -1;
              setActive(
                (old) => (old + step + results.length) % results.length,
              );
            } else if (e.key === 'Enter') {
              e.preventDefault();
              run(current);
            }
          }}
        />
        <ul id={listId} role="listbox" aria-label="结果">
          {results.map((command, index) => {
            const heading = command.group !== lastGroup;
            lastGroup = command.group;
            return [
              heading && (
                <li
                  key={'group-' + command.group}
                  role="presentation"
                  aria-hidden="true"
                  className="palette-group"
                >
                  {command.group}
                </li>
              ),
              <li
                key={command.id}
                id={listId + '-' + command.id}
                role="option"
                aria-selected={command === current}
                onMouseMove={() => {
                  setActive(index);
                }}
                onClick={() => {
                  run(command);
                }}
              >
                <span className="palette-label">{command.label}</span>
                {command.hint && <small>{command.hint}</small>}
              </li>,
            ];
          })}
        </ul>
        {results.length === 0 && (
          <p className="palette-empty">没有和“{query}”匹配的结果。</p>
        )}
        <footer>
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> 移动
          </span>
          <span>
            <kbd>↵</kbd> 打开
          </span>
          <span>
            <kbd>esc</kbd> 关闭
          </span>
        </footer>
      </dialog>
    </>
  );
}
