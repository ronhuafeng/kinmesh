import * as ContextMenu from '@radix-ui/react-context-menu';
import { useState, type ReactNode } from 'react';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { request } from '../shared/api.js';
import { SettingsIcons } from '../shared/icons.js';
import { ChannelLevel } from '../../src/domain/notify.js';
import { LEVEL_LABELS, levelOf, setLevel } from '../shared/levels.js';

/**
 * A channel's own menu, on its row in the sidebar (right-click, or a long
 * press on a phone): how loud it is for you, and leaving it.
 */
export function ChannelMenu({
  data,
  channelId,
  channelName,
  onLeave,
  onFailed,
  onRename,
  onArchived,
  children,
}: {
  data: WorkspaceSnapshot;
  channelId: string;
  channelName: string;
  onLeave: (channelId: string) => void;
  /** Says an action didn't happen, where the person will see it. */
  onFailed: (message: string) => void;
  /** Names the channel again, in place in its row. */
  onRename: (channelId: string) => void;
  onArchived: (channelId: string) => void;
  children: ReactNode;
}) {
  const level = levelOf(data, channelId);
  // Two people's own conversation is theirs as it is: no name to change,
  // nobody to open it to, nothing to archive.
  const direct = data.direct.some((d) => d.channelId === channelId);
  // Archiving takes a second press, which says what it does.
  const [archiving, setArchiving] = useState(false);
  const visibility =
    data.channels.items.find((c) => c.id === channelId)?.visibility ??
    'private';
  // Opening a channel to the whole team takes a second press.
  const [opening, setOpening] = useState(false);
  return (
    <ContextMenu.Root
      onOpenChange={() => {
        setOpening(false);
        setArchiving(false);
      }}
    >
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="menu" collisionPadding={8}>
          <p className="menu-state">
            {direct ? channelName : '#' + channelName}
          </p>
          <ContextMenu.RadioGroup
            value={level}
            onValueChange={(value) => {
              const next = ChannelLevel.safeParse(value);
              if (next.success)
                void setLevel(data.team.id, channelId, next.data).catch(() => {
                  onFailed('没能改好，请再试一次。');
                });
            }}
          >
            {/* Loudest first. */}
            {(['follow', 'default', 'mute'] as const).map((option) => (
              <ContextMenu.RadioItem
                key={option}
                value={option}
                className="menu-item"
              >
                <span className="menu-icon">
                  {option === 'follow' ? (
                    <SettingsIcons.bell size={16} />
                  ) : option === 'mute' ? (
                    <SettingsIcons.moon size={16} />
                  ) : null}
                </span>
                <span className="menu-label">{LEVEL_LABELS[option]}</span>
                <ContextMenu.ItemIndicator className="menu-check">
                  <SettingsIcons.check size={16} />
                </ContextMenu.ItemIndicator>
              </ContextMenu.RadioItem>
            ))}
          </ContextMenu.RadioGroup>
          <ContextMenu.Separator className="menu-separator" />
          {!direct && (
            <>
              <ContextMenu.Item
                className="menu-item"
                onSelect={(event) => {
                  if (visibility === 'private' && !opening) {
                    event.preventDefault();
                    setOpening(true);
                    return;
                  }
                  void request(
                    `/api/teams/${data.team.id}/channels/${channelId}/visibility`,
                    {
                      operationKey: crypto.randomUUID(),
                      visibility:
                        visibility === 'private' ? 'public' : 'private',
                    },
                  ).catch(() => {
                    onFailed('没能改好，请再试一次。');
                  });
                }}
              >
                <span className="menu-icon">
                  {visibility === 'private' ? (
                    <SettingsIcons.globe size={16} />
                  ) : (
                    <SettingsIcons.lock size={16} />
                  )}
                </span>
                <span className="menu-label">
                  {visibility === 'public'
                    ? '设为私密'
                    : opening
                      ? '确认：团队里所有人都能查看'
                      : '设为公开…'}
                </span>
              </ContextMenu.Item>
              <ContextMenu.Item
                className="menu-item"
                onSelect={() => {
                  onRename(channelId);
                }}
              >
                <span className="menu-icon">
                  <SettingsIcons.pencil size={16} />
                </span>
                <span className="menu-label">重命名…</span>
              </ContextMenu.Item>
              <ContextMenu.Item
                className="menu-item"
                onSelect={(event) => {
                  if (!archiving) {
                    event.preventDefault();
                    setArchiving(true);
                    return;
                  }
                  void request(
                    `/api/teams/${data.team.id}/channels/${channelId}/archive`,
                    { operationKey: crypto.randomUUID(), archived: true },
                  ).then(
                    () => {
                      onArchived(channelId);
                    },
                    () => {
                      onFailed('没能归档，请再试一次。');
                    },
                  );
                }}
              >
                <span className="menu-icon">
                  <SettingsIcons.archive size={16} />
                </span>
                <span className="menu-label">
                  {archiving
                    ? '确认：从列表移走，仍可查看和搜索'
                    : `归档 #${channelName}…`}
                </span>
              </ContextMenu.Item>
            </>
          )}
          <ContextMenu.Item
            className="menu-item"
            data-danger="true"
            onSelect={() => {
              onLeave(channelId);
            }}
          >
            <span className="menu-icon">
              <SettingsIcons.logOut size={16} />
            </span>
            <span className="menu-label">
              退出 {direct ? channelName : '#' + channelName}
            </span>
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
