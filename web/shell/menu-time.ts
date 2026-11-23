export const until = (iso: string | null) =>
  iso !== null && Date.parse(iso) > Date.now() ? new Date(iso) : null;
export const clockOf = (at: Date) =>
  at.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
