import { useEffect, useRef, useState } from 'react';
import { usePad } from '../shared/screen-size.js';

const OPEN_KEY = 'kinmesh:sidebar-open';
/** This device's choice, if it made one: open or closed. */
function readOpen(): boolean | null {
  try {
    // The pinned/unpinned model is gone; its key would only confuse.
    localStorage.removeItem('kinmesh:sidebar-pinned');
    const value = localStorage.getItem(OPEN_KEY);
    return value === null ? null : value === '1';
  } catch {
    return null;
  }
}
function keepOpen(open: boolean) {
  try {
    localStorage.setItem(OPEN_KEY, open ? '1' : '0');
  } catch {
    // Without storage the choice lasts until the page is reloaded.
  }
}
/**
 * The sidebar beside the content (every width but a phone's), open or
 * closed from one control: at the start of the header while closed, at the
 * end of the team name's row while open. From 900 px an open sidebar is a
 * column beside the content; narrower, it floats over the content's edge and
 * closes again on a choice of place, a click outside or Esc. ⌘\ / Ctrl+\
 * toggles it; search (⌘K) opens it. From 900 px it starts open and this
 * device remembers whether it was left open; narrower it always starts
 * closed, since it only visits. `place` is the address: when it changes, a
 * choice was made.
 */
export function useSidebar(place: string) {
  const pad = usePad();
  const [choice, setChoice] = useState(readOpen);
  const [visiting, setVisiting] = useState(false);
  // Only a person's choice slides the sidebar; a screen that changes size
  // puts it in its new place at once.
  const [moving, setMoving] = useState(false);
  // A sidebar visiting a narrow screen goes when the screen changes.
  const [visitedPad, setVisitedPad] = useState(pad);
  if (visitedPad !== pad) {
    setVisitedPad(pad);
    setVisiting(false);
    setMoving(false);
  }
  const open = pad === null || (pad === 'narrow' ? visiting : (choice ?? true));
  const floating = pad === 'narrow' && open;
  const headerToggle = useRef<HTMLButtonElement>(null);
  const rowToggle = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  // Where focus goes once the sidebar has shown or hidden: the control in
  // its new place, unless something else (search, a page) takes it.
  const focusNext = useRef<'header' | 'row' | null>(null);
  function set(next: boolean, moveFocus: boolean) {
    setMoving(true);
    if (pad === 'narrow') setVisiting(next);
    else {
      setChoice(next);
      keepOpen(next);
    }
    focusNext.current = moveFocus ? (next ? 'row' : 'header') : null;
  }
  function toggle() {
    set(!open, true);
  }
  const latest = useRef({ set, open, floating });
  useEffect(() => {
    latest.current = { set, open, floating };
  });
  useEffect(() => {
    const target = focusNext.current;
    focusNext.current = null;
    if (target === 'row') rowToggle.current?.focus({ preventScroll: true });
    else if (target === 'header') {
      const focused = document.activeElement;
      if (
        !focused ||
        focused === document.body ||
        sidebarRef.current?.contains(focused)
      )
        headerToggle.current?.focus({ preventScroll: true });
    }
  }, [open]);
  useEffect(() => {
    const sidebar = sidebarRef.current;
    if (!moving || !sidebar) return;
    const settled = (e: TransitionEvent) => {
      if (e.target === sidebar) setMoving(false);
    };
    sidebar.addEventListener('transitionend', settled);
    sidebar.addEventListener('transitioncancel', settled);
    return () => {
      sidebar.removeEventListener('transitionend', settled);
      sidebar.removeEventListener('transitioncancel', settled);
    };
  }, [moving]);
  // A choice of place closes the floating sidebar.
  const lastPlace = useRef(place);
  useEffect(() => {
    if (lastPlace.current === place) return;
    lastPlace.current = place;
    if (latest.current.floating) latest.current.set(false, false);
  }, [place]);
  useEffect(() => {
    if (!pad) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault();
        latest.current.set(!latest.current.open, true);
        return;
      }
      // Esc closes the floating sidebar, unless its search takes Esc first.
      if (
        e.key === 'Escape' &&
        latest.current.floating &&
        !(
          e.target instanceof Element &&
          e.target.closest('.team-row[data-open]')
        )
      ) {
        e.preventDefault();
        e.stopPropagation();
        latest.current.set(false, true);
      }
    };
    const onDown = (e: PointerEvent) => {
      const target = e.target;
      if (!latest.current.floating || !(target instanceof Element)) return;
      if (
        sidebarRef.current?.contains(target) ||
        headerToggle.current?.contains(target) ||
        target.closest('.search-results')
      )
        return;
      latest.current.set(false, false);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [pad]);
  return {
    pad,
    open,
    /** True while a person's choice slides it in or out. */
    moving,
    /** For the shell: closed, or open over the content; docked otherwise. */
    state: !pad
      ? undefined
      : floating
        ? 'floating'
        : open
          ? undefined
          : 'closed',
    toggle,
    /** Search was asked for: a closed sidebar opens to hold it. */
    onSearch: () => {
      if (!latest.current.open) latest.current.set(true, false);
    },
    headerToggle,
    rowToggle,
    sidebarRef,
  } as const;
}
