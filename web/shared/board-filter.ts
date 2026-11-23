/**
 * Five stages side by side and nothing else: no title (the tab says it), no
 * counts (the cards do). A new task starts as the last card of
 * Proposed; what needs you is gathered in the Inbox.
 */
/** Whose tasks and which topic's the board shows; the address keeps it. */
export interface BoardFilter {
  /** 'all', 'mine', or one member's key (`agent:<id>`, `human:<id>`). */
  who: string;
  /** '' for every topic, else one topic's ID. */
  topic: string;
}
export const ALL_TASKS: BoardFilter = { who: 'all', topic: '' };
