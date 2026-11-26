import { Group, Row, Pill, ChoiceRow } from '../shared/list.js';
import {
  SECTIONS,
  Profile,
  Sessions,
  Browsers,
  browserName,
  SHORTCUTS,
} from './sections.js';
import { Notice } from '../shared/forms.js';
import { useEffect, useState, useContext } from 'react';
import type { z } from 'zod';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { api, useRequest, MutationPermission } from '../shared/api.js';
import { Avatar } from '../shared/faces.js';
import { ago } from '../shared/format.js';
import { applyTheme, useTheme } from '../shared/theme.js';

/** A planned section: the rows it will hold, quiet, and that it is coming. */
export function Planned() {
  return (
    <div className="settings-planned">
      {SECTIONS.flatMap((s) =>
        s.planned
          ? [
              <Group key={s.id} title={s.label}>
                {s.planned.map((row) => (
                  <Row key={row} label={row}>
                    <span className="skeleton" aria-hidden="true" />
                  </Row>
                ))}
              </Group>,
            ]
          : [],
      )}
    </div>
  );
}
/** A read that failed: said where it would have shown, with a retry. */
export function Unread({ what, retry }: { what: string; retry: () => void }) {
  return (
    <Notice>
      读不到{what}。
      <button type="button" className="link-button" onClick={retry}>
        再试一次
      </button>
    </Notice>
  );
}
export function ProfileSection({ data }: { data: WorkspaceSnapshot }) {
  const [profile, setProfile] = useState<z.infer<typeof Profile> | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const load = () => {
    setFailed(false);
    setAttempt((n) => n + 1);
  };
  useEffect(() => {
    void api('/api/me/profile').then(
      (raw) => {
        setProfile(Profile.parse(raw));
      },
      () => {
        setFailed(true);
      },
    );
  }, [attempt]);
  return (
    <>
      <div className="settings-identity">
        <Avatar
          kind="human"
          name={data.human.name}
          id={data.human.id}
          size="xl"
        />
        <strong>{data.human.name}</strong>
        <Pill on>来自飞书</Pill>
      </div>
      <Group title="账号">
        <Row label="用户名">{profile?.username ?? data.human.username}</Row>
        <Row label="邮箱">{profile?.email ?? '—'}</Row>
        <Row label="团队">{profile?.team ?? data.team.name}</Row>
      </Group>
      {failed && <Unread what="账号信息" retry={load} />}
    </>
  );
}
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
  const [attempt, setAttempt] = useState(0);
  const load = () => {
    setFailed(false);
    setAttempt((n) => n + 1);
  };
  useEffect(() => {
    const failing = () => {
      setFailed(true);
    };
    void api('/api/me/sessions').then((raw) => {
      setSessions(Sessions.parse(raw));
    }, failing);
    void api('/api/push/browsers').then((raw) => {
      setBrowsers(Browsers.parse(raw));
    }, failing);
  }, [attempt]);
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
export function Appearance() {
  const theme = useTheme();
  return (
    <Group>
      <ChoiceRow
        label="配色"
        options={[
          { id: 'system', label: '跟随系统' },
          { id: 'light', label: '浅色' },
          { id: 'dark', label: '深色' },
        ]}
        value={theme}
        disabled={false}
        onChoose={(next) => {
          applyTheme(next);
        }}
      />
    </Group>
  );
}
export function Shortcuts() {
  const mod = /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘' : 'Ctrl';
  return (
    <Group>
      {SHORTCUTS(mod).map(([label, keys]) => (
        <Row key={label} label={label}>
          <kbd>{keys}</kbd>
        </Row>
      ))}
    </Group>
  );
}
/** Signing out, here or everywhere: quiet rows in the danger colour. */
export function SignOuts({
  onSignOut,
  onSignOutEverywhere,
}: {
  onSignOut: () => void;
  /** Ends every session of yours, on every device, this one included. */
  onSignOutEverywhere: () => void;
}) {
  // Out of reach, signing out waits like every other action.
  const permitted = useContext(MutationPermission);
  return (
    <Group title="退出">
      <div className="you-row you-row-danger">
        <button type="button" disabled={!permitted} onClick={onSignOut}>
          退出登录
        </button>
      </div>
      <div className="you-row you-row-danger">
        <button
          type="button"
          disabled={!permitted}
          onClick={onSignOutEverywhere}
        >
          在所有设备上退出登录
        </button>
      </div>
    </Group>
  );
}
