import { registerWorkspace } from './workspace.js';
import { workspaceReader } from './workspace-reader.js';
import { runReader } from './run-reader.js';
import { registerAgui } from './agui.js';
import { registerNativeRuns } from './native-runs.js';
import { registerDeliveries } from './deliveries.js';
import { registerDirect } from './direct.js';
import { registerPeople } from './people.js';
import { registerAgentWorkers } from './agent-workers.js';
import { registerTeamFiles } from './team-files.js';
import { registerSearch } from './search.js';
import { registerHealth } from './health.js';
import { registerLogout } from './logout.js';
import { registerPush } from './push.js';
import { registerFeishuTest } from './feishu-test.js';
import { registerEvents } from './events.js';
import { createHttp } from './http.js';
import { registerSecurityHeaders } from './security-headers.js';
import { registerErrors } from './errors.js';
import { registerRequestGuards } from './request-guards.js';
import { startT3Provisioning } from './t3-provisioning.js';
import { startGrantRenewal } from './worker-grants.js';
import { startInboxExpiry } from './inbox-expiry.js';
import { startAttachmentUpkeep } from './attachment-upkeep.js';
import { startPullRequestUpkeep } from './pull-request-upkeep.js';
import { githubPullRequests } from '../adapters/github/pull-requests.js';
import { githubTokens, registerGitHub } from './github.js';
import { registerOpenPullRequest } from './open-pull-request.js';
import { registerTeam } from './team.js';
import { registerShutdown } from './shutdown.js';
import { watchChanges } from './changes.js';
import { registerWeb } from './web.js';
import { registerTasks } from './tasks.js';
import { registerCommunication } from './communication.js';
import { registerAttachments } from './attachments.js';
import { spacePairer } from '../adapters/space/client.js';
import { attachmentStore } from '../persistence/attachment-store.js';
import { registerNotifications } from './notify.js';
import { registerMe } from './me.js';
import { registerAgents } from './agents.js';
import { defaultHub, registerConnect, type Hub } from './connect.js';
import { managedDirectory } from '../runtime/managed.js';
import { registerPrincipals } from './principals.js';
import type { Store } from '../persistence/store.js';
import type { Config } from './config.js';
import { feishuClient, type Feishu } from './feishu.js';
import { registerLogin } from './login.js';
import { createMetrics } from './metrics.js';

declare module '@fastify/secure-session' {
  interface SessionData {
    /** The server-side session's token; the cookie carries nothing else. */
    session: string;
  }
}
export async function createApp(
  config: Config,
  store: Store,
  workerReady: () => boolean = () => true,
  beforeClose?: () => Promise<void>,
  overrides: Partial<Omit<Hub, 'directory'>> = {},
  options: {
    /** Where the log goes; standard output when absent. */
    logStream?: NodeJS.WritableStream;
    /** Feishu itself unless a test stands in for it. */
    feishu?: Feishu;
  } = {},
) {
  const hub = {
    ...defaultHub(
      managedDirectory(config.state),
      new URL(config.origin).protocol === 'https:',
      config.t3 !== null,
    ),
    ...overrides,
  };
  const metrics = createMetrics();
  const app = await createHttp(config, metrics, options.logStream);
  registerSecurityHeaders(app, config);
  registerErrors(app);
  registerRequestGuards(app, config);
  registerHealth(app, store, config.version, workerReady);
  const feishu = options.feishu ?? feishuClient(config.feishu);
  registerLogin(app, store, config, feishu);
  registerLogout(app, store);
  registerPrincipals(app, store);
  const changes = watchChanges(store);
  const { grants } = registerAgents(app, store, hub.directory);
  registerPeople(app, store);
  registerAgentWorkers(app, store, hub);
  const { t3Status, renewal, runCredential } = registerConnect(
    app,
    store,
    hub,
    changes,
    config.space === null ? null : spacePairer(config.space),
  );
  startT3Provisioning(app, store, hub, config, changes);
  await startGrantRenewal(app, store);
  await startInboxExpiry(app, store);
  registerCommunication(app, store);
  registerDirect(app, store);
  const files = attachmentStore(config.files);
  await files.prepare();
  registerAttachments(app, store, files, config.attachmentsRoom);
  registerTeamFiles(app, store);
  registerSearch(app, store);
  startAttachmentUpkeep(app, store, files, config.space);
  registerTasks(app, store);
  const githubToken = githubTokens(store, hub.directory, config.github);
  registerGitHub(app, store, {
    directory: hub.directory,
    places: config.github,
    origin: config.origin,
    sessionKey: config.sessionKey,
    token: githubToken,
  });
  registerOpenPullRequest(app, store, {
    api: config.github.api,
    token: githubToken,
    origin: config.origin,
  });
  startPullRequestUpkeep(
    app,
    store,
    githubPullRequests({ api: config.github.api, token: githubToken }),
  );
  const notifier = registerNotifications(
    app,
    store,
    config.origin,
    hub.directory,
    feishu,
  );
  registerPush(app, store, notifier);
  registerMe(app, store);
  registerFeishuTest(app, store, config.origin, feishu);
  const readRun = runReader(store, runCredential);
  const reader = workspaceReader(
    store,
    renewal,
    changes,
    metrics.workspaceRead,
    config.teamMcpUrl,
  );
  registerWorkspace(app, reader);
  registerAgui(app, reader);
  registerNativeRuns(app, store, readRun);
  registerDeliveries(app, store, readRun);
  const { snapshot, runs } = reader;
  const { openStreams } = registerEvents(app, store, changes, {
    snapshot,
    t3Status,
    runs,
    grants,
  });
  metrics.register(app, store, config.metricsToken, {
    workerReady,
    openStreams,
  });
  await registerWeb(app);
  registerTeam(app, store);
  registerShutdown(app, store, changes, beforeClose);
  await app.ready();
  return app;
}
