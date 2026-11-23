import { useEffect, useState, useSyncExternalStore } from 'react';

/**
 * A ```mermaid block drawn as its diagram. Mermaid is loaded only when a
 * message holds one, runs at its strict security level, and its drawing is
 * shown as an image: an SVG in an <img> runs no script and loads nothing,
 * and needs no inline style on this page. Until it is drawn the block keeps
 * its place; if it can't be drawn it stays the code it was, silently.
 */
export function MermaidBlock({ source }: { source: string }) {
  const dark = useDark();
  const [drawn, setDrawn] = useState<Drawing | 'failed' | null>(
    () => cache.get(key(source, dark)) ?? null,
  );
  useEffect(() => {
    const cached = cache.get(key(source, dark));
    if (cached) {
      setDrawn(cached);
      return;
    }
    let live = true;
    draw(source, dark).then(
      (drawing) => {
        cache.set(key(source, dark), drawing);
        if (live) setDrawn(drawing);
      },
      () => {
        if (live) setDrawn('failed');
      },
    );
    return () => {
      live = false;
    };
  }, [source, dark]);
  if (drawn === 'failed')
    return (
      <pre data-lang="mermaid">
        <code className="language-mermaid">{source}</code>
      </pre>
    );
  return (
    <figure className="md-diagram" data-drawn={drawn ? 'true' : undefined}>
      {drawn && (
        <img
          src={drawn.src}
          alt={drawn.label}
          width={drawn.width}
          height={drawn.height}
          draggable={false}
        />
      )}
    </figure>
  );
}
interface Drawing {
  src: string;
  width: number;
  height: number;
  label: string;
}
/**
 * What an untitled diagram shows, for those who can't see it: the first few
 * names its nodes are given (`A["Name"]`, `B(Name)`), else its kind.
 */
export function describe(source: string) {
  const names: string[] = [];
  for (const m of source.matchAll(
    /\b[\w-]+\s*(?:\[\(|\(\[|\[\[|\(\(|\[|\(|\{)\s*"?([^"\]\)\}\n]+?)"?\s*(?:\)\]|\]\)|\]\]|\)\)|\]|\)|\})/g,
  )) {
    const name = (m[1] ?? '')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (name && !names.includes(name)) names.push(name);
    if (names.length === 4) break;
  }
  if (names.length > 0)
    return names.join('、') + (names.length === 4 ? '…' : '');
  return /^\s*(\w+)/.exec(source)?.[1] ?? '';
}
const cache = new Map<string, Drawing>();
const key = (source: string, dark: boolean) => (dark ? 'd:' : 'l:') + source;
let counter = 0;
/** One drawing at a time: Mermaid's settings are global. */
let queue: Promise<unknown> = Promise.resolve();
function draw(source: string, dark: boolean): Promise<Drawing> {
  const next = queue.then(async () => {
    const { default: mermaid } = await import('mermaid');
    const css = getComputedStyle(document.documentElement);
    // A colour token is written light and dark at once (light-dark()); its
    // colour now is what an element showing it computes.
    const probe = document.createElement('span');
    probe.hidden = true;
    document.body.append(probe);
    const colour = (name: string) => {
      probe.style.color = `var(${name})`;
      return getComputedStyle(probe).color;
    };
    const token = (name: string) =>
      name === '--font' ? css.getPropertyValue(name).trim() : colour(name);
    const ink = token('--ink');
    const muted = token('--ink-muted');
    const paper = token('--paper');
    const line = token('--hairline-strong');
    const primary = token('--primary');
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      // A block that can't be drawn stays code; Mermaid adds nothing.
      suppressErrorRendering: true,
      // Laid out by dagre, which comes with Mermaid; its default, ELK, is
      // another 1.5 MB to load.
      layout: 'dagre',
      theme: 'base',
      darkMode: dark,
      fontFamily: token('--font'),
      themeVariables: {
        darkMode: dark,
        background: paper,
        fontFamily: token('--font'),
        fontSize: '14px',
        primaryColor: token('--primary-soft'),
        primaryTextColor: ink,
        primaryBorderColor: primary,
        secondaryColor: token('--agent-soft'),
        tertiaryColor: token('--human-soft'),
        lineColor: muted,
        textColor: ink,
        mainBkg: token('--primary-soft'),
        nodeBorder: primary,
        clusterBkg: token('--raised'),
        clusterBorder: line,
        noteBkgColor: token('--decision-soft'),
        noteTextColor: ink,
        xyChart: {
          backgroundColor: paper,
          titleColor: ink,
          xAxisLabelColor: muted,
          xAxisTitleColor: muted,
          xAxisTickColor: line,
          xAxisLineColor: line,
          yAxisLabelColor: muted,
          yAxisTitleColor: muted,
          yAxisTickColor: line,
          yAxisLineColor: line,
          plotColorPalette: [
            primary,
            token('--agent'),
            token('--human'),
            token('--decision'),
          ].join(', '),
        },
      },
    });
    probe.remove();
    const { svg } = await mermaid.render(
      'mermaid-' + String(++counter),
      source,
    );
    // Mermaid writes its labels as HTML (a `<br/>` in one comes out `<br>`),
    // which an XML parser refuses; read it as a page would, and it is
    // written back as XML below.
    const root = new DOMParser()
      .parseFromString(svg, 'text/html')
      .querySelector('svg');
    if (!root) throw new Error('Mermaid drew nothing');
    const box = (root.getAttribute('viewBox') ?? '')
      .split(/[\s,]+/)
      .map(Number);
    const [, , boxWidth = 0, boxHeight = 0] = box;
    const widest = /max-width:\s*([\d.]+)px/.exec(
      root.getAttribute('style') ?? '',
    );
    const width = Math.round(Number(widest?.[1] ?? boxWidth));
    if (!(width > 0 && boxWidth > 0 && boxHeight > 0))
      throw new Error('Mermaid drew no size');
    // The image draws at its own size; the page scales it to the column.
    root.setAttribute('width', String(width));
    root.setAttribute(
      'height',
      String(Math.round((width * boxHeight) / boxWidth)),
    );
    // Named by its title when it has one.
    const title =
      root.querySelector('title')?.textContent.trim() ??
      /^\s*(?:title|accTitle:?)\s+"?([^"\n]+)"?/m.exec(source)?.[1]?.trim();
    const label = '图表：' + (title ?? describe(source));
    return {
      src:
        'data:image/svg+xml;charset=utf-8,' +
        encodeURIComponent(new XMLSerializer().serializeToString(root)),
      width,
      height: Math.round((width * boxHeight) / boxWidth),
      label,
    };
  });
  queue = next.catch(() => undefined);
  return next;
}
const scheme = () => window.matchMedia('(prefers-color-scheme: dark)');
/** Whether the page is drawn dark, following the system as it changes. */
function useDark() {
  return useSyncExternalStore(
    (changed) => {
      const query = scheme();
      query.addEventListener('change', changed);
      return () => {
        query.removeEventListener('change', changed);
      };
    },
    () => scheme().matches,
    () => false,
  );
}
