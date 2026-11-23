import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { ChatMessage } from './chat-message.js';

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
