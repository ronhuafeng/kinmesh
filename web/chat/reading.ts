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
 * Where a message ends on screen as laid out, leaving out any animation's
 * transform: a message rising in as it arrives must not count as moved.
 */
/**
 * Rows far from the screen skip layout (`content-visibility: auto`) and
 * stand at an estimated size until first drawn; these have been drawn.
 */
const drawn = new WeakSet<Element>();
const laidOut = (row: HTMLElement) =>
  drawn.has(row) || getComputedStyle(row).contentVisibility !== 'auto';
function layoutBottom(row: HTMLElement) {
  const { transform } = getComputedStyle(row);
  const shift = transform === 'none' ? 0 : new DOMMatrix(transform).m42;
  return row.getBoundingClientRect().bottom - shift;
}
/** A message a conversation is asked to open at; each asking is its own. */
export interface Opening {
  id: string;
}
/** How a place's conversation is being read. */
interface Reading {
  place: string;
  /**
   * The message read from: the first laid out whose end is in view, and
   * where that end was. Older messages folding its header into theirs change only
   * what is above its text, so its end is what holds still.
   */
  anchor: string | undefined;
  end: number;
  /**
   * How far the page was scrolled then: a scroll not yet noted (its event
   * comes a frame later) moved the view, not what is read from.
   */
  scrolled: number;
  bottom: boolean;
  /** Where you had stopped reading as it opened: the "new since" line. */
  unread: string | null;
  /**
   * The message still to be reached, however far back: shown and marked
   * (no `end`), or put back where its end was.
   */
  goal: { id: string; end: number | null } | null;
  /** The last opening asked for here, gone to once. */
  asked: Opening | null;
}
/**
 * How each place was being read during this visit: coming back to it (from
 * another view, a page, or Back) shows the message you were reading.
 */
const readings = new Map<string, Reading>();
/** Signed out: nothing of where anyone was reading is left. */
export const forgetReadings = () => {
  readings.clear();
};
/**
 * How a place opens: where you were reading it, unless you had read to its
 * end and more has come since; else at the first message you haven't read,
 * or the newest. A message asked for leads.
 */
function opening(
  place: string,
  firstUnread: string | null,
  target: Opening | null,
): Reading {
  const kept = readings.get(place);
  const reading: Reading =
    kept &&
    !(kept.bottom && firstUnread !== null && firstUnread !== kept.unread)
      ? {
          ...kept,
          goal:
            kept.goal ??
            (kept.bottom || kept.anchor === undefined
              ? null
              : { id: kept.anchor, end: kept.end }),
        }
      : {
          place,
          anchor: undefined,
          end: 0,
          scrolled: 0,
          bottom: true,
          unread: firstUnread,
          goal: firstUnread === null ? null : { id: firstUnread, end: null },
          asked: kept?.asked ?? null,
        };
  if (target !== null && target !== reading.asked) {
    reading.goal = { id: target.id, end: null };
    reading.asked = target;
  }
  return reading;
}
/**
 * A conversation reads from the bottom: it opens where you stopped reading
 * (see `opening`), already there on its first paint; it follows what
 * arrives while you are at the bottom, and holds still while you read
 * further back, also as older messages are added above. A message it is
 * opened at is reached however far back it is, from the top of what is
 * there, never by way of the bottom. `sent()` goes to the bottom, so what
 * you just sent comes into view however far back you were.
 */
