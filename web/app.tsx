import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import * as Tabs from '@radix-ui/react-tabs';
import { ChannelId } from '../src/domain/contracts.js';
import { TopicId } from '../src/domain/communication.js';
import { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { Auth } from './auth.js';
import { api, HttpError, MutationPermission, Offline, value } from './api.js';
import { ActionForm, Field, Notice } from './forms.js';
import { AgentDrawer, Team } from './agents.js';
import { Chat } from './chat.js';
import { Board, draftFromMessage, humanAsk, TaskDrawer } from './tasks.js';
import type { BoardFilter, TaskDraft } from './tasks.js';
import { Avatar, plural, statusLabel } from './ui.js';
import { CommandPalette } from './palette.js';
import type { Command } from './palette.js';
type View = 'chat' | 'board' | 'team';
type Focus = { kind: 'task' | 'agent'; id: string } | null;
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
function initialSelection() {
  const query = new URLSearchParams(window.location.search);
  return {
    channel: ChannelId.safeParse(query.get('channel')).success
      ? (query.get('channel') ?? '')
      : '',
    topic: TopicId.safeParse(query.get('topic')).success
      ? (query.get('topic') ?? '')
      : '',
  };
}
export function App() {
  const [selection, setSelection] = useState(initialSelection);
  const [data, setData] = useState<WorkspaceSnapshot | null>(null);
  const [status, setStatus] = useState<
    'loading' | 'ready' | 'offline' | 'signedout'
  >('loading');
  const [error, setError] = useState('');
  // Which channel selection the snapshot on screen was loaded for, and whether
  // the most recent refresh succeeded. Sending depends on these two facts,
  // never on whether a background request happens to be running.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [lastOk, setLastOk] = useState(false);
  const [revision, setRevision] = useState(0);
  const [manual, setManual] = useState(false);
  const [slow, setSlow] = useState(false);
  const [view, setView] = useState<View>('chat');
  const [cursors, setCursors] = useState<Record<string, string>>({});
  const [focus, setFocus] = useState<Focus>(null);
  const [filter, setFilter] = useState<BoardFilter>('all');
  const [draft, setDraft] = useState<TaskDraft | null>(null);
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
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);
  const refresh = useCallback(() => {
    setRevision((n) => n + 1);
  }, []);
  /** A refresh the person asked for is shown; the 15 s heartbeat is not. */
  const refreshNow = useCallback(() => {
    setManual(true);
    setRevision((n) => n + 1);
  }, []);
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
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams(cursors);
    if (selection.channel) query.set('channelId', selection.channel);
    if (selection.topic) query.set('topicId', selection.topic);
    const displayed = new URLSearchParams();
    if (selection.channel) displayed.set('channel', selection.channel);
    if (selection.topic) displayed.set('topic', selection.topic);
    window.history.replaceState(
      null,
      '',
      '/' + (displayed.size ? '?' + displayed.toString() : ''),
    );
    setStatus((previous) => (previous === 'signedout' ? previous : 'loading'));
    void api('/api/workspace?' + query.toString(), {
      signal: controller.signal,
    })
      .then((raw) => {
        const next = WorkspaceSnapshot.parse(raw);
        const apply = () => {
          shown.current = next;
          setData(next);
          setStatus('ready');
          setLoadedFor(selection.channel);
          setLastOk(true);
          setError('');
        };
        // Cards travel to their new column; other refreshes stay instant.
        if (viewRef.current === 'board' && statusesMoved(shown.current, next))
          animate(apply);
        else apply();
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        if (
          cause instanceof HttpError &&
          (cause.status === 401 || cause.status === 403)
        ) {
          // Auth loss is not a transient outage: purge the protected snapshot.
          shown.current = null;
          setData(null);
          setFocus(null);
          setDraft(null);
          // Drop stale channel and pagination identifiers before another user signs in.
          setSelection((previous) => {
            if (!previous.channel && !previous.topic) return previous;
            return { channel: '', topic: '' };
          });
          setCursors((previous) => {
            if (Object.keys(previous).length === 0) return previous;
            return {};
          });
          setError(cause.status === 403 ? cause.message : '');
          setLastOk(false);
          setStatus('signedout');
        } else {
          setError(
            cause instanceof HttpError
              ? cause.message
              : 'Disconnected. Showing the last snapshot; actions are paused.',
          );
          setLastOk(false);
          setStatus('offline');
        }
      });
    return () => {
      controller.abort();
    };
  }, [selection.channel, selection.topic, cursors, revision]);
  useEffect(() => {
    if (status === 'signedout') return;
    const poll = setInterval(refresh, 15000);
    window.addEventListener('online', refresh);
    return () => {
      clearInterval(poll);
      window.removeEventListener('online', refresh);
    };
  }, [status === 'signedout', refresh]);
  const next = (key: string, cursor: string | null) => {
    if (cursor) setCursors((old) => ({ ...old, [key]: cursor }));
  };
  const selectChannel = (channel: string) => {
    setSelection({ channel, topic: '' });
    setCursors({});
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
        <button onClick={refreshNow}>Reconnect / refresh</button>
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
  const notify = (message: string) => {
    setToast({ id: Date.now(), message });
  };
  const joinedAgents = data.agents.filter((a) =>
    data.joinedAgentIds.includes(a.id),
  );
  const openTasks = data.tasks.items.filter(
    (t) => t.state.status !== 'accepted' && t.state.status !== 'cancelled',
  ).length;
  const asks = channel
    ? data.tasks.items.flatMap((task) => {
        const ask = humanAsk(task, data);
        return ask ? [{ task, ask }] : [];
      })
    : [];
  const focusedTask =
    focus?.kind === 'task' && channelPath
      ? data.tasks.items.find((t) => t.id === focus.id)
      : undefined;
  const focusedAgent =
    focus?.kind === 'agent'
      ? data.agents.find((a) => a.id === focus.id)
      : undefined;
  const closeFocus = () => {
    setFocus(null);
  };
  const openAgent = (id: string) => {
    setFocus({ kind: 'agent', id });
  };
  const openTask = (id: string) => {
    setView('board');
    setFocus({ kind: 'task', id });
  };
  const showNeeds = () => {
    setFilter('needs');
    setView('board');
  };
  const commands: Command[] = [
    ...asks.map(({ task, ask }) => ({
      id: 'ask-' + task.id,
      group: 'Needs you',
      label: task.title,
      hint: ask,
      run: () => {
        openTask(task.id);
      },
    })),
    ...(['chat', 'board', 'team'] as const).map((v) => ({
      id: 'view-' + v,
      group: 'Views',
      label: v === 'chat' ? 'Chat' : v === 'board' ? 'Board' : 'Team',
      hint: 'view',
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
            run: () => {
              setDraft({
                id: 'new-' + String(Date.now()),
                title: '',
                description: '',
                topicId: selection.topic || null,
                sourceMessageId: null,
                from: null,
              });
              setFocus(null);
              setView('board');
            },
          },
        ]
      : []),
    {
      id: 'action-refresh',
      group: 'Actions',
      label: 'Reconnect / refresh',
      run: refresh,
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
      hint: 'agent · ' + agent.role,
      run: () => {
        openAgent(agent.id);
      },
    })),
  ];
  return (
    <MutationPermission value={canAct}>
      <Offline value={!canAct && !switching}>
        <div
          className="workspace-shell"
          data-drawer={focusedTask || focusedAgent ? 'open' : undefined}
        >
          <aside className="sidebar">
            <div className="sidebar-top">
              <a className="brand" href="/" aria-label="Kinmesh home">
                <span className="brand-mark" aria-hidden="true">
                  k
                </span>
                <span>kinmesh</span>
              </a>
              <div className="team-name">
                <span className="team-icon" aria-hidden="true">
                  {data.team.name.slice(0, 1).toUpperCase()}
                </span>
                <div>
                  <strong>{data.team.name}</strong>
                  <small>Team workspace</small>
                </div>
              </div>
            </div>
            {channel && (
              <button
                className="needs-you"
                data-count={asks.length > 0 ? 'true' : undefined}
                onClick={showNeeds}
              >
                <span>Needs you</span>
                <span className="count">{asks.length}</span>
              </button>
            )}
            <nav aria-label="Channels">
              <div className="nav-heading">
                <h2>Channels</h2>
                <span>{data.channels.items.length}</span>
              </div>
              {data.channels.items.map((c) => (
                <button
                  key={c.id}
                  aria-current={channel?.id === c.id ? 'page' : undefined}
                  onClick={() => {
                    selectChannel(c.id);
                  }}
                >
                  <span aria-hidden="true">#</span> {c.name}
                </button>
              ))}
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
            <div className="sidebar-actions">
              <details>
                <summary>New channel</summary>
                <ActionForm
                  title="Create a channel"
                  path={`/api/teams/${data.team.id}/channels`}
                  build={(f) => ({ name: value(f, 'name') })}
                  submit="Create channel"
                  onDone={refresh}
                >
                  <Field label="Channel name">
                    <input name="name" required maxLength={80} />
                  </Field>
                </ActionForm>
              </details>
              <details>
                <summary>Rejoin a channel</summary>
                <JoinChannel teamId={data.team.id} onDone={selectChannel} />
              </details>
            </div>
            {channel && (
              <section className="people" aria-label="People in this channel">
                <div className="nav-heading">
                  <h2>In this channel</h2>
                  <span>{joinedAgents.length + 1}</span>
                </div>
                <ul>
                  <li>
                    <span className="person">
                      <Avatar
                        kind="human"
                        name={data.human.username}
                        size="sm"
                      />
                      <span className="person-name">{data.human.username}</span>
                      <small>you</small>
                    </span>
                  </li>
                  {joinedAgents.map((agent) => (
                    <li key={agent.id}>
                      <button
                        className="person"
                        aria-pressed={
                          focus?.kind === 'agent' && focus.id === agent.id
                        }
                        onClick={() => {
                          openAgent(agent.id);
                        }}
                      >
                        <Avatar kind="agent" name={agent.name} size="sm" />
                        <span className="person-name">{agent.name}</span>
                        <small>{agent.role}</small>
                      </button>
                    </li>
                  ))}
                </ul>
                {joinedAgents.length === 0 && (
                  <button
                    className="link-button"
                    onClick={() => {
                      setView('team');
                    }}
                  >
                    Invite an agent
                  </button>
                )}
              </section>
            )}
            <div className="account">
              <Avatar kind="human" name={data.human.username} />
              <span>
                {data.human.username}
                <small>Human owner</small>
              </span>
              <button
                className="quiet"
                disabled={!canAct}
                onClick={() => {
                  if (!canAct) return;
                  void api('/api/logout', { method: 'POST' })
                    .then(() => {
                      shown.current = null;
                      setData(null);
                      setFocus(null);
                      setDraft(null);
                      setSelection({ channel: '', topic: '' });
                      setCursors({});
                      setStatus('signedout');
                    })
                    .catch(() => {
                      setError('Sign out failed. Reconnect and try again.');
                    });
                }}
              >
                Sign out
              </button>
            </div>
          </aside>
          <main className="workspace-main">
            <header className="workspace-header">
              <div className="title-block">
                <h1>
                  {shownChannelName
                    ? '# ' + shownChannelName
                    : switching
                      ? 'Opening channel…'
                      : 'Welcome to your team'}
                </h1>
                <p>
                  {channel
                    ? `${plural(joinedAgents.length + 1, 'member')} · ${plural(openTasks, 'open task')}`
                    : 'Create or rejoin a channel to begin.'}
                </p>
              </div>
              <CommandPalette commands={commands} />
              <div className="connection" data-state={connection}>
                <span className="connection-dot" aria-hidden="true" />
                <span role="status">
                  {connection === 'ready'
                    ? 'Snapshot connected'
                    : connection === 'loading'
                      ? 'Refreshing…'
                      : 'Disconnected'}
                </span>
                <small>
                  Read {new Date(data.observedAt).toLocaleTimeString()} · polls
                  every 15s
                </small>
                <button className="secondary" onClick={refreshNow}>
                  Reconnect / refresh
                </button>
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
            {asks.length > 0 && view !== 'board' && (
              <section className="decision-strip" aria-label="Waiting for you">
                <p>
                  <strong>
                    {asks.length === 1
                      ? '1 task is waiting for you'
                      : `${String(asks.length)} tasks are waiting for you`}
                  </strong>
                </p>
                <ul>
                  {asks.map(({ task, ask }) => (
                    <li key={task.id}>
                      <button
                        className="ask"
                        onClick={() => {
                          openTask(task.id);
                        }}
                      >
                        <span className="ask-title">{task.title}</span>
                        <small>{ask}</small>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <Tabs.Root
              value={view}
              onValueChange={(v) => {
                setView(v === 'board' || v === 'team' ? v : 'chat');
              }}
            >
              <Tabs.List aria-label="Workspace views" className="view-switch">
                <Tabs.Trigger value="chat">Chat</Tabs.Trigger>
                <Tabs.Trigger value="board">
                  Board
                  {asks.length > 0 && (
                    <span className="tab-count" aria-hidden="true">
                      {asks.length}
                    </span>
                  )}
                </Tabs.Trigger>
                <Tabs.Trigger value="team">Team</Tabs.Trigger>
              </Tabs.List>
              <fieldset
                className="view-content"
                data-switching={switching ? 'true' : undefined}
              >
                {switching && (
                  <div className="view-skeleton" aria-hidden="true">
                    <span className="skeleton-card" />
                    <span className="skeleton-card" />
                    <span className="skeleton-card" />
                  </div>
                )}
                <Tabs.Content value="chat" key={channel?.id ?? 'no-channel'}>
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
                      channelPath={channelPath}
                      onDone={refresh}
                      next={() => {
                        next('tasksCursor', data.tasks.nextCursor);
                      }}
                      openTask={openTask}
                      selected={focusedTask?.id ?? null}
                      filter={filter}
                      onFilter={setFilter}
                      draft={draft}
                      onDraft={setDraft}
                      onNotify={notify}
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
                    selected={focusedAgent?.id ?? null}
                  />
                </Tabs.Content>
              </fieldset>
            </Tabs.Root>
          </main>
          {focusedTask && channelPath && (
            <TaskDrawer
              key={focusedTask.id}
              task={focusedTask}
              data={data}
              path={channelPath + '/tasks/' + focusedTask.id}
              onDone={refresh}
              onClose={closeFocus}
              onDecided={notify}
            />
          )}
          {focusedAgent && (
            <AgentDrawer
              key={focusedAgent.id}
              agent={focusedAgent}
              data={data}
              onClose={closeFocus}
            />
          )}
          {toast && (
            <div className="toast" key={toast.id} role="status">
              {toast.message}
            </div>
          )}
        </div>
      </Offline>
    </MutationPermission>
  );
}
function JoinChannel({
  teamId,
  onDone,
}: {
  teamId: string;
  onDone: (id: string) => void;
}) {
  const [id, setId] = useState('');
  const parsed = ChannelId.safeParse(id);
  return (
    <>
      <Field label="Known channel ID">
        <input
          value={id}
          onChange={(e) => {
            setId(e.target.value);
          }}
        />
      </Field>
      {parsed.success && (
        <ActionForm
          title="Rejoin membership"
          path={`/api/teams/${teamId}/channels/${parsed.data}/subscribe`}
          build={() => ({})}
          submit="Join channel"
          onDone={() => {
            onDone(parsed.data);
          }}
        />
      )}
      <small>
        Only previously enrolled members may rejoin. Removed membership cannot
        be restored here.
      </small>
    </>
  );
}
