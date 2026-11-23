/** Eight in the morning after now, by this browser's clock. */
export function tomorrowMorning(now: Date) {
  const at = new Date(now);
  at.setDate(at.getDate() + (now.getHours() < 8 ? 0 : 1));
  at.setHours(8, 0, 0, 0);
  return at;
}
