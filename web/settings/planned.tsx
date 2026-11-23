import { Group } from '../shared/group.js';
import { Row } from '../shared/row.js';
import { SECTIONS } from './sections.js';

/** A planned section: the rows it will hold, quiet, and that it is coming. */
export function Planned() {
  return (
    <div className="settings-planned">
      {SECTIONS.flatMap((s) =>
        s.planned
          ? [
              <Group key={s.id} title={s.label}>
                {s.planned.map((row) => (
                  <Row key={row} label={row}>
                    <span className="skeleton" aria-hidden="true" />
                  </Row>
                ))}
              </Group>,
            ]
          : [],
      )}
    </div>
  );
}
