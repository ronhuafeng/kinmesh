import type { FastifyInstance } from 'fastify';
import { generateVAPIDKeys, sendNotification, WebPushError } from 'web-push';
import { z } from 'zod';
import { withinHours, PushPayload } from '../domain/notify.js';
import type { Store } from '../persistence/store.js';
import { pushKeys } from '../runtime/managed.js';
import { describeFailure } from '../diagnostics.js';
import { FeishuFailure, type Feishu } from './feishu.js';

/** How often cards are looked at, and how long one is followed at most. */
const SETTLE_EVERY_MS = 10_000;
const CARD_FOLLOWED_MS = 7 * 24 * 60 * 60 * 1000;
const CardPost = z.strictObject({
  title: z.string(),
  text: z.string(),
  url: z.string(),
});
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
  // A message opens at itself, in its channel's conversation.
  else if (n.messageId !== null) query.set('message', n.messageId);
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
  /** Feishu, whose bot forwards what stays unread. */
  feishu: Feishu,
) {
  const keys = pushKeys(directory, () => generateVAPIDKeys());
  const vapidDetails = {
    // Who sends, for push services to reach: the hub's own site.
    subject:
      new URL(origin).protocol === 'https:'
        ? origin
        : 'mailto:kinmesh@localhost',
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
  };

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
      await sendNotification(
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
        error instanceof WebPushError &&
        (error.statusCode === 404 || error.statusCode === 410)
      ) {
        await store.browsers.gone(browser.endpoint);
        return 'gone';
      }
      app.log.error(
        {
          status: error instanceof WebPushError ? error.statusCode : null,
        },
        'push_failed',
      );
      return 'failed';
    }
  }
  /** Outside the person's hours: kept for when they open. */
  /** In the person's quiet time: paused, or outside their hours. */
  async function quiet(humanId: string) {
    const [paused, hours] = await Promise.all([
      store.quiet.pausedUntilOf(humanId),
      store.quiet.hoursOf(humanId),
    ]);
    return paused !== null || !withinHours(new Date(), hours);
  }
  /** Using Kinmesh now: a session of theirs in use within the last 90 s. */
  async function present(humanId: string) {
    return (await store.online(Date.now())).some((id) => id === humanId);
  }
  /**
   * Whether this notification waits instead of going out now: held in the
   * person's quiet time (summed up when it ends), or, while they are in
   * Kinmesh, shown there as an in-page notice instead.
   */
  async function held(n: Due, what: 'push' | 'forward') {
    if (await quiet(n.humanId)) {
      await store.notifications.hold(n.id, what);
      return true;
    }
    if (await present(n.humanId)) {
      if (what === 'push') await store.notifications.shownInApp(n.id);
      return true;
    }
    return false;
  }
  /**
   * Once a person's quiet time ends, what was held while it lasted and
   * still concerns them goes out as one summary, not as a backlog.
   */
  async function summarise(humanId: string) {
    if (await quiet(humanId)) return;
    const held = await store.notifications.takeHeld(humanId);
    let waiting = 0;
    for (const n of held)
      if ((await store.notifications.describe(n)) !== null) waiting += 1;
    if (waiting === 0) return;
    const title = `免打扰期间有 ${String(waiting)} 件事等你`;
    const body = '打开 Kinmesh 查看';
    const payload = JSON.stringify(
      PushPayload.parse({
        title,
        body,
        url: '/',
        tag: 'summary',
        kind: 'test',
        channelId: null,
        taskId: null,
        deliveryId: null,
      }),
    );
    for (const browser of await store.browsers.browsers(humanId))
      await push(browser, payload);
    const union = await store.notifications.unionOf(humanId);
    if (union !== null && (await store.quiet.forwardsTo(humanId)))
      await feishu
        .message(union, { title, text: body, url: new URL('/', origin).href })
        .catch((error: unknown) => {
          app.log.error(
            { error: error instanceof FeishuFailure ? error.message : 'Error' },
            'feishu_forward_failed',
          );
        });
  }
  async function deliver(n: Due) {
    const about = await store.notifications.describe(n);
    if (about === null) return;
    if (await held(n, 'push')) return;
    const browsers = await store.browsers.browsers(n.humanId);
    if (browsers.length === 0) return;
    const payload = JSON.stringify(payloadOf(n, about));
    for (const browser of browsers) await push(browser, payload);
  }
  /**
   * What stayed unread goes to the person in Feishu, from the app's bot, if
   * it still concerns them; once, and never retried as another message.
   */
  async function forward(n: Due, union: string | null) {
    if (union === null) return;
    const about = await store.notifications.describe(n);
    if (about === null) return;
    if (await held(n, 'forward')) return;
    const payload = payloadOf(n, about);
    const post = {
      title: payload.title,
      text: payload.body,
      url: new URL(payload.url, origin).href,
    };
    try {
      const cardId = await feishu.message(union, post);
      // Followed until what it is about is settled.
      await store.notifications.cardSent(n.id, cardId, post);
    } catch (error) {
      // Only the stage and status: nothing of the message or the person.
      app.log.error(
        { error: error instanceof FeishuFailure ? error.message : 'Error' },
        'feishu_forward_failed',
      );
    }
  }
  /**
   * A card whose cause is settled (read, decided, unblocked, or no longer
   * the person's) turns into 已处理, once. One older than a week is let go.
   */
  async function settleCards() {
    for (const n of await store.notifications.openCards(50)) {
      if (closed()) return;
      if (n.cardId === null || n.card === null) {
        await store.notifications.cardClosed(n.id);
        continue;
      }
      if (Date.now() - n.createdAt > CARD_FOLLOWED_MS) {
        await store.notifications.cardClosed(n.id);
        continue;
      }
      if ((await store.notifications.describe(n)) !== null) continue;
      const post = CardPost.parse(JSON.parse(n.card));
      try {
        await feishu.settle(n.cardId, post);
        await store.notifications.cardClosed(n.id);
      } catch (error) {
        app.log.error(
          { error: error instanceof FeishuFailure ? error.message : 'Error' },
          'feishu_settle_failed',
        );
      }
    }
  }
  // What is due goes out within a second, each notification once.
  // One round at a time; closing waits for the one under way, and says
  // nothing of a database it closed under it.
  let sending: Promise<void> | null = null;
  let lastSettled = 0;
  let closing = false;
  // Read anew each time: it changes while a round awaits.
  const closed = () => closing;
  const round = async () => {
    try {
      for (;;) {
        if (closed()) return;
        const due = await store.notifications.take(20);
        if (due.length === 0) break;
        for (const n of due) await deliver(n);
      }
      for (;;) {
        if (closed()) return;
        const due = await store.notifications.takeForwards(20);
        if (due.length === 0) break;
        for (const { notification, union, forwarding } of due)
          if (forwarding) await forward(notification, union);
      }
      for (const humanId of await store.notifications.heldPeople()) {
        if (closed()) return;
        await summarise(humanId);
      }
      // Settled cards are looked for less often than what is due.
      if (Date.now() - lastSettled > SETTLE_EVERY_MS) {
        lastSettled = Date.now();
        await settleCards();
      }
    } catch (error) {
      if (!closed())
        app.log.error(describeFailure(error), 'notification_send_failed');
    }
  };
  const send = () => {
    if (sending || closing) return;
    sending = round().finally(() => {
      sending = null;
    });
  };
  const timer = setInterval(send, 1000);
  timer.unref();
  app.addHook('onClose', async () => {
    closing = true;
    clearInterval(timer);
    await sending;
  });
  return { publicKey: keys.publicKey, push };
}
export type Notifier = ReturnType<typeof registerNotifications>;
