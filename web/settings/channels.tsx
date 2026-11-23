import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { ActionForm } from '../shared/action-form.js';
import { Group } from '../shared/group.js';
import { ListRow } from '../shared/list-row.js';
import { Pill } from '../shared/pill.js';
import { LEVEL_LABELS, levelOf } from '../shared/levels.js';
import { ChannelIcon } from '../shared/channel-icon.js';

export function Channels({
  data,
  openChannel,
}: {
  data: WorkspaceSnapshot;
  openChannel: (id: string) => void;
}) {
  const joined = (
    <ul className="list-rows" aria-label="已加入的频道">
      {data.channels.items.map((c) => {
        const level = levelOf(data, c.id);
        return (
          <ListRow
            key={c.id}
            lead={<ChannelIcon id={c.id} name={c.name} />}
            title={
              <>
                {c.name}
                {level !== 'default' && (
                  <>
                    {' '}
                    <Pill>{LEVEL_LABELS[level]}</Pill>
                  </>
                )}
              </>
            }
            onOpen={() => {
              openChannel(c.id);
            }}
          />
        );
      })}
    </ul>
  );
  // Channels you left, and archived ones, are groups of their own; with
  // neither, one list.
  if (data.leftChannels.length === 0 && data.archivedChannels.length === 0)
    return joined;
  return (
    <>
      <Group title="已加入">{joined}</Group>
      {data.archivedChannels.length > 0 && (
        <Group title="已归档">
          <ul className="list-rows" aria-label="已归档的频道">
            {data.archivedChannels.map((c) => (
              <ListRow
                key={c.id}
                quiet
                lead={<ChannelIcon id={c.id} name={c.name} />}
                title={c.name}
                onOpen={() => {
                  openChannel(c.id);
                }}
                end={
                  <ActionForm
                    title={'恢复 ' + c.name}
                    path={`/api/teams/${data.team.id}/channels/${c.id}/archive`}
                    build={() => ({ archived: false })}
                    submit="恢复"
                    onDone={() => {
                      openChannel(c.id);
                    }}
                  />
                }
              />
            ))}
          </ul>
        </Group>
      )}
      {data.leftChannels.length > 0 && (
        <Group title="已退出">
          <ul className="list-rows" aria-label="已退出的频道">
            {data.leftChannels.map((c) => (
              <ListRow
                key={c.id}
                quiet
                lead={<ChannelIcon id={c.id} name={c.name} />}
                title={c.name}
                end={
                  <ActionForm
                    title={'重新加入 ' + c.name}
                    path={`/api/teams/${data.team.id}/channels/${c.id}/subscribe`}
                    build={() => ({})}
                    submit="重新加入"
                    onDone={() => {
                      openChannel(c.id);
                    }}
                  />
                }
              />
            ))}
          </ul>
        </Group>
      )}
    </>
  );
}
