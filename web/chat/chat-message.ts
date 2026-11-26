import type { z } from 'zod';
import type { Message } from '../../src/domain/communication.js';

export type ChatMessage = z.infer<typeof Message>;
/** Which files a message carries, to tell two of the same text apart. */
export const filesOf = (m: ChatMessage) =>
  m.attachments.map((a) => a.id).join(' ');
export const mine = (m: ChatMessage | undefined, me: string) =>
  m?.author.kind === 'human' && m.author.humanId === me;
/** Whether two authors are the same one. */
export const sameAuthorOf = (
  a: ChatMessage['author'],
  b: ChatMessage['author'],
) =>
  a.kind === 'human'
    ? b.kind === 'human' && a.humanId === b.humanId
    : b.kind === 'agent' && a.agentId === b.agentId;
/**
 * Scrolls to a message on screen and flashes it, so the eye finds it; with
 * reduced motion it is there at once.
 */
export function showMessage(id: string) {
  const target = document.getElementById('message-' + id);
  if (!target) return;
  target.scrollIntoView({
    block: 'center',
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 'auto'
      : 'smooth',
  });
  target.dataset.flash = 'true';
  setTimeout(() => {
    delete target.dataset.flash;
  }, 1600);
}
