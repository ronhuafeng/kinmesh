import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import type { BoardFilter } from '../shared/board-filter.js';
import { blankDraft, keepDraft, type TaskDraft } from '../shared/task-draft.js';
import { forgetReadings } from '../chat/reading.js';
import {
  readRoute,
  routeUrl,
  samePlace,
  type Focus,
  type Tab,
  type Target,
  type View,
} from './route.js';

/** This page, since it loaded: going back crosses only its own entries. */
const PAGE = crypto.randomUUID();
/** What this page keeps with each history entry it makes. */
const Entry = z.object({
  page: z.string(),
  /** The address of the entry behind it. */
  back: z.string().nullable(),
});
/** The address of the entry behind this one, when this page made both. */
const behind = () => {
  const entry = Entry.safeParse(window.history.state);
  return entry.success && entry.data.page === PAGE ? entry.data.back : null;
};
const address = () => window.location.pathname + window.location.search;
/**
 * Puts a place's address in history. Going somewhere new adds an entry, so
 * Back returns; a topic switch, or a new task becoming itself, only
 * rewrites it. Going back (`returning`) is Back when the entry behind is
 * where it leads, and otherwise rewrites the address; only with nothing of
 * this page's behind (a link opened) does it add an entry. True when it
 * went Back, which the browser does later.
 */
function follow(url: string, returning: boolean) {
  const here = address();
  const before = behind();
  if (url === here) return false;
  if (returning && url === before) {
    window.history.back();
    return true;
  }
  if (samePlace(url, here) || (returning && before !== null))
    window.history.replaceState({ page: PAGE, back: before }, '', url);
  else window.history.pushState({ page: PAGE, back: here }, '', url);
  return false;
}
/**
 * Where you are in the workspace: the channel and topic, the view, the page
 * open over it, a new task being written, the message a conversation opens
 * at and how far lists reach back. The address follows it, and Back and
 * Forward bring it back.
 */
