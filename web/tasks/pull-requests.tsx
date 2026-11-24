import { useState } from 'react';
import type { Task } from '../../src/domain/tasks.js';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import {
  pullRequestFromUrl,
  pullRequestKey,
  pullRequestStale,
  type TaskPullRequestView,
} from '../../src/domain/pull-requests.js';
import { useAction } from '../shared/api.js';
import { AddButton } from '../shared/forms.js';
import { composing } from '../shared/keys.js';
import { someoneOf } from '../shared/names.js';
import { shortTime } from '../shared/format.js';
import { MemberAvatar } from './members.js';

/** What GitHub last said, in the person's words; nothing before it says. */
function stateOf(view: TaskPullRequestView, now: number) {
  const o = view.observation;
  if (o === null) return null;
  if (o.kind === 'unavailable')
    return o.reason === 'not-found'
      ? 'GitHub 上找不到，或没有权限查看'
      : o.reason === 'forbidden'
        ? 'GitHub 拒绝了 Kinmesh 的读取权限'
        : '暂时读不到 GitHub';
  const state =
    o.state === 'merged'
      ? '已合并'
      : o.state === 'closed'
        ? '已关闭'
        : o.draft
          ? '草稿'
          : '进行中';
  return pullRequestStale(o, now) ? `${state}，可能已过时` : state;
}

/**
 * The pull requests said to belong to the task: who linked each and when,
 * its name as the link to GitHub, and what GitHub last said about it. While
 * the task is open, "+" pastes another one's address.
 */
export function TaskPullRequests({
  task,
  data,
  path,
}: {
  task: Task;
  data: WorkspaceSnapshot;
  path: string;
}) {
  const links = data.taskPullRequests.filter((l) => l.taskId === task.id);
  const open =
    task.state.status !== 'accepted' && task.state.status !== 'cancelled';
  const [adding, setAdding] = useState(false);
  if (links.length === 0 && !open) return null;
  // As of the snapshot: what GitHub said, measured against when it was read.
  const now = Date.parse(data.observedAt);
  return (
    <section className="task-pull-requests" aria-label="PR">
      <h3>
        PR
        {open && !adding && (
          <AddButton
            label="关联 PR"
            onClick={() => {
              setAdding(true);
            }}
          />
        )}
      </h3>
      {links.length > 0 && (
        <ol className="history">
          {links.map((link) => {
            const { repository, number } = link.pullRequest;
            const o = link.observation;
            const href =
              o?.kind === 'observed'
                ? o.url
                : `https://github.com/${repository}/pull/${String(number)}`;
            const state = stateOf(link, now);
            const name = `${repository}#${String(number)}`;
            return (
              <li key={link.id}>
                <time dateTime={link.createdAt}>
                  {shortTime(link.createdAt)}
                </time>
                <MemberAvatar member={someoneOf(link.author)} data={data} />
                <span>
                  <a href={href} target="_blank" rel="noopener noreferrer">
                    {o?.kind === 'observed' ? o.title : name}
                  </a>
                  <span className="pull-meta">
                    {o?.kind === 'observed' && <code>{name}</code>}
                    {state !== null && o !== null && (
                      <time
                        dateTime={o.observedAt}
                        title={`GitHub ${shortTime(o.observedAt)}`}
                      >
                        {state}
                      </time>
                    )}
                  </span>
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {adding && (
        <PullRequestField
          task={task}
          path={path}
          linked={links.map((l) => pullRequestKey(l.pullRequest))}
          onClose={() => {
            setAdding(false);
          }}
        />
      )}
    </section>
  );
}

/** A PR's address, pasted in place: Enter links it, Esc or nothing closes. */
function PullRequestField({
  task,
  path,
  linked,
  onClose,
}: {
  task: Task;
  path: string;
  linked: string[];
  onClose: () => void;
}) {
  const action = useAction({
    409: '任务刚刚有了变化，请再试一次。',
    413: '一个任务最多关联 20 个 PR。',
  });
  const [refusal, setRefusal] = useState('');
  const error = refusal || action.error;
  return (
    <form
      className="inline-field pull-request-field"
      onSubmit={(event) => {
        event.preventDefault();
        const text = new FormData(event.currentTarget).get('url');
        const pullRequest =
          typeof text === 'string' ? pullRequestFromUrl(text) : null;
        if (pullRequest === null) {
          setRefusal('这不是 GitHub 上 PR 的地址。');
          return;
        }
        if (linked.includes(pullRequestKey(pullRequest))) {
          setRefusal('这个 PR 已经关联过了。');
          return;
        }
        setRefusal('');
        void action
          .send(path + '/link-pull-request', {
            expectedVersion: task.version,
            pullRequest,
          })
          .then((ok) => {
            if (ok) onClose();
          });
      }}
    >
      <input
        name="url"
        aria-label="PR 地址"
        placeholder="粘贴 PR 的地址"
        maxLength={300}
        required
        autoFocus
        readOnly={action.busy}
        onChange={() => {
          setRefusal('');
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || composing(event)) return;
          event.preventDefault();
          onClose();
        }}
        onBlur={(event) => {
          if (!event.currentTarget.value.trim() && !error) onClose();
        }}
      />
      {error && (
        <span className="inline-error" role="alert">
          {error}
        </span>
      )}
    </form>
  );
}
