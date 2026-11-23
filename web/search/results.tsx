import { ChannelIcon } from '../shared/channel-icon.js';
import type { Search } from './use-search.js';
import type { Command } from './command.js';

/** The results, grouped as views, actions, channels, tasks and people. */
export function Results({
  search,
  run,
  reversed = false,
}: {
  search: Search;
  run: (command: Command) => void;
  /** Best last, as where the field is at the bottom of the screen. */
  reversed?: boolean;
}) {
  const { results, current, listId, query } = search;
  const shown = results.map((command, index) => ({ command, index }));
  if (reversed) shown.reverse();
  let lastGroup = '';
  return (
    <>
      <ul id={listId} role="listbox" aria-label="结果">
        {shown.map(({ command, index }) => {
          const heading = command.group !== lastGroup;
          lastGroup = command.group;
          return [
            heading && (
              <li
                key={'group-' + command.group}
                role="presentation"
                aria-hidden="true"
                className="palette-group"
              >
                {command.group}
              </li>
            ),
            <li
              key={command.id}
              id={listId + '-' + command.id}
              role="option"
              aria-selected={command === current}
              onMouseMove={() => {
                search.setActive(index);
              }}
              onClick={() => {
                run(command);
              }}
            >
              {command.channel ? (
                <span className="palette-label with-icon">
                  <ChannelIcon {...command.channel} />
                  <span>
                    <span className="visually-hidden"># </span>
                    {command.channel.name}
                  </span>
                </span>
              ) : (
                <span className="palette-label">{command.label}</span>
              )}
              {command.hint && <small>{command.hint}</small>}
            </li>,
          ];
        })}
      </ul>
      {results.length === 0 && (
        <p className="palette-empty">没有和“{query}”匹配的结果。</p>
      )}
    </>
  );
}
