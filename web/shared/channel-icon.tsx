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
