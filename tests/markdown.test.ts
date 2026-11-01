import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from '../web/markdown.js';

const html = (text: string) =>
  renderToStaticMarkup(createElement(Markdown, { text }));

await test('agent replies render as formatted text: lists, links, emphasis and code', () => {
  const out = html(
    '按热度排序：\n\n1. [claude-mem](https://github.com/thedotmack/claude-mem)：保存上下文。\n2. **skills**：技能集合，见 https://github.com/mattpocock/skills。\n\n用 `npm start` 启动。',
  );
  assert.match(out, /<p>按热度排序：<\/p>/);
  assert.match(
    out,
    /<ol><li><a href="https:\/\/github.com\/thedotmack\/claude-mem" target="_blank" rel="noopener noreferrer">claude-mem<\/a>：保存上下文。<\/li>/,
  );
  assert.match(out, /<strong>skills<\/strong>/);
  // A bare URL stops before trailing CJK punctuation.
  assert.match(out, /href="https:\/\/github.com\/mattpocock\/skills"/);
  assert.match(
    html('见https://x.dev/a。然后'),
    /">https:\/\/x.dev\/a<\/a>。然后<\/p>/,
  );
  assert.match(out, /<code>npm start<\/code>/);
  assert.match(html('- a\n- b'), /<ul><li>a<\/li><li>b<\/li><\/ul>/);
  assert.match(html('3. c\n4. d'), /<ol start="3">/);
  assert.match(
    html('```\nconst x = 1;\n```'),
    /<pre><code>const x = 1;<\/code><\/pre>/,
  );
  assert.match(html('> quoted'), /<blockquote>quoted<\/blockquote>/);
  assert.match(html('line one\nline two'), /<p>line one<br\/>line two<\/p>/);
});

await test('nothing in a message can inject markup or unsafe links', () => {
  const out = html(
    '<img src=x onerror=alert(1)> [click](javascript:alert(1)) [data](data:text/html,x) <script>alert(1)</script>',
  );
  assert.doesNotMatch(out, /<img|<script|href="javascript|href="data/);
  assert.match(out, /&lt;img/);
  assert.match(out, /\[click\]\(javascript:alert\(1\)\)/);
});
