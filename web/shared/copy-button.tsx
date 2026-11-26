import { useEffect, useState } from 'react';

/**
 * Copy with visible feedback, which a screen reader hears from a status
 * beside the button, always there; clipboard access can be refused.
 */
export function CopyButton({
  text,
  label,
  className = 'secondary',
}: {
  text: string;
  label: string;
  className?: string;
}) {
  const [done, setDone] = useState<'' | '已复制' | '复制失败'>('');
  // The word goes back after a moment, ready to copy again.
  useEffect(() => {
    if (done === '') return;
    const back = setTimeout(() => {
      setDone('');
    }, 2000);
    return () => {
      clearTimeout(back);
    };
  }, [done]);
  return (
    <>
      <button
        type="button"
        className={className}
        // Shown while it says what happened, wherever the pointer is.
        data-done={done ? 'true' : undefined}
        onClick={() => {
          navigator.clipboard.writeText(text).then(
            () => {
              setDone('已复制');
            },
            () => {
              setDone('复制失败');
            },
          );
        }}
      >
        {done || label}
      </button>
      <span className="visually-hidden" role="status">
        {done}
      </span>
    </>
  );
}
