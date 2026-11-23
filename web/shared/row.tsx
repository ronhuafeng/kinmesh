import { type ReactNode } from 'react';

/** One row: its label, then its value or control at the column's end. */
export function Row({
  label,
  children,
}: {
  label: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="you-row">
      <span className="you-row-label">{label}</span>
      <span className="you-row-end">{children}</span>
    </div>
  );
}
