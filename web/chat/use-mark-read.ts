import { useEffect, useRef } from 'react';
import { request } from '../shared/api.js';
import { atBottom } from './use-reading-position.js';

/**
 * Tells the hub what you have read: while the channel has something unread,
 * once its newest message on screen is in view in a visible tab, you have
 * read up to it, in the topic you are reading or in the whole channel. Each
 * message is told once; one that didn't go is told again at the next look.
 */
export function useMarkRead(
  channelPath: string,
  topicId: string,
  newest: string | undefined,
  unread: boolean,
  permitted: boolean,
) {
  const told = useRef('');
  useEffect(() => {
    if (!unread || !permitted || newest === undefined) return;
    const key = channelPath + ' ' + topicId + ' ' + newest;
    const look = () => {
      if (told.current === key) return;
      if (document.visibilityState !== 'visible' || !atBottom()) return;
      told.current = key;
      request(channelPath + '/read', {
        messageId: newest,
        topicId: topicId === '' ? null : topicId,
      }).catch(() => {
        if (told.current === key) told.current = '';
      });
    };
    look();
    window.addEventListener('scroll', look, { passive: true });
    document.addEventListener('visibilitychange', look);
    return () => {
      window.removeEventListener('scroll', look);
      document.removeEventListener('visibilitychange', look);
    };
  }, [channelPath, topicId, newest, unread, permitted]);
}