export function usePlace() {
  const [initial] = useState(readRoute);
  const [selection, setSelection] = useState({
    channel: initial.channel,
    topic: initial.topic,
  });
  // The message a conversation is opened at; it counts only while that
  // channel and topic are open, and the address keeps it for a reload.
  const [target, setTarget] = useState<Target | null>(initial.target);
  // How the board is narrowed, kept in the address.
  const [boardFilter, setBoardFilter] = useState<BoardFilter>(
    initial.boardFilter,
  );
  // The agent whose page is open, and the tab Esc returns to from it.
  const [agentId, setAgentId] = useState(initial.agent);
  const [backTo, setBackTo] = useState<Tab>('team');
  const [view, setView] = useState<View>(initial.view);
  const [cursors, setCursors] = useState<Record<string, string>>({});
  const [focus, setFocus] = useState<Focus>(initial.focus);
  const [draft, setDraft] = useState<TaskDraft | null>(initial.draft);
  // A new task in progress is kept in this tab until created or dropped.
  useEffect(() => {
    keepDraft(draft);
  }, [draft]);
  // A new task shares the page slot; any other page replaces it.
  const newTask = focus === null ? draft : null;
  const url = routeUrl({
    channel: selection.channel,
    topic: selection.topic,
    view,
    agent: agentId,
    focus,
    newTask: newTask !== null,
    target,
    boardFilter,
  });
  // The address follows the place (see `follow`). While the browser goes
  // Back for a way back, the place is already shown; what changes meanwhile
  // is put in history once it has.
  const routed = useRef<string | null>(null);
  const returning = useRef(false);
  const goingBack = useRef(false);
  useEffect(() => {
    if (routed.current === null)
      window.history.replaceState({ page: PAGE, back: null }, '', url);
    else if (!goingBack.current)
      goingBack.current = follow(url, returning.current);
    routed.current = url;
  }, [url]);
  // A way back counts for the change it makes, and only that.
  useEffect(() => {
    returning.current = false;
  });
  // Back and Forward go to the place their address names.
  useEffect(() => {
    // Each place keeps its own position (a conversation the message you
    // were reading); the browser's offset would land in a list not yet
    // drawn to its length.
    window.history.scrollRestoration = 'manual';
    const onPop = () => {
      // A way back arrived: the place is already shown.
      if (goingBack.current) {
        goingBack.current = false;
        if (routed.current !== null) follow(routed.current, false);
        return;
      }
      // An address pushed from elsewhere (a notice, a notification) has
      // this one behind it.
      if (window.history.state === null)
        window.history.replaceState(
          { page: PAGE, back: routed.current },
          '',
          address(),
        );
      const place = readRoute();
      setSelection((old) => {
        if (old.channel === place.channel && old.topic === place.topic)
          return old;
        if (old.channel !== place.channel) setCursors({});
        return { channel: place.channel, topic: place.topic };
      });
      setView(place.view);
      setAgentId(place.agent);
      setFocus(place.focus);
      setDraft(place.draft);
      // The same message asked for is not asked for again: coming back to
      // its conversation shows what you were reading.
      setTarget((old) =>
        old !== null &&
        place.target !== null &&
        old.channel === place.target.channel &&
        old.topic === place.target.topic &&
        old.id === place.target.id
          ? old
          : place.target,
      );
      setBoardFilter(place.boardFilter);
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
    };
  }, []);
  /**
   * Signed out: no channel or page identifiers are left for whoever signs
   * in next.
   */
  const reset = useCallback(() => {
    setFocus(null);
    setDraft(null);
    setSelection((previous) =>
      !previous.channel && !previous.topic
        ? previous
        : { channel: '', topic: '' },
    );
    setView('chat');
    setCursors((previous) =>
      Object.keys(previous).length === 0 ? previous : {},
    );
    forgetReadings();
  }, []);
  /** Reaches a list further back, by its cursor. */
  const next = (key: string, cursor: string | null) => {
    if (cursor)
      setCursors((old) =>
        old[key] === cursor ? old : { ...old, [key]: cursor },
      );
  };
  const selectChannel = (channel: string) => {
    setSelection({ channel, topic: '' });
    setCursors({});
    // A channel in the sidebar leads away from any open page.
    setFocus(null);
    setDraft(null);
    if (view === 'agent') setView('chat');
  };
  const goHome = () => {
    selectChannel('');
    setView('chat');
  };
  /** Any tab leads away from a page, even the one it sits on. */
  const leavePage = () => {
    setFocus(null);
    setDraft(null);
  };
  /**
   * Goes back: Esc, a page's way back, a phone's 返回. To the entry behind
   * when that is where `go` leads, so Back then leaves it and history
   * doesn't grow.
   */
  const back = (go: () => void) => {
    returning.current = true;
    go();
  };
  const closeFocus = () => {
    back(() => {
      setFocus(null);
    });
  };
  /** Settings at a section; on a phone '' is the map. Esc comes back here. */
  const openSettings = (section: string) => {
    setDraft(null);
    setFocus({ kind: 'settings', section });
  };
  /** An agent opens as its own page; Esc returns to the tab it came from. */
  const openAgent = (id: string) => {
    if (view !== 'agent') setBackTo(view);
    setAgentId(id);
    setView('agent');
    setFocus(null);
  };
  const openTask = (id: string) => {
    setView('board');
    setFocus({ kind: 'task', id });
  };
  /** A new task in the topic on screen, as its own (empty) page. */
  const startNewTask = () => {
    setDraft(blankDraft(selection.topic || null));
    setFocus(null);
    setView('board');
  };
  return {
    selection,
    setSelection,
    target,
    setTarget,
    boardFilter,
    setBoardFilter,
    agentId,
    backTo,
    view,
    setView,
    cursors,
    setCursors,
    focus,
    setFocus,
    draft,
    setDraft,
    newTask,
    url,
    reset,
    next,
    selectChannel,
    goHome,
    leavePage,
    back,
    closeFocus,
    openSettings,
    openAgent,
    openTask,
    startNewTask,
  };
}
export type Place = ReturnType<typeof usePlace>;
