import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Message, pageOf } from '../../src/domain/communication.js';
import { api } from '../shared/api.js';
import type { ChatMessage } from './chat-message.js';

/**
 * Asks for older messages once the top of the conversation comes near:
 * scrolling up reads further back, until there is nothing older.
 */
/**
 * The messages older than the workspace's window, read a page at a time
 * from `path` with the cursor each page gives: `cursor` is undefined until
 * the first page is read, null at the channel's beginning. Messages that
 * fall out of the window as new ones arrive are kept here, so what was
 * read back has no gap.
 */
export function useArchive(
  path: string,
  place: string,
  windowed: ChatMessage[],
) {
  const [state, setState] = useState<{
    place: string;
    items: ChatMessage[];
    cursor: string | null | undefined;
  }>({ place, items: [], cursor: undefined });
  const current =
    state.place === place
      ? state
      : { place, items: [] as ChatMessage[], cursor: undefined };
  const at = useRef(place);
  const asking = useRef<string | null>(null);
  useLayoutEffect(() => {
    at.current = place;
  }, [place]);
  const load = useCallback(
    (cursor: string) => {
      if (asking.current === cursor) return;
      asking.current = cursor;
      const from = place;
      void api(path + '?limit=100&cursor=' + encodeURIComponent(cursor))
        .then((raw) => {
          if (at.current !== from) return;
          const page = pageOf(Message).parse(raw);
          setState((old) => {
            const kept = old.place === from ? old.items : [];
            const ids = new Set(kept.map((m) => m.id));
            return {
              place: from,
              items: [...page.items.filter((m) => !ids.has(m.id)), ...kept],
              cursor: page.nextCursor,
            };
          });
        })
        .catch(() => undefined)
        .finally(() => {
          if (asking.current === cursor) asking.current = null;
        });
    },
    [path, place],
  );
  // What leaves the window's old end stays read.
  const before = useRef<ChatMessage[]>(windowed);
  useEffect(() => {
    const previous = before.current;
    before.current = windowed;
    const oldest = windowed[0]?.position;
    if (oldest === undefined) return;
    setState((old) => {
      if (old.place !== place || old.cursor === undefined) return old;
      const ids = new Set(old.items.map((m) => m.id));
      const dropped = previous.filter(
        (m) => m.position < oldest && !ids.has(m.id),
      );
      if (dropped.length === 0) return old;
      return {
        ...old,
        items: [...old.items, ...dropped].sort(
          (a, b) => a.position - b.position,
        ),
      };
    });
  }, [windowed, place]);
  return { items: current.items, cursor: current.cursor, load };
}
