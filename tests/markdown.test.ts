import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown, plainText } from '../web/shared/markdown.js';

const html = (text: string) =>
  renderToStaticMarkup(createElement(Markdown, { text })).replace(/\n/g, '');

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
  assert.match(out, /<code>npm start<\/code>/);
  assert.match(html('- a\n- b'), /<ul><li>a<\/li><li>b<\/li><\/ul>/);
  assert.match(html('3. c\n4. d'), /<ol start="3">/);
  assert.match(
    html('```\nconst x = 1;\n```'),
    /<pre><code>const x = 1;\s*<\/code><\/pre>/,
  );
  assert.match(html('> quoted'), /<blockquote><p>quoted<\/p><\/blockquote>/);
  // In chat a newline is a line break.
  assert.match(html('line one\nline two'), /<p>line one<br\/>line two<\/p>/);
});

await test('a bare address in Chinese text is linked and stops where the address ends', () => {
  // GitHub's autolinks need a space before and run on into Chinese after.
  for (const text of ['见https://x.dev/a。然后', '见 https://x.dev/a。然后'])
    assert.match(
      html(text),
      /<a href="https:\/\/x.dev\/a" target="_blank" rel="noopener noreferrer">https:\/\/x.dev\/a<\/a>。然后<\/p>/,
    );
  assert.match(
    html('技能集合，见 https://github.com/mattpocock/skills。'),
    /href="https:\/\/github.com\/mattpocock\/skills"/,
  );
  assert.match(
    html('see https://example.com/x now'),
    /see <a href="https:\/\/example.com\/x"[^>]*>https:\/\/example.com\/x<\/a> now/,
  );
});

await test('the Markdown agents write renders: nesting, tasks, rules, fences, quotes, headings, tables', () => {
  assert.match(html('- a\n  - b\n    - c'), /<ul><li>a<ul><li>b<ul><li>c/);
  const fenced = html('1. run:\n\n   ```sh\n   npm i\n   ```');
  assert.match(
    fenced,
    /<li>.*<pre data-lang="sh"><code class="language-sh">npm i/,
  );
  assert.doesNotMatch(fenced, /```/);
  const tasks = html('- [ ] todo\n- [x] done');
  assert.match(tasks, /<input type="checkbox" disabled=""\/> todo/);
  assert.match(tasks, /<input type="checkbox" disabled="" checked=""\/> done/);
  assert.match(html('~~old~~ new'), /<del>old<\/del> new/);
  assert.match(
    html('_em_ and __bold__'),
    /<em>em<\/em> and <strong>bold<\/strong>/,
  );
  assert.match(html('***both***'), /<em><strong>both<\/strong><\/em>/);
  assert.match(html('``a`b``'), /<code>a`b<\/code>/);
  assert.match(
    html('[w](https://en.wikipedia.org/wiki/Foo_(bar) "Foo")'),
    /href="https:\/\/en.wikipedia.org\/wiki\/Foo_\(bar\)"/,
  );
  assert.match(html('~~~\ncode\n~~~'), /<pre><code>code/);
  assert.match(
    html('````md\n```js\nx\n```\n````'),
    /<pre data-lang="md"><code class="language-md">```js\s*x\s*```/,
  );
  assert.match(html('a\n\n---\n\nb'), /<p>a<\/p><hr\/><p>b<\/p>/);
  assert.match(html('> - one\n> - two'), /<blockquote><ul><li>one/);
  // A message's headings sit under the page's: # and ## one level, the rest
  // the next.
  const headings = html('# One\n\n## Two\n\n### Three');
  assert.match(headings, /<h3>One<\/h3><h3>Two<\/h3><h4>Three<\/h4>/);
  for (const rule of ['| - | - |', '| --- | :-: |'])
    assert.match(
      html(`| a | b |\n${rule}\n| 1 | 2 |`),
      /<div class="md-table" role="region" aria-label="表格" tabindex="0"><table><thead><tr><th[^>]*>a<\/th>.*<td[^>]*>1<\/td>/,
    );
});

await test('emphasis and strikethrough work beside Chinese punctuation', () => {
  assert.match(
    html('这是**「重点」**内容'),
    /这是<strong>「重点」<\/strong>内容/,
  );
  assert.match(
    html('用**加粗（括号）**结尾'),
    /用<strong>加粗（括号）<\/strong>结尾/,
  );
  assert.match(html('~~「旧」~~新的'), /<del>「旧」<\/del>新的/);
});

await test('nothing in a message can inject markup, load an image from elsewhere, or link unsafely', () => {
  const out = html(
    '<img src=x onerror=alert(1)> [click](javascript:alert(1)) [data](data:text/html,x) [far](//evil.example) <script>alert(1)</script>',
  );
  assert.doesNotMatch(
    out,
    /<img|<script|href="javascript|href="data|href="\/\//,
  );
  assert.match(out, /&lt;img/);
  // An unsafe link is its words, not a link.
  assert.match(out, /click/);
  // An image from another host is a link named by its alt text, never an
  // <img> (which would load it, or have React preload it).
  const far = html('![chart](https://evil.example/p.png)');
  assert.doesNotMatch(far, /<img|<link/);
  assert.match(
    far,
    /<a href="https:\/\/evil.example\/p.png" target="_blank" rel="noopener noreferrer">chart<\/a>/,
  );
  // One from this site shows, opening its original.
  assert.match(
    html('![chart](/api/files/p.png)'),
    /<a href="\/api\/files\/p.png"[^>]*class="md-image"><img src="\/api\/files\/p.png" alt="chart"/,
  );
});

await test('a message as one plain line drops its Markdown', () => {
  assert.equal(
    plainText('# Plan\n\n- [x] _ship_ it\n- ~~old~~ new\n\n~~~js\nrun()\n~~~'),
    'Plan ship it old new run()',
  );
  assert.equal(plainText('| a | b |\n| - | - |\n| 1 | 2 |'), 'a b 1 2');
  assert.equal(plainText('snake_case_name stays'), 'snake_case_name stays');
});
