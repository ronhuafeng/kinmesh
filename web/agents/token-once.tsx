import type { ReactNode } from 'react';
import type { Agent } from '../../src/domain/agents.js';
import { CopyButton } from '../shared/copy-button.js';

/** Shown once: the token lives only in this component until dismissed. */
export function TokenOnce({
  token,
  agent,
  where,
  onDismiss,
}: {
  token: string;
  agent: Agent;
  where: ReactNode;
  onDismiss: () => void;
}) {
  const file = JSON.stringify({ token }) + '\n';
  return (
    <div className="token-once" role="status">
      <p>
        <strong>现在就复制这个凭据。</strong>Kinmesh
        只保存它的哈希，之后无法再显示。
      </p>
      <code className="reference">{token}</code>
      <div className="token-actions">
        <CopyButton text={token} label="复制凭据" />
        <a
          className="button-link"
          download={`${agent.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-token.json`}
          href={
            'data:application/json;charset=utf-8,' + encodeURIComponent(file)
          }
        >
          下载凭据文件
        </a>
        <button type="button" className="quiet" onClick={onDismiss}>
          我已保存
        </button>
      </div>
      <p className="muted">{where}不要把它贴到聊天、日志或命令参数里。</p>
    </div>
  );
}
