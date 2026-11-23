import type { ReactNode } from 'react';

export function Notice({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="notice">
      {children}
    </p>
  );
}
