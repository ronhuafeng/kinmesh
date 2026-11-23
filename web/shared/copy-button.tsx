import { useEffect, useState } from 'react';

/** Copy with visible feedback; clipboard access can be refused. */
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
    <button
      type="button"
      className={className}
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
  );
}
