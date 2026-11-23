import { type ReactNode } from 'react';

/** A state beside what it is about: on (green, with a dot) or quiet. */
export function Pill({
  on = false,
  children,
}: {
  on?: boolean;
  children: ReactNode;
}) {
  return (
    <span className="state-pill" data-tone={on ? 'on' : undefined}>
      {children}
    </span>
  );
}
