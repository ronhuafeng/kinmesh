import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PageRef, Revisions, pageParam } from '../../src/workspace/events.js';
import { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { api, HttpError } from '../shared/api.js';
import { SIGNED_OUT } from './auth.js';
import { animateBoard } from './animate-board.js';
import { reloadOnce } from './broken.js';
import { keepUnchanged } from './keep-unchanged.js';
import type { Place } from './use-place.js';
import { takeStream, useRevisions } from './use-revisions.js';

/** How long a stream may stay silent before the place is read without it. */
const SILENT_STREAM_MS = 3000;
/** An event's JSON, or undefined when it isn't JSON (so it reads as unreadable). */
function parsed(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
/**
 * The live connection: the snapshot of the place on screen, first from the
 * stream `boot.ts` opened, then as the hub says it changed; reads again
 * when the place changes or a refresh is asked for; and whether the hub is
 * reachable, the session still valid and what it sends still readable.
 */
export function useWorkspace(place: Place) {
  const { selection, cursors, focus, view, agentId } = place;
  const { setSelection, setCursors, setFocus, reset } = place;
  const [data, setData] = useState<WorkspaceSnapshot | null>(null);
  const [status, setStatus] = useState<
    'loading' | 'ready' | 'offline' | 'signedout'
  >('loading');
  // Signed out because this account lost its access, not by choice.
  const [denied, setDenied] = useState(false);
  // Which channel selection the snapshot on screen was loaded for, and whether
  // the most recent refresh succeeded. Sending depends on these two facts,
  // never on whether a background request happens to be running.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  // The exact place (channel, topic, pages) the snapshot on screen shows.
  const [loadedPlace, setLoadedPlace] = useState<string | null>(null);
  // A stream the hub refused is opened again after the next good read.
  const refused = useRef(false);
  const [streamTry, setStreamTry] = useState(0);
  const [lastOk, setLastOk] = useState(false);
  // The last read failed; it stays so through the retries that follow.
  const [unreachable, setUnreachable] = useState(false);
  // The hub sent what this page can't read, and reloading didn't help.
  const [unreadable, setUnreadable] = useState(false);
  const outdated = useCallback(() => {
    if (!reloadOnce()) setUnreadable(true);
  }, []);
  const [revision, setRevision] = useState(0);
  const [manual, setManual] = useState(false);
  const [slow, setSlow] = useState(false);
  const shown = useRef<WorkspaceSnapshot | null>(null);
  // Once signed out, only signing in again (a new page) shows the workspace:
  // a snapshot still on its way, from the stream or a board's animation,
  // never brings it back.
  const out = useRef(false);
  /**
   * Signed out, or access lost: nothing protected stays on screen, and no
   * channel or page identifiers are left for whoever signs in next.
   */
  const toSignedOut = useCallback(
    (lostAccess = false) => {
      out.current = true;
      shown.current = null;
      setData(null);
      reset();
      setDenied(lostAccess);
      setLastOk(false);
      setUnreachable(false);
      setStatus('signedout');
    },
    [reset],
  );
  const refresh = useCallback(() => {
    setRevision((n) => n + 1);
  }, []);
  const { live: liveReads, receive, readAll } = useRevisions(refresh);
  const { begin, settle, drop } = liveReads;
  /** A refresh the person asked for is shown, and reads everything on screen. */
  const refreshNow = useCallback(() => {
    setManual(true);
    setRevision((n) => n + 1);
    readAll();
  }, [readAll]);
  useEffect(() => {
    if (status !== 'loading') {
      setManual(false);
      setSlow(false);
      return;
    }
    const timer = setTimeout(() => {
      setSlow(true);
    }, 800);
    return () => {
      clearTimeout(timer);
    };
  }, [status, revision]);
  // A task opened that isn't on the board on screen (by its address, or
  // older than the board's newest) is part of the place, so the snapshot
  // carries it; decided once per task opened. One on the board is already
  // on screen: opening it reads nothing.
  const focusTask = focus?.kind === 'task' ? focus.id : '';
  const taskReach = useRef({ id: '', reach: false });
  if (taskReach.current.id !== focusTask)
    taskReach.current = {
      id: focusTask,
      reach:
        focusTask !== '' &&
        !(data?.tasks.items.some((task) => task.id === focusTask) ?? false),
    };
  const openTaskId = taskReach.current.reach ? focusTask : '';
  const query = useMemo(() => {
    const query = new URLSearchParams(cursors);
    if (selection.channel) query.set('channelId', selection.channel);
    if (selection.topic) query.set('topicId', selection.topic);
    if (openTaskId) query.set('taskId', openTaskId);
    return query.toString();
  }, [cursors, selection.channel, selection.topic, openTaskId]);
  const paged = Object.keys(cursors).length > 0;
  // The place the snapshot on screen was read for.
  const shownPlace = useRef<string | null>(null);
  // How many snapshots the stream has brought: a read answered after a
  // newer one arrived on it says nothing new.
  const streamedCount = useRef(0);
  /** A snapshot of a place, read or from the stream, put on screen. */
  const show = useCallback(
    (next: WorkspaceSnapshot, readPlace: string, readChannel: string) => {
      if (out.current) return;
      // Held at once, so the revisions naming it read nothing again.
      settle('workspace', next.revision);
      const apply = () => {
        if (out.current) return;
        // The same revision of the same place shows the same: nothing to draw.
        if (
          shownPlace.current !== readPlace ||
          shown.current?.revision !== next.revision
        ) {
          const kept = keepUnchanged(shown.current, next);
          shown.current = kept;
          shownPlace.current = readPlace;
          setData(kept);
        }
        setStatus('ready');
        setLoadedFor(readChannel);
        setLoadedPlace(readPlace);
        setLastOk(true);
        setUnreachable(false);
        if (refused.current) {
          refused.current = false;
          setStreamTry((n) => n + 1);
        }
        // A task that isn't here closes to the board.
        setFocus((old) =>
          old?.kind === 'task' &&
          next.openTask?.id !== old.id &&
          !next.tasks.items.some((task) => task.id === old.id)
            ? null
            : old,
        );
      };
      animateBoard(shown.current, next, apply);
    },
    [settle, setFocus],
  );
  // The first place comes on the stream (`boot.ts` opened it as the page
  // started); a new place, and every refresh, is read at once.
  const streamed = useRef(true);
  useEffect(() => {
    setStatus((previous) => (previous === 'signedout' ? previous : 'loading'));
    begin('workspace');
    if (streamed.current) {
      streamed.current = false;
      return;
    }
    const controller = new AbortController();
    const before = streamedCount.current;
    void api('/api/workspace?' + query, {
      signal: controller.signal,
    })
      .then((raw) => {
        // An answer for a place already left says nothing about this one.
        if (controller.signal.aborted || streamedCount.current !== before)
          return;
        const next = WorkspaceSnapshot.safeParse(raw);
        if (next.success) show(next.data, query, selection.channel);
        else outdated();
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        drop('workspace');
        const refusal = cause instanceof HttpError ? cause.status : null;
        const unopenable = refusal === 404 || refusal === 400;
        if (refusal === 401 || refusal === 403) {
          // Auth loss is not a transient outage: purge the protected snapshot.
          toSignedOut(refusal === 403);
        } else if (unopenable && paged) {
          // A page of a list that can no longer be read: back to its start.
          setCursors({});
        } else if (unopenable && selection.topic) {
          setSelection((old) => ({ ...old, topic: '' }));
        } else if (unopenable && selection.channel) {
          // A channel that can't be opened (left, removed from, or never
          // joined) is not an outage: the default channel opens instead.
          setSelection({ channel: '', topic: '' });
        } else {
          setLastOk(false);
          setUnreachable(true);
          setStatus('offline');
        }
      });
    return () => {
      controller.abort();
    };
  }, [
    query,
    paged,
    selection.channel,
    selection.topic,
    revision,
    toSignedOut,
    begin,
    show,
    drop,
    outdated,
    setCursors,
    setSelection,
  ]);
  // The hub says when what is on screen has changed; nothing is polled.
  // A page on top shows more than the place; the worker page covers the rest.
  const pageOnScreen = useMemo(() => {
    const page = PageRef.safeParse(
      focus?.kind === 'worker'
        ? { kind: 'worker', id: focus.id }
        : view === 'agent'
          ? { kind: 'agent', id: agentId }
          : null,
    );
    return page.success ? pageParam(page.data) : null;
  }, [focus, view, agentId]);
  const signedOut = status === 'signedout';
  // Signed in again: a later link from Feishu signs in by itself.
  useEffect(() => {
    if (status !== 'ready') return;
    try {
      sessionStorage.removeItem(SIGNED_OUT);
    } catch {
      // Storage refused: nothing was kept.
    }
  }, [status]);
  useEffect(() => {
    if (signedOut) return;
    const stream = new URLSearchParams(query);
    if (pageOnScreen) stream.set('page', pageOnScreen);
    const { events, early, failed } = takeStream(stream.toString());
    // A stream that opens but brings nothing, as behind a proxy that holds
    // it, still lets the place be read.
    const silent = setTimeout(refresh, SILENT_STREAM_MS);
    // The workspace arrives on the stream, first as it is, then as it changes.
    const onWorkspace = (event: Event) => {
      if (!(event instanceof MessageEvent) || typeof event.data !== 'string')
        return;
      const next = WorkspaceSnapshot.safeParse(parsed(event.data));
      if (!next.success) {
        outdated();
        return;
      }
      streamedCount.current++;
      clearTimeout(silent);
      show(next.data, query, selection.channel);
    };
    const onRevisions = (event: Event) => {
      if (!(event instanceof MessageEvent) || typeof event.data !== 'string')
        return;
      const next = Revisions.safeParse(parsed(event.data));
      if (next.success) receive(next.data);
      else outdated();
    };
    events.addEventListener('workspace', onWorkspace);
    events.addEventListener('revisions', onRevisions);
    for (const event of early)
      if (event.type === 'workspace') onWorkspace(event);
      else onRevisions(event);
    // The browser retries a lost stream, whose first event is the workspace
    // again. Reading the view now shows whether the hub is out of reach or
    // the session has ended.
    const lost = () => {
      // The browser retries a dropped stream but not a refused one.
      if (events.readyState === EventSource.CLOSED) refused.current = true;
      refresh();
    };
    events.onerror = lost;
    if (failed) lost();
    // A network that comes back may not have broken the stream at all; what
    // came from outside the hub, such as T3's models, is read again too.
    const back = () => {
      refresh();
      readAll();
    };
    window.addEventListener('online', back);
    return () => {
      clearTimeout(silent);
      events.close();
      window.removeEventListener('online', back);
    };
  }, [
    signedOut,
    query,
    pageOnScreen,
    selection.channel,
    show,
    refresh,
    readAll,
    receive,
    streamTry,
    outdated,
  ]);
  // While the hub cannot be reached, nothing can say it is back: ask again.
  useEffect(() => {
    if (status !== 'offline') return;
    const timer = setTimeout(refresh, 5000);
    return () => {
      clearTimeout(timer);
    };
  }, [status, refresh]);
  return {
    data,
    status,
    denied,
    unreadable,
    unreachable,
    lastOk,
    loadedFor,
    loadedPlace,
    manual,
    slow,
    liveReads,
    refresh,
    refreshNow,
    toSignedOut,
  };
}
export type Workspace = ReturnType<typeof useWorkspace>;
