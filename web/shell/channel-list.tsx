import { AddButton } from '../shared/add-button.js';
import { Avatar } from '../shared/avatar.js';
import { ChannelIcon } from '../shared/channel-icon.js';
import { ChannelMenu } from './channel-menu.js';
import { ChannelRow } from './channel-row.js';
import { ChannelTopics } from '../chat/topics.js';
import { Fragment, useState } from 'react';
import { InlineField } from '../shared/inline-field.js';
import { JoinableChannels } from './joinable-channels.js';
import { SettingsIcons } from '../shared/icons.js';
import { byActivity } from './by-activity.js';
import { levelOf } from '../shared/levels.js';
import { useShell } from './shell.js';

/**
 * The channels you are in, a new one written in place, the ones you may
 * join, and more when there are more.
 */
export function ChannelList() {
  const {
    data,
    phone,
    selection,
    setSelection,
    setView,
    setCursors,
    next,
    selectChannel,
    leavePage,
    channel,
    channelPath,
    directWith,
    tabValue,
    screen,
    looking,
    waitingIn,
    leaveChannelById,
    notify,
    refresh,
  } = useShell();
  const [addingChannel, setAddingChannel] = useState(false);
  // The channel being named again, in place in its row.
  const [renaming, setRenaming] = useState<string | null>(null);
  return (
    <>
      <nav aria-label="频道">
        <div className="nav-heading">
          <h2>频道</h2>
          <AddButton
            label="新建频道"
            onClick={() => {
              setAddingChannel(true);
            }}
          />
        </div>
        {(phone
          ? byActivity(data.channels.items, data.latest)
          : data.channels.items
        ).map((c) => (
          <Fragment key={c.id}>
            {renaming === c.id && channelPath !== null ? (
              <InlineField
                name="name"
                label="频道名称"
                placeholder="频道名称"
                maxLength={80}
                path={`/api/teams/${data.team.id}/channels/${c.id}/rename`}
                initial={c.name}
                taken="这个名称已被占用"
                onClose={() => {
                  setRenaming(null);
                }}
                onCreated={() => {
                  refresh();
                }}
              />
            ) : (
              <ChannelMenu
                data={data}
                channelId={c.id}
                channelName={c.name}
                onLeave={leaveChannelById}
                onFailed={notify}
                onRename={setRenaming}
                onArchived={(id) => {
                  if (id === channel?.id) selectChannel('');
                  refresh();
                }}
              >
                <button
                  // On a phone the row also shows the newest message,
                  // which describes it rather than naming it.
                  {...(phone
                    ? {
                        'aria-label': c.name,
                        'aria-describedby': 'latest-' + c.id,
                      }
                    : {})}
                  data-muted={
                    levelOf(data, c.id) === 'mute' ? 'true' : undefined
                  }
                  data-unread={
                    data.latest.find((l) => l.channelId === c.id)?.unread
                      ? 'true'
                      : undefined
                  }
                  aria-current={
                    // Only one place is current: a channel while you are
                    // in its chat or board.
                    channel?.id === c.id &&
                    (tabValue === 'chat' || tabValue === 'board') &&
                    !(phone && screen === 'home')
                      ? 'page'
                      : undefined
                  }
                  onClick={() => {
                    selectChannel(c.id);
                  }}
                >
                  {phone ? (
                    <ChannelRow
                      data={data}
                      channelId={c.id}
                      name={c.name}
                      person={directWith.get(c.id)}
                      latest={data.latest.find((l) => l.channelId === c.id)}
                      id={'latest-' + c.id}
                    />
                  ) : (
                    <>
                      {directWith.has(c.id) ? (
                        <Avatar
                          kind="human"
                          name={c.name}
                          id={directWith.get(c.id) ?? ''}
                          size="sm"
                        />
                      ) : (
                        <ChannelIcon id={c.id} name={c.name} />
                      )}
                      <span className="channel-name" title={c.name}>
                        {c.name}
                      </span>
                    </>
                  )}
                  {/* You follow it: every message notifies you. */}
                  {levelOf(data, c.id) === 'follow' && (
                    <span className="channel-follow" title="每条消息都通知你">
                      <SettingsIcons.bell size={16} />
                    </span>
                  )}
                  {/* Something in this channel waits on you; once
                              nothing does, the dot fades out. */}
                  <span
                    className="waiting-dot"
                    data-on={waitingIn.has(c.id) ? 'true' : undefined}
                    {...(waitingIn.has(c.id)
                      ? { title: '等你处理' }
                      : { 'aria-hidden': true })}
                  >
                    {waitingIn.has(c.id) && (
                      <span className="visually-hidden">等你处理</span>
                    )}
                  </span>
                </button>
              </ChannelMenu>
            )}
            {channel?.id === c.id && channelPath && (
              <ChannelTopics
                data={data}
                channelPath={channelPath}
                topic={selection.topic}
                current={tabValue === 'chat' || tabValue === 'board'}
                onTopic={(topic) => {
                  leavePage();
                  setView('chat');
                  setSelection((old) => ({ ...old, topic }));
                  setCursors({});
                }}
                next={next}
              />
            )}
          </Fragment>
        ))}
        {addingChannel && (
          <InlineField
            name="name"
            label="频道名称"
            placeholder="频道名称"
            maxLength={80}
            path={`/api/teams/${data.team.id}/channels`}
            className="channel-new"
            taken="这个名称已被占用"
            onClose={() => {
              setAddingChannel(false);
            }}
            // The channel just made is where you meant to go.
            onCreated={selectChannel}
            // Open to the team unless someone makes it private.
            extra={{ visibility: 'public' }}
          />
        )}
        {/* Channels you left, only when there are any: one click back. */}
        <JoinableChannels
          teamId={data.team.id}
          channels={[...data.publicChannels, ...data.leftChannels]}
          current={looking && channel ? channel.id : null}
          onOpen={selectChannel}
          onDone={selectChannel}
        />
      </nav>
      {data.channels.nextCursor && (
        <button
          className="quiet"
          onClick={() => {
            next('channelsCursor', data.channels.nextCursor);
          }}
        >
          更多频道
        </button>
      )}
    </>
  );
}
