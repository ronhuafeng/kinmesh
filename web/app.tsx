import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import { flushSync } from 'react-dom';
import { z } from 'zod';
import * as Tabs from '@radix-ui/react-tabs';
import { PageRef, Revisions, pageParam } from '../src/workspace/events.js';
import { LiveContext, takeStream, useRevisions } from './live.js';
import { Author } from '../src/domain/agents.js';
import { ChannelView, TeamFile } from '../src/domain/communication.js';
import { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { Auth, SIGNED_OUT } from './auth.js';
import { api, HttpError, MutationPermission, Offline, request } from './api.js';
import { ActionForm, AddButton, InlineField } from './forms.js';
import { AgentPage, Team } from './agents.js';
import { OwnWorkerPage } from './setup.js';
import { ChannelTopics, Chat, showMessage } from './chat.js';
import {
  Board,
  blankDraft,
  draftFromMessage,
  humanAsk,
  keepDraft,
  NewTaskPage,
  statusLabel,
  TaskPage,
} from './tasks.js';
import type { BoardFilter, TaskDraft } from './tasks.js';
import { joinedAgents, memberName, otherPeople } from './names.js';
import { plainText } from './markdown.js';
import { Broken, reloadOnce } from './boundary.js';
import {
  readRoute,
  routeUrl,
  samePlace,
  type Focus,
  type Tab,
  type Target,
  type View,
} from './route.js';
import {
  ChannelIcon,
  Avatar,
  AvatarImages,
  HeaderStart,
  Page,
  Presence,
  listTime,
  usePhone,
  workerConnected,
} from './ui.js';
import { SearchPage, SidebarSearch, type Remote } from './palette.js';
import { useSidebar } from './sidebar.js';
import { InboxPage, attentionCount, badgeOf } from './inbox.js';
import { FIRST, SettingsNav, SettingsPage } from './settings-map.js';
import { Files } from './files.js';
import { Pins } from './pins.js';
import { ListRow } from './settings.js';
import { sharedId, takeShared, type Shared } from './share.js';
import {
  AccountMenu,
  ChannelMenu,
  Mark,
  MemberMenu,
  TeamMenu,
} from './menus.js';
import { levelOf, setLevel } from './levels.js';
import type { ChannelLevel } from '../src/domain/notify.js';
import { closeSettled, pushSupported, renew, unsubscribe } from './push.js';
import {
  BackIcon,
  HashIcon,
  InboxIcon,
  SearchIcon,
  SettingsIcons,
  SidebarIcon,
} from './icons.js';
import type { Command } from './palette.js';
/** True when a refresh moved at least one visible task to another status. */
function statusesMoved(
  before: WorkspaceSnapshot | null,
  after: WorkspaceSnapshot,
) {
  if (!before || before.channel?.id !== after.channel?.id) return false;
  const old = new Map(before.tasks.items.map((t) => [t.id, t.state.status]));
  return after.tasks.items.some((t) => {
    const status = old.get(t.id);
    return status !== undefined && status !== t.state.status;
  });
}
/** Puts the views' one thumb under the chosen tab, or hides it on no tab. */
function placeThumb(list: HTMLElement | null) {
  if (!list) return;
  const tab = list.querySelector<HTMLElement>(
    '[role="tab"][data-state="active"]',
  );
  if (!tab) {
    delete list.dataset.thumb;
    return;
  }
  list.style.setProperty('--thumb-x', String(tab.offsetLeft) + 'px');
  list.style.setProperty('--thumb-w', String(tab.offsetWidth) + 'px');
  if (list.dataset.thumb) return;
  // Shown where it belongs first; it slides from the next placement on.
  list.dataset.thumb = 'shown';
  requestAnimationFrame(() => {
    if (list.dataset.thumb) list.dataset.thumb = 'placed';
  });
}
/**
 * The views' thumb moves in the same commit as the content it shows, so the
 * two change together, and follows the tabs when their size changes.
 */
function useThumb() {
  const list = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    placeThumb(list.current);
  });
  return useCallback((el: HTMLDivElement | null) => {
    list.current = el;
    if (!el) return;
    const resized = new ResizeObserver(() => {
      placeThumb(el);
    });
    resized.observe(el);
    return () => {
      resized.disconnect();
    };
  }, []);
}
/**
 * The new snapshot, keeping each message as the one before had it when it
 * is unchanged: a row whose message is the same object is not drawn again.
 */
