import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { request } from '../shared/api.js';
import { useRequest } from '../shared/use-request.js';
import { Notice } from '../shared/notice.js';
import { plainText } from '../shared/markdown.js';
import { memberName } from '../shared/names.js';
import { ListRow } from '../shared/list-row.js';
import { Avatar } from '../shared/avatar.js';
import { shortTime } from '../shared/format.js';

/**
 * A channel's pinned messages, the latest pinned first: who wrote each,
 * how it starts and when; a row opens it in the conversation, and 取消置顶
 * lets it go.
 */
export function Pins({
  data,
  channelPath,
  openMessage,
  onDone,
}: {
  data: WorkspaceSnapshot;
  channelPath: string;
  openMessage: (channelId: string, messageId: string) => void;
  onDone: () => void;
}) {
  const action = useRequest();
  if (data.pinned.length === 0)
    return <p className="muted">这个频道还没有置顶的消息。</p>;
  return (
    <>
      <ul className="list-rows" aria-label="置顶的消息">
        {data.pinned.map(({ message: m }) => {
          const said =
            plainText(m.body) || m.attachments.map((a) => a.name).join('、');
          const who = memberName(m.author, data);
          return (
            <ListRow
              key={m.id}
              lead={
                <Avatar
                  kind={m.author.kind}
                  name={who}
                  id={
                    m.author.kind === 'human'
                      ? m.author.humanId
                      : m.author.agentId
                  }
                />
              }
              title={said.length > 80 ? said.slice(0, 77) + '…' : said}
              detail={who + ' · ' + shortTime(m.createdAt)}
              onOpen={() => {
                openMessage(m.channelId, m.id);
              }}
              end={
                <button
                  type="button"
                  className="link-button"
                  disabled={action.disabled}
                  onClick={() => {
                    void action
                      .run(() =>
                        request(`${channelPath}/messages/${m.id}/pin`, {
                          on: false,
                        }),
                      )
                      .then(onDone);
                  }}
                >
                  取消置顶
                </button>
              }
            />
          );
        })}
      </ul>
      {action.error && <Notice>{action.error}</Notice>}
    </>
  );
}
