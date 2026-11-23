import { AccountMenu } from './account-menu.js';
import { InboxIcon, SidebarIcon } from '../shared/icons.js';
import { SettingsNav } from '../settings/settings-nav.js';
import { SidebarSearch } from '../search/sidebar-search.js';
import { TeamMenu } from './team-menu.js';
import { ChannelList } from './channel-list.js';
import { PeopleList } from './people-list.js';
import { useShell } from './shell.js';

/**
 * The sidebar: the team and search, what waits on you, the channels and
 * the people in the open one, and you at its foot; in settings, their map.
 */
export function Sidebar() {
  const {
    data,
    phone,
    sidebar,
    focus,
    setFocus,
    setDraft,
    closeFocus,
    openSettings,
    inSettings,
    settingsSection,
    waiting,
    signOut,
    signOutEverywhere,
    notify,
    commands,
    remote,
  } = useShell();
  const teamName = (
    <TeamMenu data={data} onSettings={openSettings}>
      <span
        className="team-name"
        title={data.team.name}
        data-long={data.team.name.length > 12 || undefined}
      >
        {data.team.name}
      </span>
    </TeamMenu>
  );
  return (
    <aside
      className="sidebar"
      id="sidebar"
      ref={sidebar.sidebarRef}
      aria-label="侧栏"
    >
      {inSettings && !phone ? (
        <SettingsNav
          current={settingsSection}
          onSelect={openSettings}
          onBack={closeFocus}
        />
      ) : (
        <>
          {/* The organization, as Feishu names it, set as a wordmark,
                    with search at the end of its row. A long name wraps to
                    two lines, smaller. */}
          {phone ? (
            // A phone's search is its own tab: the row is the name.
            <div className="team-row">{teamName}</div>
          ) : (
            <SidebarSearch
              commands={commands}
              remote={remote}
              onOpen={sidebar.onSearch}
              end={
                sidebar.pad && (
                  <button
                    type="button"
                    ref={sidebar.rowToggle}
                    className="quiet icon-button sidebar-toggle"
                    aria-label="收起侧栏"
                    title="收起侧栏"
                    aria-expanded="true"
                    aria-controls="sidebar"
                    aria-keyshortcuts="Meta+Backslash Control+Backslash"
                    onClick={sidebar.toggle}
                  >
                    <SidebarIcon size={20} />
                  </button>
                )
              }
            >
              {teamName}
            </SidebarSearch>
          )}
          {/* What waits on you across the team, above the channels
                      it comes from; an empty inbox needs no number. A phone
                      has it as a bottom tab. */}
          {!phone && (
            <nav className="sidebar-inbox" aria-label="收件箱">
              <button
                type="button"
                aria-current={focus?.kind === 'inbox' ? 'page' : undefined}
                onClick={() => {
                  setDraft(null);
                  setFocus({ kind: 'inbox' });
                }}
              >
                <InboxIcon size={20} />
                <span>收件箱</span>
                {waiting > 0 && <span className="count">{waiting}</span>}
              </button>
            </nav>
          )}
          <ChannelList />
          <PeopleList />
        </>
      )}
      {/* You, at the foot: your mark opens what is about you. */}
      {!phone && (
        <div className="sidebar-foot">
          <AccountMenu
            data={data}
            onSettings={openSettings}
            onSignOut={signOut}
            onSignOutEverywhere={signOutEverywhere}
            onFailed={notify}
          />
        </div>
      )}
    </aside>
  );
}
