import type { ReplyView } from '../shared/replies.js';

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
