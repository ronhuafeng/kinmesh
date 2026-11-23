import { AgentPage } from '../agents/agent-page.js';
import { ArchivedBar } from './channel-bars.js';
import { Board } from '../tasks/board.js';
import { Chat } from '../chat/chat.js';
import { Files } from '../shared/files.js';
import { JoinBar } from './channel-bars.js';
import { MutationPermission } from '../shared/api.js';
import { Pins } from '../chat/pins.js';
import * as Tabs from '@radix-ui/react-tabs';
import { Team } from '../agents/team.js';
import { draftFromMessage } from '../shared/task-draft.js';
import { showMessage } from '../chat/chat-message.js';
import { useNavigation, useScreen, useActions } from './contexts.js';

/** The views of the place on screen, and an agent's page. */
export function Views() {
  const {
    selection,
    setSelection,
    target,
    boardFilter,
    setBoardFilter,
    backTo,
    setView,
    setCursors,
    focus,
    setFocus,
    setDraft,
    next,
    selectChannel,
    openAgent,
    openTask,
    startNewTask,
  } = useNavigation();
  const {
    data,
    channel,
    channelPath,
    switching,
    canAct,
    looking,
    pageAgent,
    loadedPlace,
  } = useScreen();
  const { openMessageIn, openDirect, incoming, refresh } = useActions();
  return (
    <>
      {switching && (
        <div className="view-skeleton" aria-hidden="true">
          <span className="skeleton-card" />
          <span className="skeleton-card" />
          <span className="skeleton-card" />
        </div>
      )}
      {/* A public channel you only look in: read, but nothing to do there until you join. */}
      <MutationPermission value={canAct && !looking}>
        <Tabs.Content value="chat" key={channel?.id ?? 'no-channel'}>
          {channel && channelPath ? (
            <Chat
              data={data}
              channelPath={channelPath}
              topic={selection.topic}
              shownTopic={
                new URLSearchParams(loadedPlace ?? '').get('topicId') ?? ''
              }
              onTopic={(topic) => {
                setSelection((old) => ({ ...old, topic }));
                setCursors({});
              }}
              target={
                target?.channel === selection.channel &&
                target.topic === selection.topic
                  ? target.id
                  : null
              }
              onOpenMessage={(id) => {
                openMessageIn(channel.id, id);
              }}
              onDone={refresh}
              next={next}
              onEarlier={(cursor) => {
                next('messagesCursor', cursor);
              }}
              onMakeTask={(message) => {
                setDraft(draftFromMessage(message, data));
                setFocus(null);
                setView('board');
              }}
              openAgent={openAgent}
              onLeave={() => {
                selectChannel('');
              }}
              onTeam={() => {
                setView('team');
              }}
              incoming={incoming}
              join={
                data.channelArchived ? (
                  <MutationPermission value={canAct}>
                    <ArchivedBar
                      teamId={data.team.id}
                      channel={channel}
                      onDone={refresh}
                    />
                  </MutationPermission>
                ) : looking ? (
                  <MutationPermission value={canAct}>
                    <JoinBar
                      teamId={data.team.id}
                      channel={channel}
                      onDone={refresh}
                    />
                  </MutationPermission>
                ) : null
              }
            />
          ) : (
            <div className="empty">
              <h3>没有打开的频道</h3>
              <p>选一个已加入的频道来查看和发消息。</p>
            </div>
          )}
        </Tabs.Content>
        <Tabs.Content value="board">
          {channelPath ? (
            <Board
              data={data}
              openTask={openTask}
              onNewTask={startNewTask}
              openId={focus?.kind === 'task' ? focus.id : null}
              filter={boardFilter}
              onFilter={setBoardFilter}
            />
          ) : (
            <div className="empty">
              <p>先建一个频道，再创建任务。</p>
            </div>
          )}
        </Tabs.Content>
        <Tabs.Content value="files">
          {channel && (
            <section className="channel-files" aria-label="文件">
              <Files
                data={data}
                channelId={channel.id}
                openMessage={openMessageIn}
              />
            </section>
          )}
        </Tabs.Content>
        <Tabs.Content value="pins">
          {channel && channelPath && (
            <section className="channel-files" aria-label="置顶">
              <Pins
                data={data}
                channelPath={channelPath}
                openMessage={openMessageIn}
                onDone={refresh}
              />
            </section>
          )}
        </Tabs.Content>
        <Tabs.Content value="team">
          <Team
            data={data}
            channelPath={channelPath}
            channelName={channel?.name ?? ''}
            onDone={refresh}
            openAgent={openAgent}
            openPerson={openDirect}
          />
        </Tabs.Content>
      </MutationPermission>
      <Tabs.Content value="agent">
        {pageAgent ? (
          <AgentPage
            key={pageAgent.id}
            agent={pageAgent}
            data={data}
            channelPath={channelPath}
            onBack={() => {
              setView(backTo);
            }}
            onOwnWorker={() => {
              setFocus({ kind: 'worker', id: pageAgent.id });
            }}
            onReply={(id) => {
              // The reply is in the chat; open it there and point to it.
              setView('chat');
              setTimeout(() => {
                showMessage(id);
              }, 60);
            }}
            onDone={refresh}
          />
        ) : (
          <div className="empty">
            <p>这个智能体不在你的团队里。</p>
          </div>
        )}
      </Tabs.Content>
    </>
  );
}
