import { useState } from 'react';
import { AddButton } from '../shared/add-button.js';
import { InlineField } from '../shared/inline-field.js';

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
