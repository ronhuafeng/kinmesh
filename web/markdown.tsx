import type { ReactNode } from 'react';
import { MermaidBlock } from './mermaid.js';

/**
 * A small, safe Markdown subset for messages: paragraphs, line breaks, lists,
 * quotes, headings, code (a fence keeps its language; a mermaid fence is
 * drawn), tables, emphasis, links and images. It builds React elements only,
 * never HTML; links go only to http(s) addresses, in a new tab, and an image
 * shows only from this site (anything else is its link).
 */
export function Markdown({ text }: { text: string }) {
  return <>{blocks(text)}</>;
}

const INLINE =
  /`([^`\n]+)`|!\[([^\]\n]*)\]\(([^\s)]+)\)|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*\n]+)\*\*|(?<![\w*])\*([^*\n]+)\*(?![\w*])|(https?:\/\/[^\s<>()"'\u0080-\uffff]*[^\s<>()"'.,;:!?\u0080-\uffff])/g;

function link(href: string, children: ReactNode, key: number) {
  return (
    <a key={key} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}
/**
 * An image from this site, opening its original in a new tab. The page may
 * load images only from here, so one from elsewhere is shown as its link,
 * and an address that is neither is left as it was written.
 */
function image(alt: string, src: string, key: number) {
  if (/^\/(?!\/)/.test(src))
    return (
      <a
        key={key}
        href={src}
        target="_blank"
        rel="noopener noreferrer"
        className="md-image"
      >
        <img src={src} alt={alt} loading="lazy" decoding="async" />
      </a>
    );
  if (/^https?:\/\//.test(src)) return link(src, alt || src, key);
  return `![${alt}](${src})`;
}
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const [, code, alt, src, label, href, bold, em, url] = m;
    if (code !== undefined) out.push(<code key={key++}>{code}</code>);
    else if (alt !== undefined && src !== undefined)
      out.push(image(alt, src, key++));
    else if (label !== undefined && href !== undefined)
      out.push(link(href, inline(label), key++));
    else if (bold !== undefined)
      out.push(<strong key={key++}>{inline(bold)}</strong>);
    else if (em !== undefined) out.push(<em key={key++}>{inline(em)}</em>);
    else if (url !== undefined) out.push(link(url, url, key++));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
/** Lines joined by line breaks, each with inline formatting. */
function lines(rows: string[]): ReactNode[] {
  return rows.flatMap((row, i) =>
    i === 0 ? inline(row) : [<br key={'br' + String(i)} />, ...inline(row)],
  );
}
const FENCE = /^\s*```/;
/** A table's second row: its columns' rules and alignment. */
const RULE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;
/** A row's cells, between its pipes (an escaped pipe stays text). */
function cells(row: string) {
  const inner = row
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '');
  return inner
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, '|'));
}
function tableAt(rows: string[], i: number) {
  const head = rows[i] ?? '';
  const rule = rows[i + 1] ?? '';
  return (
    head.includes('|') &&
    RULE.test(rule) &&
    cells(head).length === cells(rule).length
  );
}
type Align = 'left' | 'center' | 'right' | undefined;
function table(rows: string[], key: number) {
  const [head = '', rule = '', ...body] = rows;
  const align: Align[] = cells(rule).map((c) =>
    c.startsWith(':') && c.endsWith(':')
      ? 'center'
      : c.endsWith(':')
        ? 'right'
        : c.startsWith(':')
          ? 'left'
          : undefined,
  );
  const width = align.length;
  const row = (line: string) => {
    const values = cells(line);
    return Array.from({ length: width }, (_, n) => values[n] ?? '');
  };
  return (
    // Wide tables scroll inside the message, by keyboard too.
    <div
      key={key}
      className="md-table"
      role="region"
      aria-label="表格"
      tabIndex={0}
    >
      <table>
        <thead>
          <tr>
            {row(head).map((cell, n) => (
              <th
                key={n}
                scope="col"
                style={align[n] ? { textAlign: align[n] } : undefined}
              >
                {inline(cell)}
              </th>
            ))}
          </tr>
        </thead>
        {body.length > 0 && (
          <tbody>
            {body.map((line, r) => (
              <tr key={r}>
                {row(line).map((cell, n) => (
                  <td
                    key={n}
                    style={align[n] ? { textAlign: align[n] } : undefined}
                  >
                    {inline(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        )}
      </table>
    </div>
  );
}
const BULLET = /^\s*[-*+]\s+/;
const NUMBER = /^\s*(\d{1,9})[.)]\s+/;

function blocks(text: string): ReactNode[] {
  const rows = text.replace(/\r\n?/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < rows.length) {
    const row = rows[i] ?? '';
    if (row.trim() === '') {
      i++;
      continue;
    }
    if (FENCE.test(row)) {
      // The fence's language is the first word after it.
      const lang = /^\s*```\s*([\w+#.-]*)/.exec(row)?.[1]?.toLowerCase() ?? '';
      const code: string[] = [];
      i++;
      while (i < rows.length && !FENCE.test(rows[i] ?? '')) {
        code.push(rows[i] ?? '');
        i++;
      }
      i++;
      const source = code.join('\n');
      out.push(
        lang === 'mermaid' && source.trim() !== '' ? (
          <MermaidBlock key={key++} source={source} />
        ) : (
          <pre key={key++} data-lang={lang || undefined}>
            <code className={lang ? 'language-' + lang : undefined}>
              {source}
            </code>
          </pre>
        ),
      );
      continue;
    }
    if (tableAt(rows, i)) {
      const lines = [rows[i] ?? '', rows[i + 1] ?? ''];
      i += 2;
      while (
        i < rows.length &&
        (rows[i] ?? '').includes('|') &&
        (rows[i] ?? '').trim() !== ''
      ) {
        lines.push(rows[i] ?? '');
        i++;
      }
      out.push(table(lines, key++));
      continue;
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(row);
    if (heading) {
      out.push(
        <p key={key++} className="md-heading">
          <strong>{inline(heading[1] ?? '')}</strong>
        </p>,
      );
      i++;
      continue;
    }
    if (BULLET.test(row) || NUMBER.test(row)) {
      const ordered = NUMBER.test(row);
      const marker = ordered ? NUMBER : BULLET;
      const start = ordered ? Number(NUMBER.exec(row)?.[1] ?? '1') : 1;
      const items: string[][] = [];
      while (i < rows.length) {
        const current = rows[i] ?? '';
        if (marker.test(current)) items.push([current.replace(marker, '')]);
        else if (current.trim() !== '' && /^\s+/.test(current))
          items.at(-1)?.push(current.trim());
        else break;
        i++;
      }
      const children = items.map((item, n) => <li key={n}>{lines(item)}</li>);
      out.push(
        ordered ? (
          <ol key={key++} start={start === 1 ? undefined : start}>
            {children}
          </ol>
        ) : (
          <ul key={key++}>{children}</ul>
        ),
      );
      continue;
    }
    if (/^\s*>\s?/.test(row)) {
      const quote: string[] = [];
      while (i < rows.length && /^\s*>\s?/.test(rows[i] ?? '')) {
        quote.push((rows[i] ?? '').replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(<blockquote key={key++}>{lines(quote)}</blockquote>);
      continue;
    }
    const paragraph: string[] = [];
    while (
      i < rows.length &&
      (rows[i] ?? '').trim() !== '' &&
      !FENCE.test(rows[i] ?? '') &&
      !tableAt(rows, i) &&
      !BULLET.test(rows[i] ?? '') &&
      !NUMBER.test(rows[i] ?? '') &&
      !/^\s{0,3}#{1,6}\s/.test(rows[i] ?? '') &&
      !/^\s*>/.test(rows[i] ?? '')
    ) {
      paragraph.push(rows[i] ?? '');
      i++;
    }
    out.push(<p key={key++}>{lines(paragraph)}</p>);
  }
  return out;
}
/**
 * A message as one plain line, for a list: the words without their Markdown
 * (fences, code ticks, emphasis, headings, quotes, list marks; a link keeps
 * its text).
 */
export function plainText(text: string) {
  return (
    text
      .replace(/```[^\n]*\n?/g, ' ')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      // A table reads as its cells: no rule row, no pipes.
      .replace(/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/gm, '')
      .replace(/^\s*\|(.*?)\|?\s*$/gm, (_, row: string) =>
        row.replace(/\|/g, ' '),
      )
      .replace(/^[ \t]*(?:#{1,6}|>|[-*+]|\d+[.)])[ \t]+/gm, '')
      .replace(/`+|\*+|~~|__/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}
