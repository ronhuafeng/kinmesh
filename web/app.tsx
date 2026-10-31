import { authorName } from './names.js';
import { useCallback, useEffect, useState } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { z } from 'zod';
import { ChannelId } from '../src/domain/contracts.js';
import { TopicId } from '../src/domain/communication.js';
import { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { Auth } from './auth.js';
import { api, HttpError, MutationPermission, value } from './api.js';
import { ActionForm, Field, Notice } from './forms.js';
import { Agents } from './agents.js';
import { humanAsk, Tasks } from './tasks.js';
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
  const [revision, setRevision] = useState(0);
  const [tab, setTab] = useState('conversation');
  const [cursors, setCursors] = useState<Record<string, string>>({});
  const [agentFocus, setAgentFocus] = useState<string | null>(null);
  const refresh = useCallback(() => {
    setRevision((n) => n + 1);
  }, []);
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
        setData(WorkspaceSnapshot.parse(raw));
        setStatus('ready');
        setError('');
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        if (
          cause instanceof HttpError &&
          (cause.status === 401 || cause.status === 403)
        ) {
          // Auth loss is not a transient outage: purge the protected snapshot.
          setData(null);
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
          setStatus('signedout');
        } else {
          setError(
            cause instanceof HttpError
              ? cause.message
              : 'Disconnected. Showing the last snapshot; actions are paused.',
          );
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
      <main className="initial-state">
        <a className="brand" href="/">
          k<span>kinmesh</span>
        </a>
        <h1>{error ? 'Workspace unavailable' : 'Opening your workspace…'}</h1>
        {error && <Notice>{error}</Notice>}
        <button onClick={refresh}>Reconnect / refresh</button>
      </main>
    );
  const channel = data.channel;
  const channelPath = channel
    ? `/api/teams/${data.team.id}/channels/${channel.id}`
    : null;
  const canAct =
    status === 'ready' &&
    (!selection.channel || selection.channel === channel?.id);
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
  const openAgent = (id: string) => {
    setAgentFocus(id);
    setTab('agents');
  };
  return (
    <MutationPermission value={canAct}>
      <div className="workspace-shell">
        <aside className="sidebar">
          <div className="sidebar-top">
            <a className="brand" href="/" aria-label="Kinmesh home">
              k<span>kinmesh</span>
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
              <JoinChannel
                teamId={data.team.id}
                onDone={selectChannel}
                disabled={!canAct}
              />
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
                    <span className="mini-avatar human" aria-hidden="true">
                      {data.human.username.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="person-name">{data.human.username}</span>
                    <small>you</small>
                  </span>
                </li>
                {joinedAgents.map((agent) => (
                  <li key={agent.id}>
                    <button
                      className="person"
                      onClick={() => {
                        openAgent(agent.id);
                      }}
                    >
                      <span className="mini-avatar agent" aria-hidden="true">
                        {agent.name.slice(0, 1).toUpperCase()}
                      </span>
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
                    setTab('agents');
                  }}
                >
                  Invite an agent
                </button>
              )}
            </section>
          )}
          <div className="account">
            <span className="avatar" aria-hidden="true">
              {data.human.username.slice(0, 1).toUpperCase()}
            </span>
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
                    setData(null);
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
              <h1>{channel ? '# ' + channel.name : 'Welcome to your team'}</h1>
              <p>
                {channel
                  ? `${plural(joinedAgents.length + 1, 'member')} · ${plural(openTasks, 'open task')}`
                  : 'Create or rejoin a channel to begin.'}
              </p>
            </div>
            <div className="connection" data-state={status}>
              <span role="status">
                {status === 'ready'
                  ? 'Snapshot connected'
                  : status === 'loading'
                    ? 'Refreshing…'
                    : 'Disconnected'}
              </span>
              <small>
                Read {new Date(data.observedAt).toLocaleTimeString()} · polls
                every 15s
              </small>
              <button className="secondary" onClick={refresh}>
                Reconnect / refresh
              </button>
            </div>
          </header>
          {error && (
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
          )}
          {asks.length > 0 && tab !== 'tasks' && (
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
                        setTab('tasks');
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
          <Tabs.Root value={tab} onValueChange={setTab}>
            <Tabs.List aria-label="Workspace views">
              <Tabs.Trigger value="conversation">Conversation</Tabs.Trigger>
              <Tabs.Trigger value="tasks">
                Tasks
                {asks.length > 0 && (
                  <span className="tab-count" aria-hidden="true">
                    {asks.length}
                  </span>
                )}
              </Tabs.Trigger>
              <Tabs.Trigger value="agents">Agents & activity</Tabs.Trigger>
            </Tabs.List>
            <fieldset className="view-content" disabled={!canAct}>
              <Tabs.Content
                value="conversation"
                key={channel?.id ?? 'no-channel'}
              >
                {channel && channelPath ? (
                  <div className="conversation">
                    <div className="conversation-toolbar">
                      <Field label="Topic">
                        <select
                          aria-label="Topic"
                          value={selection.topic}
                          onChange={(e) => {
                            setSelection((old) => ({
                              ...old,
                              topic: e.target.value,
                            }));
                            setCursors({});
                          }}
                        >
                          <option value="">All messages</option>
                          {data.topics.items.map((t) => (
                            <option value={t.id} key={t.id}>
                              {t.title}
                            </option>
                          ))}
                        </select>
                      </Field>
                      {data.topics.nextCursor && (
                        <button
                          className="quiet"
                          onClick={() => {
                            next('topicsCursor', data.topics.nextCursor);
                          }}
                        >
                          More topics
                        </button>
                      )}
                      <details className="create-panel">
                        <summary>Start a topic</summary>
                        <ActionForm
                          title="New topic"
                          path={channelPath + '/topics'}
                          submit="Create topic"
                          build={(f) => ({ title: value(f, 'title') })}
                          onDone={refresh}
                        >
                          <Field label="Topic title">
                            <input name="title" required maxLength={160} />
                          </Field>
                        </ActionForm>
                      </details>
                    </div>
                    {cursors.messagesCursor && (
                      <button
                        className="quiet page-control"
                        onClick={() => {
                          setCursors({});
                        }}
                      >
                        First messages page
                      </button>
                    )}
                    <ol className="messages" aria-label="Channel messages">
                      {data.messages.items.map((m, index) => {
                        const previous = data.messages.items[index - 1];
                        const sameAuthor =
                          previous !== undefined &&
                          JSON.stringify(previous.author) ===
                            JSON.stringify(m.author) &&
                          previous.topicId === m.topicId &&
                          Date.parse(m.createdAt) -
                            Date.parse(previous.createdAt) <
                            5 * 60_000;
                        const name = authorName(m.author, data);
                        return (
                          <li
                            key={m.id}
                            data-kind={m.author.kind}
                            data-continued={sameAuthor ? 'true' : undefined}
                          >
                            <div
                              className={'message-avatar ' + m.author.kind}
                              aria-hidden="true"
                            >
                              {name.slice(0, 1).toUpperCase()}
                            </div>
                            <div>
                              <header>
                                <strong>{name}</strong>
                                <span className="author-kind">
                                  {m.author.kind}
                                </span>
                                <time dateTime={m.createdAt}>
                                  {new Date(m.createdAt).toLocaleString(
                                    undefined,
                                    {
                                      month: 'short',
                                      day: 'numeric',
                                      hour: 'numeric',
                                      minute: '2-digit',
                                    },
                                  )}
                                </time>
                                {m.topicId && (
                                  <small className="topic-tag">
                                    Topic:{' '}
                                    {data.topics.items.find(
                                      (t) => t.id === m.topicId,
                                    )?.title ?? m.topicId}
                                  </small>
                                )}
                              </header>
                              <p>{m.body}</p>
                              {m.mentions.length > 0 && (
                                <p className="mentions">
                                  Mentions:{' '}
                                  {m.mentions
                                    .map((member) =>
                                      member.kind === 'agent'
                                        ? (data.agents.find(
                                            (a) => a.id === member.id,
                                          )?.name ?? 'Agent')
                                        : 'Human member',
                                    )
                                    .join(', ')}
                                </p>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ol>
                    {data.messages.items.length === 0 && (
                      <div className="empty">
                        <h3>A place to think together</h3>
                        <p>
                          Post the first message. Mention an enrolled agent when
                          you want their attention.
                        </p>
                      </div>
                    )}
                    {data.messages.nextCursor && (
                      <button
                        className="quiet page-control"
                        onClick={() => {
                          next('messagesCursor', data.messages.nextCursor);
                        }}
                      >
                        Next messages page
                      </button>
                    )}
                    <div className="composer">
                      <ActionForm
                        title="Message your team"
                        path={channelPath + '/messages'}
                        submit="Send message"
                        onDone={refresh}
                        build={(f) => {
                          const id = value(f, 'mention');
                          return {
                            body: value(f, 'body'),
                            topicId: selection.topic || null,
                            mentions: id
                              ? [{ kind: 'agent', id: z.uuid().parse(id) }]
                              : [],
                            sourceMessageId: null,
                            sourceEventId: null,
                          };
                        }}
                      >
                        <Field label="Message">
                          <textarea
                            name="body"
                            rows={2}
                            required
                            maxLength={8000}
                            placeholder={
                              'Message #' +
                              channel.name +
                              ' — share context, ask, or decide…'
                            }
                          />
                        </Field>
                        <Field label="Mention an agent">
                          <select name="mention">
                            <option value="">No mention</option>
                            {joinedAgents.map((a) => (
                              <option value={a.id} key={a.id}>
                                {a.name}
                              </option>
                            ))}
                          </select>
                        </Field>
                      </ActionForm>
                    </div>
                    <details className="channel-details">
                      <summary>Channel details</summary>
                      <p className="reference">Channel ID: {channel.id}</p>
                      <ActionForm
                        title="Channel membership"
                        path={channelPath + '/leave'}
                        build={() => ({})}
                        submit="Leave channel"
                        onDone={() => {
                          selectChannel('');
                        }}
                      />
                    </details>
                  </div>
                ) : (
                  <div className="empty">
                    <h3>No channel open</h3>
                    <p>Choose a joined channel to read and post.</p>
                  </div>
                )}
              </Tabs.Content>
              <Tabs.Content value="tasks">
                {channelPath ? (
                  <Tasks
                    data={data}
                    channelPath={channelPath}
                    onDone={refresh}
                    next={() => {
                      next('tasksCursor', data.tasks.nextCursor);
                    }}
                  />
                ) : (
                  <div className="empty">
                    <p>Create a channel before creating tasks.</p>
                  </div>
                )}
              </Tabs.Content>
              <Tabs.Content value="agents">
                <Agents
                  data={data}
                  channelPath={channelPath}
                  onDone={refresh}
                  selected={agentFocus}
                  onSelect={setAgentFocus}
                />
              </Tabs.Content>
            </fieldset>
          </Tabs.Root>
        </main>
      </div>
    </MutationPermission>
  );
}
function plural(count: number, noun: string) {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}
function JoinChannel({
  teamId,
  onDone,
  disabled,
}: {
  teamId: string;
  onDone: (id: string) => void;
  disabled: boolean;
}) {
  const [id, setId] = useState('');
  const parsed = ChannelId.safeParse(id);
  return (
    <>
      <Field label="Known channel ID">
        <input
          value={id}
          disabled={disabled}
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
