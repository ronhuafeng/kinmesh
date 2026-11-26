import { BackIcon, SidebarIcon } from '../shared/icons.js';
import { HeaderStart } from '../shared/page.js';
import * as Tabs from '@radix-ui/react-tabs';
import { useState } from 'react';
import { useThumb } from './use-thumb.js';
import { FocusPages } from './focus-pages.js';
import { Views } from './views.js';
import { useNavigation, useScreen } from './contexts.js';
import { PlaceLink } from '../shared/place-link.js';
import { hrefsOf } from './place-hrefs.js';

/**
 * The main area: the header with the way back, the views and the
 * connection, then the place on screen or the page open over it.
 */
export function MainArea() {
  const navigation = useNavigation();
  const { view, setView, goHome, back, leavePage } = navigation;
  const hrefs = hrefsOf(navigation);
  const {
    data,
    phone,
    sidebar: { pad, state, headerToggle, open, toggle },
    switching,
    switchingSlowly,
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
  // Each view of the channel is its own address; only a channel with pins
  // has their view.
  const views = (
    [
      ['chat', '聊天'],
      ['board', '看板'],
      ['team', '成员'],
      ['files', '文件'],
      ['pins', '置顶'],
    ] as const
  ).filter(([v]) => v !== 'pins' || data.pinned.length > 0 || view === 'pins');
  return (
    <main className="workspace-main">
      <HeaderStart.Provider value={headerStart}>
        <Tabs.Root className="workspace-tabs" value={tabValue}>
          <header
            className="workspace-header"
            // Settings beside their map hold nothing up here: no
            // views, no title, the sidebar's control in the map.
            data-bare={
              inSettings && !phone && !(pad && state) ? 'true' : undefined
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
                  onClick={() => {
                    back(goHome);
                  }}
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
              <nav
                ref={viewTabs}
                aria-label="工作区视图"
                className="view-switch"
              >
                {views.map(([v, label]) => (
                  <PlaceLink
                    key={v}
                    className="button"
                    href={hrefs.view(v)}
                    aria-current={tabValue === v ? 'page' : undefined}
                    onOpen={() => {
                      leavePage();
                      setView(v);
                    }}
                  >
                    {label}
                  </PlaceLink>
                ))}
              </nav>
            )}
            <div className="header-end">
              {/* Healthy is silent. Out of reach, it says so here, in the
                  bar's own room, so nothing under it moves; it comes back
                  by itself. A refresh asked for, or a slow one, says so,
                  inside a region that is always there, so it is heard. */}
              <div role="status">
                {(stale || refreshing) && (
                  <div
                    className="connection"
                    data-stale={stale ? 'true' : undefined}
                  >
                    <span className="connection-dot" aria-hidden="true" />
                    <span className="connection-text">
                      {stale ? '连不上 Kinmesh' : '正在刷新…'}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </header>
          <fieldset
            className="view-content"
            data-stale={stale ? 'true' : undefined}
            data-switching={switchingSlowly ? 'true' : undefined}
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