export function useReadingPosition(
  place: string,
  messages: ChatMessage[],
  {
    firstUnread,
    target,
    older,
    reachOlder,
  }: {
    firstUnread: string | null;
    target: Opening | null;
    /** The cursor to older messages; null at the channel's beginning. */
    older: string | null;
    reachOlder: (cursor: string) => void;
  },
) {
  // Decided as the place opens, so that its first paint is already there.
  const [opened, setOpened] = useState(() =>
    opening(place, firstUnread, target),
  );
  let current = opened;
  if (opened.place !== place) {
    current = opening(place, firstUnread, target);
    setOpened(current);
  }
  const held = useRef<Reading | null>(null);
  // Whether the newest message is in view, for the way back to it.
  const [atEnd, setAtEnd] = useState(true);
  /**
   * Notes what is read from, as the reader left it. `again`: only when the
   * reader scrolled, or it is gone; our own holding is not reading, and
   * noting it would add up what a pixel can't hold.
   */
  const note = (again = false) => {
    const h = held.current;
    if (!h) return;
    if (
      again &&
      window.scrollY === h.scrolled &&
      h.anchor !== undefined &&
      document.getElementById('message-' + h.anchor)
    )
      return;
    // The first on screen that is laid out, not a far row's estimated size:
    // what is drawn above it as it nears the screen moves only what is
    // above. With none drawn yet (just opened, or reached), it stays what
    // it was.
    let first: HTMLElement | undefined;
    let shown: HTMLElement | undefined;
    for (const row of document.querySelectorAll<HTMLElement>(
      '.messages > li[id^="message-"]',
    )) {
      const box = row.getBoundingClientRect();
      if (box.bottom <= 0) continue;
      first ??= row;
      if (box.top >= window.innerHeight) break;
      if (laidOut(row)) {
        shown = row;
        break;
      }
    }
    const kept =
      h.anchor === undefined
        ? null
        : document.getElementById('message-' + h.anchor);
    const row = shown ?? kept ?? first;
    h.anchor = row?.id.slice('message-'.length);
    h.end = row ? layoutBottom(row) : 0;
    h.scrolled = window.scrollY;
    h.bottom = atBottom();
    setAtEnd(h.bottom);
  };
  /**
   * What the conversation shows changed or grew: at the bottom it stays
   * there; read back, what was read from stays where it was, whatever was
   * added or drawn above it (older messages, a diagram, an image). It is
   * measured on the page, not the screen, so a scroll made since it was
   * noted stays as the reader made it.
   */
  const hold = () => {
    const h = held.current;
    if (!h) return;
    if (h.bottom && (window.scrollY >= h.scrolled || atBottom())) {
      toBottom();
      return;
    }
    const row =
      h.anchor === undefined
        ? null
        : document.getElementById('message-' + h.anchor);
    const moved = row
      ? layoutBottom(row) - h.end + window.scrollY - h.scrolled
      : 0;
    // Less than a pixel is where it was: chasing it would never settle.
    if (Math.abs(moved) < 1) return;
    // Held: it is where it was, now this much further down the page.
    const from = window.scrollY;
    window.scrollBy({ top: moved });
    const went = window.scrollY - from;
    h.scrolled += went;
    // What the page's edge stopped is let go, not owed: carried, it would
    // move the reader's own next scroll.
    h.end += moved - went;
  };
  /**
   * Goes to the message still to be reached, once it is there; true when it
   * went. One that isn't there, with nothing older, is given up.
   */
  const reach = (h: Reading, further: string | null) => {
    const goal = h.goal;
    if (!goal) return false;
    const row = document.getElementById('message-' + goal.id);
    if (!row) {
      if (further === null) h.goal = null;
      return false;
    }
    h.goal = null;
    if (goal.end !== null) {
      const moved = layoutBottom(row) - goal.end;
      if (moved !== 0) window.scrollBy({ top: moved });
    } else {
      // Shown and marked, so the eye finds it.
      row.scrollIntoView({ block: 'center' });
      row.dataset.flash = 'true';
      setTimeout(() => {
        delete row.dataset.flash;
      }, 1600);
    }
    // Read from it from now on, where it was put, drawn or not yet.
    h.anchor = goal.id;
    h.end = goal.end ?? layoutBottom(row);
    h.scrolled = window.scrollY;
    h.bottom = atBottom();
    setAtEnd(h.bottom);
    return true;
  };
  useLayoutEffect(() => {
    const h = held.current;
    if (h?.place !== place) {
      const now = { ...current };
      held.current = now;
      readings.set(place, now);
      // What isn't there yet is reached from the top of what is.
      if (!reach(now, older)) {
        if (now.goal) window.scrollTo({ top: 0 });
        else toBottom();
        note();
      }
    } else {
      if (target !== null && target !== h.asked) {
        h.goal = { id: target.id, end: null };
        h.asked = target;
      }
      if (!reach(h, older)) {
        hold();
        note(true);
      }
    }
  }, [place, messages, target, current, older]);
  // Not there yet: read further back, a page at a time, until it is.
  useEffect(() => {
    const h = held.current;
    if (h?.place === place && h.goal !== null && older !== null)
      reachOlder(older);
  }, [place, messages, target, older, reachOlder]);
  // Reading moves the position; so does the window changing size.
  useEffect(() => {
    // What was laid out since it was noted (a row drawn as it nears the
    // screen) is held first: only the reader's own scroll moves it.
    const scrolled = () => {
      hold();
      note(true);
    };
    // A window that changes size keeps you at the bottom if you were.
    const resized = () => {
      if (held.current?.bottom) toBottom();
      note();
    };
    window.addEventListener('scroll', scrolled, { passive: true });
    window.addEventListener('resize', resized);
    return () => {
      window.removeEventListener('scroll', scrolled);
      window.removeEventListener('resize', resized);
    };
  }, []);
  // Something that grows once shown (a diagram drawn, an image loaded)
  // keeps the place: the bottom, or what was read from.
  const list = useCallback((element: HTMLOListElement | null) => {
    if (!element) return;
    const grown = new ResizeObserver(hold);
    grown.observe(element);
    const shown = (event: Event) => {
      if (
        event instanceof ContentVisibilityAutoStateChangeEvent &&
        !event.skipped &&
        event.target instanceof Element
      )
        drawn.add(event.target);
    };
    element.addEventListener('contentvisibilityautostatechange', shown, true);
    return () => {
      grown.disconnect();
      element.removeEventListener(
        'contentvisibilityautostatechange',
        shown,
        true,
      );
    };
  }, []);
  return {
    list,
    atEnd,
    /** Where you had stopped reading as this place opened. */
    unread: current.unread,
    sent: () => {
      toBottom();
      if (held.current) held.current.bottom = true;
      setAtEnd(true);
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
