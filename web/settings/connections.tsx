import { useState } from 'react';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { useRequest } from '../shared/use-request.js';
import { Notice } from '../shared/notice.js';
import { Group } from '../shared/group.js';
import { Row } from '../shared/row.js';
import { MODE_NAMES, t3Where } from '../shared/t3.js';
import { useT3 } from '../shared/use-t3.js';
import { Pairing } from './pairing.js';

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
