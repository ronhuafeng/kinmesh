import type { z } from 'zod';
import { TaskEvent, type Task, TaskExecution } from '../../src/domain/tasks.js';
import { type Member, memberKey } from '../../src/domain/communication.js';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { memberName, someoneOf } from '../shared/names.js';
import { cjk, shortTime } from '../shared/format.js';
import { useEffect, useState } from 'react';
import { threadLink } from '../../src/workspace/links.js';
import { everyPage } from '../shared/api.js';
import { Notice } from '../shared/forms.js';
import { MemberAvatar } from './members.js';

const quote = (note: string) =>
  '：“' + (note.length > 120 ? note.slice(0, 117) + '…' : note) + '”';
/** One line of task history as a person would say it. */
export function historySentence(
  e: z.infer<typeof TaskEvent>,
  data: WorkspaceSnapshot,
): string {
  return cjk(said(e, data));
}
function said(e: z.infer<typeof TaskEvent>, data: WorkspaceSnapshot): string {
  // Everyone, you included, is their name: the record reads the same to all.
  const who = memberName(e.author, data);
  const name = (m: Member) => memberName(m, data);
  const c = e.command;
  switch (c.type) {
    case 'create':
      return `${who} 创建了任务`;
    case 'claim':
      return `${who} 认领了任务`;
    case 'progress':
      return `${who} 发布了进展${quote(c.note)}`;
    case 'handoff': {
      const self =
        e.author.kind === c.recipient.kind &&
        (e.author.kind === 'human' ? e.author.humanId : e.author.agentId) ===
          c.recipient.id;
      return c.mode === 'review'
        ? `${who} 请 ${name(c.recipient)} 审核${quote(c.note)}`
        : self
          ? `${who} 接手了工作${quote(c.note)}`
          : `${who} 把工作交给了 ${name(c.recipient)}${quote(c.note)}`;
    }
    case 'request-review':
      return `${who} 请 ${name(c.reviewer)} 审核${quote(c.note)}`;
    case 'review':
      return c.decision === 'approve'
        ? `${who} 审核通过${quote(c.note)}`
        : `${who} 要求修改${quote(c.note)}`;
    case 'accept':
      return `${who} 验收通过${quote(c.note)}`;
    case 'rework':
      return `${who} 退回了任务${quote(c.note)}`;
    case 'cancel':
      return `${who} 取消了任务${quote(c.note)}`;
    case 'link-execution':
      return `${who} 关联了一次 T3 运行`;
    case 'link-pull-request':
      return `${who} 关联了 PR ${c.pullRequest.repository}#${String(c.pullRequest.number)}`;
    case 'edit': {
      const before = e.before;
      const changed = before
        ? [
            before.title !== c.title && '标题',
            before.description !== c.description && '描述',
            before.criteria.join('\n') !== c.criteria.join('\n') && '完成标准',
            (before.state.reviewer === null
              ? ''
              : memberKey(before.state.reviewer)) !==
              (c.reviewer === null ? '' : memberKey(c.reviewer)) && '审核人',
            before.due !== c.due && '截止日期',
            before.priority !== c.priority && '优先级',
          ].filter((v): v is string => v !== false)
        : [];
      return `${who} 修改了${changed.length > 0 ? changed.join('、') : '任务'}`;
    }
  }
}
export function TaskHistory({
  task,
  path,
  data,
}: {
  task: Task;
  path: string;
  data: WorkspaceSnapshot;
}) {
  const [history, setHistory] = useState<z.infer<typeof TaskEvent>[]>([]);
  const [links, setLinks] = useState<z.infer<typeof TaskExecution>[]>([]);
  const [failing, setFailing] = useState(false);
  // Read again whenever the task moves on; a failed read retries by itself,
  // a little later each time, and says so only once it keeps failing.
  useEffect(() => {
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    const read = (attempt: number) => {
      void Promise.all([
        everyPage(path + '/history', TaskEvent, controller.signal),
        everyPage(path + '/executions', TaskExecution, controller.signal),
      ])
        .then(([events, refs]) => {
          setHistory(events);
          setLinks(refs);
          setFailing(false);
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          if (attempt >= 2) setFailing(true);
          retry = setTimeout(
            () => {
              read(attempt + 1);
            },
            Math.min(1000 * 2 ** attempt, 30000),
          );
        });
    };
    read(0);
    return () => {
      controller.abort();
      clearTimeout(retry);
    };
  }, [path, task.version]);
  const avatarOf = (author: z.infer<typeof TaskEvent>['author']) => (
    <MemberAvatar member={someoneOf(author)} data={data} />
  );
  const origin = data.nativeT3Origin;
  // Decisions and linked T3 runs, one timeline, oldest first. A linked run
  // is said once, by its link, which opens its thread on the team's T3; a
  // linked PR is said once, under PR.
  const lines = [
    ...history
      .filter(
        (e) =>
          e.command.type !== 'link-execution' &&
          e.command.type !== 'link-pull-request',
      )
      .map((e) => ({
        key: e.id,
        at: e.createdAt,
        who: avatarOf(e.author),
        text: historySentence(e, data),
        href: null as string | null,
      })),
    ...links.map((link) => ({
      key: link.id,
      at: link.createdAt,
      who: avatarOf(link.author),
      text: cjk(`${memberName(link.author, data)} 关联了一次 T3 运行`),
      href: origin ? threadLink(origin, link.reference) : null,
    })),
  ].sort((x, y) => x.at.localeCompare(y.at));
  return (
    <section className="task-history" aria-label="记录">
      <h3>记录</h3>
      {failing && <Notice>暂时读不到记录。</Notice>}
      <ol className="history">
        {lines.map((line) => (
          <li key={line.key}>
            <time dateTime={line.at}>{shortTime(line.at)}</time>
            {line.who}
            <span>
              {line.href ? (
                <a href={line.href} target="_blank" rel="noopener noreferrer">
                  {line.text}
                </a>
              ) : (
                line.text
              )}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
