import type { ReactNode } from 'react';
import { CopyButton } from './copy-button.js';

/** A block of code that copies as written, from a button on its corner. */
export function Copyable({
  source,
  children,
}: {
  source: string;
  children: ReactNode;
}) {
  return (
    <div className="code-block">
      {children}
      <CopyButton text={source} label="复制" className="code-copy" />
    </div>
  );
}
