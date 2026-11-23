import {
  type ReactNode,
  memo,
  useCallback,
  useMemo,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { z } from 'zod';
import { Message, REACH, pageOf } from '../src/domain/communication.js';
import { Attachment } from '../src/domain/attachments.js';
import type { Shared } from './share.js';
import type { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { MutationPermission, api, request } from './api.js';
import { ActionForm, AddButton, InlineField } from './forms.js';
import { SettingsIcons } from './icons.js';
import { MessageFiles } from './attachments.js';
import { joinedAgents, memberName, otherPeople } from './names.js';
import {
  Avatar,
  clockTime,
  CopyButton,
  dayLabel,
  dayOf,
  shortTime,
  workerConnected,
} from './ui.js';
import { DeliveryLine } from './deliveries.js';
import { Markdown, plainText } from './markdown.js';
import { Composer, type Mentionable } from './composer.js';
import { ReactButton, Reactions } from './reactions.js';
import { EditMessage, WithdrawButton } from './message-edit.js';
import { useOutbox, type Outgoing } from './outbox.js';
import { ReplyOrigin, answerOnly, type ReplyView } from './replies.js';
import type { DeliveryView } from './deliveries.js';

type ChatMessage = z.infer<typeof Message>;
/** Which files a message carries, to tell two of the same text apart. */
const filesOf = (m: ChatMessage) => m.attachments.map((a) => a.id).join(' ');
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
 * Marks what arrived while the conversation was open: messages newer than
 * any shown before in this place (a channel, or one of its topics). Older
 * ones loaded by scrolling back did not arrive.
 */
function useArrivals(place: string, messages: ChatMessage[], me: string) {
  const seen = useRef<{ place: string; newest: number } | null>(null);
  const [divider, setDivider] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  // What arrived from others, said politely to a screen reader.
  const [heard, setHeard] = useState<ChatMessage[]>([]);
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
    setHeard(arrived.filter((m) => !mine(m, me)));
  }, [place, messages, me]);
  return { divider, fresh, heard };
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
  // Whether the newest message is in view, for the way back to it.
  const [atEnd, setAtEnd] = useState(true);
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
    setAtEnd(h.bottom);
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
    atEnd,
    sent: () => {
      toBottom();
      if (held.current) held.current.bottom = true;
      setAtEnd(true);
    },
    /**
     * Shows a message, marked, and reads from it: what grows above or below
     * afterwards holds it still instead of going back to the bottom.
     */
    show: (id: string) => {
      const row = document.getElementById('message-' + id);
      if (!row) return;
      row.scrollIntoView({ block: 'center' });
      row.dataset.flash = 'true';
      setTimeout(() => {
        delete row.dataset.flash;
      }, 1600);
      note();
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
/**
 * The messages older than the workspace's window, read a page at a time
 * from `path` with the cursor each page gives: `cursor` is undefined until
 * the first page is read, null at the channel's beginning. Messages that
 * fall out of the window as new ones arrive are kept here, so what was
 * read back has no gap.
 */
function useArchive(path: string, place: string, windowed: ChatMessage[]) {
  const [state, setState] = useState<{
    place: string;
    items: ChatMessage[];
    cursor: string | null | undefined;
  }>({ place, items: [], cursor: undefined });
  const current =
    state.place === place
      ? state
      : { place, items: [] as ChatMessage[], cursor: undefined };
  const at = useRef(place);
  const asking = useRef<string | null>(null);
  useLayoutEffect(() => {
    at.current = place;
  }, [place]);
  const load = useCallback(
    (cursor: string) => {
      if (asking.current === cursor) return;
      asking.current = cursor;
      const from = place;
      void api(path + '?limit=100&cursor=' + encodeURIComponent(cursor))
        .then((raw) => {
          if (at.current !== from) return;
          const page = pageOf(Message).parse(raw);
          setState((old) => {
            const kept = old.place === from ? old.items : [];
            const ids = new Set(kept.map((m) => m.id));
            return {
              place: from,
              items: [...page.items.filter((m) => !ids.has(m.id)), ...kept],
              cursor: page.nextCursor,
            };
          });
        })
        .catch(() => undefined)
        .finally(() => {
          if (asking.current === cursor) asking.current = null;
        });
    },
    [path, place],
  );
  // What leaves the window's old end stays read.
  const before = useRef<ChatMessage[]>(windowed);
  useEffect(() => {
    const previous = before.current;
    before.current = windowed;
    const oldest = windowed[0]?.position;
    if (oldest === undefined) return;
    setState((old) => {
      if (old.place !== place || old.cursor === undefined) return old;
      const ids = new Set(old.items.map((m) => m.id));
      const dropped = previous.filter(
        (m) => m.position < oldest && !ids.has(m.id),
      );
      if (dropped.length === 0) return old;
      return {
        ...old,
        items: [...old.items, ...dropped].sort(
          (a, b) => a.position - b.position,
        ),
      };
    });
  }, [windowed, place]);
  return { items: current.items, cursor: current.cursor, load };
}
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
  open: (id: string) => void;
  reply: (id: string) => void;
  pin: (id: string, on: boolean) => void;
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
  /** Its reactions, by reaction. */
  reactions: WorkspaceSnapshot['reactions'];
  /** Whether it is pinned in its channel. */
  pinned: boolean;
  /** For the delivery lines, which read the workspace. */
  data: WorkspaceSnapshot;
  permitted: boolean;
  act: RowActions;
}
/** No reactions: one list, so a row without any compares as unchanged. */
const NONE: WorkspaceSnapshot['reactions'] = [];
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
  a.pinned === b.pinned &&
  a.act === b.act &&
  // The workspace keeps an unchanged reply or delivery the same object
  // (keepUnchanged), so these compare by identity, never by serializing.
  a.reply === b.reply &&
  a.quote?.id === b.quote?.id &&
  a.quote?.text === b.quote?.text &&
  sameList(a.lines, b.lines, (x, y) => x === y) &&
  sameList(
    a.reactions,
    b.reactions,
    (x, y) => x.emoji === y.emoji && x.humanIds.join() === y.humanIds.join(),
  ) &&
  sameList(
    a.mentions,
    b.mentions,
    (x, y) => x.kind === y.kind && x.id === y.id && x.name === y.name,
  ) &&
  ((a.lines.length === 0 && b.lines.length === 0) || a.data === b.data);
/** Two lists with the same items, in order. */
function sameList<T>(a: T[], b: T[], same: (x: T, y: T) => boolean) {
  if (a.length !== b.length) return false;
  for (const [i, x] of a.entries()) {
    const y = b[i];
    if (y === undefined || !same(x, y)) return false;
  }
  return true;
}
/** Whether two authors are the same one. */
const sameAuthorOf = (a: ChatMessage['author'], b: ChatMessage['author']) =>
  a.kind === 'human'
    ? b.kind === 'human' && a.humanId === b.humanId
    : b.kind === 'agent' && a.agentId === b.agentId;
const MessageRow = memo(function MessageRow({
  m: given,
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
  reactions,
  pinned,
  data,
  permitted,
  act,
}: RowProps) {
  const [editing, setEditing] = useState(false);
  // What its author just saved shows at once, until the workspace has it.
  const [changed, setChanged] = useState<ChatMessage | null>(null);
  const m =
    changed !== null &&
    ((changed.withdrawnAt !== null && given.withdrawnAt === null) ||
      (changed.editedAt ?? '') > (given.editedAt ?? ''))
      ? {
          ...given,
          body: changed.body,
          editedAt: changed.editedAt,
          withdrawnAt: changed.withdrawnAt,
        }
      : given;
  const saved = (value: unknown) => {
    setChanged(Message.parse(value));
    act.done();
  };
  const path = `/api/teams/${data.team.id}/channels/${m.channelId}/messages/${m.id}`;
  const withdrawn = m.withdrawnAt !== null;
  // Only its author changes what a message says, until it is withdrawn.
  const mine =
    o === undefined &&
    !withdrawn &&
    m.author.kind === 'human' &&
    m.author.humanId === data.human.id;
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
            event.target.closest('a, button, textarea')
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
                act.open(quote.id);
              }}
            >
              <span aria-hidden="true">↩</span>{' '}
              <span className="visually-hidden">回复 </span>
              {quote.text}
            </button>
          )}
          {withdrawn ? (
            <p className="message-removed">这条消息已撤回</p>
          ) : editing ? (
            <EditMessage
              path={path}
              body={m.body}
              hasFiles={m.attachments.length > 0}
              onClose={() => {
                setEditing(false);
              }}
              onSaved={saved}
            />
          ) : (
            m.body !== '' && (
              <div className="message-text">
                <MessageText text={answerOnly(m.body, reply)} />
              </div>
            )
          )}
          {m.editedAt !== null && !withdrawn && !editing && (
            <p className="message-edited">
              <time dateTime={m.editedAt} title={shortTime(m.editedAt)}>
                已编辑
              </time>
            </p>
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
          {o === undefined && !withdrawn && (
            <Reactions
              list={reactions}
              path={path}
              data={data}
              permitted={permitted}
              onDone={act.done}
            />
          )}
          {reply && <ReplyOrigin reply={reply} />}
          {mentions.length > 0 && !withdrawn && (
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
          {o === undefined
            ? !withdrawn &&
              !editing && (
                <div className="message-actions">
                  {/* As written: its Markdown, never a reply's provenance. */}
                  {m.body.trim() !== '' && (
                    <CopyButton
                      text={answerOnly(m.body, reply)}
                      label="复制"
                      className="quiet"
                    />
                  )}
                  {/* Its address: opening it shows this message in its channel. */}
                  <CopyButton
                    text={
                      window.location.origin +
                      '/?channel=' +
                      m.channelId +
                      '&message=' +
                      m.id
                    }
                    label="复制链接"
                    className="quiet"
                  />
                  <ReactButton
                    path={path}
                    mine={reactions
                      .filter((r) => r.humanIds.includes(data.human.id))
                      .map((r) => r.emoji)}
                    permitted={permitted}
                    onDone={act.done}
                  />
                  <button
                    type="button"
                    className="quiet"
                    disabled={!permitted}
                    onClick={() => {
                      act.pin(m.id, !pinned);
                    }}
                  >
                    {pinned ? '取消置顶' : '置顶'}
                  </button>
                  <button
                    type="button"
                    className="quiet"
                    onClick={() => {
                      act.reply(m.id);
                    }}
                  >
                    回复
                  </button>
                  <button
                    type="button"
                    className="quiet"
                    onClick={() => {
                      act.makeTask(m);
                    }}
                  >
                    转为任务
                  </button>
                  {mine && (
                    <button
                      type="button"
                      className="quiet"
                      disabled={!permitted}
                      onClick={() => {
                        setEditing(true);
                      }}
                    >
                      编辑
                    </button>
                  )}
                  {mine && m.attachments.length === 0 && (
                    <WithdrawButton
                      path={path}
                      permitted={permitted}
                      onSaved={saved}
                    />
                  )}
                </div>
              )
            : o.failed && (
                // It stays where it was written, to be sent again with
                // the same key (posted once, whatever happened) or let go.
                <p className="delivery message-failed" data-tone="problem">
                  {o.refused ? '没发出去：' + o.refused : '没发出去'}
                  {!o.refused && (
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
                  )}
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
  incoming,
  join = null,
  target = null,
  onOpenMessage,
}: {
  data: WorkspaceSnapshot;
  channelPath: string;
  topic: string;
  /** The message the conversation is opened at, reached however far back. */
  target?: string | null;
  /** Opens a message of this channel, as search and quotes do. */
  onOpenMessage: (id: string) => void;
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
  /** What was shared to Kinmesh, for this channel's composer. */
  incoming?: { key: string; shared: Shared } | undefined;
  /** In place of the composer: joining a channel you only look in. */
  join?: ReactNode;
}) {
  const channel = data.channel;
  const window_ = data.messages.items;
  const shown = (channel?.id ?? '') + ':' + shownTopic;
  // Past the workspace's window (its newest `REACH`), older messages are
  // read page by page: the whole history can be reached.
  const archive = useArchive(
    channelPath +
      (shownTopic ? '/topics/' + shownTopic + '/messages' : '/messages'),
    shown,
    window_,
  );
  const messages = useMemo(
    () =>
      archive.items.length === 0 ? window_ : [...archive.items, ...window_],
    [archive.items, window_],
  );
  const full = window_.length >= REACH;
  // Where older messages come from now: the window's own cursor until it is
  // full, then the history's pages; null at the channel's beginning.
  const older = full
    ? archive.cursor === undefined
      ? data.messages.nextCursor
      : archive.cursor
    : data.messages.nextCursor;
  const reachOlder = useCallback(
    (cursor: string) => {
      if (full) archive.load(cursor);
      else onEarlier(cursor);
    },
    [full, archive.load, onEarlier],
  );
  const { divider, fresh, heard } = useArrivals(shown, messages, data.human.id);
  // The message tapped on a touch screen, which shows its actions.
  const [chosen, setChosen] = useState<string | null>(null);
  // The message the next one answers, chosen with 回复, in this place.
  const [replying, setReplying] = useState<{
    place: string;
    id: string;
  } | null>(null);
  const reading = useReadingPosition(shown, messages);
  const earlier = useEarlier(older, reachOlder);
  // Where you stopped reading, as this place opened: it opens there, under
  // the "new since" line, until you go elsewhere.
  const [unreadFrom, setUnreadFrom] = useState<{
    place: string;
    id: string;
  } | null>(null);
  const openedAt = useRef<string | null>(null);
  useEffect(() => {
    if (openedAt.current === shown) return;
    openedAt.current = shown;
    setUnreadFrom(
      data.firstUnread ? { place: shown, id: data.firstUnread } : null,
    );
  }, [shown, data.firstUnread]);
  const unreadHere = unreadFrom?.place === shown ? unreadFrom.id : null;
  // The "new since" line: what arrived while here, else where you stopped.
  const newLine = divider ?? unreadHere;
  const goTo = target ?? unreadHere;
  // A message opened here is reached however far back it is, shown and
  // marked once.
  const reachedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!goTo || reachedFor.current === shown + goTo) return;
    if (messages.some((m) => m.id === goTo)) {
      reachedFor.current = shown + goTo;
      requestAnimationFrame(() => {
        reading.show(goTo);
      });
    } else if (older !== null) reachOlder(older);
    else reachedFor.current = shown + goTo;
  }, [goTo, shown, messages, older, reachOlder]);
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
  const latest = useRef({
    onMakeTask,
    openAgent,
    onDone,
    outbox,
    onOpenMessage,
    shown,
    channelPath,
  });
  useLayoutEffect(() => {
    latest.current = {
      onMakeTask,
      openAgent,
      onDone,
      outbox,
      onOpenMessage,
      shown,
      channelPath,
    };
  });
  const [act] = useState<RowActions>(() => ({
    choose: (id) => {
      setChosen((old) => (old === id ? null : id));
    },
    open: (id) => {
      latest.current.onOpenMessage(id);
    },
    pin: (id, on) => {
      void request(`${latest.current.channelPath}/messages/${id}/pin`, {
        on,
      }).then(
        () => {
          latest.current.onDone();
        },
        () => undefined,
      );
    },
    reply: (id) => {
      setReplying({ place: latest.current.shown, id });
      document
        .querySelector<HTMLTextAreaElement>('.composer textarea')
        ?.focus();
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
  const pinnedIds = new Set(data.pinned.map((p) => p.message.id));
  // Each message's reactions, once.
  const reactedTo = new Map<string, WorkspaceSnapshot['reactions']>();
  for (const r of data.reactions)
    reactedTo.set(r.messageId, [...(reactedTo.get(r.messageId) ?? []), r]);
  // A mention already written as @Name in the text needs no second chip;
  // nor does a person's written as @handle before they had a name.
  const people = new Map<string, (typeof data.people)[number]>(
    data.people.map((p) => [p.id, p]),
  );
  const agents = new Map<string, (typeof data.agents)[number]>(
    data.agents.map((a) => [a.id, a]),
  );
  const handle = (id: string) => people.get(id)?.username;
  const unwritten = (m: ChatMessage) =>
    m.mentions.filter((member) => {
      const old = member.kind === 'human' ? handle(member.id) : undefined;
      return (
        !m.body.includes('@' + memberName(member, data)) &&
        !(old !== undefined && m.body.includes('@' + old))
      );
    });
  // Each message by its ID, once, for the quotes above replies.
  const byId = new Map<string, ChatMessage>(messages.map((m) => [m.id, m]));
  const replySource = (id: string) => {
    const source = byId.get(id);
    if (!source) return '之前的一条消息';
    if (source.withdrawnAt !== null)
      return `${memberName(source.author, data)}：这条消息已撤回`;
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
      {older === null && (
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
      {/* What others write while you are here is read out, without moving
          focus: who, then the start of what they wrote. */}
      <p className="visually-hidden" aria-live="polite">
        {heard
          .map(
            (m) =>
              memberName(m.author, data) +
              '：' +
              (plainText(m.body).slice(0, 140) ||
                m.attachments.map((a) => a.name).join('、')),
          )
          .join('。')}
      </p>
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
            sameAuthorOf(previous.author, m.author) &&
            previous.topicId === m.topicId &&
            Date.parse(m.createdAt) - Date.parse(previous.createdAt) <
              5 * 60_000 &&
            newLine !== m.id;
          const agent =
            m.author.kind === 'agent'
              ? agents.get(m.author.agentId)
              : undefined;
          // A reply right under what it answers needs neither the quote
          // nor the "replied" line to say so.
          const answers = replyTo.get(m.id) ?? m.sourceMessageId ?? undefined;
          const quoted = answers !== undefined && answers !== previous?.id;
          const following = rows[index + 1]?.m.id;
          return (
            <MessageRow
              key={o?.key ?? keyOf.get(m.id) ?? m.id}
              m={m}
              o={o}
              newDay={newDay}
              sameAuthor={sameAuthor}
              divider={newLine === m.id}
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
              reactions={reactedTo.get(m.id) ?? NONE}
              pinned={pinnedIds.has(m.id)}
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
      {/* Read back, the newest is one press away. */}
      {!reading.atEnd && rows.length > 0 && (
        <div className="to-newest">
          <button type="button" onClick={reading.sent}>
            回到最新 ↓
          </button>
        </div>
      )}
      {join ?? (
        <Composer
          key={channel.id}
          channelPath={channelPath}
          topicId={topic}
          incoming={incoming}
          replyTo={
            replying?.place === shown
              ? { id: replying.id, said: replySource(replying.id) }
              : null
          }
          onClearReply={() => {
            setReplying(null);
          }}
          members={[
            // A disabled agent takes no requests, so it isn't offered.
            ...joinedAgents(data)
              .filter((a) => a.lifecycle === 'active')
              .map((a): Mentionable => ({
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
            const attachments = z
              .array(Attachment)
              .parse(body.attachments ?? []);
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
                editedAt: null,
                withdrawnAt: null,
                id: key,
                channelId: channel.id,
                position: after + 1,
                author: { kind: 'human', humanId: data.human.id },
                createdAt: new Date().toISOString(),
              }),
              after,
              id: null,
              failed: false,
              refused: null,
            });
          }}
          onDone={reading.sent}
        />
      )}
    </div>
  );
}
