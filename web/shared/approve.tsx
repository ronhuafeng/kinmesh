import { useRequest } from './use-request.js';
import { value } from './api.js';
import { Field } from './field.js';
import { Notice } from './notice.js';

/**
 * A sign-in under way: the approval opens in T3. When T3's approval ends on
 * the person's own computer, its address is pasted here to finish.
 */
export function Approve({
  teamId,
  url,
  pasteCallback,
  agentName,
  reload,
}: {
  teamId: string;
  url: string;
  pasteCallback: boolean;
  agentName: string;
  reload: () => void;
}) {
  const pasted = useRequest({
    400: '这不是这次批准打开的地址。',
    409: '这已不适用，面板显示了变化。',
  });
  return (
    <div className="approve">
      <a
        className="button-link"
        href={url}
        target="_blank"
        rel="noopener noreferrer"
      >
        在 T3 中批准 ↗
      </a>
      <span className="muted" role="status">
        等待你批准…
      </span>
      <ul className="approve-hints">
        <li>
          选择 {agentName} 的运行方式：<strong>监督</strong>、
          <strong>自动</strong>或<strong>完全访问</strong>。
        </li>
        <li>
          需要配对码？在 {new URL(url).host} 的 Settings → Sharing &amp; access
          中创建。
        </li>
      </ul>
      {pasteCallback && (
        <form
          className="t3-connect"
          onSubmit={(event) => {
            event.preventDefault();
            const address = value(new FormData(event.currentTarget), 'url');
            void pasted
              .send(`/api/teams/${teamId}/t3/callback`, { url: address })
              .then((raw) => {
                if (raw !== undefined) reload();
              });
          }}
        >
          <Field label="批准后的地址">
            <input
              name="url"
              type="url"
              required
              autoComplete="off"
              placeholder="http://127.0.0.1:49871/callback?…"
            />
          </Field>
          <div className="token-actions">
            <button type="submit" disabled={!pasted.permitted || pasted.busy}>
              {pasted.busy ? '正在完成…' : '完成'}
            </button>
          </div>
        </form>
      )}
      {pasted.error && <Notice>{pasted.error}</Notice>}
    </div>
  );
}
