import { PlaceLink } from '../shared/place-link.js';
import { BackIcon } from '../shared/icons.js';
import { GROUPS, inOrder, lit, COMING } from './sections.js';

/**
 * In settings the sidebar is the map: back to where you were, then the
 * sections by group, the current one lit as a channel is.
 */
export function SettingsNav({
  current,
  hrefOf,
  onSelect,
  onBack,
}: {
  current: string;
  /** A section's address. */
  hrefOf: (id: string) => string;
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
            <PlaceLink
              key={s.id}
              className="button settings-nav-item"
              href={hrefOf(s.id)}
              aria-current={lit(current) === s.id ? 'page' : undefined}
              onOpen={() => {
                onSelect(s.id);
              }}
            >
              <s.icon size={20} />
              <span>{s.label}</span>
            </PlaceLink>
          ))}
        </section>
      ))}
      <section aria-label={COMING.label}>
        <PlaceLink
          className="button settings-nav-item"
          href={hrefOf(COMING.id)}
          data-planned="true"
          aria-current={lit(current) === COMING.id ? 'page' : undefined}
          onOpen={() => {
            onSelect(COMING.id);
          }}
        >
          <COMING.icon size={20} />
          <span>{COMING.label}</span>
        </PlaceLink>
      </section>
    </nav>
  );
}
/** A phone's map: the two groups as iOS grouped lists. */
export function SettingsList({
  hrefOf,
  onSelect,
}: {
  hrefOf: (id: string) => string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="settings-list">
      {GROUPS.map((group) => (
        <section key={group.id} aria-label={group.label}>
          <h2>{group.label}</h2>
          <ul>
            {inOrder(group.id).map((s) => (
              <li key={s.id}>
                <PlaceLink
                  className="button"
                  href={hrefOf(s.id)}
                  onOpen={() => {
                    onSelect(s.id);
                  }}
                >
                  <s.icon size={20} />
                  <span>{s.label}</span>
                </PlaceLink>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <section aria-label={COMING.label}>
        <ul>
          <li>
            <PlaceLink
              className="button"
              href={hrefOf(COMING.id)}
              data-planned="true"
              onOpen={() => {
                onSelect(COMING.id);
              }}
            >
              <COMING.icon size={20} />
              <span>{COMING.label}</span>
            </PlaceLink>
          </li>
        </ul>
      </section>
    </div>
  );
}
