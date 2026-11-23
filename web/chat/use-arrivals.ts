import { useEffect, useRef, useState } from 'react';
import { type ChatMessage, mine } from './chat-message.js';

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
