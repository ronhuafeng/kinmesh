import type { ReactNode } from 'react';

/** One thing to do now: the only control on screen until it is done. */
export function NextStep({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="next-step" role="group" aria-label={title}>
      <strong>{title}</strong>
      {children}
    </div>
  );
}
