import { type ReactNode } from 'react';

/**
 * A row with its choice at the end: the segmented control. `title` says on
 * hover what the row does, when its label alone may not.
 */
/**
 * A settings group: a small heading over its rows, which hairlines divide.
 * A page of one group has no heading; the map already names it.
 */
export function Group({
  title,
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <section className="settings-group" aria-label={title}>
      {title && <h2 className="settings-group-title">{title}</h2>}
      {children}
    </section>
  );
}
