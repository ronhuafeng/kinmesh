import { z } from 'zod';
import { Author } from '../../src/domain/agents.js';
import { TeamFile } from '../../src/domain/communication.js';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { api } from '../shared/api.js';
import { memberName } from '../shared/names.js';
import type { Remote } from '../search/command.js';

/** What the hub's search finds: messages and files, newest first. */
const SearchFound = z.object({
  messages: z.array(
    z.object({
      messageId: z.string(),
      channelId: z.string(),
      excerpt: z.string(),
      author: Author,
    }),
  ),
  files: z.array(TeamFile),
});
/** Messages and files the hub finds for what is typed in search. */
export function remoteSearch(
  data: WorkspaceSnapshot,
  openMessageIn: (channelId: string, messageId: string) => void,
): Remote {
  return async (query, signal) => {
    const found = SearchFound.parse(
      await api(
        `/api/teams/${data.team.id}/search?q=${encodeURIComponent(query)}`,
        { signal },
      ),
    );
    const where = (channelId: string) =>
      '#' +
      (data.channels.items.find((c) => c.id === channelId)?.name ?? '频道');
    return [
      ...found.messages.map((m) => ({
        id: 'message-' + m.messageId,
        group: '消息',
        label: m.excerpt,
        hint: memberName(m.author, data) + ' · ' + where(m.channelId),
        run: () => {
          openMessageIn(m.channelId, m.messageId);
        },
      })),
      ...found.files.map((f) => ({
        id: 'file-' + f.attachment.id,
        group: '文件',
        label: f.attachment.name,
        hint: where(f.channelId),
        run: () => {
          openMessageIn(f.channelId, f.messageId);
        },
      })),
    ];
  };
}
