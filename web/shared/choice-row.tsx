import { useId } from 'react';

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
