import stylelint, { type PostcssResult, type Rule } from 'stylelint';

/**
 * Authored styles use the generated tokens for every reusable visual
 * decision. A custom property the stylesheet declares itself is either
 * structural (a size, a gutter: no colour or shape of its own), an alias of a
 * token, or a named theme effect; it never hides a raw colour, shadow or
 * shape. Every `var()` names something that exists.
 */
const ruleName = 'kinmesh/token-policy';
const messages = stylelint.utils.ruleMessages(ruleName, {
  redeclared: (property: string) =>
    `${property} is a generated token: change it in tokens/, not here.`,
  unknown: (name: string) => `${name} is neither a token nor declared here.`,
  laundered: (property: string) =>
    `${property} hides a raw colour, shadow or shape: make it a token in tokens/.`,
  structural: (name: string) =>
    `${name} is structural and cannot supply a colour, shadow or shape.`,
});

const VISUAL =
  /^(?:color|background(?:-color)?|border(?:-[a-z]+)*-color|border(?:-[a-z]+)*-radius|box-shadow|outline-color|fill|stroke|caret-color|text-decoration-color|accent-color)$/;

export interface PolicyOptions {
  /** Every custom property `web/shared/tokens.css` defines. */
  readonly tokens: readonly string[];
  /** The theme's own values that are not a token type: a pressed filter, a
   * hairline's width by screen density. */
  readonly theme?: readonly string[];
  /** Set by scripts at run time from measured geometry. */
  readonly runtime?: readonly string[];
}

export function aliasTarget(value: string): string | null {
  return /^\s*var\(\s*(--[a-z0-9-]+)\s*\)\s*$/i.exec(value)?.[1] ?? null;
}

export function classify(value: string): 'alias' | 'visual' | 'structural' {
  if (
    aliasTarget(value) ||
    /^\s*(?:transparent|currentcolor|none)\s*$/i.test(value)
  )
    return 'alias';
  let stripped = value;
  let previous;
  do {
    previous = stripped;
    stripped = stripped
      .replace(/\bvar\(\s*--[a-z0-9-]+\s*\)/gi, ' ')
      .replace(/\b(?:calc|min|max|clamp|env)\([^()]*\)/gi, ' ');
  } while (stripped !== previous);
  const residue = stripped
    .replace(/-?\d*\.?\d+(?:px|rem|em|%|vh|vw|dvh|dvw|ms|s|deg)?\b/gi, ' ')
    .replace(/[%.,+\-*/()\s]/g, '');
  return /#[0-9a-f]{3,8}\b/i.test(value) || /[a-z]/i.test(residue)
    ? 'visual'
    : 'structural';
}

const rule: Rule<PolicyOptions> =
  (options) => (root, result: PostcssResult) => {
    const generated = new Set(options.tokens);
    const effects = new Set([
      ...(options.theme ?? []),
      ...(options.runtime ?? []),
    ]);
    const aliases = new Set<string>();
    const structural = new Set<string>();
    root.walkDecls((decl) => {
      if (!decl.prop.startsWith('--')) return;
      if (generated.has(decl.prop))
        stylelint.utils.report({
          ruleName,
          result,
          node: decl,
          message: messages.redeclared(decl.prop),
        });
      if (generated.has(decl.prop) || effects.has(decl.prop)) return;
      const kind = classify(decl.value);
      if (kind === 'structural') structural.add(decl.prop);
      else if (kind === 'alias') aliases.add(decl.prop);
      else
        stylelint.utils.report({
          ruleName,
          result,
          node: decl,
          message: messages.laundered(decl.prop),
        });
    });
    root.walkDecls((decl) => {
      for (const match of decl.value.matchAll(/var\(\s*(--[A-Za-z0-9-]+)/g)) {
        const name = match[1] ?? '';
        if (generated.has(name) || aliases.has(name) || effects.has(name))
          continue;
        if (structural.has(name)) {
          if (VISUAL.test(decl.prop))
            stylelint.utils.report({
              ruleName,
              result,
              node: decl,
              message: messages.structural(name),
            });
          continue;
        }
        stylelint.utils.report({
          ruleName,
          result,
          node: decl,
          message: messages.unknown(name),
        });
      }
    });
  };
rule.ruleName = ruleName;
rule.messages = messages;

export default stylelint.createPlugin(ruleName, rule);
