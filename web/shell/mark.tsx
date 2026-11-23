import { SettingsIcons } from '../shared/icons.js';

/**
 * A person's mark: their initials in a round of the primary colour, not
 * their picture. The last two characters of a Chinese name (as Feishu
 * shows one), the initials of a Latin one.
 */
export function initials(name: string) {
  const chars = Array.from(name.trim());
  if (chars.length === 0) return '?';
  if (/\p{Script=Han}/u.test(name)) return chars.slice(-2).join('');
  const words = name.trim().split(/\s+/);
  return (
    words.length > 1
      ? (words[0]?.[0] ?? '') + (words[1]?.[0] ?? '')
      : chars.slice(0, 2).join('')
  ).toUpperCase();
}
export function Mark({
  name,
  quiet = false,
  size = 'md',
}: {
  name: string;
  /** Notifications paused: a small moon on its edge. */
  quiet?: boolean;
  size?: 'md' | 'lg';
}) {
  return (
    <span className="mark" data-size={size} aria-hidden="true">
      {initials(name)}
      {quiet && (
        <span className="mark-moon">
          <SettingsIcons.moon size={16} />
        </span>
      )}
    </span>
  );
}
