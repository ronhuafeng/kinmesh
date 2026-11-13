import type { WorkspaceSnapshot } from '../src/workspace/contracts.js';

type ReplyView = WorkspaceSnapshot['replies'][number];
/**
 * Provenance once appended to agent replies; stripped wherever a reply is
 * read or becomes a task, so older messages read as answers.
 */
export const LEGACY_FOOTER = /\s*\[T3 (?:succeeded|failed|stopped)[^\]]*\]\s*$/;

/** The text of a message as people should read it: the answer only. */
export function answerOnly(body: string, reply: ReplyView | undefined) {
  if (!reply) return body;
  const text = body.replace(LEGACY_FOOTER, '');
  if (text.trim() !== '') return text;
  return reply.state === 'failed'
    ? 'The run in T3 failed before writing a reply.'
    : 'The run in T3 was stopped before writing a reply.';
}
/**
 * Under an agent reply, only an exception is said: a run that failed or
 * stopped, or an answer that was shortened. What ran it is on the agent's
 * page, with the run.
 */
export function ReplyOrigin({ reply }: { reply: ReplyView | undefined }) {
  if (!reply) return null;
  const ending =
    reply.answered && reply.state !== 'succeeded'
      ? reply.state === 'failed'
        ? 'The run failed'
        : 'The run was stopped'
      : null;
  const said = [ending, reply.excerpt ? 'Shortened' : null].filter(Boolean);
  if (said.length === 0) return null;
  return <p className="reply-origin">{said.join(' · ')}</p>;
}
