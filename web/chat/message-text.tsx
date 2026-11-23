import { memo } from 'react';
import { Markdown } from '../shared/markdown.js';

/** The text of a message, drawn again only when the text changes. */
export const MessageText = memo(function MessageText({
  text,
}: {
  text: string;
}) {
  return <Markdown text={text} />;
});
