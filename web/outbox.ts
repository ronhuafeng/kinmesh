import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { Message } from '../src/domain/communication.js';
import { HttpError, api } from './api.js';
import { keep, kept } from './session.js';

/**
 * A message on its way: shown at once, as it will read, until the server
 * has it. Its request is kept exactly, operation key and all, so sending it
 * again can only ever post it once.
 */
export const Outgoing = z.object({
  key: z.string(),
  path: z.string(),
  request: z.string(),
  message: Message,
  /** The newest position on screen when it was sent: it lands after it. */
  after: z.number(),
  /** The message the server made, once it has said so. */
  id: z.string().nullable(),
  failed: z.boolean(),
  /** Why the hub refused it for good, when it did: sending again can't help. */
  refused: z.string().nullable().default(null),
});
export type Outgoing = z.infer<typeof Outgoing>;
/**
 * Why the hub refused a message, when sending it again can't succeed: a
 * client error other than a timeout (408) or a rate limit (429).
 */
function refusal(cause: unknown) {
  if (!(cause instanceof HttpError)) return null;
  const { status } = cause;
  if (status < 400 || status >= 500 || status === 408 || status === 429)
    return null;
  if (status === 403) return '你已不能在这个频道发消息。';
  if (status === 404) return '这个频道或话题已经不在了。';
  if (status === 400) return '内容或附件已经不能这样发了。';
  return cause.message;
}
/**
 * The messages written here that the conversation doesn't show yet, sent
 * one after another so they land in the order written. What hasn't been
 * confirmed survives a reload or a switch of channel; its outcome is then
 * unknown, so it waits to be sent again (or arrives on its own, if it got
 * through).
 */
export function useOutbox(channelPath: string, onSent: () => void) {
  const storeKey = 'outbox:' + channelPath;
  const [outgoing, setOutgoing] = useState<Outgoing[]>(() => {
    const saved = z.array(Outgoing).safeParse(kept(storeKey));
    return saved.success
      ? saved.data
          .filter((o) => o.id === null)
          .map((o) => ({ ...o, failed: true }))
      : [];
  });
  useEffect(() => {
    const unconfirmed = outgoing.filter((o) => o.id === null);
    keep(storeKey, unconfirmed.length > 0 ? unconfirmed : null);
  }, [storeKey, outgoing]);
  const sent = useRef(onSent);
  useEffect(() => {
    sent.current = onSent;
  }, [onSent]);
  const queue = useRef(Promise.resolve());
  const update = (key: string, change: Partial<Outgoing>) => {
    setOutgoing((old) =>
      old.map((o) => (o.key === key ? { ...o, ...change } : o)),
    );
  };
  const post = (entry: Outgoing) => {
    queue.current = queue.current.then(async () => {
      try {
        const raw = await api(entry.path, {
          method: 'POST',
          body: entry.request,
          headers: { 'content-type': 'application/json' },
        });
        update(entry.key, { id: z.object({ id: z.string() }).parse(raw).id });
        sent.current();
      } catch (cause) {
        update(entry.key, { failed: true, refused: refusal(cause) });
      }
    });
  };
  return {
    outgoing,
    send(entry: Outgoing) {
      setOutgoing((old) => [...old, entry]);
      post(entry);
    },
    retry(entry: Outgoing) {
      update(entry.key, { failed: false, refused: null });
      post({ ...entry, failed: false, refused: null });
    },
    remove(keys: string[]) {
      setOutgoing((old) => old.filter((o) => !keys.includes(o.key)));
    },
  };
}
