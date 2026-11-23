import { useEffect, useState } from 'react';
import type { z } from 'zod';
import type { Agent } from '../../src/domain/agents.js';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { useLive } from '../shared/live.js';
import { api, value } from '../shared/api.js';
import { Field } from '../shared/forms.js';
import { Notice } from '../shared/forms.js';
import { useSetupRequest } from '../shared/t3.js';
import { Providers } from '../shared/t3.js';
import { NextStep } from './setup-parts.js';

/** Pick what the agent runs on, as one choice: provider and model together. */
export function ChooseModel({
  agent,
  data,
  onDone,
  onCancel,
}: {
  agent: Agent;
  data: WorkspaceSnapshot;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const { send, busy, error, permitted } = useSetupRequest();
  const [offered, setOffered] = useState<
    z.infer<typeof Providers>['providers'] | 'unavailable' | null
  >(null);
  // T3 cannot say when its models change, so they are read again whenever
  // T3 is: on a new connection, Refresh now, or a network that comes back.
  const { reads } = useLive();
  useEffect(() => {
    void api(`/api/teams/${data.team.id}/t3/providers`)
      .then((raw) => {
        setOffered(
          Providers.parse(raw).providers.filter((p) => p.models.length > 0),
        );
      })
      .catch(() => {
        setOffered('unavailable');
      });
  }, [data.team.id, reads.t3]);
  const prefs = agent.preferences;
  const current =
    prefs.providerId && prefs.modelId
      ? prefs.providerId + '\n' + prefs.modelId
      : '';
  const title = `选择 ${agent.name} 使用的模型`;
  return (
    <NextStep title={title}>
      <form
        className="agent-connect"
        aria-label={title}
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const read = (key: string) => value(form, key).trim();
          const [providerId = '', modelId = ''] = read('model').includes('\n')
            ? read('model').split('\n')
            : [read('providerId'), read('modelId')];
          void send(`/api/teams/${data.team.id}/agents/${agent.id}/connect`, {
            providerId,
            modelId,
          }).then((ok) => {
            if (ok !== undefined) onDone();
          });
        }}
      >
        {offered === null ? (
          <p className="muted">正在询问 T3 能运行什么…</p>
        ) : offered === 'unavailable' ? (
          <p className="muted">现在连不上 T3。</p>
        ) : offered.length === 0 ? (
          <>
            <p className="muted">T3 没有列出模型，请按 T3 显示的名称填写。</p>
            <div className="field-row">
              <Field label="提供方">
                <input
                  name="providerId"
                  required
                  defaultValue={prefs.providerId ?? ''}
                />
              </Field>
              <Field label="模型">
                <input
                  name="modelId"
                  required
                  defaultValue={prefs.modelId ?? ''}
                />
              </Field>
            </div>
          </>
        ) : (
          <Field label="模型">
            <select
              name="model"
              required
              defaultValue={
                offered.some((p) =>
                  p.models.some((m) => p.id + '\n' + m === current),
                )
                  ? current
                  : undefined
              }
            >
              {offered.map((p) => (
                <optgroup key={p.id} label={p.id}>
                  {p.models.map((m) => (
                    <option key={m} value={p.id + '\n' + m}>
                      {m}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </Field>
        )}
        <div className="token-actions">
          <button
            type="submit"
            disabled={
              !permitted ||
              busy ||
              offered === null ||
              offered === 'unavailable' ||
              agent.lifecycle !== 'active'
            }
          >
            {busy ? '正在连接…' : `连接 ${agent.name}`}
          </button>
          {onCancel && (
            <button type="button" className="quiet" onClick={onCancel}>
              保持不变
            </button>
          )}
        </div>
      </form>
      {error && <Notice>{error}</Notice>}
    </NextStep>
  );
}
