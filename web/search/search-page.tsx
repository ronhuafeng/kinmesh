import { useEffect, useLayoutEffect, useRef } from 'react';
import type { Command, Remote } from './command.js';
import { useSearch } from './use-search.js';
import { Results } from './results.js';

/**
 * On a phone, search is a tab of its own: the field at the bottom, just
 * above the keyboard (or the tabs, with none), and the results above it,
 * the best nearest the thumb. A choice goes there and leaves search.
 */
export function SearchPage({
  commands,
  remote,
  onClose,
}: {
  commands: Command[];
  remote?: Remote;
  /** Back to where search was opened from. */
  onClose: () => void;
}) {
  const search = useSearch(commands, remote);
  const field = useRef<HTMLInputElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // The field rides on the keyboard: the visual viewport says how much of
  // the screen it takes.
  useEffect(() => {
    const view = window.visualViewport;
    const place = () => {
      const keyboard = view
        ? Math.max(0, window.innerHeight - view.height - view.offsetTop)
        : 0;
      // With no keyboard, the field sits just above the tabs.
      const tabs =
        document.querySelector('.phone-tabs')?.getBoundingClientRect().height ??
        0;
      page.current?.style.setProperty(
        '--search-bottom',
        String(keyboard > 0 ? keyboard : tabs) + 'px',
      );
    };
    place();
    view?.addEventListener('resize', place);
    view?.addEventListener('scroll', place);
    // The page takes focus as it opens; the field takes it after.
    const later = window.setTimeout(() => {
      field.current?.focus({ preventScroll: true });
    });
    return () => {
      window.clearTimeout(later);
      view?.removeEventListener('resize', place);
      view?.removeEventListener('scroll', place);
    };
  }, []);
  // The best result stays in view, at the bottom.
  useLayoutEffect(() => {
    const list = scroller.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [search.query]);
  function run(command: Command | undefined) {
    if (!command) return;
    onClose();
    command.run();
  }
  return (
    <div className="search-page" ref={page}>
      <div className="palette search-page-results" ref={scroller}>
        <Results search={search} run={run} reversed />
      </div>
      <input
        ref={field}
        {...search.input(run, true)}
        className="search-page-field"
        placeholder="搜索"
        enterKeyHint="go"
      />
    </div>
  );
}
