import type { FastifyInstance, FastifyRequest } from 'fastify';
import webpush from 'web-push';
import { z } from 'zod';
import { DomainError } from '../domain/errors.js';
import { AgentId, TeamId } from '../domain/contracts.js';
import {
  MuteInput,
  NotifyLevel,
  PAUSE_MOST_MS,
  PauseInput,
  PushPayload,
  PushSubscriptionInput,
  PushEndpoint,
} from '../domain/notify.js';
import type { Store } from '../persistence/store.js';
import { pushKeys } from '../inbox/managed.js';
import { describeFailure } from '../diagnostics.js';
import { principal } from './principals.js';

type Due = Awaited<ReturnType<Store['notifications']['take']>>[number];
type About = NonNullable<
  Awaited<ReturnType<Store['notifications']['describe']>>
>;
/** At most this many characters, cut between characters, never inside one. */
const cut = (text: string, most: number) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length <= most ? flat : chars.slice(0, most - 1).join('') + '…';
};
/** A name and the words after it: no space between Chinese, one after Latin. */
const said = (name: string, words: string) =>
  /[A-Za-z0-9]$/.test(name) ? `${name} ${words}` : name + words;
/** What a notification says, where it opens, and the place it stands for. */
export function payloadOf(n: Due, about: About) {
  const place =
    '#' +
    about.channelName +
    (about.topicTitle === null ? '' : ' · ' + about.topicTitle);
  const query = new URLSearchParams({ channel: n.channelId });
  if (n.taskId !== null) query.set('task', n.taskId);
  else if (n.topicId !== null) query.set('topic', n.topicId);
  const kind = z
    .enum(['reply', 'blocked', 'decide', 'task', 'mention', 'message'])
    .parse(n.kind);
  const title =
    kind === 'decide'
      ? '等你验收'
      : kind === 'task'
        ? about.status === 'review-requested'
          ? '请你评审'
          : about.status === 'rework-requested'
            ? '退回给你'
            : '交给你了'
        : kind === 'blocked'
          ? said(about.author ?? '智能体', '卡住了')
          : (about.author ?? '有人');
  return PushPayload.parse({
    title: cut(title + ' · ' + place, 120),
    body: cut(about.text, 240),
    url: '/?' + query.toString(),
    tag:
      n.taskId !== null
        ? 'task:' + n.taskId
        : n.deliveryId !== null
          ? 'delivery:' + n.deliveryId
          : 'channel:' + n.channelId + ':' + (n.topicId ?? ''),
    kind,
    channelId: n.channelId,
    taskId: n.taskId,
    deliveryId: n.deliveryId,
  });
}
/**
 * Browser notifications: a person's level, the browsers they turned them on
 * in, and sending what is due to those browsers, if it still concerns them.
 */
