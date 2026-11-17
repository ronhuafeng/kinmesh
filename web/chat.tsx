import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { z } from 'zod';
import { Message, REACH } from '../src/domain/communication.js';
import { Attachment } from '../src/domain/attachments.js';
import type { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { MutationPermission, api, request, value } from './api.js';
import { ActionForm, AddButton, Field, InlineField } from './forms.js';
import { AttachIcon, SendIcon, SettingsIcons } from './icons.js';
import {
  MessageFiles,
  fileSize,
  inline,
  pendingOf,
  upload,
  type Pending,
} from './attachments.js';
import { joinedAgents, memberName, otherPeople } from './names.js';
import {
  Avatar,
  Presence,
  clockTime,
  dayLabel,
  dayOf,
  shortTime,
  workerConnected,
} from './ui.js';
import { keep, kept } from './session.js';
import { DeliveryLine } from './deliveries.js';
import { Markdown } from './markdown.js';
import { ReplyOrigin, answerOnly, type ReplyView } from './replies.js';
import type { DeliveryView } from './deliveries.js';

type ChatMessage = z.infer<typeof Message>;
/** Which files a message carries, to tell two of the same text apart. */
const filesOf = (m: ChatMessage) => m.attachments.map((a) => a.id).join(' ');
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
  onSend,
  onDone,
}: {
  channelPath: string;
  topicId: string;
  members: Mentionable[];
  /** Takes a message on its way, so the field is free at once. */
  onSend: (path: string, body: Record<string, unknown>) => void;
  onDone: () => void;
}) {
  const [chips, setChips] = useState<Mentionable[]>([]);
  // Files dropped, pasted or chosen: each uploads at once, and the message
  // goes once they all have.
  const [files, setFiles] = useState<Pending[]>([]);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  function send(pending: Pending) {
    upload(channelPath, pending).then(
      (attachment) => {
        setFiles((old) =>
          old.map((f) =>
            f.key === pending.key ? { ...f, state: 'ready', attachment } : f,
          ),
        );
      },
      (cause: unknown) => {
        setFiles((old) =>
          old.map((f) =>
            f.key === pending.key
              ? {
                  ...f,
                  state: 'failed',
                  problem:
                    cause instanceof Error ? cause.message : '没有传上去',
                }
              : f,
          ),
        );
      },
    );
  }
  function attach(list: Iterable<File>) {
    const added = pendingOf(list, files.length);
    if (added.length === 0) return;
    setFiles((old) => [...old, ...added]);
    for (const pending of added)
      if (pending.state === 'uploading') send(pending);
    input.current?.focus();
  }
  function detach(key: string) {
    setFiles((old) => old.filter((f) => f.key !== key));
  }
  const filesReady =
    files.length > 0 && files.every((f) => f.state === 'ready');
  const filesWaiting = files.some((f) => f.state !== 'ready');
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
  const narrow = window.matchMedia('(max-width: 575px)').matches;
  // What was typed and not sent survives a reload, per channel.
  const draftKey = 'message:' + channelPath;
  const unsent = kept(draftKey);
  // Send shows once there is something to send.
  const [ready, setReady] = useState(
    () => typeof unsent === 'string' && unsent.trim() !== '',
  );
  return (
    <div
      className="composer"
      data-dragging={dragging ? 'true' : undefined}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (
          !(e.relatedTarget instanceof Node) ||
          !e.currentTarget.contains(e.relatedTarget)
        )
          setDragging(false);
      }}
      onDrop={(e) => {
        if (e.dataTransfer.files.length === 0) return;
        e.preventDefault();
        setDragging(false);
        attach(e.dataTransfer.files);
      }}
    >
      <ActionForm
        title="给团队发消息"
        path={channelPath + '/messages'}
        submit="发送消息"
        icon={<SendIcon size={20} />}
        ready={(ready || filesReady) && !filesWaiting}
        handOff={onSend}
        onDone={() => {
          // The field is free for the next message at once; what was sent
          // shows in the conversation until the server has it.
          if (input.current) input.current.value = '';
          setFiles([]);
          setChips([]);
          setQuery(null);
          setReady(false);
          keep(draftKey, null);
          onDone();
        }}
        build={(f) => {
          const body = value(f, 'body').trim();
          const attached = files.flatMap((p) =>
            p.attachment === null ? [] : [p.attachment],
          );
          if (body === '' && attached.length === 0)
            throw new Error('Nothing to send');
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
            attachments: attached,
          };
        }}
      >
        {files.length > 0 && (
          <ul className="composer-files" aria-label="附件">
            {files.map((p) => (
              <li
                key={p.key}
                data-state={p.state}
                title={p.problem ?? undefined}
              >
                {p.image && p.state !== 'failed' ? (
                  // The server's copy, once it has it: the square holds
                  // its place until then.
                  p.attachment !== null && inline(p.attachment.type) ? (
                    <img
                      src={`${channelPath}/attachments/${p.attachment.id}`}
                      alt=""
                    />
                  ) : (
                    <span className="composer-image" />
                  )
                ) : (
                  <span className="composer-file">
                    <span className="file-name">{p.file.name}</span>
                    <span className="file-size">
                      {p.problem ?? fileSize(p.file.size)}
                    </span>
                  </span>
                )}
                <button
                  type="button"
                  className="composer-file-remove"
                  aria-label={'移除 ' + p.file.name}
                  onClick={() => {
                    detach(p.key);
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
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
                  {/* Two of the same name are told apart by handle. */}
                  {member.handle !== null &&
                    candidates.some(
                      (other) =>
                        other.id !== member.id && other.name === member.name,
                    ) && <span className="muted">{member.handle}</span>}
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
              required={files.length === 0}
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
              onPaste={(e) => {
                if (e.clipboardData.files.length === 0) return;
                e.preventDefault();
                attach(e.clipboardData.files);
              }}
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
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.currentTarget.files) attach(e.currentTarget.files);
              e.currentTarget.value = '';
            }}
          />
          <button
            type="button"
            className="quiet composer-attach"
            aria-label="添加文件"
            onClick={() => picker.current?.click()}
          >
            <AttachIcon size={20} />
          </button>
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
/**
 * A team's first steps, at the top of a channel until all are done: an
 * agent, T3 for it to run in, and a first message to it. Each says what is
 * left and has the one control that does it; what is done is checked.
 */
function FirstSteps({
  data,
  openAgent,
  onTeam,
}: {
  data: WorkspaceSnapshot;
  openAgent: (id: string) => void;
  onTeam: () => void;
}) {
  const agent = data.agents[0];
  const steps = [
    {
      label: '添加一个智能体',
      done: agent !== undefined,
      action: { label: '添加', run: onTeam },
    },
    {
      label: agent ? `为 ${agent.name} 连接 T3` : '连接 T3，智能体在那里工作',
      done: data.nativeT3Origin !== null,
      action: agent
        ? {
            label: '连接',
            run: () => {
              openAgent(agent.id);
            },
          }
        : null,
    },
    {
      label: agent
        ? `在下面 @${agent.name}，请它做第一件事`
        : '在频道里 @ 它，请它做第一件事',
      done:
        data.deliveries.length > 0 ||
        data.messages.items.some((m) => m.author.kind === 'agent'),
      action: null,
    },
  ];
  if (steps.every((step) => step.done)) return null;
  return (
    <section className="first-steps" aria-label="开始使用">
      <h2>开始使用</h2>
      <ol>
        {steps.map((step, index) => (
          <li key={step.label} data-done={step.done ? 'true' : undefined}>
            <span className="first-step-mark" aria-hidden="true">
              {step.done ? <SettingsIcons.check size={16} /> : index + 1}
            </span>
            <span className="first-step-label">
              {step.label}
              {step.done && <span className="visually-hidden">（已完成）</span>}
            </span>
            {!step.done && step.action && (
              <button
                type="button"
                className="link-button"
                onClick={step.action.run}
              >
                {step.action.label}
              </button>
            )}
          </li>
        ))}
      </ol>
    </section>
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
 * A message on its way: shown at once, as it will read, until the server
 * has it. Its request is kept exactly, operation key and all, so sending it
 * again can only ever post it once.
 */
const Outgoing = z.object({
  key: z.string(),
  path: z.string(),
  request: z.string(),
  message: Message,
  /** The newest position on screen when it was sent: it lands after it. */
  after: z.number(),
  /** The message the server made, once it has said so. */
  id: z.string().nullable(),
  failed: z.boolean(),
});
type Outgoing = z.infer<typeof Outgoing>;
/**
 * The messages written here that the conversation doesn't show yet, sent
 * one after another so they land in the order written. What hasn't been
 * confirmed survives a reload or a switch of channel; its outcome is then
 * unknown, so it waits to be sent again (or arrives on its own, if it got
 * through).
 */
function useOutbox(channelPath: string, onSent: () => void) {
  const storeKey = 'outbox:' + channelPath;
  const [outgoing, setOutgoing] = useState<Outgoing[]>(() => {
    const saved = z.array(Outgoing).safeParse(kept(storeKey));
    return saved.success
      ? saved.data
          .filter((o) => o.id === null)
          .map((o) => ({ ...o, failed: true }))
      : [];
  });
  useEffect(() => {
    const unconfirmed = outgoing.filter((o) => o.id === null);
    keep(storeKey, unconfirmed.length > 0 ? unconfirmed : null);
  }, [storeKey, outgoing]);
  const sent = useRef(onSent);
  useEffect(() => {
    sent.current = onSent;
  }, [onSent]);
  const queue = useRef(Promise.resolve());
  const update = (key: string, change: Partial<Outgoing>) => {
    setOutgoing((old) =>
      old.map((o) => (o.key === key ? { ...o, ...change } : o)),
    );
  };
  const post = (entry: Outgoing) => {
    queue.current = queue.current.then(async () => {
      try {
        const raw = await api(entry.path, {
          method: 'POST',
          body: entry.request,
          headers: { 'content-type': 'application/json' },
        });
        update(entry.key, { id: z.object({ id: z.string() }).parse(raw).id });
        sent.current();
      } catch {
        update(entry.key, { failed: true });
      }
    });
  };
  return {
    outgoing,
    send(entry: Outgoing) {
      setOutgoing((old) => [...old, entry]);
      post(entry);
    },
    retry(entry: Outgoing) {
      update(entry.key, { failed: false });
      post({ ...entry, failed: false });
    },
    remove(keys: string[]) {
      setOutgoing((old) => old.filter((o) => !keys.includes(o.key)));
    },
  };
}
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
    /**
     * The message read from: the first whose end is in view, and where that
     * end was. Older messages folding its header into theirs change only
     * what is above its text, so its end is what holds still.
     */
    anchor: string | undefined;
    end: number;
    bottom: boolean;
  } | null>(null);
  /** Notes what is read from, as the reader left it. */
  const note = () => {
    const h = held.current;
    if (!h) return;
    h.anchor = undefined;
    h.end = 0;
    for (const row of document.querySelectorAll<HTMLElement>(
      '.messages > li[id^="message-"]',
    )) {
      const end = row.getBoundingClientRect().bottom;
      if (end > 0) {
        h.anchor = row.id.slice('message-'.length);
        h.end = end;
        break;
      }
    }
    h.bottom = atBottom();
  };
  /**
   * What the conversation shows changed or grew: at the bottom it stays
   * there; read back, what was read from stays where it was, whatever was
   * added or drawn above it (older messages, a diagram, an image).
   */
  const hold = () => {
    const h = held.current;
    if (!h) return;
    if (h.bottom) {
      toBottom();
      return;
    }
    const row =
      h.anchor === undefined
        ? null
        : document.getElementById('message-' + h.anchor);
    const moved = row ? row.getBoundingClientRect().bottom - h.end : 0;
    if (moved !== 0) window.scrollBy({ top: moved });
  };
  useLayoutEffect(() => {
    if (held.current?.place !== place) {
      held.current = { place, anchor: undefined, end: 0, bottom: true };
      toBottom();
    } else hold();
    note();
  }, [place, messages]);
  // Reading moves the position; so does the window changing size.
  useEffect(() => {
    // A window that changes size keeps you at the bottom if you were.
    const resized = () => {
      if (held.current?.bottom) toBottom();
      note();
    };
    window.addEventListener('scroll', note, { passive: true });
    window.addEventListener('resize', resized);
    return () => {
      window.removeEventListener('scroll', note);
      window.removeEventListener('resize', resized);
    };
  }, []);
  // Something that grows once shown (a diagram drawn, an image loaded)
  // keeps the place: the bottom, or what was read from.
  const list = useCallback((element: HTMLOListElement | null) => {
    if (!element) return;
    const grown = new ResizeObserver(hold);
    grown.observe(element);
    return () => {
      grown.disconnect();
    };
  }, []);
  return {
    list,
    sent: () => {
      toBottom();
      if (held.current) held.current.bottom = true;
    },
  };
}
/**
 * Tells the hub what you have read: while the channel has something unread,
 * once its newest message on screen is in view in a visible tab, you have
 * read up to it, in the topic you are reading or in the whole channel. Each
 * message is told once; one that didn't go is told again at the next look.
 */
function useMarkRead(
  channelPath: string,
  topicId: string,
  newest: string | undefined,
  unread: boolean,
  permitted: boolean,
) {
  const told = useRef('');
  useEffect(() => {
    if (!unread || !permitted || newest === undefined) return;
    const key = channelPath + ' ' + topicId + ' ' + newest;
    const look = () => {
      if (told.current === key) return;
      if (document.visibilityState !== 'visible' || !atBottom()) return;
      told.current = key;
      request(channelPath + '/read', {
        messageId: newest,
        topicId: topicId === '' ? null : topicId,
      }).catch(() => {
        if (told.current === key) told.current = '';
      });
    };
    look();
    window.addEventListener('scroll', look, { passive: true });
    document.addEventListener('visibilitychange', look);
    return () => {
      window.removeEventListener('scroll', look);
      document.removeEventListener('visibilitychange', look);
    };
  }, [channelPath, topicId, newest, unread, permitted]);
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
/** What a message row can do; one object for all rows (`Chat`). */
interface RowActions {
  choose: (id: string) => void;
  makeTask: (m: ChatMessage) => void;
  openAgent: (id: string) => void;
  done: () => void;
  retry: (o: Outgoing) => void;
  remove: (key: string) => void;
}
interface RowProps {
  m: ChatMessage;
  /** What was sent for it, while it is on its way. */
  o: Outgoing | undefined;
  newDay: boolean;
  sameAuthor: boolean;
  divider: boolean;
  fresh: boolean;
  chosen: boolean;
  name: string;
  /** The agent who wrote it, when it is one of the team's. */
  agentId: string | null;
  /** What it answers, when that is not right above it. */
  quote: { id: string; text: string } | null;
  reply: ReplyView | undefined;
  topicTag: string | null;
  /** Mentions not already written in the text, by name. */
  mentions: { kind: 'human' | 'agent'; id: string; name: string }[];
  lines: DeliveryView[];
  /** For the delivery lines, which read the workspace. */
  data: WorkspaceSnapshot;
  permitted: boolean;
  act: RowActions;
}
/** The text of a message, drawn again only when the text changes. */
const MessageText = memo(function MessageText({ text }: { text: string }) {
  return <Markdown text={text} />;
});
/**
 * A row is drawn again only when what it shows changed: the same message
 * (the workspace keeps unchanged ones as they were), the same lists by
 * value, and the workspace itself only for the delivery lines that read it.
 */
const sameRow = (a: RowProps, b: RowProps) =>
  a.m === b.m &&
  a.o === b.o &&
  a.newDay === b.newDay &&
  a.sameAuthor === b.sameAuthor &&
  a.divider === b.divider &&
  a.fresh === b.fresh &&
  a.chosen === b.chosen &&
  a.name === b.name &&
  a.agentId === b.agentId &&
  a.topicTag === b.topicTag &&
  a.permitted === b.permitted &&
  a.act === b.act &&
  JSON.stringify([a.quote, a.reply, a.mentions, a.lines]) ===
    JSON.stringify([b.quote, b.reply, b.mentions, b.lines]) &&
  ((a.lines.length === 0 && b.lines.length === 0) || a.data === b.data);
const MessageRow = memo(function MessageRow({
  m,
  o,
  newDay,
  sameAuthor,
  divider,
  fresh,
  chosen,
  name,
  agentId,
  quote,
  reply,
  topicTag,
  mentions,
  lines,
  data,
  permitted,
  act,
}: RowProps) {
  return (
    <>
      {newDay && (
        <li className="day-divider" role="separator">
          <span>{dayLabel(m.createdAt)}</span>
        </li>
      )}
      <li
        id={'message-' + m.id}
        data-kind={m.author.kind}
        data-continued={sameAuthor ? 'true' : undefined}
        // What was sent arrived when it was shown: settling, it
        // only comes to full strength.
        data-new={fresh ? 'true' : undefined}
        data-pending={
          o === undefined ? undefined : o.failed ? 'failed' : 'sending'
        }
        // On touch, a tapped message shows what can be done with it.
        data-chosen={chosen ? 'true' : undefined}
        onClick={(event) => {
          if (
            event.target instanceof Element &&
            event.target.closest('a, button')
          )
            return;
          act.choose(m.id);
        }}
      >
        {divider && (
          <div className="new-divider" role="separator">
            {shortTime(m.createdAt)} 以来的新消息
          </div>
        )}
        {sameAuthor ? (
          // Under the group's face: the time, shown on hover (and
          // always read out), and the author for a screen reader.
          <time className="gutter-time" dateTime={m.createdAt}>
            <span className="visually-hidden">{name} </span>
            {clockTime(m.createdAt)}
          </time>
        ) : (
          <Avatar
            kind={m.author.kind}
            name={name}
            id={m.author.kind === 'agent' ? m.author.agentId : m.author.humanId}
          />
        )}
        <div className="message-body">
          {!sameAuthor && (
            <header>
              {agentId !== null ? (
                <button
                  type="button"
                  className="author-link"
                  onClick={() => {
                    act.openAgent(agentId);
                  }}
                >
                  {name}
                </button>
              ) : (
                <strong>{name}</strong>
              )}
              <time dateTime={m.createdAt} title={shortTime(m.createdAt)}>
                {clockTime(m.createdAt)}
              </time>
              {/* Only the whole channel tags a message with its topic;
              inside a topic it would say the place again. */}
              {topicTag !== null && (
                <small className="topic-tag">{topicTag}</small>
              )}
            </header>
          )}
          {quote && (
            <button
              type="button"
              className="reply-to link-button"
              onClick={() => {
                showMessage(quote.id);
              }}
            >
              <span aria-hidden="true">↩</span>{' '}
              <span className="visually-hidden">回复 </span>
              {quote.text}
            </button>
          )}
          {m.body !== '' && (
            <div className="message-text">
              <MessageText text={answerOnly(m.body, reply)} />
            </div>
          )}
          {m.attachments.length > 0 && (
            <MessageFiles
              files={m.attachments}
              base={`/api/teams/${data.team.id}/channels/${m.channelId}/attachments`}
            />
          )}
          {m.removedAttachments.map((r) => (
            // The text stays as written; a removed file says who and when.
            <p key={r.removedAt + r.removedBy} className="message-removed">
              {memberName({ kind: 'human', humanId: r.removedBy }, data)}{' '}
              删除了一个文件 ·{' '}
              <time dateTime={r.removedAt}>{shortTime(r.removedAt)}</time>
            </p>
          ))}
          {reply && <ReplyOrigin reply={reply} />}
          {mentions.length > 0 && (
            <ul className="mentions" aria-label="已提及">
              {mentions.map((member) => (
                <li
                  key={member.kind + member.id}
                  className="mention-chip"
                  data-kind={member.kind}
                >
                  @{member.name}
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
                  openAgent={act.openAgent}
                  onDone={act.done}
                />
              ))}
            </ul>
          )}
          {o === undefined ? (
            <div className="message-actions">
              <button
                type="button"
                className="quiet"
                onClick={() => {
                  act.makeTask(m);
                }}
              >
                转为任务
              </button>
            </div>
          ) : (
            o.failed && (
              // It stays where it was written, to be sent again with
              // the same key (posted once, whatever happened) or let go.
              <p className="delivery message-failed" data-tone="problem">
                没发出去
                <button
                  type="button"
                  className="link-button"
                  disabled={!permitted}
                  onClick={() => {
                    act.retry(o);
                  }}
                >
                  重试
                </button>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => {
                    act.remove(o.key);
                  }}
                >
                  删除
                </button>
              </p>
            )
          )}
        </div>
      </li>
    </>
  );
}, sameRow);
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
  onTeam,
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
  /** The channel's 成员 view, where an agent is added. */
  onTeam: () => void;
}) {
  const channel = data.channel;
  const messages = data.messages.items;
  const shown = (channel?.id ?? '') + ':' + shownTopic;
  const { divider, fresh } = useArrivals(shown, messages, data.human.id);
  // The message tapped on a touch screen, which shows its actions.
  const [chosen, setChosen] = useState<string | null>(null);
  const reading = useReadingPosition(shown, messages);
  const earlier = useEarlier(data.messages.nextCursor, onEarlier);
  const permitted = useContext(MutationPermission);
  useMarkRead(
    channelPath,
    shownTopic,
    messages.at(-1)?.id,
    data.latest.find((l) => l.channelId === channel?.id)?.unread ?? false,
    permitted,
  );
  const outbox = useOutbox(channelPath, onDone);
  // What a row can do, the same object for every render, each doing what
  // the latest render says: a row unchanged need not be drawn again.
  const latest = useRef({ onMakeTask, openAgent, onDone, outbox });
  useLayoutEffect(() => {
    latest.current = { onMakeTask, openAgent, onDone, outbox };
  });
  const [act] = useState<RowActions>(() => ({
    choose: (id) => {
      setChosen((old) => (old === id ? null : id));
    },
    makeTask: (m) => {
      latest.current.onMakeTask(m);
    },
    openAgent: (id) => {
      latest.current.openAgent(id);
    },
    done: () => {
      latest.current.onDone();
    },
    retry: (o) => {
      latest.current.outbox.retry(o);
    },
    remove: (key) => {
      latest.current.outbox.remove([key]);
    },
  }));
  // Which message each one sent became: the one the server named, or, when
  // its answer was lost, the same words of mine arriving after it. A
  // message keeps the place, and the element, of what was shown for it.
  const became = useRef(new Map<string, string>());
  const claimed = new Set(became.current.keys());
  const keyOf = new Map(became.current);
  for (const o of outbox.outgoing) if (o.id !== null) claimed.add(o.id);
  for (const o of outbox.outgoing) {
    const id =
      o.id ??
      messages.find(
        (m) =>
          !claimed.has(m.id) &&
          mine(m, data.human.id) &&
          m.position > o.after &&
          m.body === o.message.body &&
          filesOf(m) === filesOf(o.message) &&
          m.topicId === o.message.topicId,
      )?.id;
    if (id === undefined) continue;
    claimed.add(id);
    keyOf.set(id, o.key);
  }
  const landed = outbox.outgoing.filter((o) =>
    messages.some((m) => keyOf.get(m.id) === o.key),
  );
  const waiting = outbox.outgoing.filter(
    (o) =>
      !landed.includes(o) &&
      (shownTopic === '' || o.message.topicId === shownTopic),
  );
  const landedKeys = landed.map((o) => o.key).join(' ');
  useEffect(() => {
    if (landedKeys === '') return;
    const keys = landedKeys.split(' ');
    for (const [id, key] of keyOf)
      if (keys.includes(key)) became.current.set(id, key);
    outbox.remove(keys);
  }, [landedKeys]);
  if (!channel) return null;
  // What is on its way is shown after what has arrived, as it will read.
  const rows = [
    ...messages.map((m) => ({ m, o: undefined })),
    ...waiting.map((o) => ({ m: o.message, o })),
  ];
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
    const flat = (
      source.body || source.attachments.map((a) => a.name).join('、')
    )
      .replace(/\s+/g, ' ')
      .trim();
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
      <FirstSteps data={data} openAgent={openAgent} onTeam={onTeam} />
      <ol className="messages" aria-label="频道消息" ref={reading.list}>
        {rows.map(({ m, o }, index) => {
          const previous = rows[index - 1]?.m;
          // A new day opens with its date; a group never crosses one.
          const newDay =
            previous === undefined ||
            dayOf(previous.createdAt) !== dayOf(m.createdAt);
          // One author's run of messages, within five minutes of each other,
          // in one topic and on one day, is one group: the face and name
          // once, the rest under them.
          const sameAuthor =
            previous !== undefined &&
            !newDay &&
            JSON.stringify(previous.author) === JSON.stringify(m.author) &&
            previous.topicId === m.topicId &&
            Date.parse(m.createdAt) - Date.parse(previous.createdAt) <
              5 * 60_000 &&
            divider !== m.id;
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
          const following = rows[index + 1]?.m.id;
          return (
            <MessageRow
              key={o?.key ?? keyOf.get(m.id) ?? m.id}
              m={m}
              o={o}
              newDay={newDay}
              sameAuthor={sameAuthor}
              divider={divider === m.id}
              fresh={o !== undefined || fresh.has(m.id) || keyOf.has(m.id)}
              chosen={chosen === m.id}
              name={memberName(m.author, data)}
              agentId={agent?.id ?? null}
              quote={
                quoted ? { id: answers, text: replySource(answers) } : null
              }
              reply={origin.get(m.id)}
              topicTag={
                topic === '' && m.topicId ? topicTitle(m.topicId) : null
              }
              mentions={unwritten(m).map((member) => ({
                ...member,
                name: memberName(member, data),
              }))}
              lines={(asked.get(m.id) ?? []).filter(
                (d) =>
                  !(d.state === 'acked' && d.resultMessageId === following),
              )}
              data={data}
              permitted={permitted}
              act={act}
            />
          );
        })}
      </ol>
      {rows.length === 0 && (
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
        onSend={(path, body) => {
          const key = crypto.randomUUID();
          const after = messages.at(-1)?.position ?? 0;
          // The files go as their IDs; what shows meanwhile has them whole.
          const attachments = z.array(Attachment).parse(body.attachments ?? []);
          outbox.send({
            key,
            path,
            request: JSON.stringify({
              ...body,
              attachments: attachments.map((a) => a.id),
              operationKey: key,
            }),
            message: Message.parse({
              ...body,
              attachments,
              removedAttachments: [],
              id: key,
              channelId: channel.id,
              position: after + 1,
              author: { kind: 'human', humanId: data.human.id },
              createdAt: new Date().toISOString(),
            }),
            after,
            id: null,
            failed: false,
          });
        }}
        onDone={reading.sent}
      />
    </div>
  );
}
