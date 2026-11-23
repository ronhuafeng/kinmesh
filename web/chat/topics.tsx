import { useState } from 'react';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { NewTopic } from './new-topic.js';

/**
 * The current channel's topics, under it in the sidebar like a tree: "All",
 * the ten most recently active, then the rest only when asked for, a "+" to
 * start one, and leaving the channel. A topic is pressed only while its
 * channel's chat or board is the place on screen (`current`).
 */
export function ChannelTopics({
  data,
  channelPath,
  topic,
  current: here,
  onTopic,
  next,
}: {
  data: WorkspaceSnapshot;
  channelPath: string;
  topic: string;
  current: boolean;
  onTopic: (topic: string) => void;
  next: (key: string, cursor: string | null) => void;
}) {
  const [all, setAll] = useState(false);
  const recent = data.activeTopics.items;
  const shown = new Set(recent.map((t) => t.id));
  // The topic you are in stays in sight even when it is not among the recent.
  const current = data.topics.items.find(
    (t) => t.id === topic && !shown.has(t.id),
  );
  const rest = all
    ? data.topics.items.filter((t) => !shown.has(t.id) && t.id !== current?.id)
    : [];
  const row = (t: { id: string; title: string }) => (
    <li key={t.id}>
      <button
        type="button"
        aria-pressed={here && topic === t.id}
        onClick={() => {
          onTopic(t.id);
        }}
      >
        {t.title}
      </button>
    </li>
  );
  return (
    <div className="channel-topics">
      <ul aria-label="话题">
        {/* "All" leads back to the whole channel, which its own row
            already marks as current; only a topic is pressed. */}
        {recent.length > 0 && (
          <li>
            <button
              type="button"
              onClick={() => {
                onTopic('');
              }}
            >
              全部
            </button>
          </li>
        )}
        {recent.map(row)}
        {current && row(current)}
        {rest.map(row)}
        {data.activeTopics.more &&
          (!all ? (
            <li>
              <button
                type="button"
                className="quiet"
                onClick={() => {
                  setAll(true);
                }}
              >
                更多话题
              </button>
            </li>
          ) : (
            data.topics.nextCursor && (
              <li>
                <button
                  type="button"
                  className="quiet"
                  onClick={() => {
                    next('topicsCursor', data.topics.nextCursor);
                  }}
                >
                  更多话题
                </button>
              </li>
            )
          ))}
        <li>
          <NewTopic channelPath={channelPath} onCreated={onTopic} />
        </li>
      </ul>
    </div>
  );
}
