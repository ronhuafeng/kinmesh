import { z } from 'zod';
import type { Scope, Agent } from '../../src/domain/agents.js';
import { ListedGrant, type Step } from '../shared/t3.js';
import { type ReactNode } from 'react';
import { CopyButton } from '../shared/copy-button.js';

/** Scopes the Inbox worker needs (docs/collaboration.md, Grants and scopes). */
export const WORKER_SCOPES: Scope[] = [
  'channels:read',
  'channels:write',
  'tasks:read',
  'tasks:write',
  'tasks:review',
  'executions:read',
  'executions:write',
];
/** What the agent's provider uses to work with the team through Team MCP. */
export const TEAM_MCP_SCOPES: Scope[] = [
  'channels:read',
  'channels:write',
  'tasks:read',
  'tasks:write',
  'tasks:review',
];
export const LIFETIME_DAYS = 30;
export const Issued = z.object({
  grant: ListedGrant.loose(),
  token: z.string(),
});
export function Row({
  step,
  title,
  children,
}: {
  step: Step;
  title: string;
  children?: ReactNode;
}) {
  return (
    <li className="setup-step" data-step={step}>
      <span className="setup-mark" aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        <span className="visually-hidden">
          {step === 'done'
            ? '（已完成）'
            : step === 'manual'
              ? '（在 Kinmesh 之外）'
              : '（待完成）'}
        </span>
        {children}
      </div>
    </li>
  );
}
/** One thing to do now: the only control on screen until it is done. */
export function NextStep({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="next-step" role="group" aria-label={title}>
      <strong>{title}</strong>
      {children}
    </div>
  );
}
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
