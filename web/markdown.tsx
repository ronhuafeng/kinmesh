import type { ReactNode } from 'react';

/**
 * A small, safe Markdown subset for messages: paragraphs, line breaks, lists,
 * quotes, headings, code, emphasis and links. It builds React elements only,
 * never HTML, and links only to http(s) addresses, in a new tab.
 */
export function Markdown({ text }: { text: string }) {
  return <>{blocks(text)}</>;
}

const INLINE =
  /`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*\n]+)\*\*|(?<![\w*])\*([^*\n]+)\*(?![\w*])|(https?:\/\/[^\s<>()"'\u0080-\uffff]*[^\s<>()"'.,;:!?\u0080-\uffff])/g;

function link(href: string, children: ReactNode, key: number) {
  return (
    <a key={key} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const [, code, label, href, bold, em, url] = m;
    if (code !== undefined) out.push(<code key={key++}>{code}</code>);
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
    if (/^\s*```/.test(row)) {
      const code: string[] = [];
      i++;
      while (i < rows.length && !/^\s*```/.test(rows[i] ?? '')) {
        code.push(rows[i] ?? '');
        i++;
      }
      i++;
      out.push(
        <pre key={key++}>
          <code>{code.join('\n')}</code>
        </pre>,
      );
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
      !/^\s*```/.test(rows[i] ?? '') &&
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
