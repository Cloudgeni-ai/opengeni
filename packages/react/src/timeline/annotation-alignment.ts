/* ----------------------------------------------------------------------------
   Matching rendered text against markdown source text.

   A message is stored as markdown but shown rendered, so a selection such as
   "do you mean Claude Max on me@example.com" comes from source text like
   "do you mean **Claude Max on** [me@example.com](mailto:me@example.com)".
   These helpers line the two up while skipping markdown syntax and
   whitespace, so an annotation can cover exactly what the person selected.
   -------------------------------------------------------------------------- */

export type TextSpan = { start: number; end: number };

/** Characters markdown can use as syntax that rendering drops. */
const MARKUP_CHARACTERS = new Set(["*", "_", "~", "`", "[", "]", "<", ">", "|", "\\", "#"]);

/** Block markers at the start of a line: headings, quotes, list items, tasks. */
const LINE_START_MARKER =
  /^(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+(?:\[[ xX]\][ \t]+)?|\d{1,9}[.)][ \t]+)/;
/** Table delimiter rows and thematic breaks, which render as no text. */
const LINE_START_RULE = /^[ \t]*(?=[|:\- \t]*-{3})[|:\- \t]+(?=\n|$)/;

/** Longest link destination or reference label skipped as syntax. */
const MAX_LINK_TAIL = 2048;

function isSpace(character: string | undefined): boolean {
  return character !== undefined && /\s/.test(character);
}

function atLineStart(text: string, index: number): boolean {
  let cursor = index - 1;
  while (cursor >= 0 && (text[cursor] === " " || text[cursor] === "\t")) cursor--;
  return cursor < 0 || text[cursor] === "\n";
}

/** Index just past the `)` closing a link destination that starts at `open + 1`. */
function closingParen(text: string, open: number): number {
  let depth = 1;
  const limit = Math.min(text.length, open + 1 + MAX_LINK_TAIL);
  for (let index = open + 1; index < limit; index++) {
    const character = text[index];
    if (character === "\n") return -1;
    if (character === "\\") {
      index++;
      continue;
    }
    if (character === "(") depth++;
    else if (character === ")" && --depth === 0) return index + 1;
  }
  return -1;
}

/** How many characters of markdown syntax start at `index` (0 when none). */
export function markupLengthAt(text: string, index: number): number {
  const character = text[index];
  if (character === undefined) return 0;
  if (character === "]" && text[index + 1] === "(") {
    const end = closingParen(text, index + 1);
    if (end > 0) return end - index;
  }
  if (character === "]" && text[index + 1] === "[") {
    const end = text.indexOf("]", index + 2);
    if (end > 0 && end - index <= MAX_LINK_TAIL && !text.slice(index, end).includes("\n")) {
      return end - index + 1;
    }
  }
  if (atLineStart(text, index)) {
    const head = text.slice(index, index + 64);
    const rule = LINE_START_RULE.exec(head);
    if (rule && rule[0].length > 0) return rule[0].length;
    const marker = LINE_START_MARKER.exec(head);
    if (marker) return marker[0].length;
  }
  if (character === "!" && text[index + 1] === "[") return 1;
  return MARKUP_CHARACTERS.has(character) ? 1 : 0;
}

function skipSpace(text: string, index: number): number {
  while (index < text.length && isSpace(text[index])) index++;
  return index;
}

/**
 * Where `plain` ends when matched against `markup` from `start`, or null.
 * Matching ignores whitespace on both sides and skips markdown syntax in
 * `markup`; equal characters are always matched first.
 */
function alignRenderedAt(markup: string, start: number, plain: string): number | null {
  let m = start;
  let p = 0;
  let end = start;
  for (;;) {
    p = skipSpace(plain, p);
    if (p >= plain.length) return end;
    m = skipSpace(markup, m);
    if (m >= markup.length) return null;
    if (markup[m] === plain[p]) {
      m++;
      p++;
      end = m;
      continue;
    }
    const skip = markupLengthAt(markup, m);
    if (skip === 0) return null;
    m += skip;
  }
}

/**
 * Where a markdown `quote` ends when matched against rendered `plain` text from
 * `start`, or null. The mirror of `alignRenderedAt`: syntax is skipped in the
 * quote instead.
 */
function alignMarkupAt(plain: string, start: number, quote: string): number | null {
  let p = start;
  let q = 0;
  let end = start;
  for (;;) {
    q = skipSpace(quote, q);
    if (q >= quote.length) return end;
    p = skipSpace(plain, p);
    if (p < plain.length && plain[p] === quote[q]) {
      p++;
      q++;
      end = p;
      continue;
    }
    const skip = markupLengthAt(quote, q);
    if (skip === 0) return null;
    q += skip;
  }
}

