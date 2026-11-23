export function shortTime(iso: string) {
  const date = new Date(iso);
  const today = new Date().toDateString() === date.toDateString();
  return date.toLocaleString(
    'zh-CN',
    today
      ? { hour: '2-digit', minute: '2-digit' }
      : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' },
  );
}
/** The time of day alone ("09:41"), where the day is said around it. */
export function clockTime(iso: string) {
  return new Date(iso).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });
}
/** The local calendar day an instant falls on, to compare two. */
export function dayOf(iso: string) {
  return new Date(iso).toDateString();
}
/**
 * A conversation's day: "今天", "昨天", the date this year ("11月13日 周四"),
 * otherwise with its year.
 */
export function dayLabel(iso: string, now = new Date()) {
  const date = new Date(iso);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === now.toDateString()) return '今天';
  if (date.toDateString() === yesterday.toDateString()) return '昨天';
  return date.toLocaleDateString('zh-CN', {
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  });
}
/** In a list: the time today, otherwise the day ("11月14日"). */
export function listTime(iso: string) {
  const date = new Date(iso);
  const today = new Date().toDateString() === date.toDateString();
  return date.toLocaleString(
    'zh-CN',
    today
      ? { hour: '2-digit', minute: '2-digit' }
      : { month: 'short', day: 'numeric' },
  );
}
/** Whether an Inbox worker would wake this agent now. */
export function workerConnected(
  wake: readonly { agentId: string; connected: boolean }[],
  agentId: string,
) {
  return wake.find((w) => w.agentId === agentId)?.connected ?? false;
}
/**
 * Chinese runs on without spaces: a sentence built from names and words
 * keeps a space only beside Latin text ("Ada 正在处理", "小助手正在处理").
 */
export function cjk(text: string) {
  return text.replace(
    /(?<=[\p{Script=Han}，。：；）”])[ ]+(?=[\p{Script=Han}（“])/gu,
    '',
  );
}
/** "刚刚" or "5 分钟前", for sentences. */
export function ago(iso: string, now = Date.now()) {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${String(minutes)} 分钟前`;
  const hours = Math.round(minutes / 60);
  return hours < 24
    ? `${String(hours)} 小时前`
    : `${String(Math.round(hours / 24))} 天前`;
}