export function registerNotifications(
  app: FastifyInstance,
  store: Store,
  origin: string,
  /** The hub's private directory, where its push keys are kept. */
  directory: string,
) {
  const keys = pushKeys(directory, () => webpush.generateVAPIDKeys());
  const vapidDetails = {
    // Who sends, for push services to reach: the hub's own site.
    subject:
      new URL(origin).protocol === 'https:'
        ? origin
        : 'mailto:kinmesh@localhost',
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
  };
  const human = (request: FastifyRequest) => {
    const p = principal(request);
    if (p.kind !== 'human') throw new DomainError('forbidden');
    return p.humanId;
  };
  app.get('/api/push/key', (request) => {
    human(request);
    return { publicKey: keys.publicKey };
  });
  app.put('/api/push/subscription', async (request, reply) => {
    const humanId = human(request);
    const session = request.session.get('session');
    if (typeof session !== 'string') throw new DomainError('unauthenticated');
    await store.notifications.subscribe(
      humanId,
      session,
      PushSubscriptionInput.parse(request.body),
    );
    return reply.code(204).send();
  });
  app.post('/api/push/renew', async (request, reply) => {
    const humanId = human(request);
    const session = request.session.get('session');
    if (typeof session !== 'string') throw new DomainError('unauthenticated');
    await store.notifications.renew(
      humanId,
      session,
      PushEndpoint.parse(request.body).endpoint,
    );
    return reply.code(204).send();
  });
  app.post('/api/push/unsubscribe', async (request, reply) => {
    await store.notifications.unsubscribe(
      human(request),
      PushEndpoint.parse(request.body).endpoint,
    );
    return reply.code(204).send();
  });
  app.put('/api/me/pause', async (request, reply) => {
    const humanId = human(request);
    const { until } = PauseInput.parse(request.body);
    const at = until === null ? null : Date.parse(until);
    if (at !== null && (at <= Date.now() || at > Date.now() + PAUSE_MOST_MS))
      throw new DomainError('invalid');
    const team = await store.teamFor(humanId);
    if (!team) throw new DomainError('forbidden');
    await store.notifications.pause(humanId, team.team.id, at);
    return reply.code(204).send();
  });
  app.post(
    '/api/teams/:teamId/agents/:agentId/mute',
    async (request, reply) => {
      const humanId = human(request);
      const { teamId, agentId } = z
        .strictObject({ teamId: TeamId, agentId: AgentId })
        .parse(request.params);
      const team = await store.teamFor(humanId);
      if (team?.team.id !== teamId) throw new DomainError('not-found');
      await store.notifications.muteAgent(
        humanId,
        teamId,
        agentId,
        MuteInput.parse(request.body).muted,
      );
      return reply.code(204).send();
    },
  );
  app.put('/api/me/notify', async (request, reply) => {
    const humanId = human(request);
    const { level } = z
      .strictObject({ level: NotifyLevel })
      .parse(request.body);
    const team = await store.teamFor(humanId);
    if (!team) throw new DomainError('forbidden');
    await store.notifications.level(humanId, team.team.id, level);
    return reply.code(204).send();
  });

  /**
   * Pushes to one browser: `sent`, `gone` (its push service no longer knows
   * it, so it is forgotten) or `failed` (the push service could not be
   * reached or refused; only its status is logged, the endpoint being a
   * credential).
   */
  async function push(
    browser: { endpoint: string; p256dh: string; auth: string },
    payload: string,
  ) {
    try {
      await webpush.sendNotification(
        {
          endpoint: browser.endpoint,
          keys: { p256dh: browser.p256dh, auth: browser.auth },
        },
        payload,
        { vapidDetails, TTL: 86_400, urgency: 'high', timeout: 10_000 },
      );
      return 'sent';
    } catch (error) {
      if (
        error instanceof webpush.WebPushError &&
        (error.statusCode === 404 || error.statusCode === 410)
      ) {
        await store.notifications.gone(browser.endpoint);
        return 'gone';
      }
      app.log.error(
        {
          status:
            error instanceof webpush.WebPushError ? error.statusCode : null,
        },
        'push_failed',
      );
      return 'failed';
    }
  }
  async function deliver(n: Due) {
    const about = await store.notifications.describe(n);
    if (about === null) return;
    const browsers = await store.notifications.browsers(n.humanId);
    if (browsers.length === 0) return;
    const payload = JSON.stringify(payloadOf(n, about));
    for (const browser of browsers) await push(browser, payload);
  }
  // A person sends this browser a notification, to see that it gets them:
  // 410 when this browser no longer does, 502 when its push service
  // can't be reached.
  app.post('/api/push/test', async (request, reply) => {
    const humanId = human(request);
    const { endpoint } = PushEndpoint.parse(request.body);
    const browser = await store.notifications.browser(humanId, endpoint);
    if (browser === null) return reply.code(410).send();
    const outcome = await push(
      browser,
      JSON.stringify(
        PushPayload.parse({
          title: 'Kinmesh',
          body: '这台设备能收到通知。',
          url: '/?settings',
          tag: 'test',
          kind: 'test',
          channelId: null,
          taskId: null,
          deliveryId: null,
        }),
      ),
    );
    return reply
      .code(outcome === 'sent' ? 204 : outcome === 'gone' ? 410 : 502)
      .send();
  });
  // What is due goes out within a second, each notification once.
  let sending = false;
  const send = async () => {
    if (sending) return;
    sending = true;
    try {
      for (;;) {
        const due = await store.notifications.take(20);
        if (due.length === 0) break;
        for (const n of due) await deliver(n);
      }
    } catch (error) {
      app.log.error(describeFailure(error), 'notification_send_failed');
    } finally {
      sending = false;
    }
  };
  const timer = setInterval(() => void send(), 1000);
  timer.unref();
  app.addHook('onClose', () => {
    clearInterval(timer);
  });
}
