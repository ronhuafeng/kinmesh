import { useId, isValidElement, cloneElement } from 'react';
import type { ReactNode } from 'react';

/** A labelled input; a hint is said in the input itself, as its placeholder. */
export function Field({
  label,
  hint,
  children,
}: {
  label: ReactNode;
  hint?: string;
  children: ReactNode;
}) {
  const id = useId();
  if (!isValidElement<{ id?: string; placeholder?: string }>(children))
    throw new Error('Field requires one input');
  return (
    <div className="field">
      <div className="field-label">
        <label htmlFor={id}>{label}</label>
      </div>
      {cloneElement(children, {
        id,
        ...(hint && !children.props.placeholder ? { placeholder: hint } : {}),
      })}
    </div>
  );
}
