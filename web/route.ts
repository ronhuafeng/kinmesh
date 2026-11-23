import { Agent } from '../src/domain/agents.js';
import { ChannelId, TaskId } from '../src/domain/contracts.js';
import { MessageId, TopicId } from '../src/domain/communication.js';
import { blankDraft, keptDraft } from './tasks.js';
import type { BoardFilter, TaskDraft } from './tasks.js';

/*
 * Where you are and its address: what a reload or a shared link opens, and
 * the address each place is kept at (`readRoute` and `routeUrl`, inverses).
 */
/** Tabs, plus one agent's own page reached from them. */
export type View = 'chat' | 'board' | 'team' | 'files' | 'pins' | 'agent';
export type Tab = Exclude<View, 'agent'>;
export type Focus =
  | { kind: 'task' | 'worker'; id: string }
  | { kind: 'inbox' | 'search' }
  /** A settings section by id; '' is the map (a phone's list). */
  | { kind: 'settings'; section: string }
  | null;

/**
 * Where you are, as the address says it, so a reload or a shared link opens
 * the same place: the channel and topic, the view, an agent's page, a task
 * (or "new"), the Inbox, Settings, or a hand-run worker.
 */
export function readRoute() {
  const query = new URLSearchParams(window.location.search);
  const valid =
    (parse: { safeParse: (v: unknown) => { success: boolean } }) =>
    (key: string) => {
      const value = query.get(key);
      return value !== null && parse.safeParse(value).success ? value : '';
    };
  const agentParam = valid(Agent.shape.id);
  const channel = valid(ChannelId)('channel');
  const topic = valid(TopicId)('topic');
  const worker = agentParam('worker');
  const task = query.get('task');
  let agent = agentParam('agent');
  const asked = query.get('view');
  let view: View =
    asked === 'board' ||
    asked === 'team' ||
    asked === 'files' ||
    asked === 'pins'
      ? asked
      : 'chat';
  let focus: Focus = null;
  let draft: TaskDraft | null = null;
  if (task === 'new') {
    view = 'board';
    draft = keptDraft()?.draft ?? blankDraft(topic || null);
  } else if (task !== null && TaskId.safeParse(task).success) {
    view = 'board';
    focus = { kind: 'task', id: task };
  } else if (worker) {
    view = 'agent';
    agent = worker;
    focus = { kind: 'worker', id: worker };
  } else if (query.has('inbox')) focus = { kind: 'inbox' };
  else if (query.has('settings'))
    focus = { kind: 'settings', section: query.get('settings') ?? '' };
  else if (query.has('search')) focus = { kind: 'search' };
  if (agent && !worker) view = 'agent';
  // A message the channel is opened at, while that channel is open.
  const message = MessageId.safeParse(query.get('message'));
  const target =
    channel && message.success && view === 'chat' && focus === null
      ? { channel, topic, id: message.data }
      : null;
  // How the board is narrowed: whose tasks, which topic's.
  const who = query.get('who') ?? '';
  const about = valid(TopicId)('about');
  const boardFilter: BoardFilter = {
    who:
      who === 'mine' || /^(human|agent):[0-9a-f-]{36}$/.test(who) ? who : 'all',
    topic: about,
  };
  return { channel, topic, view, agent, focus, draft, target, boardFilter };
}
/** A message a conversation is opened at, and where. */
export interface Target {
  channel: string;
  topic: string;
  id: string;
}
/** The address for a place; the inverse of readRoute. */
export function routeUrl(place: {
  channel: string;
  topic: string;
  view: View;
  agent: string;
  focus: Focus;
  newTask: boolean;
  target: Target | null;
  boardFilter: BoardFilter;
}) {
  const query = new URLSearchParams();
  if (place.channel) query.set('channel', place.channel);
  if (place.topic) query.set('topic', place.topic);
  if (place.focus?.kind === 'task') query.set('task', place.focus.id);
  else if (place.newTask) query.set('task', 'new');
  else if (place.focus?.kind === 'worker') query.set('worker', place.focus.id);
  else if (place.focus?.kind === 'inbox') query.set('inbox', '');
  else if (place.focus?.kind === 'settings')
    query.set('settings', place.focus.section);
  else if (place.focus?.kind === 'search') query.set('search', '');
  else if (place.view === 'agent' && place.agent)
    query.set('agent', place.agent);
  else if (
    place.view === 'board' ||
    place.view === 'team' ||
    place.view === 'files' ||
    place.view === 'pins'
  ) {
    query.set('view', place.view);
    if (place.view === 'board') {
      if (place.boardFilter.who !== 'all')
        query.set('who', place.boardFilter.who);
      if (place.boardFilter.topic) query.set('about', place.boardFilter.topic);
    }
  } else if (
    place.target?.channel === place.channel &&
    place.target.topic === place.topic &&
    place.view === 'chat'
  )
    query.set('message', place.target.id);
  const search = query.toString().replace(/=(?=&|$)/g, '');
  return '/' + (search ? '?' + search : '');
}
/** Two addresses are the same place when only the topic differs. */
export function samePlace(a: string, b: string) {
  const strip = (url: string) => {
    const parsed = new URL(url, window.location.origin);
    parsed.searchParams.delete('topic');
    return parsed.search;
  };
  return strip(a) === strip(b);
}
