import { useState } from 'react';
import { ChoiceRow } from '../shared/choice-row.js';
import { Group } from '../shared/group.js';
import { applyTheme, readTheme, type Theme } from '../shared/theme.js';

export function Appearance() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  return (
    <Group>
      <ChoiceRow
        label="配色"
        options={[
          { id: 'system', label: '跟随系统' },
          { id: 'light', label: '浅色' },
          { id: 'dark', label: '深色' },
        ]}
        value={theme}
        disabled={false}
        onChoose={(next) => {
          applyTheme(next);
          setTheme(next);
        }}
      />
    </Group>
  );
}
