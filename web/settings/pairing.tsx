import { useEffect, useState } from 'react';
import type { z } from 'zod';
import { useRequest } from '../shared/use-request.js';
import { Notice } from '../shared/notice.js';
import { Row } from '../shared/row.js';
import { Paired } from './sections.js';

/**
 * A pairing code for this browser (or another) to reach the team's T3:
 * T3 asks for one before it lets a browser in, to approve a sign-in or open
 * a run. The code shows with the link that pairs at once, and how long it
 * lasts; a new one replaces it.
 */
export function Pairing({ teamId }: { teamId: string }) {
  const action = useRequest({ 409: '这个 T3 不能从这里配对。' });
  const [paired, setPaired] = useState<z.infer<typeof Paired> | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // The code says when it stops working, and goes once it has.
  useEffect(() => {
    if (paired === null) return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [paired]);
  const live = paired !== null && Date.parse(paired.expiresAt) > now;
  return (
    <>
      <Row label="配对码">
        <button
          type="button"
          className="link-button"
          disabled={action.disabled}
          onClick={() => {
            void action.send(`/api/teams/${teamId}/t3/pair`, {}).then((raw) => {
              if (raw === undefined) return;
              setPaired(Paired.parse(raw));
              setNow(Date.now());
            });
          }}
        >
          {live ? '换一个' : '生成配对码'}
        </button>
      </Row>
      {live && (
        <div className="pairing">
          <code className="pairing-code">{paired.token}</code>
          <span className="muted">
            {new Date(paired.expiresAt).toLocaleTimeString('zh-CN', {
              hour: '2-digit',
              minute: '2-digit',
            })}{' '}
            前有效
          </span>
          <a href={paired.url} target="_blank" rel="noreferrer">
            在 T3 中配对
          </a>
        </div>
      )}
      {action.error && <Notice>{action.error}</Notice>}
    </>
  );
}
