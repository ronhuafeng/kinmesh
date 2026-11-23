import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  useLayoutEffect,
  type ReactNode,
} from 'react';
import { ChannelIcon } from '../shared/faces.js';
import { SearchIcon } from '../shared/icons.js';
import { composing } from '../shared/keys.js';

export interface Command {
  id: string;
  group: string;
  label: string;
  hint?: string | undefined;
  /** A channel shows its icon in place of the "#" its label starts with. */
  channel?: { id: string; name: string };
  run: () => void;
}
/** Every word typed must appear somewhere in the label, hint or group. */
export function matches(command: Command, query: string) {
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
/** Found on the hub for what is typed: messages and files, by their text. */
export type Remote = (query: string, signal: AbortSignal) => Promise<Command[]>;
/**
 * What is typed, the results, the one active. With `remote`, two or more
 * characters also find messages and files, after what is on screen.
 */
export function useSearch(commands: Command[], remote?: Remote) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [found, setFound] = useState<{ query: string; items: Command[] }>({
    query: '',
    items: [],
  });
  const listId = useId();
  // The latest way to ask, without asking again when only it changed.
  const asking = useRef(remote);
  useEffect(() => {
    asking.current = remote;
  }, [remote]);
  useEffect(() => {
    const typed = query.trim();
    const ask = asking.current;
    if (!ask || typed.length < 2) return;
    const stop = new AbortController();
    // Asked once typing pauses, not for every key.
    const timer = setTimeout(() => {
      ask(typed, stop.signal).then(
        (items) => {
          setFound({ query: typed, items });
        },
        () => undefined,
      );
    }, 200);
    return () => {
      clearTimeout(timer);
      stop.abort();
    };
  }, [query]);
  const results = [
    ...commands.filter((c) => matches(c, query)),
    ...(found.query === query.trim() ? found.items : []),
  ].slice(0, 40);
  const current = results[Math.min(active, results.length - 1)];
  return {
    query,
    results,
    current,
    listId,
    setActive,
    reset() {
      setQuery('');
      setActive(0);
    },
    /** The combobox: typing filters, arrows move, Enter runs. */
    input(run: (command: Command | undefined) => void, reversed = false) {
      return {
        type: 'text',
        role: 'combobox',
        'aria-label': '搜索频道、任务、成员、消息和文件',
        'aria-expanded': true,
        'aria-controls': listId,
        'aria-activedescendant': current
          ? listId + '-' + current.id
          : undefined,
        value: query,
        onChange: (e: ChangeEvent<HTMLInputElement>) => {
          setQuery(e.target.value);
          setActive(0);
        },
        onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (results.length === 0) return;
            // Shown best-last (nearest the thumb), Up moves to worse ones.
            const step = (e.key === 'ArrowDown') !== reversed ? 1 : -1;
            setActive((old) => (old + step + results.length) % results.length);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            run(current);
          }
        },
      } as const;
    },
  };
}
export type Search = ReturnType<typeof useSearch>;
/** ⌘K / Ctrl+K anywhere opens the search, or closes it again. */
export function useShortcut(toggle: () => void) {
  const latest = useRef(toggle);
  useEffect(() => {
    latest.current = toggle;
  });
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        latest.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);
}
/** The results, grouped as views, actions, channels, tasks and people. */
export function Results({
  search,
  run,
  reversed = false,
}: {
  search: Search;
  run: (command: Command) => void;
  /** Best last, as where the field is at the bottom of the screen. */
  reversed?: boolean;
}) {
  const { results, current, listId, query } = search;
  const shown = results.map((command, index) => ({ command, index }));
  if (reversed) shown.reverse();
  let lastGroup = '';
  return (
    <>
      <ul id={listId} role="listbox" aria-label="结果">
        {shown.map(({ command, index }) => {
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
                search.setActive(index);
              }}
              onClick={() => {
                run(command);
              }}
            >
              {command.channel ? (
                <span className="palette-label with-icon">
                  <ChannelIcon {...command.channel} />
                  <span>
                    <span className="visually-hidden"># </span>
                    {command.channel.name}
                  </span>
                </span>
              ) : (
                <span className="palette-label">{command.label}</span>
              )}
              {command.hint && <small>{command.hint}</small>}
            </li>,
          ];
        })}
      </ul>
      {results.length === 0 && (
        <p className="palette-empty">没有和“{query}”匹配的结果。</p>
      )}
    </>
  );
}
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
/**
 * On a phone, search is a tab of its own: the field at the bottom, just
 * above the keyboard (or the tabs, with none), and the results above it,
 * the best nearest the thumb. A choice goes there and leaves search.
 */
export function SearchPage({
  commands,
  remote,
  onClose,
}: {
  commands: Command[];
  remote?: Remote;
  /** Back to where search was opened from. */
  onClose: () => void;
}) {
  const search = useSearch(commands, remote);
  const field = useRef<HTMLInputElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // The field rides on the keyboard: the visual viewport says how much of
  // the screen it takes.
  useEffect(() => {
    const view = window.visualViewport;
    const place = () => {
      const keyboard = view
        ? Math.max(0, window.innerHeight - view.height - view.offsetTop)
        : 0;
      // With no keyboard, the field sits just above the tabs.
      const tabs =
        document.querySelector('.phone-tabs')?.getBoundingClientRect().height ??
        0;
      page.current?.style.setProperty(
        '--search-bottom',
        String(keyboard > 0 ? keyboard : tabs) + 'px',
      );
    };
    place();
    view?.addEventListener('resize', place);
    view?.addEventListener('scroll', place);
    // The page takes focus as it opens; the field takes it after.
    const later = window.setTimeout(() => {
      field.current?.focus({ preventScroll: true });
    });
    return () => {
      window.clearTimeout(later);
      view?.removeEventListener('resize', place);
      view?.removeEventListener('scroll', place);
    };
  }, []);
  // The best result stays in view, at the bottom.
  useLayoutEffect(() => {
    const list = scroller.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [search.query]);
  function run(command: Command | undefined) {
    if (!command) return;
    onClose();
    command.run();
  }
  return (
    <div className="search-page" ref={page}>
      <div className="palette search-page-results" ref={scroller}>
        <Results search={search} run={run} reversed />
      </div>
      <input
        ref={field}
        {...search.input(run, true)}
        className="search-page-field"
        placeholder="搜索"
        enterKeyHint="go"
      />
    </div>
  );
}
