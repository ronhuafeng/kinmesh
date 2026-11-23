import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { memberName } from '../shared/names.js';
import { plainText } from '../shared/markdown.js';
import { ChannelIcon } from '../shared/channel-icon.js';
import { Avatar } from '../shared/avatar.js';
import { listTime } from '../shared/format.js';

/** A channel on a phone's Home: its name and time, then "作者：正文". */
export function ChannelRow({
  data,
  channelId,
  name,
  person,
  latest,
  id,
}: {
  data: WorkspaceSnapshot;
  channelId: string;
  name: string;
  /** Who your own conversation is with, shown by their face. */
  person: string | undefined;
  latest: WorkspaceSnapshot['latest'][number] | undefined;
  id: string;
}) {
  return (
    <span className="channel-row">
      {person === undefined ? (
        <ChannelIcon id={channelId} name={name} />
      ) : (
        <Avatar kind="human" name={name} id={person} />
      )}
      <span className="channel-row-name">{name}</span>
      {latest && (
        <>
          <time className="channel-row-time" dateTime={latest.createdAt}>
            {listTime(latest.createdAt)}
          </time>
          <span className="channel-row-last" id={id}>
            {memberName(latest.author, data)}：{plainText(latest.excerpt)}
          </span>
        </>
      )}
    </span>
  );
}
