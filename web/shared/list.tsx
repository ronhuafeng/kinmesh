import { type ReactNode, useId } from 'react';

/**
 * A row with its choice at the end: the segmented control. `title` says on
 * hover what the row does, when its label alone may not.
 */
/**
 * A settings group: a small heading over its rows, which hairlines divide.
 * A page of one group has no heading; the map already names it.
 */
export function Group({
  title,
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <section className="settings-group" aria-label={title}>
      {title && <h2 className="settings-group-title">{title}</h2>}
      {children}
    </section>
  );
}
/** A state beside what it is about: on (green, with a dot) or quiet. */
export function Pill({
  on = false,
  children,
}: {
  on?: boolean;
  children: ReactNode;
}) {
  return (
    <span className="state-pill" data-tone={on ? 'on' : undefined}>
      {children}
    </span>
  );
}
/** One row: its label, then its value or control at the column's end. */
export function Row({
  label,
  children,
}: {
  label: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="you-row">
      <span className="you-row-label">{label}</span>
      <span className="you-row-end">{children}</span>
    </div>
  );
}
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
export function ChoiceRow<T extends string>({
  label,
  title,
  options,
  value,
  disabled,
  onChoose,
}: {
  label: string;
  title?: string;
  options: readonly { id: T; label: string; title?: string }[];
  value: T;
  disabled: boolean;
  onChoose: (id: T) => void;
}) {
  const id = useId();
  return (
    <div className="you-row">
      <span id={id} {...(title ? { title } : {})}>
        {label}
      </span>
      <div className="segmented" role="group" aria-labelledby={id}>
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            aria-pressed={value === o.id}
            disabled={disabled}
            {...(o.title ? { title: o.title } : {})}
            onClick={() => {
              if (o.id !== value) onChoose(o.id);
            }}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
