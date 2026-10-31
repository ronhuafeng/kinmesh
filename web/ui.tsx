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
/** Compact age for cards: "now", "5m", "3h", "2d". */
export function age(iso: string, now = Date.now()) {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.round(minutes / 60);
  return hours < 24
    ? `${String(hours)}h`
    : `${String(Math.round(hours / 24))}d`;
}
/** Whether an Inbox worker would wake this agent now (never "online"). */
export function wakeOf(
  wake: readonly { agentId: string; connected: boolean; lastSeenAt: string }[],
  agentId: string,
) {
  const row = wake.find((w) => w.agentId === agentId);
  return {
    connected: row?.connected ?? false,
    lastSeenAt: row?.lastSeenAt ?? null,
  };
}
export function WakeLabel({
  wake,
  agentId,
}: {
  wake: readonly { agentId: string; connected: boolean; lastSeenAt: string }[];
  agentId: string;
}) {
  const state = wakeOf(wake, agentId);
  return (
    <span className="wake-label" data-wake={state.connected ? 'on' : 'off'}>
      {state.connected
        ? 'Can be woken'
        : state.lastSeenAt
          ? `Not connected · last seen ${ago(state.lastSeenAt)}`
          : 'Not connected'}
    </span>
  );
}
/** "just now" or "5m ago", for sentences. */
export function ago(iso: string) {
  const value = age(iso);
  return value === 'now' ? 'just now' : `${value} ago`;
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
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
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
  // Esc closes the drawer even after focus fell back to the page (for example
  // when the button just used disappears), unless a popover or dialog took it.
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.key !== 'Escape' ||
        e.defaultPrevented ||
        document.querySelector('dialog[open]')
      )
        return;
      close.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
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
        <div className="drawer-content">{children}</div>
      </section>
    </>
  );
}
