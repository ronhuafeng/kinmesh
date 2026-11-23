import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { TeamFile } from '../../src/domain/communication.js';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { api } from './api.js';
import { useAction } from './use-action.js';
import { fileSize } from '../../src/domain/attachments.js';
import { inline } from './attachments.js';
import { FileIcon } from './icons.js';
import { memberName } from './names.js';
import { Notice } from './notice.js';
import { shortTime } from './format.js';
import { ListRow } from './list-row.js';

const Page = z.strictObject({
  items: z.array(TeamFile),
  next: z.number().int().nullable(),
});
type File = z.infer<typeof TeamFile>;
/**
 * A fresh first page joined to what was already read: the page as it is
 * now, then the older files beyond it that were loaded before, each once.
 */
function joined(page: File[], old: File[] | null) {
  const ids = new Set(page.map((f) => f.attachment.id));
  const oldest = page.at(-1)?.createdAt;
  const older = (old ?? []).filter(
    (f) =>
      !ids.has(f.attachment.id) &&
      (oldest === undefined || f.createdAt < oldest),
  );
  return [...page, ...older];
}
/**
 * The files of every channel you are in, newest first: what each is, who
 * shared it where and when. A row opens its message; 删除 removes the file
 * from the team, after a second press says so.
 */
export function Files({
  data,
  channelId,
  openMessage,
}: {
  data: WorkspaceSnapshot;
  /** One channel's files (its 文件 view); without, every channel's. */
  channelId?: string;
  openMessage: (channelId: string, messageId: string) => void;
}) {
  const path =
    `/api/teams/${data.team.id}/files` +
    (channelId ? `?channelId=${channelId}` : '');
  const [files, setFiles] = useState<File[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [asked, setAsked] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // Older pages read so far for this list; a fresh first page keeps them.
  const older = useRef<{ path: string; read: boolean }>({ path, read: false });
  if (older.current.path !== path) older.current = { path, read: false };
  const action = useAction({ 404: '这个文件已经不在了。' });
  // Read again whenever the workspace changes: a file shared or removed
  // anywhere shows here at once, and older pages already read stay.
  useEffect(() => {
    let current = true;
    void api(path).then(
      (raw) => {
        if (!current) return;
        const page = Page.parse(raw);
        setFailed(false);
        setFiles((old) =>
          older.current.read ? joined(page.items, old) : page.items,
        );
        if (!older.current.read) setNext(page.next);
      },
      () => {
        if (current) setFailed(true);
      },
    );
    return () => {
      current = false;
    };
  }, [path, data.revision, attempt]);
  const readOlder = useCallback(() => {
    if (next === null) return;
    const from = path;
    void api(path + (channelId ? '&' : '?') + `before=${String(next)}`).then(
      (raw) => {
        // A page for a list no longer on screen is dropped.
        if (older.current.path !== from) return;
        const page = Page.parse(raw);
        older.current.read = true;
        setFailed(false);
        setFiles((old) => {
          const kept = old ?? [];
          const ids = new Set(kept.map((f) => f.attachment.id));
          return [
            ...kept,
            ...page.items.filter((f) => !ids.has(f.attachment.id)),
          ];
        });
        setNext(page.next);
      },
      () => {
        setFailed(true);
      },
    );
  }, [path, channelId, next]);
  const retry = (
    <Notice>
      读不到文件列表。
      <button
        type="button"
        className="link-button"
        onClick={() => {
          setAttempt((n) => n + 1);
        }}
      >
        再试一次
      </button>
    </Notice>
  );
  if (files === null) return failed ? retry : null;
  if (files.length === 0)
    return (
      <p className="muted">
        {channelId
          ? '这个频道里分享的文件会在这里。'
          : '频道里分享的文件会在这里。'}
      </p>
    );
  const channelName = (id: string) =>
    data.channels.items.find((c) => c.id === id)?.name ?? '频道';
  return (
    <>
      <ul className="list-rows" aria-label="文件">
        {files.map((f) => {
          const base = `/api/teams/${data.team.id}/channels/${f.channelId}/attachments/${f.attachment.id}`;
          const asking = asked === f.attachment.id;
          return (
            <ListRow
              key={f.attachment.id}
              lead={
                inline(f.attachment.type) ? (
                  <img
                    className="list-row-picture"
                    src={base}
                    alt=""
                    loading="lazy"
                    decoding="async"
                  />
                ) : (
                  <span className="list-row-picture">
                    <FileIcon size={20} />
                  </span>
                )
              }
              title={f.attachment.name}
              detail={[
                memberName({ kind: 'human', humanId: f.uploader }, data),
                '#' + channelName(f.channelId),
                shortTime(f.createdAt),
                fileSize(f.attachment.size),
              ].join(' · ')}
              onOpen={() => {
                openMessage(f.channelId, f.messageId);
              }}
              end={
                <button
                  type="button"
                  className="link-button"
                  data-danger={asking ? 'true' : undefined}
                  disabled={action.disabled}
                  onClick={() => {
                    if (!asking) {
                      setAsked(f.attachment.id);
                      return;
                    }
                    void action
                      .send(
                        `/api/teams/${data.team.id}/channels/${f.channelId}/attachments/${f.attachment.id}/remove`,
                        {},
                      )
                      .then((done) => {
                        if (!done) return;
                        setAsked(null);
                        setFiles((old) =>
                          (old ?? []).filter(
                            (o) => o.attachment.id !== f.attachment.id,
                          ),
                        );
                      });
                  }}
                  onBlur={() => {
                    if (asking) setAsked(null);
                  }}
                >
                  {asking ? '确认删除' : '删除'}
                </button>
              }
            />
          );
        })}
      </ul>
      {next !== null && (
        <button type="button" className="link-button" onClick={readOlder}>
          更早的文件
        </button>
      )}
      {failed && retry}
      {action.error && <Notice>{action.error}</Notice>}
    </>
  );
}
