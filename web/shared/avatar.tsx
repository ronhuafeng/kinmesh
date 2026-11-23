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
