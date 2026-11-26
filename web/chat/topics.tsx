import { useState } from 'react';
import { TOPICS_FIRST, TOPICS_MOST } from '../../src/domain/communication.js';
import { topicTitle } from '../shared/names.js';
import { AddButton, InlineField } from '../shared/forms.js';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';

/**
 * A topic starts from a "+" after the topics: one field, Enter creates it
 * and opens it.
 */
export function NewTopic({
  channelPath,
  onCreated,
}: {
  channelPath: string;
  onCreated: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return open ? (
    <InlineField
      name="title"
      label="话题名称"
      placeholder="新话题"
      maxLength={160}
      path={channelPath + '/topics'}
      className="pill"
      onClose={() => {
        setOpen(false);
      }}
      onCreated={onCreated}
    />
  ) : (
    <AddButton
      label="新建话题"
      className="topic-add"
      onClick={() => {
        setOpen(true);
      }}
    />
  );
}
/**
 * The current channel's topics, under it in the sidebar like a tree: "All",
 * the ten most recently active, then the rest of the same list only when
 * asked for (更多话题, which reaches further each time), a "+" to start one.
 * The topic you are in is always there. A topic is pressed only while its
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
  const listed = data.topics.items;
  const recent = listed.slice(0, 10);
  const shown = new Set<string>(recent.map((t) => t.id));
  // The topic you are in stays in sight even when it is not among the recent.
  const title = shown.has(topic) ? null : topicTitle(data, topic || null);
  const current = title === null ? undefined : { id: topic, title };
  const rest = all ? listed.slice(10).filter((t) => t.id !== current?.id) : [];
  const further = data.topics.more && listed.length < TOPICS_MOST;
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
        {(listed.length > 10 || further) &&
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
            further && (
              <li>
                <button
                  type="button"
                  className="quiet"
                  onClick={() => {
                    next(
                      'topicsShown',
                      String(
                        Math.min(listed.length + TOPICS_FIRST, TOPICS_MOST),
                      ),
                    );
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
