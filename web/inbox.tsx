import type { ReactNode } from 'react';
import type { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { deliveryText, Recovery } from './deliveries.js';
import { InboxIcon } from './icons.js';
import { memberName } from './names.js';
import { humanAsk } from './tasks.js';
import { Avatar, Page, ago, plural, workerConnected } from './ui.js';

/** How many things wait on you: the Inbox's one number. */
export function attentionCount(attention: WorkspaceSnapshot['attention']) {
  return (
    attention.decide.length +
    attention.unstuck.length +
    attention.connect.length
  );
}
/** One row: who it is about, what it is, where and when; the row opens it. */
interface Item {
  key: string;
  tone: 'decide' | 'problem' | 'setup';
  agentId: string | null;
  who: string;
  what: string;
  where: string | null;
  at: string | null;
  open: () => void;
  fix?: ReactNode;
}
/**
 * Everything waiting on this person across the team, as one list, newest
 * first. An item leaves as soon as its cause is resolved; nothing to dismiss
 * or mark as read.
 */
export function InboxPage({
  data,
  onClose,
  openTask,
  openChannel,
  openAgent,
  onDone,
}: {
  data: WorkspaceSnapshot;
  onClose: () => void;
  onDone: () => void;
  openTask: (channelId: string, taskId: string) => void;
  openChannel: (channelId: string) => void;
  openAgent: (agentId: string) => void;
}) {
  const { decide, unstuck, connect } = data.attention;
  const name = (id: string) => memberName({ kind: 'agent', id }, data);
  const items: Item[] = [
    ...decide.map(({ task, channelName }): Item => {
      const agent =
        task.state.owner?.kind === 'agent'
          ? task.state.owner.id
          : task.state.reviewer?.kind === 'agent'
            ? task.state.reviewer.id
            : null;
      return {
        key: 'task-' + task.id,
        tone: 'decide',
        agentId: agent,
        who: agent ? name(agent) : data.human.username,
        what: task.title,
        where: (humanAsk(task, data) ?? 'Your decision') + ' · #' + channelName,
        at: task.updatedAt,
        open: () => {
          openTask(task.channelId, task.id);
        },
      };
    }),
    ...unstuck.map((d): Item => ({
      key: 'delivery-' + d.id,
      tone: 'problem',
      agentId: d.agentId,
      who: name(d.agentId),
      what: deliveryText(
        d,
        name(d.agentId),
        workerConnected(data.wake, d.agentId),
      ).text,
      where: '#' + d.channelName,
      at: d.updatedAt,
      open: () => {
        if (d.taskId) openTask(d.channelId, d.taskId);
        else openChannel(d.channelId);
      },
      fix: (
        <Recovery
          delivery={d}
          data={data}
          channelId={d.channelId}
          openAgent={openAgent}
          onDone={onDone}
        />
      ),
    })),
    ...connect.map((c): Item => ({
      key: 'connect-' + c.agentId,
      tone: 'setup',
      agentId: c.agentId,
      who: name(c.agentId),
      what: `${plural(c.queued, 'request')} waiting, but ${name(c.agentId)} can’t be woken yet`,
      where: null,
      at: null,
      open: () => {
        openAgent(c.agentId);
      },
    })),
  ].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
  return (
    <Page label="Inbox" onClose={onClose} className="inbox" bar={false}>
      {items.length === 0 ? (
        <div className="inbox-empty">
          <span className="inbox-empty-mark" aria-hidden="true">
            <InboxIcon />
          </span>
          <p>You’re all caught up.</p>
        </div>
      ) : (
        <ul className="inbox-list" aria-label="Inbox">
          {items.map((item) => (
            <li key={item.key} className="inbox-row" data-tone={item.tone}>
              <span className="inbox-face">
                {item.agentId ? (
                  <Avatar kind="agent" name={item.who} id={item.agentId} />
                ) : (
                  <Avatar kind="human" name={item.who} />
                )}
              </span>
              <button
                type="button"
                className="inbox-main"
                aria-label={item.what}
                onClick={item.open}
              >
                <span className="inbox-what">{item.what}</span>
                {item.where && (
                  <span className="inbox-where">{item.where}</span>
                )}
              </button>
              {item.at && (
                <time dateTime={item.at} className="inbox-time">
                  {ago(item.at)}
                </time>
              )}
              {item.fix && <div className="inbox-fix">{item.fix}</div>}
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}
