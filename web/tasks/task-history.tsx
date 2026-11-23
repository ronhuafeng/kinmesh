import { useEffect, useState } from 'react';
import type { z } from 'zod';
import type { Task } from '../../src/domain/tasks.js';
import { TaskEvent, TaskExecution } from '../../src/domain/tasks.js';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { threadLink } from '../../src/workspace/links.js';
import { everyPage } from '../shared/api.js';
import { Notice } from '../shared/notice.js';
import { memberName, someoneOf } from '../shared/names.js';
import { cjk, shortTime } from '../shared/format.js';
import { MemberAvatar } from './member-avatar.js';
import { historySentence } from './history-sentence.js';

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
  // is said once, by its link, which opens its thread on the team's T3.
  const lines = [
    ...history
      .filter((e) => e.command.type !== 'link-execution')
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