function firstContentIndex(text: string): number {
  let index = skipSpace(text, 0);
  for (;;) {
    const skip = markupLengthAt(text, index);
    if (skip === 0) return index;
    index = skipSpace(text, index + skip);
  }
}

function countOf(text: string, token: string): number {
  return text.split(token).length - 1;
}

/**
 * Widens a span of markdown so the syntax inside it is balanced: emphasis it
 * opens is closed, and a link it starts keeps its destination.
 */
export function balanceMarkupSpan(text: string, span: TextSpan): TextSpan {
  let { start, end } = span;
  for (const token of ["**", "__", "~~", "`"]) {
    const quote = text.slice(start, end);
    if (countOf(quote, token) % 2 === 0) continue;
    // An odd delimiter right after text closes emphasis the quote starts
    // inside; otherwise it opens emphasis the quote ends inside.
    const first = quote.indexOf(token);
    const closes = first > 0 && !isSpace(quote[first - 1]);
    if (closes) {
      const open = text.lastIndexOf(token, start - token.length);
      if (open >= 0 && !text.slice(open, start).includes("\n")) start = open;
    } else {
      const close = text.indexOf(token, end);
      if (close >= 0 && !text.slice(end, close).includes("\n")) end = close + token.length;
    }
  }
  for (const token of ["*", "_"]) {
    const inner = text.slice(start, end).replaceAll(token + token, "");
    if (countOf(inner, token) % 2 === 0) continue;
    if (text[end] === token && text[end + 1] !== token) end += 1;
    else if (text[start - 1] === token && text[start - 2] !== token) start -= 1;
  }
  const quote = text.slice(start, end);
  if (countOf(quote, "[") > countOf(quote, "]")) {
    if (text[end] === "]") end += markupLengthAt(text, end);
  } else if (countOf(quote, "]") > countOf(quote, "[")) {
    const open = text.lastIndexOf("[", start);
    if (open >= 0 && start - open <= MAX_LINK_TAIL && !text.slice(open, start).includes("\n")) {
      start = open;
    }
  }
  return { start, end };
}

/**
 * Spans of markdown `source` that render as `rendered`, in order. Each span
 * starts at the first rendered character and is widened to balanced syntax.
 */
export function sourceSpansForRenderedText(source: string, rendered: string): TextSpan[] {
  const plain = rendered.trim();
  if (!plain) return [];
  const first = plain[0]!;
  const spans: TextSpan[] = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf(first, from);
    if (start < 0) break;
    const end = alignRenderedAt(source, start, plain);
    if (end !== null) {
      spans.push(balanceMarkupSpan(source, { start, end }));
      from = end;
    } else {
      from = start + 1;
    }
  }
  return spans;
}

/** Spans of rendered `plain` text that show the markdown `quote`, in order. */
export function renderedSpansForSourceQuote(plain: string, quote: string): TextSpan[] {
  const firstIndex = firstContentIndex(quote);
  const first = quote[firstIndex];
  if (first === undefined) return [];
  const spans: TextSpan[] = [];
  let from = 0;
  for (;;) {
    const start = plain.indexOf(first, from);
    if (start < 0) break;
    const end = alignMarkupAt(plain, start, quote.slice(firstIndex));
    if (end !== null) {
      spans.push({ start, end });
      from = end;
    } else {
      from = start + 1;
    }
  }
  return spans;
}

/**
 * How a markdown quote reads once rendered, for showing it in annotation
 * chips, cards and previews. Links keep their text, emphasis and block
 * markers drop out, and escaped characters lose their backslash.
 */
export function renderedMarkdownQuote(quote: string): string {
  return quote
    .replace(/!?\[([^\]\n]*)\]\((?:[^()\n]|\([^()\n]*\))*\)/g, "$1")
    .replace(/!?\[([^\]\n]*)\]\[[^\]\n]*\]/g, "$1")
    .replace(
      /^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+(?:\[[ xX]\][ \t]+)?|\d{1,9}[.)][ \t]+)/gm,
      "",
    )
    .replace(/(\*\*|__|~~)/g, "")
    .replace(/`+/g, "")
    .replace(/(^|[\s([{"'])[*_](?=\S)/g, "$1")
    .replace(/(\S)[*_](?=$|[\s.,;:!?)\]}"'])/gm, "$1")
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~<])/g, "$1");
}
