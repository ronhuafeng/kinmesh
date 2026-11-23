import { PlusIcon } from './icons.js';

/** A "+" that starts something new beside the list it belongs to. */
export function AddButton({
  label,
  onClick,
  className = '',
}: {
  label: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={'quiet icon-button add-button ' + className}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <PlusIcon />
    </button>
  );
}
