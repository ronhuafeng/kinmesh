import { z } from 'zod';
import { api, request } from './api.js';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';

/** Whether this browser can be notified while Kinmesh is closed. */
export const pushSupported = () =>
  'serviceWorker' in navigator &&
  'PushManager' in window &&
  'Notification' in window;
const registration = () =>
  navigator.serviceWorker.register('/sw.js', { scope: '/' });
/** Base64url, as Web Push keys are written, to bytes. */
function bytes(base64url: string) {
  const text = atob(base64url.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}
/** This browser's subscription, when notifications are on in it. */
export async function currentSubscription() {
  if (!pushSupported() || Notification.permission !== 'granted') return null;
  const existing = await navigator.serviceWorker.getRegistration('/');
  return (await existing?.pushManager.getSubscription()) ?? null;
}
/**
 * Turns notifications on in this browser: asks the browser once (from a
 * click), then hands the hub where to push. False when the browser said no.
 */
export async function subscribe() {
  if (!pushSupported()) return false;
  if ((await Notification.requestPermission()) !== 'granted') return false;
  const ready = await registration();
  const { publicKey } = z
    .object({ publicKey: z.string() })
    .parse(await api('/api/push/key'));
  const subscription =
    (await ready.pushManager.getSubscription()) ??
    (await ready.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: bytes(publicKey),
    }));
  await request('/api/push/subscription', subscription.toJSON(), 'PUT');
  return true;
}
/** Turns them off in this browser. */
export async function unsubscribe() {
  const subscription = await currentSubscription();
  if (subscription) {
    await request('/api/push/unsubscribe', { endpoint: subscription.endpoint });
    await subscription.unsubscribe();
  }
  return true;
}
/**
 * On opening the workspace: a browser where notifications are on for you is
 * handed to this session, so it lasts as long as your newest sign-in on it.
 */
export async function renew() {
  const subscription = await currentSubscription();
  if (subscription)
    await request('/api/push/renew', { endpoint: subscription.endpoint });
}
/** What a notification shown here is about (`sw.js`). */
const Shown = z.object({
  kind: z.string(),
  channelId: z.string(),
  taskId: z.string().nullable(),
  deliveryId: z.string().nullable(),
});
/**
 * Closes the notifications in this browser about what is no longer new:
 * channels read since, and decisions and stuck work no longer waiting.
 */
export async function closeSettled(data: WorkspaceSnapshot) {
  if (!pushSupported()) return;
  const ready = await navigator.serviceWorker.getRegistration('/');
  if (!ready) return;
  const unread = new Set<string>(
    data.latest.filter((l) => l.unread).map((l) => l.channelId),
  );
  const deciding = new Set<string>(data.attention.decide.map((d) => d.task.id));
  const stuck = new Set<string>(data.attention.unstuck.map((d) => d.id));
  for (const n of await ready.getNotifications()) {
    const parsed = Shown.safeParse(n.data);
    if (!parsed.success) continue;
    const about = parsed.data;
    const settled =
      about.kind === 'decide'
        ? !deciding.has(about.taskId ?? '')
        : about.kind === 'blocked'
          ? !stuck.has(about.deliveryId ?? '')
          : about.kind === 'task'
            ? false
            : !unread.has(about.channelId);
    if (settled) n.close();
  }
}