function keepUnchanged(
  previous: WorkspaceSnapshot | null,
  next: WorkspaceSnapshot,
): WorkspaceSnapshot {
  if (!previous) return next;
  const kept = new Map(previous.messages.items.map((m) => [m.id, m]));
  return {
    ...next,
    messages: {
      ...next.messages,
      items: next.messages.items.map((m) => {
        const old = kept.get(m.id);
        return old && JSON.stringify(old) === JSON.stringify(m) ? old : m;
      }),
    },
  };
}
/** How long a stream may stay silent before the place is read without it. */
const SILENT_STREAM_MS = 3000;
/** You signed out here: the sign-in page waits for you to sign in again. */
function markSignedOut() {
  try {
    sessionStorage.setItem(SIGNED_OUT, '1');
  } catch {
    // Storage refused: inside Feishu the page may sign you back in.
  }
}
/** What the hub's search finds: messages and files, newest first. */
const SearchFound = z.object({
  messages: z.array(
    z.object({
      messageId: z.string(),
      channelId: z.string(),
      excerpt: z.string(),
      author: Author,
    }),
  ),
  files: z.array(TeamFile),
});
function animate(update: () => void) {
  if (
    typeof document.startViewTransition !== 'function' ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ) {
    update();
    return;
  }
  document.startViewTransition(() => {
    flushSync(update);
  });
}
/** A notification clicked while the workspace is open (`sw.js`). */
const Opened = z.strictObject({
  kind: z.literal('open'),
  url: z.string().startsWith('/'),
});
/** An event's JSON, or undefined when it isn't JSON (so it reads as unreadable). */
function parsed(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
export function App() {
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
  // Phone only: the people, you among them, sit behind a menu button.
  // A phone stacks the places: Home, a channel, a page.
  const phone = usePhone();
  const [addingChannel, setAddingChannel] = useState(false);
  // The channel being named again, in place in its row.
  const [renaming, setRenaming] = useState<string | null>(null);
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
  const [view, setView] = useState<View>(initial.view);
  const [cursors, setCursors] = useState<Record<string, string>>({});
  const [focus, setFocus] = useState<Focus>(initial.focus);
  const [draft, setDraft] = useState<TaskDraft | null>(initial.draft);
  // A phone opened with no place in its address starts where something
  // waits on you, if anything does; an address always wins.
  const [addressed] = useState(() => window.location.search !== '');
  const landed = useRef(false);
  useEffect(() => {
    if (landed.current || !data) return;
    landed.current = true;
    if (phone && !addressed && attentionCount(data.attention) > 0)
      setFocus({ kind: 'inbox' });
  }, [data, phone, addressed]);
  // A phone's search is a tab, which ⌘K opens (and closes again); a wider
  // screen searches from the sidebar.
  useEffect(() => {
    if (!phone) {
      setFocus((old) => (old?.kind === 'search' ? null : old));
      return;
    }
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'k') return;
      e.preventDefault();
      setDraft(null);
      setFocus((old) => (old?.kind === 'search' ? null : { kind: 'search' }));
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [phone]);
  // A new task in progress is kept in this tab until created or dropped.
  useEffect(() => {
    keepDraft(draft);
  }, [draft]);
  // A short word at the foot of the screen; a notice also opens its place.
  // Where a page beside the sidebar puts its way back.
  const [headerStart, setHeaderStart] = useState<HTMLElement | null>(null);
  // What the system shared to Kinmesh: asked where it goes, then handed to
  // that channel's composer.
  const [shared, setShared] = useState<Shared | null>(null);
  const [incoming, setIncoming] = useState<
    { key: string; shared: Shared } | undefined
  >(undefined);
  useEffect(() => {
    if (sharedId === null) return;
    void takeShared(sharedId).then(
      (found) => {
        setShared(found);
      },
      () => undefined,
    );
  }, []);
  const [toast, setToast] = useState<{
    id: number;
    message: string;
    detail?: string;
    url?: string;
  } | null>(null);
  // In-page notices shown already, so a refresh doesn't show them again.
  const noticed = useRef(new Set<string>());
  // Notices still to show, one after another.
  const [queuedNotices, setQueuedNotices] = useState<
    { id: string; title: string; body: string; url: string }[]
  >([]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(
      () => {
        setToast(null);
      },
      toast.url ? 8000 : 4000,
    );
    return () => {
      clearTimeout(timer);
    };
  }, [toast]);
  const shown = useRef<WorkspaceSnapshot | null>(null);
  // Once signed out, only signing in again (a new page) shows the workspace:
  // a snapshot still on its way, from the stream or a board's animation,
  // never brings it back.
  const out = useRef(false);
  /**
   * Signed out, or access lost: nothing protected stays on screen, and no
   * channel or page identifiers are left for whoever signs in next.
   */
  const toSignedOut = useCallback((lostAccess = false) => {
    out.current = true;
    shown.current = null;
    setData(null);
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
    setDenied(lostAccess);
    setLastOk(false);
    setUnreachable(false);
    setStatus('signedout');
  }, []);
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
  const place = useMemo(() => {
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
      // Cards on screen travel to their new column; other refreshes stay
      // instant.
      if (
        document.querySelector('.board') &&
        statusesMoved(shown.current, next)
      )
        animate(apply);
      else apply();
    },
    [settle],
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
    void api('/api/workspace?' + place, {
      signal: controller.signal,
    })
      .then((raw) => {
        // An answer for a place already left says nothing about this one.
        if (controller.signal.aborted || streamedCount.current !== before)
          return;
        const next = WorkspaceSnapshot.safeParse(raw);
        if (next.success) show(next.data, place, selection.channel);
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
    place,
    paged,
    selection.channel,
    selection.topic,
    revision,
    toSignedOut,
    begin,
    show,
    drop,
    outdated,
  ]);
  // The address follows the place. Going somewhere new adds a history
  // entry, so Back returns; a topic switch only rewrites the address.
  const routed = useRef(false);
  // A new task shares the page slot; any other page replaces it.
  const newTask = focus === null ? draft : null;
  // On a tablet the sidebar folds away or slides in; a new place closes it.
  const sidebar = useSidebar(
    routeUrl({
      channel: selection.channel,
      topic: selection.topic,
      view,
      agent: agentId,
      focus,
      newTask: newTask !== null,
      target,
      boardFilter,
    }),
  );
  useEffect(() => {
    const next = routeUrl({
      channel: selection.channel,
      topic: selection.topic,
      view,
      agent: agentId,
      focus,
      newTask: newTask !== null,
      target,
      boardFilter,
    });
    const here = window.location.pathname + window.location.search;
    if (next !== here) {
      if (routed.current && !samePlace(next, here))
        window.history.pushState(null, '', next);
      else window.history.replaceState(null, '', next);
    }
    routed.current = true;
  }, [
    selection.channel,
    selection.topic,
    view,
    agentId,
    focus,
    newTask,
    target,
    boardFilter,
  ]);
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
  // The app's badge, where the browser shows one: how many decisions wait on
  // you; else a dot while anything is unread; else nothing, as when signed
  // out.
  const badge =
    data && !signedOut
      ? badgeOf(
          attentionCount(data.attention),
          data.latest.some((l) => l.unread),
        )
      : null;
  useEffect(() => {
    if (!('setAppBadge' in navigator)) return;
    void (
      badge === null
        ? navigator.clearAppBadge()
        : badge === true
          ? navigator.setAppBadge()
          : navigator.setAppBadge(badge)
    ).catch(() => undefined);
  }, [badge]);
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
    const query = new URLSearchParams(place);
    if (pageOnScreen) query.set('page', pageOnScreen);
    const { events, early, failed } = takeStream(query.toString());
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
      show(next.data, place, selection.channel);
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
    place,
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
  const next = (key: string, cursor: string | null) => {
    if (cursor)
      setCursors((old) =>
        old[key] === cursor ? old : { ...old, [key]: cursor },
      );
  };
  const viewTabs = useThumb();
  const selectChannel = (channel: string) => {
    setSelection({ channel, topic: '' });
    setCursors({});
    // A channel in the sidebar leads away from any open page.
    setFocus(null);
    setDraft(null);
    if (view === 'agent') setView('chat');
  };
  // A browser where notifications are on for you stays on for this session;
  // a notification clicked opens its place here.
  const signedIn = data !== null;
  useEffect(() => {
    if (!signedIn || !pushSupported()) return;
    void renew().catch(() => undefined);
    const onMessage = (event: MessageEvent) => {
      const message = Opened.safeParse(event.data);
      if (!message.success) return;
      window.history.pushState(null, '', message.data.url);
      window.dispatchEvent(new PopStateEvent('popstate'));
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => {
      navigator.serviceWorker.removeEventListener('message', onMessage);
    };
  }, [signedIn]);
  // Notifications here about what has since been read or settled close.
  useEffect(() => {
    if (data) void closeSettled(data).catch(() => undefined);
  }, [data]);
  // What concerned you while you were here comes as a notice on the page
  // instead of a notification; each once.
  const notices = data?.notices;
  useEffect(() => {
    const fresh = (notices ?? []).filter((n) => !noticed.current.has(n.id));
    if (fresh.length === 0) return;
    for (const n of fresh) noticed.current.add(n.id);
    setQueuedNotices((old) => [...old, ...fresh]);
  }, [notices]);
  // The next notice shows once the one before it has gone.
  useEffect(() => {
    const [next, ...rest] = queuedNotices;
    if (toast || !next) return;
    setQueuedNotices(rest);
    setToast({
      id: Date.now(),
      message: next.title,
      detail: next.body,
      url: next.url,
    });
  }, [toast, queuedNotices]);
  // ⌘, (Ctrl+, elsewhere) opens settings, as in any Mac app.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== ',' || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      setFocus({ kind: 'settings', section: '' });
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);
  // Pictures by member ID: agents' set here, people's from Feishu. One map
  // while they are unchanged (the workspace keeps unchanged parts the same
  // objects), so a toast or a status change redraws no Avatar.
  const teamId = data?.team.id;
  const avatars = data?.avatars;
  const pictured = data?.people;
  const avatarImages = useMemo(
    () =>
      new Map([
        ...(avatars ?? []).map((a): [string, string] => [
          a.agentId,
          `/api/teams/${teamId ?? ''}/agents/${a.agentId}/avatar?v=${encodeURIComponent(a.updatedAt)}`,
        ]),
        ...(pictured ?? []).flatMap((p): [string, string][] =>
          p.avatar === null
            ? []
            : [
                [
                  p.id,
                  `/api/teams/${teamId ?? ''}/people/${p.id}/avatar?v=${encodeURIComponent(p.avatar)}`,
                ],
              ],
        ),
      ]),
    [teamId, avatars, pictured],
  );
  if (unreadable) return <Broken />;
  if (status === 'signedout') return <Auth denied={denied} />;
  if (!data) {
    const failed = unreachable;
    return (
      <main className="initial-state" aria-busy={!failed}>
        <a className="brand" href="/">
          <span className="brand-mark" aria-hidden="true">
            k
          </span>
          <span>kinmesh</span>
        </a>
        <h1>{failed ? '工作区打不开' : '正在打开工作区…'}</h1>
        {!failed && (
          <div className="skeleton-board" aria-hidden="true">
            {[3, 2, 1].map((cards, column) => (
              <div className="skeleton-column" key={column}>
                {Array.from({ length: cards }, (_, card) => (
                  <span className="skeleton-card" key={card} />
                ))}
              </div>
            ))}
          </div>
        )}
        {/* Only a failure offers anything to do. */}
        {failed && <button onClick={refreshNow}>再试一次</button>}
      </main>
    );
  }
  const channel = data.channel;
  const channelPath = channel
    ? `/api/teams/${data.team.id}/channels/${channel.id}`
    : null;
  // The snapshot on screen belongs to the selected channel (an empty selection
  // means the server's default, which is whatever arrived).
  const onScreen =
    loadedFor === selection.channel ||
    (channel !== null && selection.channel === channel.id);
  // Switching channels: the screen still holds the previous one.
  const switching = status === 'loading' && !onScreen;
  // Act on a confirmed snapshot of the channel in view. A background refresh
  // changes neither, so it never interrupts typing or sending.
  const canAct = lastOk && onScreen && status !== 'offline';
  // A refresh stays silent unless asked for or slow. What is on screen is
  // stale from a failed read until the next good one, retries included.
  const refreshing = lastOk && status === 'loading' && (manual || slow);
  const stale = unreachable;
  const shownChannelName = switching
    ? data.channels.items.find((c) => c.id === selection.channel)?.name
    : channel?.name;
  // Your own conversations, each by who it is with: called by them, with
  // their face, and no "#".
  const directWith = new Map<string, string>(
    data.direct.map((d) => [d.channelId, d.humanId]),
  );
  const shownDirect = directWith.has(
    switching ? selection.channel : (channel?.id ?? ''),
  );
  /** Opens your own conversation with someone, made the first time. */
  const openDirect = (humanId: string) => {
    void request(`/api/teams/${data.team.id}/direct`, {
      operationKey: crypto.randomUUID(),
      humanId,
    }).then(
      (raw) => {
        const opened = ChannelView.safeParse(raw);
        if (!opened.success) return;
        leavePage();
        setView('chat');
        selectChannel(opened.data.id);
        refresh();
      },
      () => {
        notify('没能打开对话，请再试一次。');
      },
    );
  };
  const channelAgents = joinedAgents(data);
  const notify = (message: string) => {
    setToast({ id: Date.now(), message });
  };
  const focusedTask =
    focus?.kind === 'task' && channelPath
      ? (data.tasks.items.find((t) => t.id === focus.id) ??
        (data.openTask?.id === focus.id ? data.openTask : undefined))
      : undefined;
  const workerAgent =
    focus?.kind === 'worker'
      ? data.agents.find((a) => a.id === focus.id)
      : undefined;
  // An open page: a task or a new one (on the board), or the Inbox,
  // Settings or a hand-run worker (on no tab).
  // A task just created is a page already, while its first refresh arrives.
  const onBoardPage =
    channelPath !== null && (focus?.kind === 'task' || newTask !== null);
  const onPage =
    onBoardPage ||
    workerAgent !== undefined ||
    focus?.kind === 'inbox' ||
    focus?.kind === 'settings' ||
    focus?.kind === 'search' ||
    shared !== null;
  // A task (new or open) sits on the board and the Inbox is its own tab;
  // Settings and a hand-run worker sit on no tab. An agent's page is its own tab panel,
  // which no trigger lights.
  const tabValue = onBoardPage
    ? 'board'
    : focus?.kind === 'inbox'
      ? 'inbox'
      : onPage
        ? 'page'
        : view;
  /**
   * Where a phone is: Home (the channels and the team), a channel, a page
   * pushed over it, or a page reached from the bottom tabs. A wider screen
   * shows them side by side and ignores this.
   */
  const screen =
    focus?.kind === 'inbox' ||
    (focus?.kind === 'settings' && focus.section === '') ||
    focus?.kind === 'search'
      ? 'tab'
      : onPage || view === 'agent'
        ? 'page'
        : !selection.channel
          ? 'home'
          : 'channel';
  /** A member's row in the open channel: its menu takes them out of it. */
  const memberRow = (
    member: { kind: 'human' | 'agent'; id: string },
    name: string,
    row: ReactElement,
  ) =>
    channel && channelPath ? (
      <MemberMenu
        channelPath={channelPath}
        channelName={channel.name}
        member={member}
        name={name}
        onFailed={notify}
        onDone={refresh}
      >
        {row}
      </MemberMenu>
    ) : (
      row
    );
  /** What an action that can't go now says, instead of nothing. */
  const cannot = () => {
    notify(
      stale ? '连不上 Kinmesh，恢复连接后再试。' : '页面还在更新，请稍后再试。',
    );
  };
  const signOut = () => {
    if (!canAct) {
      cannot();
      return;
    }
    // This browser stops being notified for you before you leave it.
    void unsubscribe()
      .catch(() => undefined)
      .then(() => api('/api/logout', { method: 'POST' }))
      .then(() => {
        markSignedOut();
        toSignedOut();
      })
      .catch(() => {
        notify('没能退出登录，请再试一次。');
      });
  };
  const signOutEverywhere = () => {
    if (!canAct) {
      cannot();
      return;
    }
    // This browser stops being notified for you before you leave it.
    void unsubscribe()
      .catch(() => undefined)
      .then(() => api('/api/me/sessions/end', { method: 'POST' }))
      .then(() => {
        markSignedOut();
        toSignedOut();
      })
      .catch(() => {
        notify('没能退出登录，请再试一次。');
      });
  };
  /** Leaves the open channel, from the command palette. */
  const leaveChannel = () => {
    if (!channelPath) return;
    if (!canAct) {
      cannot();
      return;
    }
    void api(channelPath + '/leave', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operationKey: crypto.randomUUID() }),
    })
      .then(() => {
        selectChannel('');
      })
      .catch(() => {
        notify('没能退出频道，请再试一次。');
      });
  };
  // How loud the open channel is for you, changed from search.
  const channelLevel = channel ? levelOf(data, channel.id) : 'default';
  const changeLevel = (level: ChannelLevel) => {
    if (!channel) return;
    if (!canAct) {
      cannot();
      return;
    }
    void setLevel(data.team.id, channel.id, level).catch(() => {
      notify('没能改好，请再试一次。');
    });
  };
  /** Leaves any channel you are in, from its row's menu. */
  // A public channel opened without joining it: there to read.
  const looking =
    channel !== null && !data.joinedHumanIds.includes(data.human.id);
  const leaveChannelById = (id: string) => {
    if (!canAct) {
      cannot();
      return;
    }
    void api(`/api/teams/${data.team.id}/channels/${id}/leave`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operationKey: crypto.randomUUID() }),
    })
      .then(() => {
        if (id === channel?.id) selectChannel('');
      })
      .catch(() => {
        notify('没能退出频道，请再试一次。');
      });
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
  const pageAgent =
    view === 'agent' ? data.agents.find((a) => a.id === agentId) : undefined;
  const closeFocus = () => {
    setFocus(null);
  };
  /** Settings at a section; on a phone '' is the map. Esc comes back here. */
  const openSettings = (section: string) => {
    setDraft(null);
    setFocus({ kind: 'settings', section });
  };
  const inSettings = focus?.kind === 'settings';
  const settingsSection =
    focus?.kind === 'settings'
      ? focus.section || (phone ? '' : FIRST.personal)
      : '';
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
  /** Open a task in any joined channel; its page appears once it loads. */
  const openTaskIn = (channelId: string, id: string) => {
    if (channelId !== channel?.id) selectChannel(channelId);
    openTask(id);
  };
  /** A new task in the topic on screen, as its own (empty) page. */
  const startNewTask = () => {
    setDraft(blankDraft(selection.topic || null));
    setFocus(null);
    setView('board');
  };
  const waiting = attentionCount(data.attention);
  // The channels where something waits on you.
  const waitingIn = new Set<string>([
    ...data.attention.decide.map((d) => d.task.channelId),
    ...data.attention.unstuck.map((d) => d.channelId),
  ]);
  /** A message, in its channel's conversation, scrolled to and flashed. */
  /**
   * Opens a message in its channel's conversation (every topic's messages
   * are there too), reaching back as far as it is.
   */
  const openMessageIn = (id: string, messageId: string) => {
    setFocus(null);
    if (id !== channel?.id) selectChannel(id);
    else setSelection((old) => ({ ...old, topic: '' }));
    setView('chat');
    setTarget({ channel: id, topic: '', id: messageId });
  };
  /** Messages and files the hub finds for what is typed in search. */
  const remote: Remote = async (query, signal) => {
    const found = SearchFound.parse(
      await api(
        `/api/teams/${data.team.id}/search?q=${encodeURIComponent(query)}`,
        { signal },
      ),
    );
    const where = (channelId: string) =>
      '#' +
      (data.channels.items.find((c) => c.id === channelId)?.name ?? '频道');
    return [
      ...found.messages.map((m) => ({
        id: 'message-' + m.messageId,
        group: '消息',
        label: m.excerpt,
        hint: memberName(m.author, data) + ' · ' + where(m.channelId),
        run: () => {
          openMessageIn(m.channelId, m.messageId);
        },
      })),
      ...found.files.map((f) => ({
        id: 'file-' + f.attachment.id,
        group: '文件',
        label: f.attachment.name,
        hint: where(f.channelId),
        run: () => {
          openMessageIn(f.channelId, f.messageId);
        },
      })),
    ];
  };
  const commands: Command[] = [
    ...data.attention.decide.map(({ task, channelName }) => ({
      id: 'ask-' + task.id,
      group: '收件箱',
      label: task.title,
      hint: (humanAsk(task, data) ?? '等你决定') + ' · #' + channelName,
      run: () => {
        openTaskIn(task.channelId, task.id);
      },
    })),
    ...(['chat', 'board', 'team', 'files'] as const).map((v) => ({
      id: 'view-' + v,
      group: '视图',
      label: { chat: '聊天', board: '看板', team: '成员', files: '文件' }[v],
      run: () => {
        setView(v);
      },
    })),
    // Places to go first, so a name typed finds its place before an
    // action that mentions it; then the actions.
    ...data.channels.items.map((c) => ({
      id: 'channel-' + c.id,
      group: '频道',
      label: (directWith.has(c.id) ? '' : '# ') + c.name,
      // Its icon says it is a channel; the "#" stays for screen readers.
      channel: { id: c.id, name: c.name },
      run: () => {
        selectChannel(c.id);
      },
    })),
    ...data.agents.map((agent) => ({
      id: 'agent-' + agent.id,
      group: '成员',
      label: agent.name,
      run: () => {
        openAgent(agent.id);
      },
    })),
    ...data.tasks.items.map((task) => ({
      id: 'task-' + task.id,
      group: '任务',
      label: task.title,
      hint:
        '#' + String(task.position) + ' · ' + statusLabel(task.state.status),
      run: () => {
        openTask(task.id);
      },
    })),
    ...(channelPath
      ? [
          {
            id: 'action-new-task',
            group: '操作',
            label: '新任务',
            hint: channel ? '#' + channel.name : undefined,
            run: startNewTask,
          },
        ]
      : []),
    // Only the channel on screen can be left: never the one a switch is
    // leaving behind.
    ...(channel && channelPath && onScreen
      ? [
          {
            id: 'action-mute',
            group: '操作',
            label:
              (channelLevel === 'mute' ? '取消静音 #' : '静音 #') +
              channel.name,
            run: () => {
              changeLevel(channelLevel === 'mute' ? 'default' : 'mute');
            },
          },
          {
            id: 'action-follow',
            group: '操作',
            label:
              (channelLevel === 'follow'
                ? '只通知与我有关的 #'
                : '每条消息都通知 #') + channel.name,
            run: () => {
              changeLevel(channelLevel === 'follow' ? 'default' : 'follow');
            },
          },
          {
            id: 'action-leave',
            group: '操作',
            label: '退出 #' + channel.name,
            run: leaveChannel,
          },
        ]
      : []),
    {
      id: 'action-refresh',
      group: '操作',
      label: '立即刷新',
      run: refreshNow,
    },
  ];
  const teamName = (
    <TeamMenu data={data} onSettings={openSettings}>
      <span
        className="team-name"
        title={data.team.name}
        data-long={data.team.name.length > 12 || undefined}
      >
        {data.team.name}
      </span>
    </TeamMenu>
  );
  return (
    <MutationPermission value={canAct}>
      <LiveContext.Provider value={liveReads}>
        <AvatarImages.Provider value={avatarImages}>
          <Offline value={!canAct && !switching}>
            <div
              className="workspace-shell"
              data-screen={screen}
              data-sidebar={sidebar.state}
            >
              <aside
                className="sidebar"
                id="sidebar"
                ref={sidebar.sidebarRef}
                aria-label="侧栏"
              >
                {inSettings && !phone ? (
                  <SettingsNav
                    current={settingsSection}
                    onSelect={openSettings}
                    onBack={closeFocus}
                  />
                ) : (
                  <>
                    {/* The organization, as Feishu names it, set as a wordmark,
                    with search at the end of its row. A long name wraps to
                    two lines, smaller. */}
                    {phone ? (
                      // A phone's search is its own tab: the row is the name.
                      <div className="team-row">{teamName}</div>
                    ) : (
                      <SidebarSearch
                        commands={commands}
                        remote={remote}
                        onOpen={sidebar.onSearch}
                        end={
                          sidebar.pad && (
                            <button
                              type="button"
                              ref={sidebar.rowToggle}
                              className="quiet icon-button sidebar-toggle"
                              aria-label="收起侧栏"
                              title="收起侧栏"
                              aria-expanded="true"
                              aria-controls="sidebar"
                              aria-keyshortcuts="Meta+Backslash Control+Backslash"
                              onClick={sidebar.toggle}
                            >
                              <SidebarIcon size={20} />
                            </button>
                          )
                        }
                      >
                        {teamName}
                      </SidebarSearch>
                    )}
                    {/* What waits on you across the team, above the channels
                      it comes from; an empty inbox needs no number. A phone
                      has it as a bottom tab. */}
                    {!phone && (
                      <nav className="sidebar-inbox" aria-label="收件箱">
                        <button
                          type="button"
                          aria-current={
                            focus?.kind === 'inbox' ? 'page' : undefined
                          }
                          onClick={() => {
                            setDraft(null);
                            setFocus({ kind: 'inbox' });
                          }}
                        >
                          <InboxIcon size={20} />
                          <span>收件箱</span>
                          {waiting > 0 && (
                            <span className="count">{waiting}</span>
                          )}
                        </button>
                      </nav>
                    )}
                    <nav aria-label="频道">
                      <div className="nav-heading">
                        <h2>频道</h2>
                        <AddButton
                          label="新建频道"
                          onClick={() => {
                            setAddingChannel(true);
                          }}
                        />
                      </div>
                      {(phone
                        ? byActivity(data.channels.items, data.latest)
                        : data.channels.items
                      ).map((c) => (
                        <Fragment key={c.id}>
                          {renaming === c.id && channelPath !== null ? (
                            <InlineField
                              name="name"
                              label="频道名称"
                              placeholder="频道名称"
                              maxLength={80}
                              path={`/api/teams/${data.team.id}/channels/${c.id}/rename`}
                              initial={c.name}
                              taken="这个名称已被占用"
                              onClose={() => {
                                setRenaming(null);
                              }}
                              onCreated={() => {
                                refresh();
                              }}
                            />
                          ) : (
                            <ChannelMenu
                              data={data}
                              channelId={c.id}
                              channelName={c.name}
                              onLeave={leaveChannelById}
                              onFailed={notify}
                              onRename={setRenaming}
                              onArchived={(id) => {
                                if (id === channel?.id) selectChannel('');
                                refresh();
                              }}
                            >
                              <button
                                // On a phone the row also shows the newest message,
                                // which describes it rather than naming it.
                                {...(phone
                                  ? {
                                      'aria-label': c.name,
                                      'aria-describedby': 'latest-' + c.id,
                                    }
                                  : {})}
                                data-muted={
                                  levelOf(data, c.id) === 'mute'
                                    ? 'true'
                                    : undefined
                                }
                                data-unread={
                                  data.latest.find((l) => l.channelId === c.id)
                                    ?.unread
                                    ? 'true'
                                    : undefined
                                }
                                aria-current={
                                  // Only one place is current: a channel while you are
                                  // in its chat or board.
                                  channel?.id === c.id &&
                                  (tabValue === 'chat' ||
                                    tabValue === 'board') &&
                                  !(phone && screen === 'home')
                                    ? 'page'
                                    : undefined
                                }
                                onClick={() => {
                                  selectChannel(c.id);
                                }}
                              >
                                {phone ? (
                                  <ChannelRow
                                    data={data}
                                    channelId={c.id}
                                    name={c.name}
                                    person={directWith.get(c.id)}
                                    latest={data.latest.find(
                                      (l) => l.channelId === c.id,
                                    )}
                                    id={'latest-' + c.id}
                                  />
                                ) : (
                                  <>
                                    {directWith.has(c.id) ? (
                                      <Avatar
                                        kind="human"
                                        name={c.name}
                                        id={directWith.get(c.id) ?? ''}
                                        size="sm"
                                      />
                                    ) : (
                                      <ChannelIcon id={c.id} name={c.name} />
                                    )}
                                    <span
                                      className="channel-name"
                                      title={c.name}
                                    >
                                      {c.name}
                                    </span>
                                  </>
                                )}
                                {/* You follow it: every message notifies you. */}
                                {levelOf(data, c.id) === 'follow' && (
                                  <span
                                    className="channel-follow"
                                    title="每条消息都通知你"
                                  >
                                    <SettingsIcons.bell size={16} />
                                  </span>
                                )}
                                {/* Something in this channel waits on you; once
                              nothing does, the dot fades out. */}
                                <span
                                  className="waiting-dot"
                                  data-on={
                                    waitingIn.has(c.id) ? 'true' : undefined
                                  }
                                  {...(waitingIn.has(c.id)
                                    ? { title: '等你处理' }
                                    : { 'aria-hidden': true })}
                                >
                                  {waitingIn.has(c.id) && (
                                    <span className="visually-hidden">
                                      等你处理
                                    </span>
                                  )}
                                </span>
                              </button>
                            </ChannelMenu>
                          )}
                          {channel?.id === c.id && channelPath && (
                            <ChannelTopics
                              data={data}
                              channelPath={channelPath}
                              topic={selection.topic}
                              current={
                                tabValue === 'chat' || tabValue === 'board'
                              }
                              onTopic={(topic) => {
                                leavePage();
                                setView('chat');
                                setSelection((old) => ({ ...old, topic }));
                                setCursors({});
                              }}
                              next={next}
                            />
                          )}
                        </Fragment>
                      ))}
                      {addingChannel && (
                        <InlineField
                          name="name"
                          label="频道名称"
                          placeholder="频道名称"
                          maxLength={80}
                          path={`/api/teams/${data.team.id}/channels`}
                          className="channel-new"
                          taken="这个名称已被占用"
                          onClose={() => {
                            setAddingChannel(false);
                          }}
                          // The channel just made is where you meant to go.
                          onCreated={selectChannel}
                          // Open to the team unless someone makes it private.
                          extra={{ visibility: 'public' }}
                        />
                      )}
                      {/* Channels you left, only when there are any: one click back. */}
                      <JoinableChannels
                        teamId={data.team.id}
                        channels={[
                          ...data.publicChannels,
                          ...data.leftChannels,
                        ]}
                        current={looking ? channel.id : null}
                        onOpen={selectChannel}
                        onDone={selectChannel}
                      />
                    </nav>
                    {data.channels.nextCursor && (
                      <button
                        className="quiet"
                        onClick={() => {
                          next('channelsCursor', data.channels.nextCursor);
                        }}
                      >
                        更多频道
                      </button>
                    )}
                    <section
                      className="people"
                      aria-label={channel ? '本频道成员' : '成员'}
                    >
                      {/* A line, not a heading: what follows plainly belongs to
                      the channel above. */}
                      <hr className="nav-separator" />
                      <ul>
                        {/* You know you are here: the list is the others. A
                        person has no page of their own: their row opens your
                        own conversation with them. */}
                        {otherPeople(data).map((person) => (
                          <li key={person.id}>
                            {memberRow(
                              { kind: 'human', id: person.id },
                              person.name,
                              // A person's face opens your own conversation.
                              <button
                                className="person"
                                aria-pressed={
                                  channel !== null &&
                                  directWith.get(channel.id) === person.id
                                }
                                onClick={() => {
                                  openDirect(person.id);
                                }}
                              >
                                <Avatar
                                  kind="human"
                                  name={person.name}
                                  id={person.id}
                                  size="sm"
                                />
                                <span className="person-name">
                                  {person.name}
                                </span>
                                <Presence online={person.online} dot />
                              </button>,
                            )}
                          </li>
                        ))}
                        {channelAgents.map((agent) => (
                          <li key={agent.id}>
                            {memberRow(
                              { kind: 'agent', id: agent.id },
                              agent.name,
                              <button
                                className="person"
                                aria-pressed={
                                  view === 'agent' && agentId === agent.id
                                }
                                onClick={() => {
                                  openAgent(agent.id);
                                }}
                              >
                                <Avatar
                                  kind="agent"
                                  name={agent.name}
                                  id={agent.id}
                                  size="sm"
                                />
                                <span className="person-name">
                                  {agent.name}
                                </span>
                                <Presence
                                  online={workerConnected(data.wake, agent.id)}
                                  dot
                                />
                              </button>,
                            )}
                          </li>
                        ))}
                      </ul>
                      {channel && channelAgents.length === 0 && (
                        <button
                          className="link-button"
                          onClick={() => {
                            setView('team');
                          }}
                        >
                          添加智能体
                        </button>
                      )}
                    </section>
                  </>
                )}
                {/* You, at the foot: your mark opens what is about you. */}
                {!phone && (
                  <div className="sidebar-foot">
                    <AccountMenu
                      data={data}
                      onSettings={openSettings}
                      onSignOut={signOut}
                      onSignOutEverywhere={signOutEverywhere}
                      onFailed={notify}
                    />
                  </div>
                )}
              </aside>
              <main className="workspace-main">
                <HeaderStart.Provider value={headerStart}>
                  <Tabs.Root
                    className="workspace-tabs"
                    value={tabValue}
                    // Focus returning from a page or the palette must not switch views.
                    activationMode="manual"
                    onValueChange={(v) => {
                      if (v === 'inbox') return;
                      setView(
                        v === 'board' ||
                          v === 'team' ||
                          v === 'files' ||
                          v === 'pins'
                          ? v
                          : 'chat',
                      );
                    }}
                  >
                    <header
                      className="workspace-header"
                      // Settings beside their map hold nothing up here: no
                      // views, no title, the sidebar's control in the map.
                      data-bare={
                        inSettings && !phone && !(sidebar.pad && sidebar.state)
                          ? 'true'
                          : undefined
                      }
                      // The views centre over the column the place on
                      // screen uses: the bar and the content share an axis.
                      data-column={
                        view === 'agent'
                          ? 'agent'
                          : onBoardPage || view === 'board' || view === 'team'
                            ? undefined
                            : onPage || view === 'files' || view === 'pins'
                              ? 'reading'
                              : 'conversation'
                      }
                    >
                      {/* The start: the way back (a phone's, or a page's on a
                        tablet, put here by the page) and the sidebar's
                        control; the views sit in the middle. */}
                      <div className="header-start" ref={setHeaderStart}>
                        {/* A phone shows no sidebar beside a channel: its bar leads
                      back Home and says where you are. */}
                        {phone && (
                          <button
                            type="button"
                            className="quiet icon-button header-back"
                            aria-label="返回"
                            onClick={goHome}
                          >
                            <BackIcon size={20} />
                          </button>
                        )}
                        {/* Beside the sidebar the page never repeats where you are:
                      the title is there for screen readers only. */}
                        <h1
                          className={phone ? 'header-title' : 'visually-hidden'}
                        >
                          {pageAgent
                            ? pageAgent.name
                            : view === 'team' && !phone
                              ? '成员'
                              : shownChannelName
                                ? (shownDirect ? '' : '# ') + shownChannelName
                                : switching
                                  ? '正在打开频道…'
                                  : '欢迎来到你的团队'}
                        </h1>
                        {/* Closed, the sidebar opens from here; open, the same
                        control ends the team name's row. A floating sidebar
                        covers this one, which keeps the header still. */}
                        {sidebar.pad && sidebar.state && (
                          <button
                            type="button"
                            ref={sidebar.headerToggle}
                            className="quiet icon-button sidebar-toggle"
                            aria-label="展开侧栏"
                            title="展开侧栏"
                            aria-expanded={sidebar.open}
                            aria-controls="sidebar"
                            aria-keyshortcuts="Meta+Backslash Control+Backslash"
                            onClick={sidebar.toggle}
                          >
                            <SidebarIcon size={20} />
                          </button>
                        )}
                      </div>
                      {/* Views stay in reach however far the conversation scrolls;
                        they belong to a channel, so settings show none. */}
                      {!inSettings && (
                        <Tabs.List
                          ref={viewTabs}
                          aria-label="工作区视图"
                          className="view-switch"
                        >
                          <Tabs.Trigger value="chat" onClick={leavePage}>
                            聊天
                          </Tabs.Trigger>
                          <Tabs.Trigger value="board" onClick={leavePage}>
                            看板
                          </Tabs.Trigger>
                          <Tabs.Trigger value="team" onClick={leavePage}>
                            成员
                          </Tabs.Trigger>
                          <Tabs.Trigger value="files" onClick={leavePage}>
                            文件
                          </Tabs.Trigger>
                          {/* Only a channel with pins has their view. */}
                          {(data.pinned.length > 0 || view === 'pins') && (
                            <Tabs.Trigger value="pins" onClick={leavePage}>
                              置顶
                            </Tabs.Trigger>
                          )}
                        </Tabs.List>
                      )}
                      <div className="header-end">
                        {/* Healthy is silent; a refresh asked for, or a slow
                          one, says so. */}
                        {refreshing && (
                          <div className="connection">
                            <span
                              className="connection-dot"
                              aria-hidden="true"
                            />
                            <span role="status">正在刷新…</span>
                          </div>
                        )}
                      </div>
                    </header>
                    {/* One line, and nothing to press: it comes back by itself. */}
                    {stale && (
                      <p className="stale-line" role="status">
                        连不上 Kinmesh。先显示之前的内容，恢复连接前暂停发送。
                      </p>
                    )}
                    <fieldset
                      className="view-content"
                      data-switching={switching ? 'true' : undefined}
                      data-page={onPage ? 'true' : undefined}
                      // A wide tablet keeps the board beside a task's page.
                      data-beside={onBoardPage ? 'board' : undefined}
                    >
                      {/* A task, a new task, the Inbox, Settings or a hand-run
                      worker opens here, in place of the view. Unsent text
                      survives in session storage, not in the hidden view. */}
                      {focusedTask && channelPath && (
                        <TaskPage
                          key={focusedTask.id}
                          task={focusedTask}
                          data={data}
                          path={channelPath + '/tasks/' + focusedTask.id}
                          onDone={refresh}
                          onClose={closeFocus}
                          onDecided={notify}
                          onReply={(id) => {
                            // The reply is in the chat; open it there and point to it.
                            leavePage();
                            setView('chat');
                            setTimeout(() => {
                              showMessage(id);
                            }, 60);
                          }}
                          openAgent={openAgent}
                        />
                      )}
                      {workerAgent && (
                        <OwnWorkerPage
                          key={workerAgent.id}
                          agent={workerAgent}
                          data={data}
                          onClose={closeFocus}
                          onDone={refresh}
                        />
                      )}
                      {focus?.kind === 'inbox' && (
                        <InboxPage
                          data={data}
                          onClose={closeFocus}
                          openTask={openTaskIn}
                          openChannel={(id) => {
                            if (id !== channel?.id) selectChannel(id);
                            setView('chat');
                            setFocus(null);
                          }}
                          openAgent={openAgent}
                          onDone={refresh}
                        />
                      )}
                      {newTask && channelPath && (
                        <NewTaskPage
                          draft={newTask}
                          data={data}
                          channelPath={channelPath}
                          onClose={() => {
                            setDraft(null);
                          }}
                          onCreated={(id) => {
                            // The new task stays on screen, now as itself.
                            setDraft(null);
                            setView('board');
                            setFocus({ kind: 'task', id });
                            refresh();
                          }}
                          onNotify={notify}
                        />
                      )}
                      {phone && focus?.kind === 'search' && (
                        <Page label="搜索" onClose={closeFocus} bar={false}>
                          <SearchPage
                            commands={commands}
                            remote={remote}
                            onClose={closeFocus}
                          />
                        </Page>
                      )}
                      {shared && (
                        <Page
                          label="分享到频道"
                          onClose={() => {
                            setShared(null);
                          }}
                        >
                          <div className="page-body share-page">
                            <p className="muted">
                              {[
                                shared.files.length > 0
                                  ? `${String(shared.files.length)} 个文件`
                                  : '',
                                shared.text !== '' ? '一段文字' : '',
                              ]
                                .filter(Boolean)
                                .join('和')}
                              ，发到哪个频道？
                            </p>
                            <ul className="list-rows" aria-label="频道">
                              {data.channels.items.map((c) => (
                                <ListRow
                                  key={c.id}
                                  lead={<ChannelIcon id={c.id} name={c.name} />}
                                  title={c.name}
                                  onOpen={() => {
                                    setIncoming({
                                      key: crypto.randomUUID(),
                                      shared,
                                    });
                                    setShared(null);
                                    setFocus(null);
                                    selectChannel(c.id);
                                    setView('chat');
                                  }}
                                />
                              ))}
                            </ul>
                          </div>
                        </Page>
                      )}
                      {focus?.kind === 'settings' && (
                        <SettingsPage
                          key={settingsSection}
                          section={settingsSection}
                          phone={phone}
                          data={data}
                          onSection={openSettings}
                          onClose={closeFocus}
                          onSignOut={signOut}
                          onSignOutEverywhere={signOutEverywhere}
                          openChannel={(id) => {
                            setFocus(null);
                            selectChannel(id);
                            setView('chat');
                          }}
                          openMessage={openMessageIn}
                          openAgent={openAgent}
                        />
                      )}

                      {switching && (
                        <div className="view-skeleton" aria-hidden="true">
                          <span className="skeleton-card" />
                          <span className="skeleton-card" />
                          <span className="skeleton-card" />
                        </div>
                      )}
                      {/* A public channel you only look in: read, but nothing to do there until you join. */}
                      <MutationPermission value={canAct && !looking}>
                        <Tabs.Content
                          value="chat"
                          key={channel?.id ?? 'no-channel'}
                        >
                          {channel && channelPath ? (
                            <Chat
                              data={data}
                              channelPath={channelPath}
                              topic={selection.topic}
                              shownTopic={
                                new URLSearchParams(loadedPlace ?? '').get(
                                  'topicId',
                                ) ?? ''
                              }
                              onTopic={(topic) => {
                                setSelection((old) => ({ ...old, topic }));
                                setCursors({});
                              }}
                              target={
                                target?.channel === selection.channel &&
                                target.topic === selection.topic
                                  ? target.id
                                  : null
                              }
                              onOpenMessage={(id) => {
                                openMessageIn(channel.id, id);
                              }}
                              onDone={refresh}
                              next={next}
                              onEarlier={(cursor) => {
                                next('messagesCursor', cursor);
                              }}
                              onMakeTask={(message) => {
                                setDraft(draftFromMessage(message, data));
                                setFocus(null);
                                setView('board');
                              }}
                              openAgent={openAgent}
                              onLeave={() => {
                                selectChannel('');
                              }}
                              onTeam={() => {
                                setView('team');
                              }}
                              incoming={incoming}
                              join={
                                data.channelArchived ? (
                                  <MutationPermission value={canAct}>
                                    <ArchivedBar
                                      teamId={data.team.id}
                                      channel={channel}
                                      onDone={refresh}
                                    />
                                  </MutationPermission>
                                ) : looking ? (
                                  <MutationPermission value={canAct}>
                                    <JoinBar
                                      teamId={data.team.id}
                                      channel={channel}
                                      onDone={refresh}
                                    />
                                  </MutationPermission>
                                ) : null
                              }
                            />
                          ) : (
                            <div className="empty">
                              <h3>没有打开的频道</h3>
                              <p>选一个已加入的频道来查看和发消息。</p>
                            </div>
                          )}
                        </Tabs.Content>
                        <Tabs.Content value="board">
                          {channelPath ? (
                            <Board
                              data={data}
                              openTask={openTask}
                              onNewTask={startNewTask}
                              openId={focus?.kind === 'task' ? focus.id : null}
                              filter={boardFilter}
                              onFilter={setBoardFilter}
                            />
                          ) : (
                            <div className="empty">
                              <p>先建一个频道，再创建任务。</p>
                            </div>
                          )}
                        </Tabs.Content>
                        <Tabs.Content value="files">
                          {channel && (
                            <section
                              className="channel-files"
                              aria-label="文件"
                            >
                              <Files
                                data={data}
                                channelId={channel.id}
                                openMessage={openMessageIn}
                              />
                            </section>
                          )}
                        </Tabs.Content>
                        <Tabs.Content value="pins">
                          {channel && channelPath && (
                            <section
                              className="channel-files"
                              aria-label="置顶"
                            >
                              <Pins
                                data={data}
                                channelPath={channelPath}
                                openMessage={openMessageIn}
                                onDone={refresh}
                              />
                            </section>
                          )}
                        </Tabs.Content>
                        <Tabs.Content value="team">
                          <Team
                            data={data}
                            channelPath={channelPath}
                            channelName={channel?.name ?? ''}
                            onDone={refresh}
                            openAgent={openAgent}
                            openPerson={openDirect}
                          />
                        </Tabs.Content>
                      </MutationPermission>
                      <Tabs.Content value="agent">
                        {pageAgent ? (
                          <AgentPage
                            key={pageAgent.id}
                            agent={pageAgent}
                            data={data}
                            channelPath={channelPath}
                            onBack={() => {
                              setView(backTo);
                            }}
                            onOwnWorker={() => {
                              setFocus({ kind: 'worker', id: pageAgent.id });
                            }}
                            onReply={(id) => {
                              // The reply is in the chat; open it there and point to it.
                              setView('chat');
                              setTimeout(() => {
                                showMessage(id);
                              }, 60);
                            }}
                            onDone={refresh}
                          />
                        ) : (
                          <div className="empty">
                            <p>这个智能体不在你的团队里。</p>
                          </div>
                        )}
                      </Tabs.Content>
                    </fieldset>
                  </Tabs.Root>
                </HeaderStart.Provider>
              </main>
              {/* A phone's three places at the bottom of Home and of the pages
                  they open; a channel or a pushed page has the screen. */}
              {phone && (
                <nav className="phone-tabs" aria-label="位置">
                  {/* Icons only; each says what it is to a screen reader. */}
                  <button
                    type="button"
                    aria-label="频道"
                    title="频道"
                    aria-current={screen === 'home' ? 'page' : undefined}
                    onClick={() => {
                      leavePage();
                      goHome();
                    }}
                  >
                    <HashIcon size={24} />
                  </button>
                  <button
                    type="button"
                    aria-label="搜索"
                    title="搜索"
                    aria-current={focus?.kind === 'search' ? 'page' : undefined}
                    onClick={() => {
                      setDraft(null);
                      setFocus({ kind: 'search' });
                    }}
                  >
                    <SearchIcon size={24} />
                  </button>
                  <button
                    type="button"
                    aria-label="收件箱"
                    title="收件箱"
                    aria-current={focus?.kind === 'inbox' ? 'page' : undefined}
                    onClick={() => {
                      setDraft(null);
                      setFocus({ kind: 'inbox' });
                    }}
                  >
                    <InboxIcon size={24} />
                    {waiting > 0 && <span className="count">{waiting}</span>}
                  </button>
                  <button
                    type="button"
                    aria-label="我"
                    title="我"
                    aria-current={inSettings ? 'page' : undefined}
                    onClick={() => {
                      openSettings('');
                    }}
                  >
                    <Mark name={data.human.name} />
                  </button>
                </nav>
              )}
              {/* One live region, always there, says each toast once; a
                  notice inside it stays a button that opens what it is
                  about. */}
              <div className="toast-region" role="status">
                {toast &&
                  (toast.url ? (
                    <button
                      type="button"
                      className="toast toast-notice"
                      key={toast.id}
                      onClick={() => {
                        const url = toast.url;
                        setToast(null);
                        if (!url) return;
                        window.history.pushState(null, '', url);
                        window.dispatchEvent(new PopStateEvent('popstate'));
                      }}
                    >
                      <strong>{toast.message}</strong>
                      {toast.detail && <span>{toast.detail}</span>}
                    </button>
                  ) : (
                    <div className="toast" key={toast.id}>
                      {toast.message}
                    </div>
                  ))}
              </div>
            </div>
          </Offline>
        </AvatarImages.Provider>
      </LiveContext.Provider>
    </MutationPermission>
  );
}
/**
 * Channels you are not in but may join, muted under the rest: public ones
 * open to look in, and every one is one click from joining.
 */
