import { useCallback, useEffect, useRef, useState } from 'react';
import type { BoardFilter } from '../shared/board-filter.js';
import { blankDraft, keepDraft, type TaskDraft } from '../shared/task-draft.js';
import {
  readRoute,
  routeUrl,
  samePlace,
  type Focus,
  type Tab,
  type Target,
  type View,
} from './route.js';

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
  // The address follows the place. Going somewhere new adds a history
  // entry, so Back returns; a topic switch only rewrites the address.
  const routed = useRef(false);
  useEffect(() => {
    const here = window.location.pathname + window.location.search;
    if (url !== here) {
      if (routed.current && !samePlace(url, here))
        window.history.pushState(null, '', url);
      else window.history.replaceState(null, '', url);
    }
    routed.current = true;
  }, [url]);
  // Back and Forward go to the place their address names.
  useEffect(() => {
    const onPop = () => {
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
      setTarget(place.target);
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
  const closeFocus = () => {
    setFocus(null);
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
    closeFocus,
    openSettings,
    openAgent,
    openTask,
    startNewTask,
  };
}
export type Place = ReturnType<typeof usePlace>;
