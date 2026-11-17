import { useEffect, useState } from 'react';
import { z } from 'zod';
import { TeamFile } from '../src/domain/communication.js';
import type { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { api, useAction } from './api.js';
import { fileSize, inline } from './attachments.js';
import { FileIcon } from './icons.js';
import { memberName } from './names.js';
import { Notice } from './forms.js';
import { shortTime } from './ui.js';
import { ListRow } from './settings.js';

const Page = z.strictObject({
  items: z.array(TeamFile),
  next: z.number().int().nullable(),
});
type File = z.infer<typeof TeamFile>;
/**
 * The files of every channel you are in, newest first: what each is, who
 * shared it where and when. A row opens its message; 删除 removes the file
 * from the team, after a second press says so.
 */
export function Files({
  data,
  openMessage,
}: {
  data: WorkspaceSnapshot;
  openMessage: (channelId: string, messageId: string) => void;
}) {
  const path = `/api/teams/${data.team.id}/files`;
  const [files, setFiles] = useState<File[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [asked, setAsked] = useState<string | null>(null);
  const action = useAction({ 404: '这个文件已经不在了。' });
  // Read again whenever the workspace changes: a file shared or removed
  // anywhere shows here at once.
  useEffect(() => {
    let current = true;
    void api(path).then(
      (raw) => {
        if (!current) return;
        const page = Page.parse(raw);
        setFiles(page.items);
        setNext(page.next);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [path, data.revision]);
  if (files === null) return null;
  if (files.length === 0)
    return <p className="muted">频道里分享的文件会在这里。</p>;
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
        <button
          type="button"
          className="link-button"
          onClick={() => {
            void api(`${path}?before=${String(next)}`).then((raw) => {
              const page = Page.parse(raw);
              setFiles((old) => [...(old ?? []), ...page.items]);
              setNext(page.next);
            });
          }}
        >
          更早的文件
        </button>
      )}
      {action.error && <Notice>{action.error}</Notice>}
    </>
  );
}
