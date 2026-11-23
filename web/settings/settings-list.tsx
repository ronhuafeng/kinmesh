import { GROUPS, inOrder, COMING } from './sections.js';

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
