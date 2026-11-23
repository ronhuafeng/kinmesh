import { type ReactNode } from 'react';

/**
 * One thing in a list (a person, a channel, an agent, a file): its face or
 * mark, its name over what to know, and what can be done at the end. The
 * row opens it when there is somewhere to go.
 */
export function ListRow({
  lead,
  title,
  detail,
  end,
  onOpen,
  quiet,
}: {
  lead: ReactNode;
  title: ReactNode;
  detail?: ReactNode;
  end?: ReactNode;
  onOpen?: () => void;
  /** Not current (a channel left): in the muted ink. */
  quiet?: boolean;
}) {
  const body = (
    <>
      {lead}
      <span className="list-row-text">
        <span className="list-row-title">{title}</span>
        {detail && <span className="list-row-detail">{detail}</span>}
      </span>
    </>
  );
  return (
    <li className="list-row" data-quiet={quiet ? 'true' : undefined}>
      {onOpen ? (
        <button type="button" className="list-row-main" onClick={onOpen}>
          {body}
        </button>
      ) : (
        <span className="list-row-main">{body}</span>
      )}
      {end && <span className="list-row-end">{end}</span>}
    </li>
  );
}
