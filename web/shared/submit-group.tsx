import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import { MutationPermission } from './api.js';

/** True while the form around is sending, so its buttons wait. */
export const Sending = createContext(false);
/**
 * Groups submit buttons supplied by a caller so they pause with the
 * workspace, and while their form is sending.
 */
export function SubmitGroup({
  className,
  children,
  held = false,
}: {
  className?: string;
  children: ReactNode;
  /** Keeps buttons down while the caller waits for its own result to arrive. */
  held?: boolean;
}) {
  const permitted = useContext(MutationPermission);
  const sending = useContext(Sending);
  return (
    <fieldset className={className} disabled={!permitted || held || sending}>
      {children}
    </fieldset>
  );
}
