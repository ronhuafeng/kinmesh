import type { z } from 'zod';
import type { REACTIONS } from '../../src/domain/communication.js';
import { type MessageReactions } from '../../src/domain/communication.js';
import { request } from '../shared/api.js';

export type Reacted = z.infer<typeof MessageReactions>;
export type Emoji = (typeof REACTIONS)[number];
/** Adds or takes back your reaction; the conversation shows it as it lands. */
export function react(
  path: string,
  emoji: Emoji,
  on: boolean,
  done: () => void,
) {
  void request(path + '/reactions', { emoji, on }).then(done, () => undefined);
}
