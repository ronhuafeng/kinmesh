import type { ReactNode } from 'react';
import type { DeliveryView } from './deliveries.js';
import { useApproval } from './use-approval.js';

/**
 * What came of a request; while its run waits for an approval, a link to the
 * run in T3, where it is approved.
 */
export function Outcome({
  delivery,
  teamId,
  t3Origin,
  className,
  children,
}: {
  delivery: DeliveryView;
  teamId: string;
  t3Origin: string | null;
  className?: string;
  children: ReactNode;
}) {
  const approve = useApproval(delivery, teamId, t3Origin);
  return (
    <span className={className}>
      {approve ? (
        <a
          className="link-button"
          href={approve}
          target="_blank"
          rel="noopener noreferrer"
        >
          {children} ↗
        </a>
      ) : (
        children
      )}
    </span>
  );
}
