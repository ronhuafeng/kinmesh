import type { WorkspaceSnapshot } from '../src/workspace/contracts.js';

export type ReplyView = WorkspaceSnapshot['replies'][number];
/**
 * Provenance once appended to agent replies; stripped wherever a reply is
 * read or becomes a task, so older messages read as answers.
 */
export const LEGACY_FOOTER = /\s*\[T3 (?:succeeded|failed|stopped)[^\]]*\]\s*$/;

/** A run that ended without an answer, said as its outcome. */
const NO_ANSWER = {
  failed: '还没回复就失败了。',
  stopped: '还没回复就停止了。',
};
/** Notices stored in English before the interface spoke Chinese. */
const ENGLISH_NOTICE =
  /^The run in T3 (failed|was stopped) before writing a reply\.$/;
/** The text of a message as people should read it: the answer only. */
export function answerOnly(body: string, reply: ReplyView | undefined) {
  if (!reply) return body;
  const text = body.replace(LEGACY_FOOTER, '');
  const english = ENGLISH_NOTICE.exec(text.trim());
  if (english)
    return english[1] === 'failed' ? NO_ANSWER.failed : NO_ANSWER.stopped;
  if (text.trim() !== '') return text;
  return reply.state === 'failed' ? NO_ANSWER.failed : NO_ANSWER.stopped;
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
        ? '运行失败'
        : '运行已停止'
      : null;
  const said = [ending, reply.excerpt ? '内容有删减' : null].filter(Boolean);
  if (said.length === 0) return null;
  return <p className="reply-origin">{said.join(' · ')}</p>;
}
