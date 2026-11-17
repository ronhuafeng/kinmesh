import { z } from 'zod';

/**
 * What notifies a person: everything in their channels, only what concerns
 * them (the default), or nothing.
 */
export const NotifyLevel = z.enum(['all', 'mine', 'off']);
export type NotifyLevel = z.infer<typeof NotifyLevel>;
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
/** Whether a person at this level is notified of this. */
export const notifies = (level: NotifyLevel, kind: NotificationKind) =>
  level === 'all' || (level === 'mine' && kind !== 'message');
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
export const Unsubscribe = z.strictObject({
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
  kind: NotificationKind,
  channelId: z.uuid(),
  taskId: z.uuid().nullable(),
  deliveryId: z.uuid().nullable(),
});
export type PushPayload = z.infer<typeof PushPayload>;
