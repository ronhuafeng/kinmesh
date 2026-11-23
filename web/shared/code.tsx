import { useEffect, useState, type ReactNode } from 'react';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import type { Root } from 'hast';
import type { createLowlight } from 'lowlight';
import { CopyButton } from './copy-button.js';

type Lowlight = ReturnType<typeof createLowlight>;
let lowlight: Promise<Lowlight> | null = null;
/**
 * The highlighter, loaded the first time a message has code in a language,
 * as Mermaid is for diagrams: a message without one never loads it.
 */
function highlighter() {
  lowlight ??= import('lowlight').then(({ common, createLowlight }) =>
    createLowlight(common),
  );
  return lowlight;
}
const drawn = new Map<string, Root | null>();
/**
 * A fenced block in its declared language, highlighted by classes only
 * (`hljs-keyword`…, coloured from the design's tokens), so no inline style
 * or HTML is needed. Until the highlighter is there, and for a language it
 * doesn't know, the block is its plain code, in the same box.
 */
export function CodeBlock({ lang, source }: { lang: string; source: string }) {
  const key = lang + '\n' + source;
  const [tree, setTree] = useState<Root | null>(() => drawn.get(key) ?? null);
  useEffect(() => {
    if (drawn.has(key)) {
      setTree(drawn.get(key) ?? null);
      return;
    }
    let live = true;
    void highlighter()
      .then((low) =>
        low.registered(lang) ? low.highlight(lang, source) : null,
      )
      .then(
        (next) => {
          drawn.set(key, next);
          if (live) setTree(next);
        },
        () => undefined,
      );
    return () => {
      live = false;
    };
  }, [key, lang, source]);
  return (
    <Copyable source={source}>
      <pre data-lang={lang}>
        <code className={'language-' + lang}>
          {tree ? toJsxRuntime(tree, { Fragment, jsx, jsxs }) : source}
        </code>
      </pre>
    </Copyable>
  );
}
/** A block of code that copies as written, from a button on its corner. */
export function Copyable({
  source,
  children,
}: {
  source: string;
  children: ReactNode;
}) {
  return (
    <div className="code-block">
      {children}
      <CopyButton text={source} label="复制" className="code-copy" />
    </div>
  );
}
