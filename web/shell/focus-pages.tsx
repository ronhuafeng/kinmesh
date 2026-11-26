import { ChannelIcon } from '../shared/faces.js';
import { InboxPage } from '../inbox/inbox-page.js';
import { ListRow } from '../shared/list.js';
import { NewTaskPage } from '../tasks/new-task-page.js';
import { OwnWorkerPage } from '../agents/own-worker-page.js';
import { Page } from '../shared/page.js';
import { SearchPage } from '../search/palette.js';
import { SettingsPage } from '../settings/settings-page.js';
import { TaskPage } from '../tasks/task-page.js';
import { useNavigation, useScreen, useActions } from './contexts.js';
import { hrefsOf } from './place-hrefs.js';

/**
 * What opens in place of the view: a task or a new one, a hand-run worker,
 * the Inbox, search on a phone, something shared to Kinmesh, or settings.
 */
export function FocusPages() {
  const navigation = useNavigation();
  const hrefs = hrefsOf(navigation);
  const {
    setView,
    focus,
    setFocus,
    setDraft,
    newTask,
    selectChannel,
    leavePage,
    closeFocus,
    back,
    openSettings,
    openAgent,
  } = navigation;
  const {
    data,
    phone,
    channel,
    channelPath,
    focusedTask,
    workerAgent,
    settingsSection,
  } = useScreen();
  const {
    signOut,
    signOutEverywhere,
    openTaskIn,
    openMessageIn,
    shared,
    setShared,
    setIncoming,
    notify,
    refresh,
    commands,
    remote,
  } = useActions();
  return (
    <>
      {/* A task, a new task, the Inbox, Settings or a hand-run
                      worker opens here, in place of the view. Unsent text
                      survives in session storage, not in the hidden view. */}
      {focusedTask && channelPath && (
        <TaskPage
          key={focusedTask.id}
          task={focusedTask}
          data={data}
          path={channelPath + '/tasks/' + focusedTask.id}
          onDone={refresh}
          onClose={closeFocus}
          onDecided={notify}
          onReply={(id) => {
            // The reply is in the conversation, however far back.
            leavePage();
            openMessageIn(focusedTask.channelId, id);
          }}
          openAgent={openAgent}
        />
      )}
      {workerAgent && (
        <OwnWorkerPage
          key={workerAgent.id}
          agent={workerAgent}
          data={data}
          onClose={closeFocus}
          onDone={refresh}
        />
      )}
      {focus?.kind === 'inbox' && (
        <InboxPage
          data={data}
          onClose={closeFocus}
          openTask={openTaskIn}
          openChannel={(id) => {
            if (id !== channel?.id) selectChannel(id);
            setView('chat');
            setFocus(null);
          }}
          openAgent={openAgent}
          onDone={refresh}
        />
      )}
      {newTask && channelPath && (
        <NewTaskPage
          draft={newTask}
          data={data}
          channelPath={channelPath}
          onClose={() => {
            back(() => {
              setDraft(null);
            });
          }}
          onCreated={(id) => {
            // The new task stays on screen, now as itself.
            setDraft(null);
            setView('board');
            setFocus({ kind: 'task', id });
            refresh();
          }}
          onNotify={notify}
        />
      )}
      {phone && focus?.kind === 'search' && (
        <Page label="搜索" onClose={closeFocus} bar={false}>
          <SearchPage
            commands={commands}
            remote={remote}
            onClose={closeFocus}
          />
        </Page>
      )}
      {shared && (
        <Page
          label="分享到频道"
          onClose={() => {
            setShared(null);
          }}
        >
          <div className="page-body share-page">
            <p className="muted">
              {[
                shared.files.length > 0
                  ? `${String(shared.files.length)} 个文件`
                  : '',
                shared.text !== '' ? '一段文字' : '',
              ]
                .filter(Boolean)
                .join('和')}
              ，发到哪个频道？
            </p>
            <ul className="list-rows" aria-label="频道">
              {data.channels.items.map((c) => (
                <ListRow
                  key={c.id}
                  lead={<ChannelIcon id={c.id} name={c.name} />}
                  title={c.name}
                  onOpen={() => {
                    setIncoming({
                      key: crypto.randomUUID(),
                      shared,
                    });
                    setShared(null);
                    setFocus(null);
                    selectChannel(c.id);
                    setView('chat');
                  }}
                />
              ))}
            </ul>
          </div>
        </Page>
      )}
      {focus?.kind === 'settings' && (
        <SettingsPage
          key={settingsSection}
          section={settingsSection}
          phone={phone}
          data={data}
          sectionHref={hrefs.settings}
          onSection={openSettings}
          onClose={closeFocus}
          onSignOut={signOut}
          onSignOutEverywhere={signOutEverywhere}
          openChannel={(id) => {
            setFocus(null);
            selectChannel(id);
            setView('chat');
          }}
          openMessage={openMessageIn}
          openAgent={openAgent}
        />
      )}
    </>
  );
}
