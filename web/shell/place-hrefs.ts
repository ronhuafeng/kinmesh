import { routeUrl, type Tab } from './route.js';
import type { Place } from './use-place.js';

/**
 * The address of each place a link leads to from here: the one a plain
 * click opens in place, so a new tab opens the same.
 */
export function hrefsOf(place: Place) {
  const here = {
    channel: place.selection.channel,
    topic: place.selection.topic,
    view: place.view,
    agent: place.agentId,
    focus: place.focus,
    newTask: place.newTask !== null,
    target: place.target,
    boardFilter: place.boardFilter,
  };
  return {
    /** A channel, in the view on screen (its chat from an agent's page). */
    channel: (id: string) =>
      routeUrl({
        ...here,
        channel: id,
        topic: '',
        view: place.view === 'agent' ? 'chat' : place.view,
        focus: null,
        newTask: false,
      }),
    /** A task's page, on its channel's board. */
    task: (id: string) =>
      routeUrl({
        ...here,
        view: 'board',
        focus: { kind: 'task', id },
        newTask: false,
      }),
    /** A settings section. */
    settings: (section: string) =>
      routeUrl({
        ...here,
        focus: { kind: 'settings', section },
        newTask: false,
      }),
    /** One of the channel's views, leaving any page. */
    view: (tab: Tab) =>
      routeUrl({ ...here, view: tab, focus: null, newTask: false }),
  };
}
