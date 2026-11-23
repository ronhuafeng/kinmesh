import {
  type ReactNode,
  useCallback,
  useMemo,
  useContext,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { z } from 'zod';
import { Message, REACH } from '../../src/domain/communication.js';
import { Attachment } from '../../src/domain/attachments.js';
import type { Shared } from '../shared/share.js';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { MutationPermission, request } from '../shared/api.js';
import { ActionForm } from '../shared/forms.js';
import { joinedAgents, memberName, otherPeople } from '../shared/names.js';
import { dayOf, workerConnected } from '../shared/format.js';
import { plainText } from '../shared/markdown.js';
import { Composer, type Mentionable } from './composer.js';
import { useOutbox } from './outbox.js';
import type { DeliveryView } from '../shared/deliveries.js';
import {
  type ChatMessage,
  mine,
  filesOf,
  sameAuthorOf,
} from './chat-message.js';
import { useArchive } from './reading.js';
import { useArrivals } from './reading.js';
import { useReadingPosition } from './reading.js';
import { useEarlier } from './reading.js';
import { useMarkRead } from './reading.js';
import { type RowActions, MessageRow, NONE } from './message-row.js';
import { NewTopic } from './topics.js';
import { FirstSteps } from './first-steps.js';

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
  const loadArchive = archive.load;
  const reachOlder = useCallback(
    (cursor: string) => {
      if (full) loadArchive(cursor);
      else onEarlier(cursor);
    },
    [full, loadArchive, onEarlier],
  );
  const { divider, fresh, heard } = useArrivals(shown, messages, data.human.id);
  // The message tapped on a touch screen, which shows its actions.
  const [chosen, setChosen] = useState<string | null>(null);
  // The message the next one answers, chosen with 回复, in this place.
  const [replying, setReplying] = useState<{
    place: string;
    id: string;
  } | null>(null);
  const {
    atEnd,
    list: listRef,
    sent: toNewest,
    show: showMessage,
  } = useReadingPosition(shown, messages);
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
  const reveal = useEffectEvent((id: string) => {
    requestAnimationFrame(() => {
      showMessage(id);
    });
  });
  useEffect(() => {
    if (!goTo || reachedFor.current === shown + goTo) return;
    if (messages.some((m) => m.id === goTo)) {
      reachedFor.current = shown + goTo;
      reveal(goTo);
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
  const claimed = new Set(outbox.became.keys());
  const keyOf = new Map(outbox.became);
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
  const land = useEffectEvent((keys: string[]) => {
    outbox.land([...keyOf].filter(([, key]) => keys.includes(key)));
  });
  useEffect(() => {
    if (landedKeys !== '') land(landedKeys.split(' '));
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
      <ol className="messages" aria-label="频道消息" ref={listRef}>
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
      {!atEnd && rows.length > 0 && (
        <div className="to-newest">
          <button type="button" onClick={toNewest}>
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
          onDone={toNewest}
        />
      )}
    </div>
  );
}
