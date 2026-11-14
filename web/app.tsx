import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { flushSync } from 'react-dom';
import * as Tabs from '@radix-ui/react-tabs';
import { ChannelId, TaskId } from '../src/domain/contracts.js';
import { PageRef, Revisions, pageParam } from '../src/workspace/events.js';
import { LiveContext, useRevisions } from './live.js';
import { Agent } from '../src/domain/agents.js';
import { TopicId } from '../src/domain/communication.js';
import { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { Auth } from './auth.js';
import { api, HttpError, MutationPermission, Offline } from './api.js';
import { ActionForm, AddButton, InlineField, Notice } from './forms.js';
import { AgentPage, Team } from './agents.js';
import { OwnWorkerPage } from './setup.js';
import { ChannelTopics, Chat, showMessage } from './chat.js';
import {
  Board,
  blankDraft,
  draftFromMessage,
  humanAsk,
  keepDraft,
  keptDraft,
  NewTaskPage,
  statusLabel,
  TaskPage,
} from './tasks.js';
import type { TaskDraft } from './tasks.js';
import { joinedAgents } from './names.js';
import {
  Avatar,
  AvatarImages,
  Presence,
  usePhone,
  workerConnected,
} from './ui.js';
import { CommandPalette } from './palette.js';
import { InboxPage, attentionCount } from './inbox.js';
import { SettingsPage } from './settings.js';
import { BackIcon, HomeIcon, InboxIcon, PowerIcon } from './icons.js';
import type { Command } from './palette.js';
/** Tabs, plus one agent's own page reached from them. */
type View = 'chat' | 'board' | 'team' | 'agent';
type Tab = Exclude<View, 'agent'>;
type Focus =
  | { kind: 'task' | 'worker'; id: string }
  | { kind: 'inbox' | 'settings' }
  | null;
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
/**
 * Where you are, as the address says it, so a reload or a shared link opens
 * the same place: the channel and topic, the view, an agent's page, a task
 * (or "new"), the Inbox, Settings, or a hand-run worker.
 */
function readRoute() {
  const query = new URLSearchParams(window.location.search);
  const valid =
    (parse: { safeParse: (v: unknown) => { success: boolean } }) =>
    (key: string) => {
      const value = query.get(key);
      return value !== null && parse.safeParse(value).success ? value : '';
    };
  const agentParam = valid(Agent.shape.id);
  const channel = valid(ChannelId)('channel');
  const topic = valid(TopicId)('topic');
  const worker = agentParam('worker');
  const task = query.get('task');
  let agent = agentParam('agent');
  let view: View =
    query.get('view') === 'board'
      ? 'board'
      : query.get('view') === 'team'
        ? 'team'
        : 'chat';
  let focus: Focus = null;
  let draft: TaskDraft | null = null;
  if (task === 'new') {
    view = 'board';
    draft = keptDraft()?.draft ?? blankDraft(topic || null);
  } else if (task !== null && TaskId.safeParse(task).success) {
    view = 'board';
    focus = { kind: 'task', id: task };
  } else if (worker) {
    view = 'agent';
    agent = worker;
    focus = { kind: 'worker', id: worker };
  } else if (query.has('inbox')) focus = { kind: 'inbox' };
  else if (query.has('settings')) focus = { kind: 'settings' };
  if (agent && !worker) view = 'agent';
  return { channel, topic, view, agent, focus, draft };
}
/** The address for a place; the inverse of readRoute. */
function routeUrl(place: {
  channel: string;
  topic: string;
  view: View;
  agent: string;
  focus: Focus;
  newTask: boolean;
}) {
  const query = new URLSearchParams();
  if (place.channel) query.set('channel', place.channel);
  if (place.topic) query.set('topic', place.topic);
  if (place.focus?.kind === 'task') query.set('task', place.focus.id);
  else if (place.newTask) query.set('task', 'new');
  else if (place.focus?.kind === 'worker') query.set('worker', place.focus.id);
  else if (place.focus?.kind === 'inbox') query.set('inbox', '');
  else if (place.focus?.kind === 'settings') query.set('settings', '');
  else if (place.view === 'agent' && place.agent)
    query.set('agent', place.agent);
  else if (place.view === 'board' || place.view === 'team')
    query.set('view', place.view);
  const search = query.toString().replace(/=(?=&|$)/g, '');
  return '/' + (search ? '?' + search : '');
}
/** Two addresses are the same place when only the topic differs. */
function samePlace(a: string, b: string) {
  const strip = (url: string) => {
    const parsed = new URL(url, window.location.origin);
    parsed.searchParams.delete('topic');
    return parsed.search;
  };
  return strip(a) === strip(b);
}
export function App() {
  const [initial] = useState(readRoute);
  const [selection, setSelection] = useState({
    channel: initial.channel,
    topic: initial.topic,
  });
  // The agent whose page is open, and the tab Esc returns to from it.
  const [agentId, setAgentId] = useState(initial.agent);
  const [backTo, setBackTo] = useState<Tab>('team');
  // Phone only: the people, you among them, sit behind a menu button.
  // A phone stacks the places: Home, a channel, a page.
  const phone = usePhone();
  const [addingChannel, setAddingChannel] = useState(false);
  const [data, setData] = useState<WorkspaceSnapshot | null>(null);
  const [status, setStatus] = useState<
    'loading' | 'ready' | 'offline' | 'signedout'
  >('loading');
  const [error, setError] = useState('');
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
  const [revision, setRevision] = useState(0);
  const [manual, setManual] = useState(false);
  const [slow, setSlow] = useState(false);
  const [view, setView] = useState<View>(initial.view);
  const [cursors, setCursors] = useState<Record<string, string>>({});
  const [focus, setFocus] = useState<Focus>(initial.focus);
  const [draft, setDraft] = useState<TaskDraft | null>(initial.draft);
  // A new task in progress is kept in this tab until created or dropped.
  useEffect(() => {
    keepDraft(draft);
  }, [draft]);
  const [toast, setToast] = useState<{ id: number; message: string } | null>(
    null,
  );
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => {
      setToast(null);
    }, 4000);
    return () => {
      clearTimeout(timer);
    };
  }, [toast]);
  const shown = useRef<WorkspaceSnapshot | null>(null);
  /**
   * Signed out, or access lost: nothing protected stays on screen, and no
   * channel or page identifiers are left for whoever signs in next.
   */
  const toSignedOut = useCallback((message: string) => {
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
    setError(message);
    setLastOk(false);
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
  const place = useMemo(() => {
    const query = new URLSearchParams(cursors);
    if (selection.channel) query.set('channelId', selection.channel);
    if (selection.topic) query.set('topicId', selection.topic);
    return query.toString();
  }, [cursors, selection.channel, selection.topic]);
  useEffect(() => {
    const controller = new AbortController();
    setStatus((previous) => (previous === 'signedout' ? previous : 'loading'));
    begin('workspace');
    void api('/api/workspace?' + place, {
      signal: controller.signal,
    })
      .then((raw) => {
        const next = WorkspaceSnapshot.parse(raw);
        const apply = () => {
          settle('workspace', next.revision);
          shown.current = next;
          setData(next);
          setStatus('ready');
          setLoadedFor(selection.channel);
          setLoadedPlace(place);
          setLastOk(true);
          if (refused.current) {
            refused.current = false;
            setStreamTry((n) => n + 1);
          }
          setError('');
        };
        // Cards on screen travel to their new column; other refreshes stay
        // instant.
        if (
          document.querySelector('.board') &&
          statusesMoved(shown.current, next)
        )
          animate(apply);
        else apply();
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        drop('workspace');
        if (
          cause instanceof HttpError &&
          (cause.status === 401 || cause.status === 403)
        ) {
          // Auth loss is not a transient outage: purge the protected snapshot.
          toSignedOut(cause.status === 403 ? cause.message : '');
        } else {
          setError(
            cause instanceof HttpError
              ? cause.message
              : 'You’re offline. Showing what was here before; sending is paused until you’re back.',
          );
          setLastOk(false);
          setStatus('offline');
        }
      });
    return () => {
      controller.abort();
    };
  }, [place, selection.channel, revision, toSignedOut, begin, settle, drop]);
  // The address follows the place. Going somewhere new adds a history
  // entry, so Back returns; a topic switch only rewrites the address.
  const routed = useRef(false);
  // A new task shares the page slot; any other page replaces it.
  const newTask = focus === null ? draft : null;
  useEffect(() => {
    const next = routeUrl({
      channel: selection.channel,
      topic: selection.topic,
      view,
      agent: agentId,
      focus,
      newTask: newTask !== null,
    });
    const here = window.location.pathname + window.location.search;
    if (next !== here) {
      if (routed.current && !samePlace(next, here))
        window.history.pushState(null, '', next);
      else window.history.replaceState(null, '', next);
    }
    routed.current = true;
  }, [selection.channel, selection.topic, view, agentId, focus, newTask]);
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
  const live = status !== 'signedout' && loadedPlace === place;
  useEffect(() => {
    if (!live) return;
    const query = new URLSearchParams(place);
    if (pageOnScreen) query.set('page', pageOnScreen);
    const events = new EventSource('/api/events?' + query.toString());
    let lost = false;
    events.addEventListener('revisions', (event) => {
      if (event instanceof MessageEvent && typeof event.data === 'string')
        receive(Revisions.parse(JSON.parse(event.data) as unknown));
    });
    // The browser retries a lost stream. Reading the view now shows whether
    // the hub is out of reach or the session has ended; it is read again
    // once the stream is back.
    events.onerror = () => {
      lost = true;
      // The browser retries a dropped stream but not a refused one.
      if (events.readyState === EventSource.CLOSED) refused.current = true;
      refresh();
    };
    events.onopen = () => {
      if (!lost) return;
      lost = false;
      refresh();
    };
    // A network that comes back may not have broken the stream at all; what
    // came from outside the hub, such as T3's models, is read again too.
    const back = () => {
      refresh();
      readAll();
    };
    window.addEventListener('online', back);
    return () => {
      events.close();
      window.removeEventListener('online', back);
    };
  }, [live, place, pageOnScreen, refresh, readAll, receive, streamTry]);
  // While the hub cannot be reached, nothing can say it is back: ask again.
  useEffect(() => {
    if (status !== 'offline') return;
    const timer = setTimeout(refresh, 5000);
    return () => {
      clearTimeout(timer);
    };
  }, [status, refresh]);
  const next = (key: string, cursor: string | null) => {
    if (cursor) setCursors((old) => ({ ...old, [key]: cursor }));
  };
  const selectChannel = (channel: string) => {
    setSelection({ channel, topic: '' });
    setCursors({});
    // A channel in the sidebar leads away from any open page.
    setFocus(null);
    setDraft(null);
    // On a phone the team is on Home, so a channel opens on its chat.
    if (view === 'agent' || (phone && view === 'team')) setView('chat');
  };
  if (status === 'signedout')
    return (
      <>
        {error && <Notice>{error} Sign in with an authorized account.</Notice>}
        <Auth onLogin={refresh} />
      </>
    );
  if (!data)
    return (
      <main className="initial-state" aria-busy={!error}>
        <a className="brand" href="/">
          <span className="brand-mark" aria-hidden="true">
            k
          </span>
          <span>kinmesh</span>
        </a>
        <h1>{error ? 'Workspace unavailable' : 'Opening your workspace…'}</h1>
        {error ? (
          <Notice>{error}</Notice>
        ) : (
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
        <button onClick={refreshNow}>Try again</button>
      </main>
    );
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
  // The heartbeat refresh stays silent unless asked for, failing, or slow.
  const connection =
    status === 'loading' && !manual && !slow && lastOk ? 'ready' : status;
  const shownChannelName = switching
    ? data.channels.items.find((c) => c.id === selection.channel)?.name
    : channel?.name;
  const channelAgents = joinedAgents(data);
  const notify = (message: string) => {
    setToast({ id: Date.now(), message });
  };
  const focusedTask =
    focus?.kind === 'task' && channelPath
      ? data.tasks.items.find((t) => t.id === focus.id)
      : undefined;
  const workerAgent =
    focus?.kind === 'worker'
      ? data.agents.find((a) => a.id === focus.id)
      : undefined;
  const avatarImages = new Map(
    data.avatars.map((a) => [
      a.agentId,
      `/api/teams/${data.team.id}/agents/${a.agentId}/avatar?v=${encodeURIComponent(a.updatedAt)}`,
    ]),
  );
  // An open page: a task or a new one (on the board), or the Inbox,
  // Settings or a hand-run worker (on no tab).
  // A task just created is a page already, while its first refresh arrives.
  const onBoardPage =
    channelPath !== null && (focus?.kind === 'task' || newTask !== null);
  const onPage =
    onBoardPage ||
    workerAgent !== undefined ||
    focus?.kind === 'inbox' ||
    focus?.kind === 'settings';
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
    focus?.kind === 'inbox' || focus?.kind === 'settings'
      ? 'tab'
      : onPage || view === 'agent'
        ? 'page'
        : !selection.channel || view === 'team'
          ? 'home'
          : 'channel';
  const signOut = () => {
    if (!canAct) return;
    void api('/api/logout', { method: 'POST' })
      .then(() => {
        toSignedOut('');
      })
      .catch(() => {
        setError('Sign out failed. Reconnect and try again.');
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
  const commands: Command[] = [
    ...data.attention.decide.map(({ task, channelName }) => ({
      id: 'ask-' + task.id,
      group: 'Inbox',
      label: task.title,
      hint: (humanAsk(task, data) ?? 'Your decision') + ' · #' + channelName,
      run: () => {
        openTaskIn(task.channelId, task.id);
      },
    })),
    ...(['chat', 'board', 'team'] as const).map((v) => ({
      id: 'view-' + v,
      group: 'Views',
      label: v === 'chat' ? 'Chat' : v === 'board' ? 'Board' : 'Team',
      run: () => {
        setView(v);
      },
    })),
    ...(channelPath
      ? [
          {
            id: 'action-new-task',
            group: 'Actions',
            label: 'New task',
            hint: channel ? '#' + channel.name : undefined,
            run: startNewTask,
          },
        ]
      : []),
    {
      id: 'action-refresh',
      group: 'Actions',
      label: 'Refresh now',
      run: refreshNow,
    },
    ...data.tasks.items.map((task) => ({
      id: 'task-' + task.id,
      group: 'Tasks',
      label: task.title,
      hint:
        '#' + String(task.position) + ' · ' + statusLabel(task.state.status),
      run: () => {
        openTask(task.id);
      },
    })),
    ...data.channels.items.map((c) => ({
      id: 'channel-' + c.id,
      group: 'Channels',
      label: '# ' + c.name,
      run: () => {
        selectChannel(c.id);
      },
    })),
    ...data.agents.map((agent) => ({
      id: 'agent-' + agent.id,
      group: 'People',
      label: agent.name,
      run: () => {
        openAgent(agent.id);
      },
    })),
  ];
  return (
    <MutationPermission value={canAct}>
      <LiveContext.Provider value={liveReads}>
        <AvatarImages.Provider value={avatarImages}>
          <Offline value={!canAct && !switching}>
            <div className="workspace-shell" data-screen={screen}>
              <aside className="sidebar">
                {/* Search first; the team's name lives in Settings. */}
                <div className="sidebar-top">
                  <CommandPalette commands={commands} />
                </div>
                <nav aria-label="Channels">
                  <div className="nav-heading">
                    <h2>Channels</h2>
                    <AddButton
                      label="New channel"
                      onClick={() => {
                        setAddingChannel(true);
                      }}
                    />
                  </div>
                  {data.channels.items.map((c) => (
                    <Fragment key={c.id}>
                      <button
                        aria-current={
                          // Only one place is current: a channel while you are
                          // in its chat or board.
                          channel?.id === c.id &&
                          (tabValue === 'chat' || tabValue === 'board') &&
                          !(phone && screen === 'home')
                            ? 'page'
                            : undefined
                        }
                        onClick={() => {
                          selectChannel(c.id);
                        }}
                      >
                        <span aria-hidden="true">#</span> {c.name}
                        {/* Something in this channel waits on you. */}
                        {waitingIn.has(c.id) && (
                          <span className="waiting-dot" title="Waiting on you">
                            <span className="visually-hidden">
                              Waiting on you
                            </span>
                          </span>
                        )}
                      </button>
                      {channel?.id === c.id && channelPath && (
                        <ChannelTopics
                          data={data}
                          channelPath={channelPath}
                          topic={selection.topic}
                          onTopic={(topic) => {
                            leavePage();
                            setView('chat');
                            setSelection((old) => ({ ...old, topic }));
                            setCursors({});
                          }}
                          next={next}
                          onDone={refresh}
                          onLeave={() => {
                            selectChannel('');
                          }}
                        />
                      )}
                    </Fragment>
                  ))}
                  {addingChannel && (
                    <InlineField
                      name="name"
                      label="Channel name"
                      placeholder="channel-name"
                      maxLength={80}
                      path={`/api/teams/${data.team.id}/channels`}
                      className="channel-new"
                      onClose={() => {
                        setAddingChannel(false);
                      }}
                      onDone={refresh}
                    />
                  )}
                  {/* Channels you left, only when there are any: one click back. */}
                  <LeftChannels
                    teamId={data.team.id}
                    channels={data.leftChannels}
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
                    More channels
                  </button>
                )}
                {/* On a phone, Home holds the team: the gallery of faces. */}
                {phone && (
                  <div className="home-team">
                    <Team
                      data={data}
                      channelPath={null}
                      onDone={refresh}
                      openAgent={openAgent}
                    />
                  </div>
                )}
                <section
                  className="people"
                  aria-label={channel ? 'People in this channel' : 'People'}
                >
                  {/* A line, not a heading: what follows plainly belongs to
                      the channel above. */}
                  <hr className="nav-separator" />
                  <ul>
                    <li>
                      {/* You are one of the people; your row opens your
                        settings, so the account is not shown twice. */}
                      <button
                        className="person"
                        aria-pressed={focus?.kind === 'settings'}
                        onClick={() => {
                          setFocus({ kind: 'settings' });
                        }}
                      >
                        <Avatar
                          kind="human"
                          name={data.human.username}
                          size="sm"
                        />
                        <span className="person-name">
                          {data.human.username}
                        </span>
                        <Presence online dot />
                      </button>
                    </li>
                    {channelAgents.map((agent) => (
                      <li key={agent.id}>
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
                          <span className="person-name">{agent.name}</span>
                          <Presence
                            online={workerConnected(data.wake, agent.id)}
                            dot
                          />
                        </button>
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
                      Add an agent
                    </button>
                  )}
                </section>
              </aside>
              <main className="workspace-main">
                <Tabs.Root
                  className="workspace-tabs"
                  value={tabValue}
                  // Focus returning from a page or the palette must not switch views.
                  activationMode="manual"
                  onValueChange={(v) => {
                    if (v === 'inbox') return;
                    setView(v === 'board' || v === 'team' ? v : 'chat');
                  }}
                >
                  <header className="workspace-header">
                    {/* A phone shows no sidebar beside a channel: its bar leads
                      back Home and says where you are. */}
                    {phone && (
                      <button
                        type="button"
                        className="quiet icon-button header-back"
                        aria-label="Back"
                        onClick={goHome}
                      >
                        <BackIcon />
                      </button>
                    )}
                    {/* Beside the sidebar the page never repeats where you are:
                      the title is there for screen readers only. */}
                    <h1 className={phone ? 'header-title' : 'visually-hidden'}>
                      {pageAgent
                        ? pageAgent.name
                        : view === 'team'
                          ? 'Team'
                          : shownChannelName
                            ? '# ' + shownChannelName
                            : switching
                              ? 'Opening channel…'
                              : 'Welcome to your team'}
                    </h1>
                    {/* Views stay in reach however far the conversation scrolls. */}
                    <Tabs.List
                      aria-label="Workspace views"
                      className="view-switch"
                    >
                      <Tabs.Trigger value="chat" onClick={leavePage}>
                        Chat
                      </Tabs.Trigger>
                      <Tabs.Trigger value="board" onClick={leavePage}>
                        Board
                      </Tabs.Trigger>
                      {/* On a phone the team is on Home and the Inbox is a
                        bottom tab. */}
                      {!phone && (
                        <Tabs.Trigger value="team" onClick={leavePage}>
                          Team
                        </Tabs.Trigger>
                      )}
                      {/* What waits on you across the team; an empty inbox
                        needs no number. */}
                      {!phone && (
                        <Tabs.Trigger
                          value="inbox"
                          onClick={() => {
                            setDraft(null);
                            setFocus({ kind: 'inbox' });
                          }}
                        >
                          Inbox
                          {waiting > 0 && (
                            <span className="count">{waiting}</span>
                          )}
                        </Tabs.Trigger>
                      )}
                    </Tabs.List>
                    <div className="header-end">
                      {/* Healthy is silent: the pill appears only when something is off. */}
                      {connection !== 'ready' && (
                        <div className="connection" data-state={connection}>
                          <span className="connection-dot" aria-hidden="true" />
                          <span role="status">
                            {connection === 'loading'
                              ? 'Refreshing…'
                              : 'Disconnected'}
                          </span>
                          {connection === 'offline' && (
                            <>
                              <small>
                                Last update{' '}
                                {new Date(data.observedAt).toLocaleTimeString()}
                              </small>
                              <button
                                className="secondary"
                                onClick={refreshNow}
                              >
                                Reconnect
                              </button>
                            </>
                          )}
                        </div>
                      )}
                      {!phone && (
                        <button
                          className="quiet icon-button"
                          aria-label="Sign out"
                          title="Sign out"
                          disabled={!canAct}
                          onClick={signOut}
                        >
                          <PowerIcon />
                        </button>
                      )}
                    </div>
                  </header>
                  {error && (
                    <div className="stale-banner" data-state={status}>
                      <Notice>
                        {error}{' '}
                        <button
                          onClick={() => {
                            selectChannel('');
                            setError('');
                          }}
                        >
                          Return to joined channels
                        </button>
                      </Notice>
                    </div>
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
                    {focus?.kind === 'settings' && (
                      <SettingsPage
                        data={data}
                        onClose={closeFocus}
                        onDone={refresh}
                        onNotify={notify}
                        {...(phone ? { onSignOut: signOut } : {})}
                      />
                    )}

                    {switching && (
                      <div className="view-skeleton" aria-hidden="true">
                        <span className="skeleton-card" />
                        <span className="skeleton-card" />
                        <span className="skeleton-card" />
                      </div>
                    )}
                    <Tabs.Content
                      value="chat"
                      key={channel?.id ?? 'no-channel'}
                    >
                      {channel && channelPath ? (
                        <Chat
                          data={data}
                          channelPath={channelPath}
                          topic={selection.topic}
                          onTopic={(topic) => {
                            setSelection((old) => ({ ...old, topic }));
                            setCursors({});
                          }}
                          onDone={refresh}
                          next={next}
                          firstPage={() => {
                            setCursors({});
                          }}
                          pagedBack={Boolean(cursors.messagesCursor)}
                          onMakeTask={(message) => {
                            setDraft(draftFromMessage(message, data));
                            setFocus(null);
                            setView('board');
                          }}
                          openAgent={openAgent}
                          onLeave={() => {
                            selectChannel('');
                          }}
                        />
                      ) : (
                        <div className="empty">
                          <h3>No channel open</h3>
                          <p>Choose a joined channel to read and post.</p>
                        </div>
                      )}
                    </Tabs.Content>
                    <Tabs.Content value="board">
                      {channelPath ? (
                        <Board
                          data={data}
                          next={() => {
                            next('tasksCursor', data.tasks.nextCursor);
                          }}
                          openTask={openTask}
                          onNewTask={startNewTask}
                          openId={focus?.kind === 'task' ? focus.id : null}
                        />
                      ) : (
                        <div className="empty">
                          <p>Create a channel before creating tasks.</p>
                        </div>
                      )}
                    </Tabs.Content>
                    <Tabs.Content value="team">
                      <Team
                        data={data}
                        channelPath={channelPath}
                        onDone={refresh}
                        openAgent={openAgent}
                      />
                    </Tabs.Content>
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
                          <p>This agent isn’t in your team.</p>
                        </div>
                      )}
                    </Tabs.Content>
                  </fieldset>
                </Tabs.Root>
              </main>
              {/* A phone's three places at the bottom of Home and of the pages
                  they open; a channel or a pushed page has the screen. */}
              {phone && (
                <nav className="phone-tabs" aria-label="Places">
                  <button
                    type="button"
                    aria-current={screen === 'home' ? 'page' : undefined}
                    onClick={goHome}
                  >
                    <HomeIcon />
                    <span>Home</span>
                  </button>
                  <button
                    type="button"
                    aria-current={focus?.kind === 'inbox' ? 'page' : undefined}
                    onClick={() => {
                      setDraft(null);
                      setFocus({ kind: 'inbox' });
                    }}
                  >
                    <InboxIcon />
                    <span>Inbox</span>
                    {waiting > 0 && <span className="count">{waiting}</span>}
                  </button>
                  <button
                    type="button"
                    aria-current={
                      focus?.kind === 'settings' ? 'page' : undefined
                    }
                    onClick={() => {
                      setDraft(null);
                      setFocus({ kind: 'settings' });
                    }}
                  >
                    <Avatar kind="human" name={data.human.username} size="sm" />
                    <span>You</span>
                  </button>
                </nav>
              )}
              {toast && (
                <div className="toast" key={toast.id} role="status">
                  {toast.message}
                </div>
              )}
            </div>
          </Offline>
        </AvatarImages.Provider>
      </LiveContext.Provider>
    </MutationPermission>
  );
}
/** Channels you left, muted under the rest, each one click from rejoining. */
function LeftChannels({
  teamId,
  channels,
  onDone,
}: {
  teamId: string;
  channels: WorkspaceSnapshot['leftChannels'];
  onDone: (id: string) => void;
}) {
  if (channels.length === 0) return null;
  return (
    <ul className="left-channels" aria-label="Channels you left">
      {channels.map((c) => (
        <li key={c.id}>
          <span>
            <span aria-hidden="true">#</span> {c.name}
          </span>
          <ActionForm
            title={'Rejoin ' + c.name}
            path={`/api/teams/${teamId}/channels/${c.id}/subscribe`}
            build={() => ({})}
            submit="Rejoin"
            onDone={() => {
              onDone(c.id);
            }}
          />
        </li>
      ))}
    </ul>
  );
}
