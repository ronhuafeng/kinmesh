import { managedRepository } from './managed.js';
import { t3ConnectionRepository } from './t3-connections.js';
import { teamMcpPresenceRepository } from './team-mcp-presence.js';
import { spaceRepository } from './spaces.js';
import { inboxBindingRepository } from './inbox-bindings.js';
import { notificationRepository } from './notify.js';
import { quietRepository } from './quiet.js';
import { browserRepository } from './browsers.js';
import { inboxRepository } from './inbox.js';
import { inboxViews } from './inbox-views.js';
import { taskRepository } from './tasks.js';
import { channelAccess } from './channel-access.js';
import { factsOf } from './facts.js';
import { messageViews } from './message-views.js';
import { channelRepository } from './channels.js';
import { topicRepository } from './topics.js';
import { messageRepository } from './messages.js';
import { fileRepository } from './files.js';
import { reactionRepository } from './reactions.js';
import { pinRepository } from './pins.js';
import { agentRepository } from './agents.js';
import { agentEventRepository } from './agent-events.js';
import { operationJournal } from './operations.js';
import { memberRepository } from './members.js';
import { loginRepository } from './logins.js';
import { sessionRepository } from './sessions.js';
import { openDatabase } from './database.js';

/**
 * The team's store on PostgreSQL. Every method answers asynchronously; writes
 * that belong together run in one serializable transaction.
 */
export async function openStore(url: string) {
  const d = await openDatabase(url);
  const agentStore = agentRepository(d);
  const agentEvents = agentEventRepository(d, agentStore);
  // What every channel's repositories share, made once so a read asks each
  // question once.
  const gate = channelAccess(d, agentStore);
  const facts = factsOf(d, agentStore);
  const views = messageViews(d);
  const channels = channelRepository(d, agentStore, gate, facts);
  const topics = topicRepository(d, gate, facts, views);
  const messages = messageRepository(d, agentStore, gate, facts, views);
  const tasks = taskRepository(d, agentStore, channels, topics, messages);
  const inbox = inboxRepository(
    d,
    agentStore,
    agentEvents,
    channels,
    topics,
    messages,
    tasks,
  );
  const t3Connections = t3ConnectionRepository(d, agentStore);
  return {
    /** Calls `listener` after any change committed anywhere; returns how to stop. */
    listen: d.listen,
    /** Which database this is, to tell it from a replacement. */
    identity: d.identity,
    inbox,
    spaces: spaceRepository(d, inbox),
    inboxBindings: inboxBindingRepository(d),
    /** What the workspace shows a person about deliveries and workers. */
    inboxViews: inboxViews(d, agentStore, channels),
    tasks,
    channels,
    topics,
    messages,
    files: fileRepository(d, gate, facts, views),
    reactions: reactionRepository(d, gate, views),
    pins: pinRepository(d, gate, views),
    operations: operationJournal(d),
    agents: agentStore,
    agentEvents,
    managed: managedRepository(d, agentStore, t3Connections),
    t3Connections,
    teamMcpPresence: teamMcpPresenceRepository(d, agentStore),
    /** What notifies a person, their browsers, and what is sent to them. */
    notifications: notificationRepository(d),
    /** How each person set Kinmesh to reach them. */
    quiet: quietRepository(d),
    /** The browsers each person is notified in. */
    browsers: browserRepository(d),
    close: d.close,
    logins: loginRepository(d),
    sessions: sessionRepository(d),
    ...memberRepository(d, agentStore, channels),
    ready: d.ready,
    /** Runs reads as one consistent read (`openDatabase`). */
    read: d.read,
    /** How many transactions and queries some work began, for tests. */
    tally: d.tally,
  };
}
export type Store = Awaited<ReturnType<typeof openStore>>;
