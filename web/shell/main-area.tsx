import { BackIcon, SidebarIcon } from '../shared/icons.js';
import { HeaderStart } from '../shared/page.js';
import * as Tabs from '@radix-ui/react-tabs';
import { useState } from 'react';
import { useThumb } from './use-thumb.js';
import { FocusPages } from './focus-pages.js';
import { Views } from './views.js';
import { useNavigation, useScreen } from './contexts.js';

/**
 * The main area: the header with the way back, the views and the
 * connection, then the place on screen or the page open over it.
 */
export function MainArea() {
  const { view, setView, goHome, leavePage } = useNavigation();
  const {
    data,
    phone,
    sidebar: { pad, state, headerToggle, open, toggle },
    switching,
    refreshing,
    stale,
    shownChannelName,
    shownDirect,
    onBoardPage,
    onPage,
    tabValue,
    pageAgent,
    inSettings,
  } = useScreen();
  // Where a page beside the sidebar puts its way back.
  const [headerStart, setHeaderStart] = useState<HTMLElement | null>(null);
  const viewTabs = useThumb();
  return (
    <main className="workspace-main">
      <HeaderStart.Provider value={headerStart}>
        <Tabs.Root
          className="workspace-tabs"
          value={tabValue}
          // Focus returning from a page or the palette must not switch views.
          activationMode="manual"
          onValueChange={(v) => {
            if (v === 'inbox') return;
            setView(
              v === 'board' || v === 'team' || v === 'files' || v === 'pins'
                ? v
                : 'chat',
            );
          }}
        >
          <header
            className="workspace-header"
            // Settings beside their map hold nothing up here: no
            // views, no title, the sidebar's control in the map.
            data-bare={
              inSettings && !phone && !(pad && state) ? 'true' : undefined
            }
            // The views centre over the column the place on
            // screen uses: the bar and the content share an axis.
            data-column={
              view === 'agent'
                ? 'agent'
                : onBoardPage || view === 'board' || view === 'team'
                  ? undefined
                  : onPage || view === 'files' || view === 'pins'
                    ? 'reading'
                    : 'conversation'
            }
          >
            {/* The start: the way back (a phone's, or a page's on a
                        tablet, put here by the page) and the sidebar's
                        control; the views sit in the middle. */}
            <div className="header-start" ref={setHeaderStart}>
              {/* A phone shows no sidebar beside a channel: its bar leads
                      back Home and says where you are. */}
              {phone && (
                <button
                  type="button"
                  className="quiet icon-button header-back"
                  aria-label="返回"
                  onClick={goHome}
                >
                  <BackIcon size={20} />
                </button>
              )}
              {/* Beside the sidebar the page never repeats where you are:
                      the title is there for screen readers only. */}
              <h1 className={phone ? 'header-title' : 'visually-hidden'}>
                {pageAgent
                  ? pageAgent.name
                  : view === 'team' && !phone
                    ? '成员'
                    : shownChannelName
                      ? (shownDirect ? '' : '# ') + shownChannelName
                      : switching
                        ? '正在打开频道…'
                        : '欢迎来到你的团队'}
              </h1>
              {/* Closed, the sidebar opens from here; open, the same
                        control ends the team name's row. A floating sidebar
                        covers this one, which keeps the header still. */}
              {pad && state && (
                <button
                  type="button"
                  ref={headerToggle}
                  className="quiet icon-button sidebar-toggle"
                  aria-label="展开侧栏"
                  title="展开侧栏"
                  aria-expanded={open}
                  aria-controls="sidebar"
                  aria-keyshortcuts="Meta+Backslash Control+Backslash"
                  onClick={toggle}
                >
                  <SidebarIcon size={20} />
                </button>
              )}
            </div>
            {/* Views stay in reach however far the conversation scrolls;
                        they belong to a channel, so settings show none. */}
            {!inSettings && (
              <Tabs.List
                ref={viewTabs}
                aria-label="工作区视图"
                className="view-switch"
              >
                <Tabs.Trigger value="chat" onClick={leavePage}>
                  聊天
                </Tabs.Trigger>
                <Tabs.Trigger value="board" onClick={leavePage}>
                  看板
                </Tabs.Trigger>
                <Tabs.Trigger value="team" onClick={leavePage}>
                  成员
                </Tabs.Trigger>
                <Tabs.Trigger value="files" onClick={leavePage}>
                  文件
                </Tabs.Trigger>
                {/* Only a channel with pins has their view. */}
                {(data.pinned.length > 0 || view === 'pins') && (
                  <Tabs.Trigger value="pins" onClick={leavePage}>
                    置顶
                  </Tabs.Trigger>
                )}
              </Tabs.List>
            )}
            <div className="header-end">
              {/* Healthy is silent; a refresh asked for, or a slow
                          one, says so. */}
              {refreshing && (
                <div className="connection">
                  <span className="connection-dot" aria-hidden="true" />
                  <span role="status">正在刷新…</span>
                </div>
              )}
            </div>
          </header>
          {/* One line, and nothing to press: it comes back by itself. */}
          {stale && (
            <p className="stale-line" role="status">
              连不上 Kinmesh。先显示之前的内容，恢复连接前暂停发送。
            </p>
          )}
          <fieldset
            className="view-content"
            data-switching={switching ? 'true' : undefined}
            data-page={onPage ? 'true' : undefined}
            // A wide tablet keeps the board beside a task's page.
            data-beside={onBoardPage ? 'board' : undefined}
          >
            <FocusPages />
            <Views />
          </fieldset>
        </Tabs.Root>
      </HeaderStart.Provider>
    </main>
  );
}
