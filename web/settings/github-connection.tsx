import { useEffect, useState } from 'react';
import {
  GitHubManifest,
  GitHubStatus,
} from '../../src/domain/github-connection.js';
import { api, useRequest } from '../shared/api.js';
import { Group, Row } from '../shared/list.js';
import { Notice } from '../shared/forms.js';

/** GitHub sends the person back here with this when a step didn't finish. */
const failedHere = () =>
  new URLSearchParams(window.location.search).get('github') === 'failed';

/**
 * The team's GitHub: connected once, on GitHub's own pages (create, then
 * choose repositories), it shows whose repositories agents work in and
 * where to change them. Nothing here names how GitHub does it.
 */
export function GitHubConnection({ teamId }: { teamId: string }) {
  const [status, setStatus] = useState<GitHubStatus | null>(null);
  const [unread, setUnread] = useState(false);
  const action = useRequest();
  useEffect(() => {
    const controller = new AbortController();
    void api(`/api/teams/${teamId}/github`, { signal: controller.signal })
      .then((raw) => {
        setStatus(GitHubStatus.parse(raw));
      })
      .catch(() => {
        if (!controller.signal.aborted) setUnread(true);
      });
    return () => {
      controller.abort();
    };
  }, [teamId]);
  /** Posts the team's app to GitHub, which asks the person to create it. */
  const connect = () => {
    void action.send(`/api/teams/${teamId}/github/connect`, {}).then((raw) => {
      if (raw === undefined) return;
      const { action: to, manifest } = GitHubManifest.parse(raw);
      const form = document.createElement('form');
      form.method = 'post';
      form.action = to;
      const field = document.createElement('input');
      field.type = 'hidden';
      field.name = 'manifest';
      field.value = manifest;
      form.append(field);
      document.body.append(form);
      form.submit();
    });
  };
  return (
    <Group title="GitHub">
      {status?.state === 'installed' || status?.state === 'unreachable' ? (
        <>
          <Row label="账号">{status.account ?? '—'}</Row>
          <Row label="仓库">
            {status.state === 'unreachable' ? (
              <span className="muted">暂时读不到 GitHub</span>
            ) : (
              <span className="github-repositories">
                <span>
                  {status.repositories === null
                    ? '全部仓库'
                    : status.repositories
                        .map((name) => name.split('/')[1])
                        .join('、') + (status.more ? ' 等' : '')}
                </span>
                <a href={status.manageUrl} target="_blank" rel="noreferrer">
                  更改
                </a>
              </span>
            )}
          </Row>
        </>
      ) : (
        <Row label="仓库">
          {status?.state === 'created' ? (
            <a href={status.installUrl}>选择仓库</a>
          ) : status?.state === 'none' ? (
            <button
              type="button"
              className="link-button"
              disabled={action.disabled}
              onClick={connect}
            >
              连接 GitHub
            </button>
          ) : unread ? (
            <span className="muted">暂时读不到</span>
          ) : null}
        </Row>
      )}
      {(failedHere() || action.error) && (
        <Notice>{action.error || '没有连上 GitHub，再试一次。'}</Notice>
      )}
    </Group>
  );
}
