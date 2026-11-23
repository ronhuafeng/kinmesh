import type { z } from 'zod';
import { z as zod } from 'zod';
import { keep, kept } from './session.js';
import type { Message } from '../../src/domain/communication.js';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { memberName } from './names.js';
import { LEGACY_FOOTER } from './replies.js';

export interface TaskDraft {
  id: string;
  title: string;
  description: string;
  topicId: string | null;
  sourceMessageId: string | null;
  from: string | null;
}
const KeptDraft = zod.object({
  draft: zod.object({
    id: zod.string(),
    title: zod.string(),
    description: zod.string(),
    topicId: zod.string().nullable(),
    sourceMessageId: zod.string().nullable(),
    from: zod.string().nullable(),
  }),
  fields: zod.record(zod.string(), zod.string()).default({}),
});
/** The new task being written in this tab, if any, with what was typed. */
export function keptDraft() {
  const parsed = KeptDraft.safeParse(kept('new-task'));
  return parsed.success ? parsed.data : null;
}
/** Keeps a new task and what was typed into it, until created or dropped. */
export function keepDraft(
  draft: TaskDraft | null,
  fields?: Record<string, string>,
) {
  if (draft === null) {
    keep('new-task', null);
    return;
  }
  const before = keptDraft();
  keep('new-task', {
    draft,
    fields: fields ?? (before?.draft.id === draft.id ? before.fields : {}),
  });
}
/** One line of Markdown as plain words: no markers, links as their text. */
export function plainLine(line: string) {
  return line
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d{1,9}[.)]\s+)/, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|_|`)(.+?)\1/g, '$2')
    .trim();
}
/** A new task with nothing typed yet, in the topic it was started from. */
export const blankDraft = (topicId: string | null): TaskDraft => ({
  id: 'new-' + String(Date.now()),
  title: '',
  description: '',
  topicId,
  sourceMessageId: null,
  from: null,
});
export function draftFromMessage(
  message: z.infer<typeof Message>,
  data: WorkspaceSnapshot,
): TaskDraft {
  // The answer only (no provenance footer), and a title in plain words.
  const body = message.body.replace(LEGACY_FOOTER, '').trim();
  const firstLine =
    body
      .split('\n')
      .map(plainLine)
      .find((line) => line !== '') ?? '';
  return {
    id: message.id,
    title: firstLine.slice(0, 160),
    description: body.slice(0, 4000),
    topicId: message.topicId,
    sourceMessageId: message.id,
    from: memberName(message.author, data),
  };
}
