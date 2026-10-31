import { useEffect, useId, useRef, useState } from 'react';
import { z } from 'zod';
import type { Agent } from '../src/domain/agents.js';
import type { Message } from '../src/domain/communication.js';
import type { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { value } from './api.js';
import { ActionForm, Field } from './forms.js';
import { authorName } from './names.js';
import { Avatar, shortTime } from './ui.js';

type ChatMessage = z.infer<typeof Message>;
const mentionQuery = /(?:^|\s)@([\w.-]{0,40})$/;
/** `@Name` typed in full counts as a mention even without the popover. */
function mentionedAgents(body: string, agents: Agent[]) {
  return agents.filter((a) =>
    new RegExp(
      '(?:^|\\s)@' +
        a.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
        '(?![\\w-])',
      'i',
    ).test(body),
  );
}
function Composer({
  channelName,
  channelPath,
  topicId,
  agents,
  onDone,
}: {
  channelName: string;
  channelPath: string;
  topicId: string;
  agents: Agent[];
  onDone: () => void;
}) {
  const [chips, setChips] = useState<Agent[]>([]);
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const candidates =
    query === null
      ? []
      : agents
          .filter((a) => a.name.toLowerCase().startsWith(query.toLowerCase()))
          .slice(0, 8);
  const open = candidates.length > 0;
  function track() {
    const el = input.current;
    if (!el) return;
    const match = mentionQuery.exec(el.value.slice(0, el.selectionStart));
    setQuery(match ? (match[1] ?? '') : null);
    setActive(0);
  }
  function choose(agent: Agent) {
    const el = input.current;
    if (!el || query === null) return;
    const caret = el.selectionStart;
    el.setRangeText(
      '@' + agent.name + ' ',
      caret - query.length - 1,
      caret,
      'end',
    );
    el.focus();
    setChips((old) =>
      old.some((c) => c.id === agent.id) ? old : [...old, agent].slice(0, 20),
    );
    setQuery(null);
  }
  return (
    <div className="composer">
      <ActionForm
        title="Message your team"
        path={channelPath + '/messages'}
        submit="Send message"
        onDone={() => {
          setChips([]);
          setQuery(null);
          onDone();
        }}
        build={(f) => {
          const body = value(f, 'body');
          const mentioned = [...chips];
          for (const agent of mentionedAgents(body, agents))
            if (!mentioned.some((m) => m.id === agent.id))
              mentioned.push(agent);
          return {
            body,
            topicId: topicId || null,
            mentions: mentioned
              .slice(0, 20)
              .map((a) => ({ kind: 'agent', id: z.uuid().parse(a.id) })),
            sourceMessageId: null,
            sourceEventId: null,
          };
        }}
      >
        {chips.length > 0 && (
          <ul className="mention-chips" aria-label="Mentions">
            {chips.map((agent) => (
              <li key={agent.id}>
                <span className="mention-chip">@{agent.name}</span>
                <button
                  type="button"
                  className="quiet"
                  aria-label={'Remove mention of ' + agent.name}
                  onClick={() => {
                    setChips((old) => old.filter((c) => c.id !== agent.id));
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="composer-input">
          {open && (
            <ul
              className="mention-popover"
              id={listId}
              role="listbox"
              aria-label="Mention suggestions"
            >
              {candidates.map((agent, index) => (
                <li
                  key={agent.id}
                  id={listId + '-' + agent.id}
                  role="option"
                  aria-selected={index === active}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(agent);
                  }}
                >
                  <Avatar kind="agent" name={agent.name} size="sm" />
                  <span className="person-name">{agent.name}</span>
                  <small>Agent · {agent.role}</small>
                </li>
              ))}
            </ul>
          )}
          <Field label="Message">
            <textarea
              ref={input}
              name="body"
              rows={2}
              required
              maxLength={8000}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={open}
              aria-controls={open ? listId : undefined}
              aria-activedescendant={
                open && candidates[active]
                  ? listId + '-' + candidates[active].id
                  : undefined
              }
              placeholder={
                'Message #' +
                channelName +
                ' — @ to mention, ⌘/Ctrl+Enter to send'
              }
              onInput={track}
              onClick={track}
              onBlur={() => {
                setQuery(null);
              }}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  // The submit handler still refuses while sending is paused.
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                  return;
                }
                if (!open) return;
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  const step = e.key === 'ArrowDown' ? 1 : -1;
                  setActive(
                    (old) =>
                      (old + step + candidates.length) % candidates.length,
                  );
                } else if (e.key === 'Enter' || e.key === 'Tab') {
                  const agent = candidates[active];
                  if (agent) {
                    e.preventDefault();
                    choose(agent);
                  }
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  setQuery(null);
                }
              }}
            />
          </Field>
          <button
            type="button"
            className="quiet mention-trigger"
            aria-label="Mention an agent"
            disabled={agents.length === 0}
            onClick={() => {
              const el = input.current;
              if (!el) return;
              el.focus();
              const before = el.value.slice(0, el.selectionStart);
              el.setRangeText(
                before === '' || /\s$/.test(before) ? '@' : ' @',
                el.selectionStart,
                el.selectionEnd,
                'end',
              );
              track();
            }}
          >
            @
          </button>
        </div>
      </ActionForm>
    </div>
  );
}
/** Remembers which messages were already shown so new arrivals can be marked. */
function useArrivals(channelId: string, messages: ChatMessage[], me: string) {
  const seen = useRef<{ channel: string; ids: Set<string> } | null>(null);
  const [divider, setDivider] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  useEffect(() => {
    const previous = seen.current;
    const ids = new Set(messages.map((m) => m.id));
    if (previous?.channel !== channelId) {
      seen.current = { channel: channelId, ids };
      setDivider(null);
      setFresh(new Set());
      return;
    }
    const arrived = messages.filter((m) => !previous.ids.has(m.id));
    for (const id of ids) previous.ids.add(id);
    if (arrived.length === 0) return;
    setFresh(new Set(arrived.map((m) => m.id)));
    const fromOthers = arrived.find(
      (m) => m.author.kind !== 'human' || m.author.humanId !== me,
    );
    if (fromOthers) setDivider((old) => old ?? fromOthers.id);
  }, [channelId, messages, me]);
  return { divider, fresh };
}
export function Chat({
  data,
  channelPath,
  topic,
  onTopic,
  onDone,
  next,
  firstPage,
  pagedBack,
  onMakeTask,
  openAgent,
  onLeave,
}: {
  data: WorkspaceSnapshot;
  channelPath: string;
  topic: string;
  onTopic: (topic: string) => void;
  onDone: () => void;
  next: (key: string, cursor: string | null) => void;
  firstPage: () => void;
  pagedBack: boolean;
  onMakeTask: (message: ChatMessage) => void;
  openAgent: (id: string) => void;
  onLeave: () => void;
}) {
  const channel = data.channel;
  const messages = data.messages.items;
  const { divider, fresh } = useArrivals(
    channel?.id ?? '',
    messages,
    data.human.id,
  );
  if (!channel) return null;
  const joinedAgents = data.agents.filter((a) =>
    data.joinedAgentIds.includes(a.id),
  );
  const topicTitle = (id: string) =>
    data.topics.items.find((t) => t.id === id)?.title ?? 'Topic';
  return (
    <div className="conversation">
      <div className="topic-bar">
        <div className="topic-pills" role="group" aria-label="Topics">
          <button
            type="button"
            aria-pressed={topic === ''}
            onClick={() => {
              onTopic('');
            }}
          >
            All
          </button>
          {data.topics.items.map((t) => (
            <button
              type="button"
              key={t.id}
              aria-pressed={topic === t.id}
              onClick={() => {
                onTopic(t.id);
              }}
            >
              {t.title}
            </button>
          ))}
          {data.topics.nextCursor && (
            <button
              type="button"
              className="quiet"
              onClick={() => {
                next('topicsCursor', data.topics.nextCursor);
              }}
            >
              More topics
            </button>
          )}
        </div>
        <details className="create-panel topic-create">
          <summary>Start a topic</summary>
          <ActionForm
            title="New topic"
            path={channelPath + '/topics'}
            submit="Create topic"
            build={(f) => ({ title: value(f, 'title') })}
            onDone={onDone}
          >
            <Field label="Topic title">
              <input name="title" required maxLength={160} />
            </Field>
          </ActionForm>
        </details>
      </div>
      {pagedBack && (
        <button className="quiet page-control" onClick={firstPage}>
          First messages page
        </button>
      )}
      <ol className="messages" aria-label="Channel messages">
        {messages.map((m, index) => {
          const previous = messages[index - 1];
          const sameAuthor =
            previous !== undefined &&
            JSON.stringify(previous.author) === JSON.stringify(m.author) &&
            previous.topicId === m.topicId &&
            Date.parse(m.createdAt) - Date.parse(previous.createdAt) <
              5 * 60_000 &&
            divider !== m.id;
          const name = authorName(m.author, data);
          const agent =
            m.author.kind === 'agent'
              ? data.agents.find(
                  (a) => m.author.kind === 'agent' && a.id === m.author.agentId,
                )
              : undefined;
          return (
            <li
              key={m.id}
              data-kind={m.author.kind}
              data-continued={sameAuthor ? 'true' : undefined}
              data-new={fresh.has(m.id) ? 'true' : undefined}
            >
              {divider === m.id && (
                <div className="new-divider" role="separator">
                  New since {shortTime(m.createdAt)}
                </div>
              )}
              <Avatar kind={m.author.kind} name={name} />
              <div className="message-body">
                <header>
                  {agent ? (
                    <button
                      type="button"
                      className="author-link"
                      onClick={() => {
                        openAgent(agent.id);
                      }}
                    >
                      {name}
                    </button>
                  ) : (
                    <strong>{name}</strong>
                  )}
                  <span className="author-kind">
                    {agent ? 'agent · ' + agent.role : m.author.kind}
                  </span>
                  <time dateTime={m.createdAt}>{shortTime(m.createdAt)}</time>
                  {m.topicId && (
                    <small className="topic-tag">{topicTitle(m.topicId)}</small>
                  )}
                </header>
                <p>{m.body}</p>
                {m.mentions.length > 0 && (
                  <ul className="mentions" aria-label="Mentioned">
                    {m.mentions.map((member) => (
                      <li
                        key={member.kind + member.id}
                        className="mention-chip"
                        data-kind={member.kind}
                      >
                        @
                        {member.kind === 'agent'
                          ? (data.agents.find((a) => a.id === member.id)
                              ?.name ?? 'Agent')
                          : 'Human member'}
                      </li>
                    ))}
                  </ul>
                )}
                <div className="message-actions">
                  <button
                    type="button"
                    className="quiet"
                    onClick={() => {
                      onMakeTask(m);
                    }}
                  >
                    Make task
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      {messages.length === 0 && (
        <div className="empty">
          <h3>No messages yet</h3>
          <p>
            Start the conversation, or type @ to bring an agent in. Any message
            can become a task.
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
      <Composer
        key={channel.id}
        channelName={channel.name}
        channelPath={channelPath}
        topicId={topic}
        agents={joinedAgents}
        onDone={onDone}
      />
      <details className="channel-details">
        <summary>Channel details</summary>
        <p className="reference">Channel ID: {channel.id}</p>
        <ActionForm
          title="Channel membership"
          path={channelPath + '/leave'}
          build={() => ({})}
          submit="Leave channel"
          onDone={onLeave}
        />
      </details>
    </div>
  );
}
