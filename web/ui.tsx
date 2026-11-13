import { createContext, useContext, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import type { Task } from '../src/domain/tasks.js';

export type Status = Task['state']['status'];
/** Picture URLs by agent ID, from the workspace snapshot. */
export const AvatarImages = createContext<ReadonlyMap<string, string>>(
  new Map(),
);
/**
 * Everyone is round. An agent shows its picture when it has one, otherwise
 * its initial, drawn from a data attribute so it never pollutes the
 * accessible name or text.
 */
export function Avatar({
  kind,
  name,
  id,
  size = 'md',
}: {
  kind: 'human' | 'agent';
  name: string;
  /** The member's ID, so an agent's picture can be found. */
  id?: string;
  size?: 'sm' | 'md' | 'xl';
}) {
  const src = useContext(AvatarImages).get(id ?? '');
  return (
    <span
      className={`avatar ${kind} ${size}`}
      data-initial={name.slice(0, 1).toUpperCase()}
      data-image={src ? 'true' : undefined}
      aria-hidden="true"
    >
      {src && <img src={src} alt="" draggable={false} />}
    </span>
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
function age(iso: string, now = Date.now()) {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.round(minutes / 60);
  return hours < 24
    ? `${String(hours)}h`
    : `${String(Math.round(hours / 24))}d`;
}
/** Whether an Inbox worker would wake this agent now. */
export function workerConnected(
  wake: readonly { agentId: string; connected: boolean }[],
  agentId: string,
) {
  return wake.find((w) => w.agentId === agentId)?.connected ?? false;
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
 * A page in the main area, in place of the view it was opened from: no
 * overlay and no close button. The sidebar and tabs lead away; Esc goes
 * back, unless a popover or dialog takes it. Only the innermost (last)
 * page answers Esc, so a page shown within another closes alone.
 */
export function Page({
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
  const page = useRef<HTMLElement>(null);
  useEffect(() => {
    page.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }, []);
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
      const pages = document.querySelectorAll('.page');
      if (pages[pages.length - 1] !== page.current) return;
      close.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, []);
  return (
    <section
      ref={page}
      className={'page' + (className ? ' ' + className : '')}
      aria-label={label}
      tabIndex={-1}
    >
      {children}
    </section>
  );
}
/**
 * Online or offline, said the same way for people and agents: a person is
 * online while signed in here; an agent while a worker can wake it. In a
 * list the word is left to the dot (and to screen readers).
 */
export function Presence({
  online,
  dot = false,
}: {
  online: boolean;
  dot?: boolean;
}) {
  const word = online ? 'Online' : 'Offline';
  return (
    <span
      className={dot ? 'presence dot' : 'presence'}
      data-online={online ? 'true' : undefined}
      {...(dot ? { title: word } : {})}
    >
      {dot ? <span className="visually-hidden">{word}</span> : word}
    </span>
  );
}
