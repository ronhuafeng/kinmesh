import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { SearchIcon } from '../shared/icons.js';
import { composing } from '../shared/keys.js';
import type { Command, Remote } from './command.js';
import { useSearch } from './use-search.js';
import { useShortcut } from './use-shortcut.js';
import { Results } from './results.js';

/**
 * The sidebar's head: the team name, and at the end of its row a magnifier.
 * Searching, the field grows from the magnifier over the whole row and the
 * results drop below it, wider than the sidebar (on a phone, the screen's
 * width; away from Home, ⌘K opens the row over the top). Jump to any view, channel,
 * task or teammate, or do one of the few actions that have no place on
 * screen (leaving the open channel).
 */
export function SidebarSearch({
  commands,
  remote,
  children,
  onOpen,
  end,
}: {
  commands: Command[];
  remote?: Remote;
  /** The team name, shown while not searching. */
  children: ReactNode;
  /** After the magnifier while not searching (closing the sidebar). */
  end?: ReactNode;
  /** Before it opens: a closed sidebar opens, search and all. */
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const row = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const search = useSearch(commands, remote);
  function show() {
    const focused = document.activeElement;
    returnTo.current = focused instanceof HTMLElement ? focused : null;
    onOpen?.();
    search.reset();
    setOpen(true);
  }
  /** Back to the team name; Esc and a choice give focus back where it was. */
  function hide(restore: boolean) {
    setOpen(false);
    search.reset();
    if (restore) returnTo.current?.focus({ preventScroll: true });
  }
  useShortcut(() => {
    if (open) hide(true);
    else show();
  });
  // The results hang under the field, outside the sidebar's scrolling box.
  useLayoutEffect(() => {
    const list = popup.current;
    const input = field.current;
    if (!open || !list || !input) return;
    input.focus();
    list.showPopover();
    const place = () => {
      // Its left edge is the row's: the field is still growing from the
      // magnifier.
      const box = input.getBoundingClientRect();
      const start = row.current?.getBoundingClientRect().left ?? box.left;
      list.style.setProperty('--search-top', String(box.bottom + 4) + 'px');
      list.style.setProperty('--search-left', String(start) + 'px');
    };
    place();
    const outside = (e: PointerEvent) => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (!row.current?.contains(target) && !list.contains(target)) hide(false);
    };
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
    // A sidebar sliding in carries the field with it: follow it a moment.
    let frames = 0;
    let frame = requestAnimationFrame(function follow() {
      place();
      if (++frames < 20) frame = requestAnimationFrame(follow);
    });
    document.addEventListener('pointerdown', outside, true);
    return () => {
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', place, true);
      cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', outside, true);
    };
  }, [open]);
  function run(command: Command | undefined) {
    if (!command) return;
    hide(true);
    command.run();
  }
  const input = search.input(run);
  return (
    <div className="team-row" ref={row} data-open={open || undefined}>
      {children}
      {open && (
        <input
          ref={field}
          {...input}
          placeholder="搜索"
          aria-keyshortcuts="Meta+K Control+K"
          onKeyDown={(e) => {
            if (composing(e)) return;
            if (e.key === 'Escape') {
              e.preventDefault();
              hide(true);
              return;
            }
            input.onKeyDown(e);
          }}
          onBlur={(e) => {
            // Tabbing away closes it; a click is handled as a click outside.
            const next = e.relatedTarget;
            if (
              next &&
              !row.current?.contains(next) &&
              !popup.current?.contains(next)
            )
              hide(false);
          }}
        />
      )}
      <button
        type="button"
        className="quiet icon-button search-toggle"
        aria-label="搜索"
        title="搜索"
        aria-expanded={open}
        aria-keyshortcuts="Meta+K Control+K"
        onClick={() => {
          if (open) hide(true);
          else show();
        }}
      >
        <SearchIcon size={20} />
      </button>
      {end}
      {open && (
        <div
          ref={popup}
          popover="manual"
          className="palette search-results"
          // The field keeps focus while a result is clicked.
          onMouseDown={(e) => {
            e.preventDefault();
          }}
        >
          <Results search={search} run={run} />
        </div>
      )}
    </div>
  );
}
