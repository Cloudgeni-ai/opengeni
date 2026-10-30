/**
 * Claude's web-search citation tags written as text.
 *
 * When Claude has Anthropic's native web search, the API instructs it to wrap
 * quoted claims in `cite` tags whose `index="N-M"` names search result N,
 * sentence M (several ranges are comma-separated). The API turns these into structured
 * citations only in ordinary answer text. Inside a tool argument, such as the
 * `reply` a `wait_for_input` call shows as the turn's answer, the tags arrive
 * verbatim. Neither Markdown nor chat clients render them, so they would show
 * as raw markup.
 *
 * `rewriteClaudeCiteTags` replaces each complete tag with its text, linked to
 * its search result when a resolver supplies one. Fenced code blocks and inline
 * code spans keep their contents exactly. A tag still streaming at the end of
 * the text loses only its unfinished opening tag. Tags are written with
 * character escapes here and in tests, so this file is not itself rewritten
 * by tools that act on the tags.
 */

/** A search result a citation index points at. */
export type ClaudeCiteSource = { url: string; title?: string | null };

/** Resolves a 1-based search-result index to its result, or null. */
export type ClaudeCiteResolver = (resultIndex: number) => ClaudeCiteSource | null | undefined;

const OPEN = "\u003ccite";
// One or more `N-M` ranges, comma-separated, exactly as Claude writes them.
const INDEX = String.raw`\d+-\d+(?:,\s*\d+-\d+)*`;
const COMPLETE_TAG = new RegExp(
  String.raw`\u003ccite index="(${INDEX})">((?:(?!\u003ccite[\s>])[\s\S])*?)\u003c/cite>`,
  "gu",
);
/** An opening tag with no closing tag after it (still streaming, or cut short). */
const UNCLOSED_OPEN_TAG = new RegExp(
  String.raw`\u003ccite index="${INDEX}">(?![\s\S]*\u003c/cite>)`,
  "gu",
);
/** An opening tag cut short at the very end of streaming text. */
const PARTIAL_OPEN_AT_END =
  /\u003c(?:c(?:i(?:t(?:e(?: (?:i(?:n(?:d(?:e(?:x(?:=(?:"[\d,\s-]*)?)?)?)?)?)?)?)?)?)?)?)?$/u;

/** Whether the text holds a Claude citation tag, complete or unfinished. */
export function hasClaudeCiteTag(text: string): boolean {
  return text.includes(`${OPEN} index="`);
}

/**
 * Replace Claude citation tags outside code with their text. With a resolver,
 * text whose first resolvable index has an http(s) source becomes a Markdown
 * link to it. Text without tags comes back unchanged.
 */
export function rewriteClaudeCiteTags(text: string, resolve?: ClaudeCiteResolver): string {
  if (!text.includes(OPEN)) return text;
  // Code is set aside as numbered placeholders, so a tag around inline code
  // still matches while nothing inside code is ever touched.
  if (text.includes(PLACEHOLDER_START)) {
    // Text that already holds the placeholder character is rewritten piece by
    // piece instead; a tag around code then stays plain text.
    return splitCode(text)
      .map((segment) => (segment.code ? segment.text : rewriteProse(segment.text, resolve, [])))
      .join("");
  }
  const code: string[] = [];
  const prose = splitCode(text)
    .map((segment) => {
      if (!segment.code) return segment.text;
      code.push(segment.text);
      return `${PLACEHOLDER_START}${code.length - 1}${PLACEHOLDER_END}`;
    })
    .join("");
  return rewriteProse(prose, resolve, code);
}

const PLACEHOLDER_START = "\u0000";
const PLACEHOLDER_END = "\u0001";
const PLACEHOLDER = /\u0000(\d+)\u0001/gu;

function rewriteProse(prose: string, resolve: ClaudeCiteResolver | undefined, code: string[]) {
  if (code.length === 0) return rewriteTags(prose, resolve);
  return rewriteTags(prose, resolve).replace(PLACEHOLDER, (_m, n: string) => code[Number(n)]!);
}

function rewriteTags(prose: string, resolve: ClaudeCiteResolver | undefined): string {
  return prose
    .replace(COMPLETE_TAG, (_tag, indexes: string, inner: string) =>
      citedText(inner, resolveFirst(indexes, resolve), inner.includes(PLACEHOLDER_START)),
    )
    .replace(UNCLOSED_OPEN_TAG, "")
    .replace(PARTIAL_OPEN_AT_END, "");
}

function resolveFirst(indexes: string, resolve: ClaudeCiteResolver | undefined): string | null {
  if (!resolve) return null;
  for (const range of indexes.split(",")) {
    const result = Number(range.trim().split("-")[0]);
    if (!Number.isSafeInteger(result) || result < 1) continue;
    const source = resolve(result);
    const url = source?.url;
    if (typeof url === "string" && /^https?:\/\/\S+$/iu.test(url)) return url;
  }
  return null;
}

/**
 * The cited text, linked when it can be. A link label cannot hold brackets,
 * links, code or line breaks, so such text keeps its words and gets a short
 * source link after it instead.
 */
function citedText(inner: string, url: string | null, hasCode: boolean): string {
  if (!url || !inner.trim()) return inner;
  const target = url.replace(/[()]/gu, (c) => (c === "(" ? "%28" : "%29"));
  if (hasCode || /[[\]`\n]/u.test(inner)) return `${inner} ([${hostLabel(url)}](${target}))`;
  return `[${inner}](${target})`;
}

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./u, "") || "source";
  } catch {
    return "source";
  }
}

type Segment = { text: string; code: boolean };

const FENCE = /^[ \t]*(`{3,}|~{3,})/u;

/** Split Markdown into code (fenced blocks, inline spans) and everything else. */
function splitCode(text: string): Segment[] {
  const segments: Segment[] = [];
  const lines = text.split(/(?<=\n)/u);
  let prose = "";
  let fence: { character: string; length: number; text: string } | null = null;
  for (const line of lines) {
    if (fence) {
      fence.text += line;
      const close = line.match(/^[ \t]*(`{3,}|~{3,})[ \t]*\r?\n?$/u);
      if (close && close[1]![0] === fence.character && close[1]!.length >= fence.length) {
        segments.push({ text: fence.text, code: true });
        fence = null;
      }
      continue;
    }
    const open = line.match(FENCE);
    if (open) {
      segments.push(...splitInlineCode(prose));
      prose = "";
      fence = { character: open[1]![0]!, length: open[1]!.length, text: line };
      continue;
    }
    prose += line;
  }
  segments.push(...splitInlineCode(prose));
  if (fence) segments.push({ text: fence.text, code: true });
  return segments.filter((segment) => segment.text.length > 0);
}

function splitInlineCode(text: string): Segment[] {
  const segments: Segment[] = [];
  const span = /(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/gu;
  let start = 0;
  for (const match of text.matchAll(span)) {
    segments.push({ text: text.slice(start, match.index), code: false });
    segments.push({ text: match[0], code: true });
    start = match.index! + match[0].length;
  }
  segments.push({ text: text.slice(start), code: false });
  return segments;
}
