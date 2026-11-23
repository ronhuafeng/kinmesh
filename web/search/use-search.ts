import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react';
import { type Command, type Remote, matches } from './command.js';

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
