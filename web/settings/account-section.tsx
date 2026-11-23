import { useEffect, useState } from 'react';
import type { z } from 'zod';
import { api } from '../shared/api.js';
import { useRequest } from '../shared/use-request.js';
import { Notice } from '../shared/notice.js';
import { Group } from '../shared/group.js';
import { Pill } from '../shared/pill.js';
import { Row } from '../shared/row.js';
import { SignOuts } from './sign-outs.js';
import { ago } from '../shared/format.js';
import { Sessions, Browsers, browserName } from './sections.js';
import { Unread } from './unread.js';

export function AccountSection({
  onSignOut,
  onSignOutEverywhere,
}: {
  onSignOut: () => void;
  onSignOutEverywhere: () => void;
}) {
  const action = useRequest();
  const [sessions, setSessions] = useState<z.infer<typeof Sessions>>([]);
  const [browsers, setBrowsers] = useState<z.infer<typeof Browsers>>([]);
  const [failed, setFailed] = useState(false);
  const load = () => {
    setFailed(false);
    const failing = () => {
      setFailed(true);
    };
    void api('/api/me/sessions').then((raw) => {
      setSessions(Sessions.parse(raw));
    }, failing);
    void api('/api/push/browsers').then((raw) => {
      setBrowsers(Browsers.parse(raw));
    }, failing);
  };
  useEffect(load, []);
  const end = (path: string, id: string) =>
    void action.send(path, { id }).then((done) => {
      if (done !== undefined) load();
    });
  return (
    <>
      {failed && <Unread what="登录的设备" retry={load} />}
      <Group title="登录的设备">
        {sessions.map((s) => (
          <Row
            key={s.id}
            label={
              s.current ? (
                <>
                  此浏览器 <Pill on>正在使用</Pill>
                </>
              ) : (
                `${ago(s.createdAt)}登录`
              )
            }
          >
            {s.current ? null : (
              <>
                <span className="muted">{ago(s.lastSeenAt)}用过</span>
                <button
                  type="button"
                  className="link-button"
                  disabled={action.disabled}
                  onClick={() => {
                    end('/api/me/session/end', s.id);
                  }}
                >
                  退出
                </button>
              </>
            )}
          </Row>
        ))}
      </Group>
      {browsers.length > 0 && (
        <Group title="接收通知的浏览器">
          {browsers.map((b) => (
            <Row key={b.id} label={`${browserName(b.service)} 接收通知`}>
              <button
                type="button"
                className="link-button"
                disabled={action.disabled}
                onClick={() => {
                  end('/api/push/forget', b.id);
                }}
              >
                移除
              </button>
            </Row>
          ))}
        </Group>
      )}
      {action.error && <Notice>{action.error}</Notice>}
      <SignOuts
        onSignOut={onSignOut}
        onSignOutEverywhere={onSignOutEverywhere}
      />
    </>
  );
}
