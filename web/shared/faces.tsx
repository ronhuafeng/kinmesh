import { createContext, useContext } from 'react';

/** Picture URLs by member ID, from the workspace snapshot. */
export const AvatarImages = createContext<ReadonlyMap<string, string>>(
  new Map(),
);
/**
 * Everyone is round. A person or agent shows their picture when they have
 * one, otherwise their initial, drawn from a data attribute so it never
 * pollutes the accessible name or text.
 */
export function Avatar({
  kind,
  name,
  id,
  size = 'md',
}: {
  kind: 'human' | 'agent';
  name: string;
  /** The member's ID, so their picture can be found. */
  id?: string;
  size?: 'sm' | 'md' | 'xl';
}) {
  const src = useContext(AvatarImages).get(id ?? '');
  return (
    <span
      className={`avatar ${kind} ${size}`}
      data-initial={name.slice(0, 1).toUpperCase()}
      data-image={src ? 'true' : undefined}
      aria-hidden="true"
    >
      {src && <img src={src} alt="" draggable={false} />}
    </span>
  );
}
/** The soft tints a channel's icon is drawn in. */
const tints = ['green', 'blue', 'indigo', 'orange', 'pink', 'teal'] as const;
/**
 * A channel's icon: a rounded square in a soft tint picked from its ID (so
 * it never changes), with the first character of its name. Decorative; the
 * name beside it says what it is.
 */
export function ChannelIcon({ id, name }: { id: string; name: string }) {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return (
    <span
      className="channel-icon"
      data-tint={tints[hash % tints.length]}
      data-initial={(Array.from(name.trim())[0] ?? '#').toUpperCase()}
      aria-hidden="true"
    />
  );
}
/**
 * Online or offline, said the same way for people and agents: a person is
 * online while signed in here; an agent while a worker can wake it. In a
 * list the word is left to the dot (and to screen readers).
 */
export function Presence({
  online,
  dot = false,
}: {
  online: boolean;
  dot?: boolean;
}) {
  const word = online ? '在线' : '离线';
  return (
    <span
      className={dot ? 'presence dot' : 'presence'}
      data-online={online ? 'true' : undefined}
      {...(dot ? { title: word } : {})}
    >
      {dot ? <span className="visually-hidden">{word}</span> : word}
    </span>
  );
}
