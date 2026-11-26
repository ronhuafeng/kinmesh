import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { ListRow, Pill, Group, Row } from '../shared/list.js';
import { Avatar, Presence, ChannelIcon } from '../shared/faces.js';
import { ActionForm, Notice } from '../shared/forms.js';
import { LEVEL_LABELS, levelOf } from '../shared/levels.js';
import { workerConnected } from '../shared/format.js';
import { useState, useEffect } from 'react';
import { useRequest } from '../shared/api.js';
import { MODE_NAMES, t3Where, useT3 } from '../shared/t3.js';
import type { z } from 'zod';
import { Paired } from './sections.js';
import { GitHubConnection } from './github-connection.js';

/**
 * The people of the team by name. A handle shows only where two share a
 * name, to tell them apart; you are marked 你, and the others show whether
 * they are here.
 */
export function Members({ data }: { data: WorkspaceSnapshot }) {
  const named = new Map<string, number>();
  for (const p of data.people) named.set(p.name, (named.get(p.name) ?? 0) + 1);
  return (
    <ul className="list-rows" aria-label="成员">
      {data.people.map((person) => {
        const you = person.id === data.human.id;
        return (
          <ListRow
            key={person.id}
            lead={
              <Avatar
                kind="human"
                name={person.name}
                id={person.id}
                size="md"
              />
            }
            title={
              <>
                {person.name}
                {you && (
                  <>
                    {' '}
                    <Pill>你</Pill>
                  </>
                )}
              </>
            }
            detail={
              (named.get(person.name) ?? 0) > 1 ? person.username : undefined
            }
            end={you ? undefined : <Presence online={person.online} dot />}
          />
        );
      })}
    </ul>
  );
}
export function Channels({
  data,
  openChannel,
}: {
  data: WorkspaceSnapshot;
  openChannel: (id: string) => void;
}) {
  const joined = (
    <ul className="list-rows" aria-label="已加入的频道">
      {data.channels.items.map((c) => {
        const level = levelOf(data, c.id);
        return (
          <ListRow
            key={c.id}
            lead={<ChannelIcon id={c.id} name={c.name} />}
            title={
              <>
                {c.name}
                {level !== 'default' && (
                  <>
                    {' '}
                    <Pill>{LEVEL_LABELS[level]}</Pill>
                  </>
                )}
              </>
            }
            onOpen={() => {
              openChannel(c.id);
            }}
          />
        );
      })}
    </ul>
  );
  // Channels you left, and archived ones, are groups of their own; with
  // neither, one list.
  if (data.leftChannels.length === 0 && data.archivedChannels.length === 0)
    return joined;
  return (
    <>
      <Group title="已加入">{joined}</Group>
      {data.archivedChannels.length > 0 && (
        <Group title="已归档">
          <ul className="list-rows" aria-label="已归档的频道">
            {data.archivedChannels.map((c) => (
              <ListRow
                key={c.id}
                quiet
                lead={<ChannelIcon id={c.id} name={c.name} />}
                title={c.name}
                onOpen={() => {
                  openChannel(c.id);
                }}
                end={
                  <ActionForm
                    title={'恢复 ' + c.name}
                    path={`/api/teams/${data.team.id}/channels/${c.id}/archive`}
                    build={() => ({ archived: false })}
                    submit="恢复"
                    onDone={() => {
                      openChannel(c.id);
                    }}
                  />
                }
              />
            ))}
          </ul>
        </Group>
      )}
      {data.leftChannels.length > 0 && (
        <Group title="已退出">
          <ul className="list-rows" aria-label="已退出的频道">
            {data.leftChannels.map((c) => (
              <ListRow
                key={c.id}
                quiet
                lead={<ChannelIcon id={c.id} name={c.name} />}
                title={c.name}
                end={
                  <ActionForm
                    title={'重新加入 ' + c.name}
                    path={`/api/teams/${data.team.id}/channels/${c.id}/subscribe`}
                    build={() => ({})}
                    submit="重新加入"
                    onDone={() => {
                      openChannel(c.id);
                    }}
                  />
                }
              />
            ))}
          </ul>
        </Group>
      )}
    </>
  );
}
export function Agents({
  data,
  openAgent,
}: {
  data: WorkspaceSnapshot;
  openAgent: (id: string) => void;
}) {
  return (
    <ul className="list-rows" aria-label="智能体">
      {data.agents.map((agent) => {
        const managed = data.managed.some((m) => m.agentId === agent.id);
        const awake = workerConnected(data.wake, agent.id);
        return (
          <ListRow
            key={agent.id}
            lead={
              <Avatar kind="agent" name={agent.name} id={agent.id} size="md" />
            }
            title={agent.name}
            detail={[
              agent.preferences.modelId,
              managed ? '由 Kinmesh 运行' : awake ? '由你运行' : '未运行',
            ]
              .filter(Boolean)
              .join(' · ')}
            end={<Presence online={awake} dot />}
            onOpen={() => {
              openAgent(agent.id);
            }}
          />
        );
      })}
    </ul>
  );
}
export function Connections({ data }: { data: WorkspaceSnapshot }) {
  const t3 = useT3(data.team.id);
  const connection = t3.status?.connection ?? null;
  const where = connection && t3Where(connection);
  const action = useRequest({
    409: '你还没有用飞书登录过。',
    502: '飞书机器人发不出消息：检查应用的机器人能力和发消息权限。',
  });
  const [sent, setSent] = useState(false);
  return (
    <>
      <Group title="T3">
        <Row label="地址">
          {where ? where.host : <span className="muted">未连接</span>}
        </Row>
        {connection && (
          <>
            <Row label="运行方式">
              {connection.access === 'read'
                ? '只读'
                : connection.ceiling
                  ? MODE_NAMES[connection.ceiling]
                  : '—'}
            </Row>
            <Row label="登录">
              {connection.expired ? (
                <span className="danger-text">已到期</span>
              ) : (
                '有效'
              )}
            </Row>
            {t3.status?.pairing && <Pairing teamId={data.team.id} />}
          </>
        )}
      </Group>
      <GitHubConnection teamId={data.team.id} />
      <Group title="飞书">
        <Row label="机器人">
          <button
            type="button"
            className="link-button"
            disabled={action.disabled}
            onClick={() => {
              void action.send('/api/feishu/test', {}).then((done) => {
                if (done !== undefined) setSent(true);
              });
            }}
          >
            {sent ? '已发送，去飞书看看' : '给我发一条测试消息'}
          </button>
        </Row>
      </Group>
      {action.error && <Notice>{action.error}</Notice>}
    </>
  );
}
/**
 * A pairing code for this browser (or another) to reach the team's T3:
 * T3 asks for one before it lets a browser in, to approve a sign-in or open
 * a run. The code shows with the link that pairs at once, and how long it
 * lasts; a new one replaces it.
 */
export function Pairing({ teamId }: { teamId: string }) {
  const action = useRequest({ 409: '这个 T3 不能从这里配对。' });
  const [paired, setPaired] = useState<z.infer<typeof Paired> | null>(null);
  // The code says when it stops working, and goes once it has: one timer,
  // at that moment.
  useEffect(() => {
    if (paired === null) return;
    const timer = setTimeout(
      () => {
        setPaired(null);
      },
      Math.min(Date.parse(paired.expiresAt) - Date.now(), 2 ** 31 - 1),
    );
    return () => {
      clearTimeout(timer);
    };
  }, [paired]);
  const live = paired !== null;
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
