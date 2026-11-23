import { BackIcon } from '../shared/icons.js';
import { GROUPS, inOrder, lit, COMING } from './sections.js';

/**
 * In settings the sidebar is the map: back to where you were, then the
 * sections by group, the current one lit as a channel is.
 */
export function SettingsNav({
  current,
  onSelect,
  onBack,
}: {
  current: string;
  onSelect: (id: string) => void;
  onBack: () => void;
}) {
  return (
    <nav className="settings-nav" aria-label="设置">
      <div className="settings-nav-head">
        <button
          type="button"
          className="quiet icon-button"
          aria-label="返回"
          title="返回"
          onClick={onBack}
        >
          <BackIcon size={20} />
        </button>
        <h2>设置</h2>
      </div>
      {GROUPS.map((group) => (
        <section key={group.id} aria-label={group.label}>
          <div className="nav-heading">
            <h2>{group.label}</h2>
          </div>
          {inOrder(group.id).map((s) => (
            <button
              key={s.id}
              type="button"
              className="settings-nav-item"
              aria-current={lit(current) === s.id ? 'page' : undefined}
              onClick={() => {
                onSelect(s.id);
              }}
            >
              <s.icon size={20} />
              <span>{s.label}</span>
            </button>
          ))}
        </section>
      ))}
      <section aria-label={COMING.label}>
        <button
          type="button"
          className="settings-nav-item"
          data-planned="true"
          aria-current={lit(current) === COMING.id ? 'page' : undefined}
          onClick={() => {
            onSelect(COMING.id);
          }}
        >
          <COMING.icon size={20} />
          <span>{COMING.label}</span>
        </button>
      </section>
    </nav>
  );
}
/** A phone's map: the two groups as iOS grouped lists. */
export function SettingsList({ onSelect }: { onSelect: (id: string) => void }) {
  return (
    <div className="settings-list">
      {GROUPS.map((group) => (
        <section key={group.id} aria-label={group.label}>
          <h2>{group.label}</h2>
          <ul>
            {inOrder(group.id).map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => {
                    onSelect(s.id);
                  }}
                >
                  <s.icon size={20} />
                  <span>{s.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <section aria-label={COMING.label}>
        <ul>
          <li>
            <button
              type="button"
              data-planned="true"
              onClick={() => {
                onSelect(COMING.id);
              }}
            >
              <COMING.icon size={20} />
              <span>{COMING.label}</span>
            </button>
          </li>
        </ul>
      </section>
    </div>
  );
}
