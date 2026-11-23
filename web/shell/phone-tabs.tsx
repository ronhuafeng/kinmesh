import { HashIcon, InboxIcon, SearchIcon } from '../shared/icons.js';
import { Mark } from './menus.js';
import { useShell } from './shell.js';

/**
 * A phone's three places at the bottom of Home and of the pages they open;
 * a channel or a pushed page has the screen.
 */
export function PhoneTabs() {
  const {
    data,
    phone,
    focus,
    setFocus,
    setDraft,
    goHome,
    leavePage,
    openSettings,
    screen,
    inSettings,
    waiting,
  } = useShell();
  if (!phone) return null;
  return (
    <nav className="phone-tabs" aria-label="位置">
      {/* Icons only; each says what it is to a screen reader. */}
      <button
        type="button"
        aria-label="频道"
        title="频道"
        aria-current={screen === 'home' ? 'page' : undefined}
        onClick={() => {
          leavePage();
          goHome();
        }}
      >
        <HashIcon size={24} />
      </button>
      <button
        type="button"
        aria-label="搜索"
        title="搜索"
        aria-current={focus?.kind === 'search' ? 'page' : undefined}
        onClick={() => {
          setDraft(null);
          setFocus({ kind: 'search' });
        }}
      >
        <SearchIcon size={24} />
      </button>
      <button
        type="button"
        aria-label="收件箱"
        title="收件箱"
        aria-current={focus?.kind === 'inbox' ? 'page' : undefined}
        onClick={() => {
          setDraft(null);
          setFocus({ kind: 'inbox' });
        }}
      >
        <InboxIcon size={24} />
        {waiting > 0 && <span className="count">{waiting}</span>}
      </button>
      <button
        type="button"
        aria-label="我"
        title="我"
        aria-current={inSettings ? 'page' : undefined}
        onClick={() => {
          openSettings('');
        }}
      >
        <Mark name={data.human.name} />
      </button>
    </nav>
  );
}
