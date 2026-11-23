import { Group } from '../shared/group.js';
import { Row } from '../shared/row.js';
import { SHORTCUTS } from './sections.js';

export function Shortcuts() {
  const mod = /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘' : 'Ctrl';
  return (
    <Group>
      {SHORTCUTS(mod).map(([label, keys]) => (
        <Row key={label} label={label}>
          <kbd>{keys}</kbd>
        </Row>
      ))}
    </Group>
  );
}
