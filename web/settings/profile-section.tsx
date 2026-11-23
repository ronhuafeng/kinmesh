import { useEffect, useState } from 'react';
import type { z } from 'zod';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { api } from '../shared/api.js';
import { Group } from '../shared/group.js';
import { Pill } from '../shared/pill.js';
import { Row } from '../shared/row.js';
import { Avatar } from '../shared/avatar.js';
import { Profile } from './sections.js';
import { Unread } from './unread.js';

export function ProfileSection({ data }: { data: WorkspaceSnapshot }) {
  const [profile, setProfile] = useState<z.infer<typeof Profile> | null>(null);
  const [failed, setFailed] = useState(false);
  const load = () => {
    setFailed(false);
    void api('/api/me/profile').then(
      (raw) => {
        setProfile(Profile.parse(raw));
      },
      () => {
        setFailed(true);
      },
    );
  };
  useEffect(load, []);
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