function JoinableChannels({
  teamId,
  channels,
  current,
  onOpen,
  onDone,
}: {
  teamId: string;
  channels: WorkspaceSnapshot['publicChannels'];
  /** The one open to look in. */
  current: string | null;
  onOpen: (id: string) => void;
  onDone: (id: string) => void;
}) {
  if (channels.length === 0) return null;
  return (
    <ul className="left-channels" aria-label="可加入的频道">
      {channels.map((c) => (
        <li key={c.id}>
          {c.visibility === 'public' ? (
            <button
              type="button"
              aria-current={current === c.id ? 'page' : undefined}
              onClick={() => {
                onOpen(c.id);
              }}
            >
              <span aria-hidden="true">#</span> {c.name}
            </button>
          ) : (
            <span>
              <span aria-hidden="true">#</span> {c.name}
            </span>
          )}
          <ActionForm
            title={'加入 ' + c.name}
            path={`/api/teams/${teamId}/channels/${c.id}/subscribe`}
            build={() => ({})}
            submit="加入"
            onDone={() => {
              onDone(c.id);
            }}
          />
        </li>
      ))}
    </ul>
  );
}
/** Where a channel you only look in would take a message: joining it. */
function JoinBar({
  teamId,
  channel,
  onDone,
}: {
  teamId: string;
  channel: { id: string; name: string };
  onDone: () => void;
}) {
  return (
    <div className="join-bar">
      <ActionForm
        title={'加入 ' + channel.name}
        path={`/api/teams/${teamId}/channels/${channel.id}/subscribe`}
        build={() => ({})}
        submit={'加入 #' + channel.name}
        onDone={onDone}
      />
    </div>
  );
}
/**
 * In place of the composer in an archived channel: it is read, not written
 * to, until someone brings it back.
 */
