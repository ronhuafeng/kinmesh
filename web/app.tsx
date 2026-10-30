import { authorName } from './names.js';
import { useCallback, useEffect, useState } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { z } from 'zod';
import { ChannelId } from '../src/domain/contracts.js';
import { TopicId } from '../src/domain/communication.js';
import { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { Auth } from './auth.js';
import { api, HttpError, value } from './api.js';
import { ActionForm, Field, Notice } from './forms.js';
import { Agents } from './agents.js';
import { Tasks } from './tasks.js';
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
        if (cause instanceof HttpError && cause.status === 401) {
          setData(null);
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
  if (status === 'signedout') return <Auth onLogin={refresh} />;
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
  return (
    <div className="workspace-shell">
      <aside className="sidebar">
        <a className="brand" href="/">
          k<span>kinmesh</span>
        </a>
        <div className="team-name">
          <span className="team-icon">
            {data.team.name.slice(0, 1).toUpperCase()}
          </span>
          <div>
            <strong>{data.team.name}</strong>
            <small>Team workspace</small>
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
        <p className="sidebar-note">
          A channel holds your shared history.
          <br />A task holds a clear promise.
        </p>
        <div className="account">
          <span className="avatar">
            {data.human.username.slice(0, 1).toUpperCase()}
          </span>
          <span>
            {data.human.username}
            <small>Human owner</small>
          </span>
          <button
            className="quiet"
            onClick={() => {
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
          <div>
            <p className="eyebrow">Your shared workspace</p>
            <h1>{channel ? '# ' + channel.name : 'Welcome to your team'}</h1>
            <p>
              {channel
                ? 'Conversations, teammates, and decisions in one place.'
                : 'Create or rejoin a channel to begin.'}
            </p>
          </div>
          <div className="connection">
            <span role="status">
              {status === 'ready'
                ? 'Snapshot connected'
                : status === 'loading'
                  ? 'Refreshing…'
                  : 'Disconnected'}
            </span>
            <button className="secondary" onClick={refresh}>
              Reconnect / refresh
            </button>
            <small>
              Read {new Date(data.observedAt).toLocaleTimeString()} · polls
              every 15s
            </small>
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
        <Tabs.Root value={tab} onValueChange={setTab}>
          <Tabs.List aria-label="Workspace views">
            <Tabs.Trigger value="conversation">Conversation</Tabs.Trigger>
            <Tabs.Trigger value="tasks">Tasks</Tabs.Trigger>
            <Tabs.Trigger value="agents">Agents & activity</Tabs.Trigger>
          </Tabs.List>
          <fieldset className="view-content" disabled={!canAct}>
            <Tabs.Content
              value="conversation"
              key={channel?.id ?? 'no-channel'}
            >
              {channel && channelPath ? (
                <>
                  <div className="conversation-heading">
                    <h2>Channel conversation</h2>
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
                  </div>
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
                  {data.topics.nextCursor && (
                    <button
                      onClick={() => {
                        next('topicsCursor', data.topics.nextCursor);
                      }}
                    >
                      More topics
                    </button>
                  )}
                  <ol className="messages" aria-label="Channel messages">
                    {data.messages.items.map((m) => (
                      <li key={m.id}>
                        <div className={'message-avatar ' + m.author.kind}>
                          {m.author.kind === 'human' ? 'H' : 'A'}
                        </div>
                        <div>
                          <header>
                            <strong>{authorName(m.author, data)}</strong>
                            <span className="author-kind">{m.author.kind}</span>
                            <time dateTime={m.createdAt}>
                              {new Date(m.createdAt).toLocaleString()}
                            </time>
                          </header>
                          {m.topicId && (
                            <small className="topic-tag">
                              Topic:{' '}
                              {data.topics.items.find((t) => t.id === m.topicId)
                                ?.title ?? m.topicId}
                            </small>
                          )}
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
                    ))}
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
                      onClick={() => {
                        next('messagesCursor', data.messages.nextCursor);
                      }}
                    >
                      Next messages page
                    </button>
                  )}
                  {cursors.messagesCursor && (
                    <button
                      className="quiet"
                      onClick={() => {
                        setCursors({});
                      }}
                    >
                      First messages page
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
                          rows={3}
                          required
                          maxLength={8000}
                          placeholder="Share context, ask a question, or leave a decision…"
                        />
                      </Field>
                      <Field label="Mention an agent">
                        <select name="mention">
                          <option value="">No mention</option>
                          {data.agents
                            .filter((a) => data.joinedAgentIds.includes(a.id))
                            .map((a) => (
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
                </>
              ) : (
                <p className="empty">
                  Choose a joined channel to read and post.
                </p>
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
                <p>Create a channel before creating tasks.</p>
              )}
            </Tabs.Content>
            <Tabs.Content value="agents">
              <Agents data={data} channelPath={channelPath} onDone={refresh} />
            </Tabs.Content>
          </fieldset>
        </Tabs.Root>
        <footer className="workspace-footer">
          Kinmesh owns team state. T3 owns execution. Human acceptance is always
          explicit.
        </footer>
      </main>
    </div>
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
