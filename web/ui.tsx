import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from 'react';
import { BackIcon } from './icons.js';
import type { ReactNode } from 'react';
import type { Task } from '../src/domain/tasks.js';

export type Status = Task['state']['status'];
/** Picture URLs by member ID, from the workspace snapshot. */
export const AvatarImages = createContext<ReadonlyMap<string, string>>(
  new Map(),
);
/**
 * Everyone is round. A person or agent shows their picture when they have
 * one, otherwise their initial, drawn from a data attribute so it never
 * pollutes the accessible name or text.
 */
export function Avatar({
  kind,
  name,
  id,
  size = 'md',
}: {
  kind: 'human' | 'agent';
  name: string;
  /** The member's ID, so their picture can be found. */
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
    'zh-CN',
    today
      ? { hour: '2-digit', minute: '2-digit' }
      : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' },
  );
}
/** In a list: the time today, otherwise the day ("11月14日"). */
export function listTime(iso: string) {
  const date = new Date(iso);
  const today = new Date().toDateString() === date.toDateString();
  return date.toLocaleString(
    'zh-CN',
    today
      ? { hour: '2-digit', minute: '2-digit' }
      : { month: 'short', day: 'numeric' },
  );
}
/** Whether an Inbox worker would wake this agent now. */
export function workerConnected(
  wake: readonly { agentId: string; connected: boolean }[],
  agentId: string,
) {
  return wake.find((w) => w.agentId === agentId)?.connected ?? false;
}
/**
 * Chinese runs on without spaces: a sentence built from names and words
 * keeps a space only beside Latin text ("Ada 正在处理", "小助手正在处理").
 */
export function cjk(text: string) {
  return text.replace(
    /(?<=[\p{Script=Han}，。：；）”])[ ]+(?=[\p{Script=Han}（“])/gu,
    '',
  );
}
/** "刚刚" or "5 分钟前", for sentences. */
export function ago(iso: string, now = Date.now()) {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${String(minutes)} 分钟前`;
  const hours = Math.round(minutes / 60);
  return hours < 24
    ? `${String(hours)} 小时前`
    : `${String(Math.round(hours / 24))} 天前`;
}
/**
 * A page in the main area, in place of the view it was opened from: no
 * overlay and no close button. The sidebar and tabs lead away; Esc goes
 * back, unless a popover or dialog takes it. Only the innermost (last)
 * page answers Esc, so a page shown within another closes alone.
 */
function useMedia(media: string) {
  return useSyncExternalStore(
    (changed) => {
      const query = window.matchMedia(media);
      query.addEventListener('change', changed);
      return () => {
        query.removeEventListener('change', changed);
      };
    },
    () => window.matchMedia(media).matches,
    () => false,
  );
}
/** True on a phone-sized screen, where places stack instead of sitting side by side. */
export function usePhone() {
  return useMedia('(max-width: 575px)');
}
/**
 * Beside the sidebar, how much room there is: narrow (576–899 px, an upright
 * tablet) or wide; null on a phone, where places stack.
 */
export function usePad(): 'narrow' | 'wide' | null {
  const narrow = useMedia('(min-width: 576px) and (max-width: 899px)');
  const wide = useMedia('(min-width: 900px)');
  return narrow ? 'narrow' : wide ? 'wide' : null;
}
/**
 * A page in the main area. On a phone it opens under a bar with a way back
 * and what it is (`bar`); a page reached from the bottom tabs has none.
 */
export function Page({
  label,
  onClose,
  children,
  className,
  bar = label,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  bar?: ReactNode | false;
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
  // Listening from before the first paint: Esc works the moment the page shows.
  useLayoutEffect(() => {
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
      {bar !== false && (
        <div className="page-bar">
          <button
            type="button"
            className="quiet icon-button"
            aria-label="返回"
            onClick={() => {
              close.current();
            }}
          >
            <BackIcon />
          </button>
          <span className="page-bar-title">{bar}</span>
        </div>
      )}
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
  const word = online ? '在线' : '离线';
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
