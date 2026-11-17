import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { REACH, type Message } from '../src/domain/communication.js';
import type { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { value } from './api.js';
import { ActionForm, AddButton, Field, InlineField } from './forms.js';
import { ArrowIcon } from './icons.js';
import { joinedAgents, memberName, otherPeople } from './names.js';
import { Avatar, Presence, shortTime, workerConnected } from './ui.js';
import { keep, kept } from './session.js';
import { DeliveryLine } from './deliveries.js';
import { Markdown } from './markdown.js';
import { ReplyOrigin, answerOnly } from './replies.js';
import type { DeliveryView } from './deliveries.js';

type ChatMessage = z.infer<typeof Message>;
const mentionQuery = /(?:^|\s)@([\p{L}\p{N}\p{M}_.-]{0,40})$/u;
/** Someone the `@` popover offers: the channel's agents and other people. */
interface Mentionable {
  kind: 'human' | 'agent';
  id: string;
  name: string;
  /** A person's handle, which finds them too; never shown. */
  handle: string | null;
  online: boolean;
}
/** Whether what follows `@` starts their name, a word of it, or their handle. */
function matches(member: Mentionable, query: string) {
  const typed = query.toLowerCase();
  return [member.name, ...member.name.split(/\s+/), member.handle ?? ''].some(
    (word) => word !== '' && word.toLowerCase().startsWith(typed),
  );
}
/** `@Name` (or a person's `@handle`) typed in full counts as a mention. */
function mentionedIn(body: string, members: Mentionable[]) {
  return members.filter((m) =>
    [m.name, m.handle].some(
      (said) =>
        said !== null &&
        new RegExp(
          '(?:^|\\s)@' +
            said.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
            '(?![\\p{L}\\p{N}_-])',
          'iu',
        ).test(body),
    ),
  );
}
function Composer({
  channelPath,
  topicId,
  members,
  onDone,
}: {
  channelPath: string;
  topicId: string;
  members: Mentionable[];
  onDone: () => void;
}) {
  const [chips, setChips] = useState<Mentionable[]>([]);
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const candidates =
    query === null ? [] : members.filter((m) => matches(m, query)).slice(0, 8);
  const open = candidates.length > 0;
  function track() {
    const el = input.current;
    if (!el) return;
    const match = mentionQuery.exec(el.value.slice(0, el.selectionStart));
    setQuery(match ? (match[1] ?? '') : null);
    setActive(0);
  }
  function choose(member: Mentionable) {
    const el = input.current;
    if (!el || query === null) return;
    const caret = el.selectionStart;
    el.setRangeText(
      '@' + member.name + ' ',
      caret - query.length - 1,
      caret,
      'end',
    );
    keep(draftKey, el.value);
    setReady(true);
    el.focus();
    setChips((old) =>
      old.some((c) => c.id === member.id) ? old : [...old, member].slice(0, 20),
    );
    setQuery(null);
  }
  // A channel or topic that opens is ready to type in. A touch keyboard
  // stays down until asked for, and typing elsewhere is never interrupted.
  useEffect(() => {
    if (!window.matchMedia('(hover: hover)').matches) return;
    if (document.activeElement?.matches('input, textarea, select')) return;
    input.current?.focus({ preventScroll: true });
  }, [topicId]);
  const narrow = window.matchMedia('(max-width: 720px)').matches;
  // What was typed and not sent survives a reload, per channel.
  const draftKey = 'message:' + channelPath;
  const unsent = kept(draftKey);
  // Send shows once there is something to send.
  const [ready, setReady] = useState(
    () => typeof unsent === 'string' && unsent.trim() !== '',
  );
  return (
    <div className="composer">
      <ActionForm
        title="给团队发消息"
        path={channelPath + '/messages'}
        submit="发送消息"
        icon={<ArrowIcon />}
        ready={ready}
        onDone={() => {
          setChips([]);
          setQuery(null);
          setReady(false);
          keep(draftKey, null);
          onDone();
        }}
        build={(f) => {
          const body = value(f, 'body');
          const mentioned = [...chips];
          for (const member of mentionedIn(body, members))
            if (!mentioned.some((m) => m.id === member.id))
              mentioned.push(member);
          return {
            body,
            topicId: topicId || null,
            mentions: mentioned
              .slice(0, 20)
              .map((m) => ({ kind: m.kind, id: z.uuid().parse(m.id) })),
            sourceMessageId: null,
            sourceEventId: null,
          };
        }}
      >
        {chips.length > 0 && (
          <ul className="mention-chips" aria-label="提及">
            {chips.map((member) => (
              <li key={member.id}>
                <span className="mention-chip" data-kind={member.kind}>
                  @{member.name}
                </span>
                <button
                  type="button"
                  className="quiet"
                  aria-label={'移除对 ' + member.name + ' 的提及'}
                  onClick={() => {
                    setChips((old) => old.filter((c) => c.id !== member.id));
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
              aria-label="可提及的成员"
            >
              {candidates.map((member, index) => (
                <li
                  key={member.id}
                  id={listId + '-' + member.id}
                  role="option"
                  aria-selected={index === active}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(member);
                  }}
                >
                  <Avatar
                    kind={member.kind}
                    name={member.name}
                    id={member.id}
                    size="sm"
                  />
                  <span className="person-name">{member.name}</span>
                  <Presence online={member.online} dot />
                </li>
              ))}
            </ul>
          )}
          <Field label="消息">
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
              // The hints belong in the placeholder; the sidebar already
              // names the channel, and a phone has no shortcut keys.
              placeholder={
                narrow
                  ? '输入 @ 提及成员'
                  : '输入 @ 提及成员，⌘/Ctrl+Enter 发送'
              }
              defaultValue={typeof unsent === 'string' ? unsent : ''}
              onInput={(e) => {
                keep(draftKey, e.currentTarget.value || null);
                setReady(e.currentTarget.value.trim() !== '');
                track();
              }}
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
                  const member = candidates[active];
                  if (member) {
                    e.preventDefault();
                    choose(member);
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
            aria-label="提及成员"
            disabled={members.length === 0}
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
/**
 * The current channel's topics, under it in the sidebar like a tree: "All",
 * the ten most recently active, then the rest only when asked for, a "+" to
 * start one, and leaving the channel. A topic is pressed only while its
 * channel's chat or board is the place on screen (`current`).
 */
export function ChannelTopics({
  data,
  channelPath,
  topic,
  current: here,
  onTopic,
  next,
}: {
  data: WorkspaceSnapshot;
  channelPath: string;
  topic: string;
  current: boolean;
  onTopic: (topic: string) => void;
  next: (key: string, cursor: string | null) => void;
}) {
  const [all, setAll] = useState(false);
  const recent = data.activeTopics.items;
  const shown = new Set(recent.map((t) => t.id));
  // The topic you are in stays in sight even when it is not among the recent.
  const current = data.topics.items.find(
    (t) => t.id === topic && !shown.has(t.id),
  );
  const rest = all
    ? data.topics.items.filter((t) => !shown.has(t.id) && t.id !== current?.id)
    : [];
  const row = (t: { id: string; title: string }) => (
    <li key={t.id}>
      <button
        type="button"
        aria-pressed={here && topic === t.id}
        onClick={() => {
          onTopic(t.id);
        }}
      >
        {t.title}
      </button>
    </li>
  );
  return (
    <div className="channel-topics">
      <ul aria-label="话题">
        {/* "All" leads back to the whole channel, which its own row
            already marks as current; only a topic is pressed. */}
        {recent.length > 0 && (
          <li>
            <button
              type="button"
              onClick={() => {
                onTopic('');
              }}
            >
              全部
            </button>
          </li>
        )}
        {recent.map(row)}
        {current && row(current)}
        {rest.map(row)}
        {data.activeTopics.more &&
          (!all ? (
            <li>
              <button
                type="button"
                className="quiet"
                onClick={() => {
                  setAll(true);
                }}
              >
                更多话题
              </button>
            </li>
          ) : (
            data.topics.nextCursor && (
              <li>
                <button
                  type="button"
                  className="quiet"
                  onClick={() => {
                    next('topicsCursor', data.topics.nextCursor);
                  }}
                >
                  更多话题
                </button>
              </li>
            )
          ))}
        <li>
          <NewTopic channelPath={channelPath} onCreated={onTopic} />
        </li>
      </ul>
    </div>
  );
}
/**
 * A topic starts from a "+" after the topics: one field, Enter creates it
 * and opens it.
 */
function NewTopic({
  channelPath,
  onCreated,
}: {
  channelPath: string;
  onCreated: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return open ? (
    <InlineField
      name="title"
      label="话题名称"
      placeholder="新话题"
      maxLength={160}
      path={channelPath + '/topics'}
      className="pill"
      onClose={() => {
        setOpen(false);
      }}
      onCreated={onCreated}
    />
  ) : (
    <AddButton
      label="新建话题"
      className="topic-add"
      onClick={() => {
        setOpen(true);
      }}
    />
  );
}
/** Scrolls to a message and flashes it, so the eye finds it. */
export function showMessage(id: string) {
  const target = document.getElementById('message-' + id);
  if (!target) return;
  target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  target.dataset.flash = 'true';
  setTimeout(() => {
    delete target.dataset.flash;
  }, 1600);
}
const mine = (m: ChatMessage | undefined, me: string) =>
  m?.author.kind === 'human' && m.author.humanId === me;
/**
 * Marks what arrived while the conversation was open: messages newer than
 * any shown before in this place (a channel, or one of its topics). Older
 * ones loaded by scrolling back did not arrive.
 */
function useArrivals(place: string, messages: ChatMessage[], me: string) {
  const seen = useRef<{ place: string; newest: number } | null>(null);
  const [divider, setDivider] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  useEffect(() => {
    const previous = seen.current;
    const newest = messages.at(-1)?.position ?? 0;
    if (previous?.place !== place) {
      seen.current = { place, newest };
      setDivider(null);
      setFresh(new Set());
      return;
    }
    const arrived = messages.filter((m) => m.position > previous.newest);
    previous.newest = Math.max(previous.newest, newest);
    if (arrived.length === 0) return;
    setFresh(new Set(arrived.map((m) => m.id)));
    const fromOthers = arrived.find((m) => !mine(m, me));
    if (fromOthers) setDivider((old) => old ?? fromOthers.id);
  }, [place, messages, me]);
  return { divider, fresh };
}
const atBottom = () =>
  window.innerHeight + window.scrollY >=
  document.documentElement.scrollHeight - 48;
const toBottom = () => {
  window.scrollTo({ top: document.documentElement.scrollHeight });
};
/**
 * A conversation reads from the bottom: it opens there, follows what arrives
 * while you are there, and holds still while you read further back, also as
 * older messages are added above. `sent()` goes to the bottom, so what you
 * just sent comes into view however far back you were.
 */
function useReadingPosition(place: string, messages: ChatMessage[]) {
  const held = useRef<{
    place: string;
    first: string | undefined;
    last: string | undefined;
    /**
     * Where the first message ended in the viewport. Its end, not its top:
     * older messages from the same author fold its header into theirs, and
     * what follows must not move when they do.
     */
    end: number;
    bottom: boolean;
  } | null>(null);
  const endOf = (id: string | undefined) =>
    id === undefined
      ? 0
      : (document.getElementById('message-' + id)?.getBoundingClientRect()
          .bottom ?? 0);
  useLayoutEffect(() => {
    const previous = held.current;
    const first = messages[0]?.id;
    const last = messages.at(-1)?.id;
    if (previous?.place !== place) toBottom();
    else {
      // Older messages above: what was on screen stays where it was.
      if (first !== previous.first && previous.first !== undefined) {
        const anchor = document.getElementById('message-' + previous.first);
        if (anchor)
          window.scrollBy({
            top: anchor.getBoundingClientRect().bottom - previous.end,
          });
      }
      // At the bottom, it stays there whatever grew (a message, a reply's
      // line).
      if (previous.bottom) toBottom();
    }
    held.current = {
      place,
      first,
      last,
      end: endOf(first),
      bottom: atBottom(),
    };
  }, [place, messages]);
  // Reading moves the position; so does the window changing size.
  useEffect(() => {
    const note = () => {
      if (!held.current) return;
      held.current.end = endOf(held.current.first);
      held.current.bottom = atBottom();
    };
    window.addEventListener('scroll', note, { passive: true });
    window.addEventListener('resize', note);
    return () => {
      window.removeEventListener('scroll', note);
      window.removeEventListener('resize', note);
    };
  }, []);
  return {
    sent: () => {
      toBottom();
      if (held.current) held.current.bottom = true;
    },
  };
}
/**
 * Asks for older messages once the top of the conversation comes near:
 * scrolling up reads further back, until there is nothing older.
 */
function useEarlier(older: string | null, onEarlier: (cursor: string) => void) {
  const top = useRef<HTMLDivElement>(null);
  const ask = useRef(onEarlier);
  useEffect(() => {
    ask.current = onEarlier;
  }, [onEarlier]);
  useEffect(() => {
    const edge = top.current;
    if (!edge || older === null) return;
    const watch = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) ask.current(older);
      },
      { rootMargin: '600px 0px 0px 0px' },
    );
    watch.observe(edge);
    return () => {
      watch.disconnect();
    };
  }, [older]);
  return top;
}
export function Chat({
  data,
  channelPath,
  topic,
  shownTopic,
  onTopic,
  onDone,
  next,
  onEarlier,
  onMakeTask,
  openAgent,
  onLeave,
}: {
  data: WorkspaceSnapshot;
  channelPath: string;
  topic: string;
  /** The topic the messages on screen were read for ('' for all). */
  shownTopic: string;
  onTopic: (topic: string) => void;
  onDone: () => void;
  next: (key: string, cursor: string | null) => void;
  /** Reach further back, through the page this cursor names. */
  onEarlier: (cursor: string) => void;
  onMakeTask: (message: ChatMessage) => void;
  openAgent: (id: string) => void;
  onLeave: () => void;
}) {
  const channel = data.channel;
  const messages = data.messages.items;
  const shown = (channel?.id ?? '') + ':' + shownTopic;
  const { divider, fresh } = useArrivals(shown, messages, data.human.id);
  // The message tapped on a touch screen, which shows its actions.
  const [chosen, setChosen] = useState<string | null>(null);
  const reading = useReadingPosition(shown, messages);
  const earlier = useEarlier(data.messages.nextCursor, onEarlier);
  if (!channel) return null;
  // Mention deliveries under each asking message, and the way back from a reply.
  const asked = new Map<string, DeliveryView[]>();
  const replyTo = new Map<string, string>();
  for (const d of data.deliveries) {
    if (d.messageId && d.taskId === null)
      asked.set(d.messageId, [...(asked.get(d.messageId) ?? []), d]);
    if (d.resultMessageId && d.messageId)
      replyTo.set(d.resultMessageId, d.messageId);
  }
  const origin = new Map(data.replies.map((r) => [r.messageId, r]));
  // A mention already written as @Name in the text needs no second chip;
  // nor does a person's written as @handle before they had a name.
  const handle = (id: string) => data.people.find((p) => p.id === id)?.username;
  const unwritten = (m: ChatMessage) =>
    m.mentions.filter((member) => {
      const old = member.kind === 'human' ? handle(member.id) : undefined;
      return (
        !m.body.includes('@' + memberName(member, data)) &&
        !(old !== undefined && m.body.includes('@' + old))
      );
    });
  const replySource = (id: string) => {
    const source = messages.find((m) => m.id === id);
    if (!source) return '之前的一条消息';
    const flat = source.body.replace(/\s+/g, ' ').trim();
    const text = flat.length > 80 ? flat.slice(0, 77) + '…' : flat;
    return `${memberName(source.author, data)}：${text}`;
  };
  const topicTitle = (id: string) =>
    data.topics.items.find((t) => t.id === id)?.title ?? '话题';
  return (
    <div className="conversation">
      <div className="topic-bar">
        <div className="topic-pills" role="group" aria-label="话题">
          {/* "All" means something only once there is a topic to filter by. */}
          {data.topics.items.length > 0 && (
            <button
              type="button"
              aria-pressed={topic === ''}
              onClick={() => {
                onTopic('');
              }}
            >
              全部
            </button>
          )}
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
              更多话题
            </button>
          )}
          <NewTopic channelPath={channelPath} onCreated={onTopic} />
        </div>
      </div>
      {/* Coming near it reads older messages. */}
      <div ref={earlier} aria-hidden="true" />
      {/* On a phone, leaving waits where the conversation begins, away from
          the topics a thumb taps all day. */}
      {(data.messages.nextCursor === null || messages.length >= REACH) && (
        <div className="leave-channel channel-start">
          <ActionForm
            title="频道成员资格"
            path={channelPath + '/leave'}
            build={() => ({})}
            submit="退出频道"
            onDone={onLeave}
          />
        </div>
      )}
      <ol className="messages" aria-label="频道消息">
        {messages.map((m, index) => {
          const previous = messages[index - 1];
          const sameAuthor =
            previous !== undefined &&
            JSON.stringify(previous.author) === JSON.stringify(m.author) &&
            previous.topicId === m.topicId &&
            Date.parse(m.createdAt) - Date.parse(previous.createdAt) <
              5 * 60_000 &&
            divider !== m.id;
          const name = memberName(m.author, data);
          const agent =
            m.author.kind === 'agent'
              ? data.agents.find(
                  (a) => m.author.kind === 'agent' && a.id === m.author.agentId,
                )
              : undefined;
          // A reply right under what it answers needs neither the quote
          // nor the "replied" line to say so.
          const answers = replyTo.get(m.id);
          const quoted = answers !== undefined && answers !== previous?.id;
          const following = messages[index + 1]?.id;
          const lines = (asked.get(m.id) ?? []).filter(
            (d) => !(d.state === 'acked' && d.resultMessageId === following),
          );
          return (
            <li
              key={m.id}
              id={'message-' + m.id}
              data-kind={m.author.kind}
              data-continued={sameAuthor ? 'true' : undefined}
              data-new={fresh.has(m.id) ? 'true' : undefined}
              // On touch, a tapped message shows what can be done with it.
              data-chosen={chosen === m.id ? 'true' : undefined}
              onClick={(event) => {
                if (
                  event.target instanceof Element &&
                  event.target.closest('a, button')
                )
                  return;
                setChosen((old) => (old === m.id ? null : m.id));
              }}
            >
              {divider === m.id && (
                <div className="new-divider" role="separator">
                  {shortTime(m.createdAt)} 以来的新消息
                </div>
              )}
              <Avatar
                kind={m.author.kind}
                name={name}
                id={
                  m.author.kind === 'agent'
                    ? m.author.agentId
                    : m.author.humanId
                }
              />
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
                  <time dateTime={m.createdAt}>{shortTime(m.createdAt)}</time>
                  {/* Filtered to a topic, its messages need no tag for it. */}
                  {m.topicId && m.topicId !== topic && (
                    <small className="topic-tag">{topicTitle(m.topicId)}</small>
                  )}
                </header>
                {quoted && (
                  <button
                    type="button"
                    className="reply-to link-button"
                    onClick={() => {
                      showMessage(answers);
                    }}
                  >
                    <span aria-hidden="true">↩</span>{' '}
                    <span className="visually-hidden">回复 </span>
                    {replySource(answers)}
                  </button>
                )}
                <div className="message-text">
                  <Markdown text={answerOnly(m.body, origin.get(m.id))} />
                </div>
                {origin.get(m.id) && <ReplyOrigin reply={origin.get(m.id)} />}
                {unwritten(m).length > 0 && (
                  <ul className="mentions" aria-label="已提及">
                    {unwritten(m).map((member) => (
                      <li
                        key={member.kind + member.id}
                        className="mention-chip"
                        data-kind={member.kind}
                      >
                        @{memberName(member, data)}
                      </li>
                    ))}
                  </ul>
                )}
                {lines.length > 0 && (
                  <ul className="deliveries" aria-label="智能体响应">
                    {lines.map((d) => (
                      <DeliveryLine
                        key={d.id}
                        delivery={d}
                        data={data}
                        channelId={data.channel?.id ?? ''}
                        onReply={showMessage}
                        openAgent={openAgent}
                        onDone={onDone}
                      />
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
                    转为任务
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      {messages.length === 0 && (
        <p className="board-empty">还没有消息。输入 @ 请智能体加入。</p>
      )}
      <Composer
        key={channel.id}
        channelPath={channelPath}
        topicId={topic}
        members={[
          ...joinedAgents(data).map((a): Mentionable => ({
            kind: 'agent',
            id: a.id,
            name: a.name,
            handle: null,
            online: workerConnected(data.wake, a.id),
          })),
          ...otherPeople(data).map((p): Mentionable => ({
            kind: 'human',
            id: p.id,
            name: p.name,
            handle: p.username,
            online: p.online,
          })),
        ]}
        onDone={() => {
          reading.sent();
          onDone();
        }}
      />
    </div>
  );
}
