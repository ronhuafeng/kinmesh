import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
} from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { BackIcon } from './icons.js';
import { useMedia } from './use-media.js';
import { composing } from './keys.js';

/**
 * The start of the top bar, where a page beside the sidebar puts its way
 * back: left of the views, which sit in the middle.
 */
export const HeaderStart = createContext<HTMLElement | null>(null);
/**
 * A page in the main area, in place of the view it was opened from: no
 * overlay and no close button. On a phone it opens under a bar with a way
 * back and what it is (`bar`); a page reached from the bottom tabs has
 * none. On a tablet the way back is at the start of the top bar, unless a
 * view's tab already leads back (`tabLeadsBack`, a task under 看板). Esc
 * goes back, unless a popover or dialog takes it; only the innermost (last)
 * page answers, so a page shown within another closes alone.
 */
export function Page({
  label,
  onClose,
  children,
  className,
  bar = label,
  tabLeadsBack = false,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  bar?: ReactNode | false;
  tabLeadsBack?: boolean;
}) {
  const headerStart = useContext(HeaderStart);
  const tablet = useMedia('(min-width: 576px) and (max-width: 1279px)');
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
        composing(e) ||
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
      {bar !== false &&
        tablet &&
        !tabLeadsBack &&
        headerStart !== null &&
        createPortal(
          <button
            type="button"
            className="quiet icon-button header-page-back"
            aria-label="返回"
            onClick={() => {
              close.current();
            }}
          >
            <BackIcon size={20} />
          </button>,
          headerStart,
        )}
      {bar !== false && !tablet && (
        <div className="page-bar">
          <button
            type="button"
            className="quiet icon-button"
            aria-label="返回"
            onClick={() => {
              close.current();
            }}
          >
            <BackIcon size={20} />
          </button>
          <span className="page-bar-title">{bar}</span>
        </div>
      )}
      {children}
    </section>
  );
}
