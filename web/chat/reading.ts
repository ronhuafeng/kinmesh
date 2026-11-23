import {
  useEffect,
  useRef,
  useState,
  useCallback,
  useLayoutEffect,
} from 'react';
import { type ChatMessage, mine } from './chat-message.js';
import { request, api } from '../shared/api.js';
import { Message, pageOf } from '../../src/domain/communication.js';

/**
 * Marks what arrived while the conversation was open: messages newer than
 * any shown before in this place (a channel, or one of its topics). Older
 * ones loaded by scrolling back did not arrive.
 */
export function useArrivals(
  place: string,
  messages: ChatMessage[],
  me: string,
) {
  const seen = useRef<{ place: string; newest: number } | null>(null);
  const [divider, setDivider] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  // What arrived from others, said politely to a screen reader.
  const [heard, setHeard] = useState<ChatMessage[]>([]);
  useEffect(() => {
    const previous = seen.current;
    const newest = messages.at(-1)?.position ?? 0;
    if (previous?.place !== place) {
      seen.current = { place, newest };
      setDivider(null);
      setFresh(new Set());
      return;
    }
    const arrived = messages.filter((m) => m.position > previous.newest);
    previous.newest = Math.max(previous.newest, newest);
    if (arrived.length === 0) return;
    setFresh(new Set(arrived.map((m) => m.id)));
    const fromOthers = arrived.find((m) => !mine(m, me));
    if (fromOthers) setDivider((old) => old ?? fromOthers.id);
    setHeard(arrived.filter((m) => !mine(m, me)));
  }, [place, messages, me]);
  return { divider, fresh, heard };
}
export const atBottom = () =>
  window.innerHeight + window.scrollY >=
  document.documentElement.scrollHeight - 48;
const toBottom = () => {
  window.scrollTo({ top: document.documentElement.scrollHeight });
};
/**
 * A conversation reads from the bottom: it opens there, follows what arrives
 * while you are there, and holds still while you read further back, also as
 * older messages are added above. `sent()` goes to the bottom, so what you
 * just sent comes into view however far back you were.
 */
export function useReadingPosition(place: string, messages: ChatMessage[]) {
  const held = useRef<{
    place: string;
    /**
     * The message read from: the first whose end is in view, and where that
     * end was. Older messages folding its header into theirs change only
     * what is above its text, so its end is what holds still.
     */
    anchor: string | undefined;
    end: number;
    bottom: boolean;
  } | null>(null);
  // Whether the newest message is in view, for the way back to it.
  const [atEnd, setAtEnd] = useState(true);
  /** Notes what is read from, as the reader left it. */
  const note = () => {
    const h = held.current;
    if (!h) return;
    h.anchor = undefined;
    h.end = 0;
    for (const row of document.querySelectorAll<HTMLElement>(
      '.messages > li[id^="message-"]',
    )) {
      const end = row.getBoundingClientRect().bottom;
      if (end > 0) {
        h.anchor = row.id.slice('message-'.length);
        h.end = end;
        break;
      }
    }
    h.bottom = atBottom();
    setAtEnd(h.bottom);
  };
  /**
   * What the conversation shows changed or grew: at the bottom it stays
   * there; read back, what was read from stays where it was, whatever was
   * added or drawn above it (older messages, a diagram, an image).
   */
  const hold = () => {
    const h = held.current;
    if (!h) return;
    if (h.bottom) {
      toBottom();
      return;
    }
    const row =
      h.anchor === undefined
        ? null
        : document.getElementById('message-' + h.anchor);
    const moved = row ? row.getBoundingClientRect().bottom - h.end : 0;
    if (moved !== 0) window.scrollBy({ top: moved });
  };
  useLayoutEffect(() => {
    if (held.current?.place !== place) {
      held.current = { place, anchor: undefined, end: 0, bottom: true };
      toBottom();
    } else hold();
    note();
  }, [place, messages]);
  // Reading moves the position; so does the window changing size.
  useEffect(() => {
    // A window that changes size keeps you at the bottom if you were.
    const resized = () => {
      if (held.current?.bottom) toBottom();
      note();
    };
    window.addEventListener('scroll', note, { passive: true });
    window.addEventListener('resize', resized);
    return () => {
      window.removeEventListener('scroll', note);
      window.removeEventListener('resize', resized);
    };
  }, []);
  // Something that grows once shown (a diagram drawn, an image loaded)
  // keeps the place: the bottom, or what was read from.
  const list = useCallback((element: HTMLOListElement | null) => {
    if (!element) return;
    const grown = new ResizeObserver(hold);
    grown.observe(element);
    return () => {
      grown.disconnect();
    };
  }, []);
  return {
    list,
    atEnd,
    sent: () => {
      toBottom();
      if (held.current) held.current.bottom = true;
      setAtEnd(true);
    },
    /**
     * Shows a message, marked, and reads from it: what grows above or below
     * afterwards holds it still instead of going back to the bottom.
     */
    show: (id: string) => {
      const row = document.getElementById('message-' + id);
      if (!row) return;
      row.scrollIntoView({ block: 'center' });
      row.dataset.flash = 'true';
      setTimeout(() => {
        delete row.dataset.flash;
      }, 1600);
      note();
    },
  };
}
/**
 * Tells the hub what you have read: while the channel has something unread,
 * once its newest message on screen is in view in a visible tab, you have
 * read up to it, in the topic you are reading or in the whole channel. Each
 * message is told once; one that didn't go is told again at the next look.
 */
export function useMarkRead(
  channelPath: string,
  topicId: string,
  newest: string | undefined,
  unread: boolean,
  permitted: boolean,
) {
  const told = useRef('');
  useEffect(() => {
    if (!unread || !permitted || newest === undefined) return;
    const key = channelPath + ' ' + topicId + ' ' + newest;
    const look = () => {
      if (told.current === key) return;
      if (document.visibilityState !== 'visible' || !atBottom()) return;
      told.current = key;
      request(channelPath + '/read', {
        messageId: newest,
        topicId: topicId === '' ? null : topicId,
      }).catch(() => {
        if (told.current === key) told.current = '';
      });
    };
    look();
    window.addEventListener('scroll', look, { passive: true });
    document.addEventListener('visibilitychange', look);
    return () => {
      window.removeEventListener('scroll', look);
      document.removeEventListener('visibilitychange', look);
    };
  }, [channelPath, topicId, newest, unread, permitted]);
}
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
export function useEarlier(
  older: string | null,
  onEarlier: (cursor: string) => void,
) {
  const top = useRef<HTMLDivElement>(null);
  const ask = useRef(onEarlier);
  useEffect(() => {
    ask.current = onEarlier;
  }, [onEarlier]);
  useEffect(() => {
    const edge = top.current;
    if (!edge || older === null) return;
    const watch = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) ask.current(older);
      },
      { rootMargin: '600px 0px 0px 0px' },
    );
    watch.observe(edge);
    return () => {
      watch.disconnect();
    };
  }, [older]);
  return top;
}
