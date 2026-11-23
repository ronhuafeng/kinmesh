import { memo, useState } from 'react';
import { Message } from '../../src/domain/communication.js';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { MessageFiles } from './message-files.js';
import { memberName } from '../shared/names.js';
import { Avatar } from '../shared/avatar.js';
import { clockTime, dayLabel, shortTime } from '../shared/format.js';
import { CopyButton } from '../shared/copy-button.js';
import { DeliveryLine } from '../shared/delivery-line.js';
import { ReactButton } from './react-button.js';
import { Reactions } from './reactions.js';
import { EditMessage } from './edit-message.js';
import { WithdrawButton } from './withdraw-button.js';
import type { Outgoing } from './outbox.js';
import { ReplyOrigin } from './reply-origin.js';
import { answerOnly, type ReplyView } from '../shared/replies.js';
import type { DeliveryView } from '../shared/deliveries.js';
import type { ChatMessage } from './chat-message.js';
import { MessageText } from './message-text.js';
import { showMessage } from './show-message.js';

/** What a message row can do; one object for all rows (`Chat`). */
export interface RowActions {
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
export const NONE: WorkspaceSnapshot['reactions'] = [];
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
export const MessageRow = memo(function MessageRow({
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
