import type { ReactNode } from 'react';

/**
 * A value beside the people that isn't someone: its glyph where their face
 * would be, so every value starts on one edge.
 */
export function SideValue({
  icon,
  children,
}: {
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <span className="side-value">
      <span className="side-icon" aria-hidden="true">
        {icon}
      </span>
      {children}
    </span>
  );
}
