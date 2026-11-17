import { z } from 'zod';

/**
 * Why a person is notified. All but `message` concern them: an agent replied
 * to what they asked, a delivery they caused is stuck, a task waits on their
 * sign-off or is theirs to work on or review, or someone mentioned them.
 */
export const NotificationKind = z.enum([
  'reply',
  'blocked',
  'decide',
  'task',
  'mention',
  'message',
]);
export type NotificationKind = z.infer<typeof NotificationKind>;
/**
 * What notifies a person, kind by kind; none at all is notifications off.
 * By default everything that concerns them, not every other message.
 */
export const NotifyKinds = z
  .array(NotificationKind)
  .max(6)
  .refine((kinds) => new Set(kinds).size === kinds.length);
export type NotifyKinds = z.infer<typeof NotifyKinds>;
export const DEFAULT_KINDS: NotifyKinds = [
  'reply',
  'blocked',
  'decide',
  'task',
  'mention',
];
/** Whether a person who chose these kinds is notified of this. */
export const notifies = (kinds: readonly string[], kind: NotificationKind) =>
  kinds.includes(kind);
/**
 * What waits on a person rather than tells them what happened: muting a
 * channel or an agent never silences it; only level `off` or a pause does.
 */
export const waitsOnYou = (kind: NotificationKind) =>
  kind === 'decide' || kind === 'task' || kind === 'blocked';
/** The longest a person can pause their notifications for. */
export const PAUSE_MOST_MS = 7 * 24 * 60 * 60 * 1000;
export const MuteInput = z.strictObject({ muted: z.boolean() });
/** How long unread before it also goes to Feishu, in minutes; null: never. */
export const FORWARD_MINUTES = [5, 15, 60] as const;
export const ForwardInput = z.strictObject({
  minutes: z.union([z.literal(5), z.literal(15), z.literal(60)]).nullable(),
});
/** Until when nothing notifies; null resumes them. */
export const PauseInput = z.strictObject({
  until: z.iso.datetime().nullable(),
});
/**
 * How long a notification waits before it is sent: long enough for a tab
 * open on its place to have read it, in which case it is not sent.
 */
export const NOTIFY_DELAY_MS = 5000;
/** A browser's Web Push subscription, as `PushSubscription.toJSON()` gives it. */
export const PushSubscriptionInput = z.strictObject({
  endpoint: z.url({ protocol: /^https$/ }).max(2048),
  expirationTime: z.number().nullable().optional(),
  keys: z.strictObject({
    p256dh: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .min(80)
      .max(100),
    auth: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .min(16)
      .max(32),
  }),
});
/** One of a person's browsers, by its push endpoint. */
export const PushEndpoint = z.strictObject({
  endpoint: z.url({ protocol: /^https$/ }).max(2048),
});
/**
 * What a push carries, encrypted for the browser it goes to (RFC 8291): a
 * title and a line, where it opens, and what it is about.
 */
export const PushPayload = z.strictObject({
  title: z.string().min(1).max(120),
  body: z.string().max(240),
  url: z.string().startsWith('/'),
  /** One notification per place: a later one replaces it. */
  tag: z.string().min(1).max(80),
  /** `test`: one a person sent themselves, to see this browser gets them. */
  kind: z.union([NotificationKind, z.literal('test')]),
  channelId: z.uuid().nullable(),
  taskId: z.uuid().nullable(),
  deliveryId: z.uuid().nullable(),
});
export type PushPayload = z.infer<typeof PushPayload>;
/**
 * The hours notifications may reach a person: from `from` to `to` (minutes
 * after midnight, `to` may be past midnight's next day when it is smaller),
 * every day or on weekdays only, in their own time zone. Null: any time.
 */
export const NotifyHours = z.strictObject({
  from: z.number().int().min(0).max(1439),
  to: z.number().int().min(0).max(1439),
  weekdays: z.boolean(),
  timeZone: z.string().min(1).max(64),
});
export type NotifyHours = z.infer<typeof NotifyHours>;
export const HoursInput = z.strictObject({
  hours: NotifyHours.refine((h) => h.from !== h.to)
    .refine((h) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: h.timeZone });
        return true;
      } catch {
        return false;
      }
    })
    .nullable(),
});
/** The weekday (0 Sunday) and minute of the day `at` is in a time zone. */
function wallClock(at: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value;
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(
    part('weekday') ?? '',
  );
  return {
    day,
    minute: Number(part('hour')) * 60 + Number(part('minute')),
  };
}
/** Whether a notification may reach the person at `at`. */
export function withinHours(at: Date, hours: NotifyHours | null) {
  if (hours === null) return true;
  const { day, minute } = wallClock(at, hours.timeZone);
  // A window past midnight belongs to the day it started on.
  const overnight = hours.to < hours.from;
  const inWindow = overnight
    ? minute >= hours.from || minute < hours.to
    : minute >= hours.from && minute < hours.to;
  if (!inWindow) return false;
  if (!hours.weekdays) return true;
  const started = overnight && minute < hours.to ? (day + 6) % 7 : day;
  return started >= 1 && started <= 5;
}
/**
 * The first minute from `at` on when the window is open: `at` itself when
 * it already is. Looked for minute by minute, a week ahead at most.
 */
export function nextOpening(at: Date, hours: NotifyHours | null) {
  if (withinHours(at, hours)) return at;
  const start = Math.ceil(at.getTime() / 60_000) * 60_000;
  // Half-hour steps find the window; minutes then find its first minute.
  for (let t = start; t <= start + 8 * 86_400_000; t += 30 * 60_000)
    if (withinHours(new Date(t), hours)) {
      let first = t;
      while (withinHours(new Date(first - 60_000), hours)) first -= 60_000;
      return new Date(Math.max(first, start));
    }
  return new Date(start + 8 * 86_400_000);
}
