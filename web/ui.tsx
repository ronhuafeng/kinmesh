import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import type { Task } from '../src/domain/tasks.js';

export type Status = Task['state']['status'];
/** Board order: one column per real status, nothing invented. */
export const statuses: readonly { id: Status; label: string }[] = [
  { id: 'proposed', label: 'Proposed' },
  { id: 'in-progress', label: 'In progress' },
  { id: 'review-requested', label: 'Review requested' },
  { id: 'awaiting-human', label: 'Awaiting human' },
  { id: 'rework-requested', label: 'Rework requested' },
  { id: 'accepted', label: 'Accepted' },
  { id: 'cancelled', label: 'Cancelled' },
];
export function statusLabel(status: Status) {
  return statuses.find((s) => s.id === status)?.label ?? status;
}
export function StatusChip({ status }: { status: Status }) {
  return (
    <span className="status-chip" data-status={status}>
      {statusLabel(status)}
    </span>
  );
}
/**
 * Humans are square, agents are round with a runtime glyph. The initial is
 * drawn from a data attribute so it never pollutes the accessible name or text.
 */
export function Avatar({
  kind,
  name,
  size = 'md',
}: {
  kind: 'human' | 'agent';
  name: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  return (
    <span
      className={`avatar ${kind} ${size}`}
      data-initial={name.slice(0, 1).toUpperCase()}
      aria-hidden="true"
    />
  );
}
export function shortTime(iso: string) {
  const date = new Date(iso);
  const today = new Date().toDateString() === date.toDateString();
  return date.toLocaleString(
    undefined,
    today
      ? { hour: '2-digit', minute: '2-digit' }
      : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' },
  );
}
export function plural(count: number, noun: string) {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}
/**
 * Side drawer: docked beside the view on wide screens, a sheet over it on
 * narrow ones. Focus moves in on open and returns to the opener on close.
 */
export function Drawer({
  label,
  onClose,
  children,
  className,
  disabled = false,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    panel.current?.focus({ preventScroll: true });
    return () => {
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  return (
    <>
      <div className="drawer-backdrop" aria-hidden="true" onClick={onClose} />
      <section
        ref={panel}
        className={'drawer' + (className ? ' ' + className : '')}
        aria-label={label}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <button
          type="button"
          className="drawer-close quiet"
          aria-label="Close panel"
          onClick={onClose}
        >
          <span aria-hidden="true">×</span>
          <kbd aria-hidden="true">esc</kbd>
        </button>
        <fieldset className="drawer-content" disabled={disabled}>
          {children}
        </fieldset>
      </section>
    </>
  );
}
