import { isValidElement } from 'react';
import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import remarkCjkFriendly from 'remark-cjk-friendly';
import remarkCjkFriendlyGfmStrikethrough from 'remark-cjk-friendly-gfm-strikethrough';
import type { Link, Parent, Root, RootContent, Text } from 'mdast';
import { MermaidBlock } from './mermaid.js';
import { CodeBlock } from './code.js';
import { Copyable } from './code.js';

/**
 * Messages as Markdown, with GitHub's extensions (tables, task lists,
 * strikethrough), a line break for each newline as in chat, and emphasis
 * that works beside Chinese punctuation. It builds React elements only,
 * never HTML: raw HTML stays visible text. Links go only to http(s)
 * addresses, in a new tab; an image shows only from this site (anything
 * else is its link); a mermaid fence is drawn.
 */
export function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[
        remarkGfm,
        remarkBreaks,
        remarkCjkFriendly,
        remarkCjkFriendlyGfmStrikethrough,
        cjkLinks,
      ]}
      components={components}
    >
      {text}
    </ReactMarkdown>
  );
}

const http = (href: string) => /^https?:\/\//i.test(href);

const components: Components = {
  a({ href, children }) {
    if (href === undefined || !http(href)) return <>{children}</>;
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
  /**
   * An image from this site, opening its original in a new tab. The page may
   * load images only from here, so one from elsewhere is shown as its link,
   * and an address that is neither is left as it was written.
   */
  img({ src, alt }) {
    const source = typeof src === 'string' ? src : '';
    const name = alt ?? '';
    if (/^\/(?!\/)/.test(source))
      return (
        <a
          href={source}
          target="_blank"
          rel="noopener noreferrer"
          className="md-image"
        >
          <img src={source} alt={name} loading="lazy" decoding="async" />
        </a>
      );
    if (http(source))
      return (
        <a href={source} target="_blank" rel="noopener noreferrer">
          {name || source}
        </a>
      );
    return <>{`![${name}](${source})`}</>;
  },
  /** A fence keeps its language; a mermaid fence is drawn as its diagram. */
  pre({ children }) {
    const code = isValidElement<{ className?: string; children?: ReactNode }>(
      children,
    )
      ? children.props
      : null;
    const lang = /\blanguage-([\w+#.-]+)/.exec(code?.className ?? '')?.[1];
    const source =
      typeof code?.children === 'string'
        ? code.children.replace(/\n$/, '')
        : '';
    if (lang === 'mermaid' && source.trim() !== '')
      return <MermaidBlock source={source} />;
    if (lang) return <CodeBlock lang={lang} source={source} />;
    return <Copyable source={source}>{children}</Copyable>;
  },
  // Wide tables scroll inside the message, by keyboard too.
  table({ children }) {
    return (
      <div className="md-table" role="region" aria-label="表格" tabIndex={0}>
        <table>{children}</table>
      </div>
    );
  },
  // A message's headings sit under the page's own: # and ## a step above
  // the text, the rest as bold text (DESIGN.md, Messages).
  h1: ({ children }) => <h3>{children}</h3>,
  h2: ({ children }) => <h3>{children}</h3>,
  h3: ({ children }) => <h4>{children}</h4>,
  h4: ({ children }) => <h4>{children}</h4>,
  h5: ({ children }) => <h4>{children}</h4>,
  h6: ({ children }) => <h4>{children}</h4>,
};

/**
 * A bare address in Chinese text: GitHub's autolinks need a space before
 * the address and run on into the Chinese after it. Here an address starts
 * anywhere and stops before the first non-ASCII character or trailing
 * punctuation (`见https://x.dev/a。然后`).
 */
const BARE_URL = /https?:\/\/[^\s<>()"'\u0080-￿]*[^\s<>()"'.,;:!?\u0080-￿]/g;
function cjkLinks() {
  return (tree: Root) => {
    relink(tree);
  };
}
/** A text with its bare addresses as links. */
function linked(value: string): (Text | Link)[] {
  const out: (Text | Link)[] = [];
  let last = 0;
  for (const m of value.matchAll(BARE_URL)) {
    if (m.index > last)
      out.push({ type: 'text', value: value.slice(last, m.index) });
    out.push({
      type: 'link',
      url: m[0],
      children: [{ type: 'text', value: m[0] }],
    });
    last = m.index + m[0].length;
  }
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) });
  return out;
}
/**
 * An address GitHub linked that ran on into Chinese text: cut where the
 * address ends, the rest text again.
 */
function trimmed(link: Link): RootContent[] {
  const [only] = link.children;
  if (link.children.length !== 1 || only?.type !== 'text') return [link];
  const text = only.value;
  const literal =
    link.url === text ||
    link.url === 'http://' + text ||
    link.url === encodeURI(text);
  const cut = text.search(/[\u0080-￿]/);
  if (!literal || cut <= 0) return [link];
  const kept = text.slice(0, cut).replace(/[.,;:!?]+$/, '');
  const prefix = link.url.slice(0, link.url.length - text.length);
  return [
    { ...link, url: prefix + kept, children: [{ type: 'text', value: kept }] },
    ...linked(text.slice(kept.length)),
  ];
}
function relink(node: Parent) {
  const out: RootContent[] = [];
  for (const child of node.children) {
    if (child.type === 'text') out.push(...linked(child.value));
    else if (child.type === 'link') out.push(...trimmed(child));
    else {
      if ('children' in child) relink(child);
      out.push(child);
    }
  }
  node.children = out;
}

/**
 * A message as one plain line, for a list: the words without their Markdown
 * (fences, code ticks, emphasis, headings, quotes, list and task marks; a
 * link keeps its text).
 */
export function plainText(text: string) {
  return (
    text
      .replace(/(?:```|~~~)[^\n]*\n?/g, ' ')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      // A table reads as its cells: no rule row, no pipes.
      .replace(/^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/gm, '')
      .replace(/^\s*\|(.*?)\|?\s*$/gm, (_, row: string) =>
        row.replace(/\|/g, ' '),
      )
      .replace(/^[ \t]*(?:#{1,6}|>|[-*+]|\d+[.)])[ \t]+/gm, '')
      .replace(/^[ \t]*\[[ xX]\][ \t]+/gm, '')
      .replace(/(^|[^\w])_([^_\n]+)_(?=[^\w]|$)/g, '$1$2')
      .replace(/`+|\*+|~~|__/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}
