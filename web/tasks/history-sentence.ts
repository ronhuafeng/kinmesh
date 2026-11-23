import type { z } from 'zod';
import type { TaskEvent } from '../../src/domain/tasks.js';
import type { Member } from '../../src/domain/communication.js';
import { memberKey } from '../../src/domain/communication.js';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { memberName } from '../shared/names.js';
import { cjk } from '../shared/format.js';

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
