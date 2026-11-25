import type { Task } from '../../src/domain/tasks.js';
import type { ProofPiece } from '../../src/domain/task-proof.js';
import { pullRequestKey } from '../../src/domain/pull-requests.js';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { threadLink } from '../../src/workspace/links.js';
import { memberName, someoneOf } from '../shared/names.js';
import { cjk, shortTime } from '../shared/format.js';
import { MemberAvatar } from './members.js';
import { PullRequestLine } from './pull-requests.js';

/**
 * What the owner offered for one criterion when it last asked for review:
 * its own words beside its face, then each piece of proof as the thing
 * itself — a PR with what GitHub says of it, a T3 run, a message in the
 * conversation, an address. Nothing when it offered none.
 */
export function CriterionProof({
  task,
  criterion,
  data,
  onMessage,
}: {
  task: Task;
  criterion: string;
  data: WorkspaceSnapshot;
  /** Opens a message in the conversation. */
  onMessage: (messageId: string) => void;
}) {
  const proof = task.proof;
  const given = proof?.criteria.find((c) => c.criterion === criterion);
  if (!proof || !given) return null;
  return (
    <div className="criterion-proof">
      {given.words !== null && (
        <p className="criterion-words">
          <MemberAvatar member={someoneOf(proof.author)} data={data} />
          <span>{given.words}</span>
        </p>
      )}
      {given.pieces.length > 0 && (
        <ul>
          {given.pieces.map((piece, index) => (
            <li key={index}>
              <Piece piece={piece} data={data} onMessage={onMessage} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Piece({
  piece,
  data,
  onMessage,
}: {
  piece: ProofPiece;
  data: WorkspaceSnapshot;
  onMessage: (messageId: string) => void;
}) {
  switch (piece.kind) {
    case 'pull-request': {
      const key = pullRequestKey(piece.pullRequest);
      const link = data.taskPullRequests.find(
        (l) => pullRequestKey(l.pullRequest) === key,
      );
      const name = `${piece.pullRequest.repository}#${String(piece.pullRequest.number)}`;
      return link ? (
        <PullRequestLine link={link} now={Date.parse(data.observedAt)} />
      ) : (
        <a
          href={`https://github.com/${piece.pullRequest.repository}/pull/${String(piece.pullRequest.number)}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          {name}
        </a>
      );
    }
    case 'run': {
      const origin = data.nativeT3Origin;
      const href = origin ? threadLink(origin, piece.reference) : null;
      return (
        <>
          {href ? (
            <a href={href} target="_blank" rel="noopener noreferrer">
              T3 运行
            </a>
          ) : (
            'T3 运行'
          )}
          <time dateTime={piece.linkedAt}>{shortTime(piece.linkedAt)}</time>
        </>
      );
    }
    case 'message':
      return (
        <>
          <button
            type="button"
            className="link-button"
            onClick={() => {
              onMessage(piece.messageId);
            }}
          >
            {cjk(`${memberName(someoneOf(piece.author), data)} 的消息`)}
          </button>
          <time dateTime={piece.sentAt}>{shortTime(piece.sentAt)}</time>
        </>
      );
    case 'link': {
      const url = new URL(piece.url);
      return (
        <a href={piece.url} target="_blank" rel="noopener noreferrer">
          {url.host + (url.pathname === '/' ? '' : url.pathname)}
        </a>
      );
    }
  }
}