function ArchivedBar({
  teamId,
  channel,
  onDone,
}: {
  teamId: string;
  channel: { id: string; name: string };
  onDone: () => void;
}) {
  return (
    <div className="join-bar archived-bar">
      <p className="muted">#{channel.name} 已归档。</p>
      <ActionForm
        title={'恢复 ' + channel.name}
        path={`/api/teams/${teamId}/channels/${channel.id}/archive`}
        build={() => ({ archived: false })}
        submit="恢复频道"
        onDone={onDone}
      />
    </div>
  );
}
/**
 * A phone lists channels as conversations: the newest message first (by
 * name among those without one).
 */
function byActivity(
  channels: WorkspaceSnapshot['channels']['items'],
  latest: WorkspaceSnapshot['latest'],
) {
  const at = new Map(latest.map((l) => [l.channelId, l.createdAt]));
  return [...channels].sort((a, b) => {
    const x = at.get(a.id) ?? '';
    const y = at.get(b.id) ?? '';
    return x === y ? a.name.localeCompare(b.name, 'zh-CN') : x < y ? 1 : -1;
  });
}
/** A channel on a phone's Home: its name and time, then "作者：正文". */
function ChannelRow({
  data,
  channelId,
  name,
  person,
  latest,
  id,
}: {
  data: WorkspaceSnapshot;
  channelId: string;
  name: string;
  /** Who your own conversation is with, shown by their face. */
  person: string | undefined;
  latest: WorkspaceSnapshot['latest'][number] | undefined;
  id: string;
}) {
  return (
    <span className="channel-row">
      {person === undefined ? (
        <ChannelIcon id={channelId} name={name} />
      ) : (
        <Avatar kind="human" name={name} id={person} />
      )}
      <span className="channel-row-name">{name}</span>
      {latest && (
        <>
          <time className="channel-row-time" dateTime={latest.createdAt}>
            {listTime(latest.createdAt)}
          </time>
          <span className="channel-row-last" id={id}>
            {memberName(latest.author, data)}：{plainText(latest.excerpt)}
          </span>
        </>
      )}
    </span>
  );
}
