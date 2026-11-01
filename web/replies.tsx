import type { WorkspaceSnapshot } from '../src/workspace/contracts.js';

export type ReplyView = WorkspaceSnapshot['replies'][number];
/** Provenance once appended to replies; kept readable for older messages. */
const LEGACY_FOOTER = /\s*\[T3 (?:succeeded|failed|stopped)[^\]]*\]\s*$/;

/** The text of a message as people should read it: the answer only. */
export function answerOnly(body: string, reply: ReplyView | undefined) {
  if (!reply) return body;
  const text = body.replace(LEGACY_FOOTER, '');
  if (text.trim() !== '') return text;
  return reply.state === 'failed'
    ? 'The run in T3 failed before writing a reply.'
    : 'The run in T3 was stopped before writing a reply.';
}
/** One quiet line under an agent reply: what ran it, and how it ended. */
export function ReplyOrigin({ reply }: { reply: ReplyView | undefined }) {
  if (!reply) return null;
  const ran = [reply.providerId, reply.modelId].filter(Boolean).join(' · ');
  const ending =
    reply.answered && reply.state !== 'succeeded'
      ? reply.state === 'failed'
        ? 'the run failed'
        : 'the run was stopped'
      : null;
  return (
    <div className="reply-origin">
      <span>
        via T3{ran ? ' · ' + ran : ''}
        {ending ? ' · ' + ending : ''}
        {reply.excerpt ? ' · shortened' : ''}
      </span>
      <details className="technical">
        <summary>Technical details</summary>
        <dl className="reference-list">
          <dt>Environment</dt>
          <dd>
            <code className="reference">{reply.environmentId}</code>
          </dd>
          <dt>Thread</dt>
          <dd>
            <code className="reference">{reply.threadId}</code>
          </dd>
          <dt>Run</dt>
          <dd>
            <code className="reference">{reply.runId}</code>
          </dd>
        </dl>
      </details>
    </div>
  );
}
