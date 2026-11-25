import { prepareMathMarkdown, type PreparedMathMarkdown } from "@opengeni/react/markdown-math";

/*
 * Bounds for drawing assistant Markdown in the native timeline.
 *
 * One Markdown parse never sees more than MAX_MARKDOWN_CHUNK_LENGTH UTF-16 code units
 * (about 1,300 words, after math normalization). A longer message is cut into chunks at
 * top-level block boundaries outside code fences and display math, and each chunk is
 * parsed on its own, so parsing work grows linearly with the message and crafted input
 * can never cost more than one bounded parse per chunk. While a message streams, only
 * its last chunk changes, so earlier chunks are not parsed again.
 *
 * In a long message, a code fence that starts at the beginning of a line is its own
 * unit and is drawn directly (code block, interactive preview or interactive answer),
 * without Markdown, so an `opengeni-html` visual of any length still renders.
 *
 * A message longer than MAX_MARKDOWN_LENGTH, and a single block longer than one chunk
 * (one giant paragraph), are shown as selectable plain-text pages instead.
 */

/** The most text one Markdown parse sees. */
export const MAX_MARKDOWN_CHUNK_LENGTH = 8_192;
/** The longest message drawn with formatting (about 10,000 words). */
export const MAX_MARKDOWN_LENGTH = 65_536;
/** Chunks are packed up to this size, leaving room for math normalization to expand. */
const CHUNK_TARGET_LENGTH = MAX_MARKDOWN_CHUNK_LENGTH / 2;

/** Math-normalized Markdown that fits one bounded parse, or null. */
export function prepareBoundedMarkdown(text: string): PreparedMathMarkdown | null {
  if (text.length > MAX_MARKDOWN_CHUNK_LENGTH) return null;
  const prepared = prepareMathMarkdown(text);
  // Math delimiter normalization can expand otherwise in-budget input.
  return prepared.text.length <= MAX_MARKDOWN_CHUNK_LENGTH ? prepared : null;
}

export type MarkdownSegment =
  /** Bounded Markdown: one parse. */
  | { kind: "markdown"; source: string; prepared: PreparedMathMarkdown }
  /** A top-level code fence, drawn without Markdown. `closed` is false while it streams. */
  | { kind: "fence"; source: string; language: string; content: string; closed: boolean }
  /** A block too long for one parse, shown as plain-text pages. */
  | { kind: "plain"; source: string };

type Line = { start: number; end: number; text: string };

function linesOf(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline + 1;
    lines.push({ start, end, text: text.slice(start, newline === -1 ? end : newline) });
    start = end;
  }
  return lines;
}

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

type OpenFence = { char: string; length: number };

/** A CommonMark fence opener on this line (backtick info strings cannot contain backticks). */
function fenceOpener(line: string): (OpenFence & { indent: number; info: string }) | null {
  const match = FENCE_OPEN.exec(line);
  if (!match) return null;
  const marker = match[2]!;
  const info = match[3]!;
  if (marker[0] === "`" && info.includes("`")) return null;
  return { char: marker[0]!, length: marker.length, indent: match[1]!.length, info };
}

function closesFence(line: string, fence: OpenFence): boolean {
  const match = FENCE_CLOSE.exec(line);
  return !!match && match[1]![0] === fence.char && match[1]!.length >= fence.length;
}

/** The closer a multi-line display math opener waits for (as prepareMathMarkdown reads it). */
function displayMathCloser(line: string): "$$" | "\\]" | null {
  const trimmed = line.trim();
  const opener = trimmed.startsWith("$$") ? "$$" : trimmed.startsWith("\\[") ? "\\[" : null;
  if (!opener) return null;
  const closer = opener === "$$" ? "$$" : "\\]";
  const rest = trimmed.slice(2);
  if (rest.trimEnd().endsWith(closer) && rest.trim().length > closer.length) return null;
  if (opener === "$$" ? rest.includes("$") : rest.includes("\\]")) return null;
  return closer;
}

type Block =
  | { kind: "text"; start: number; end: number }
  | {
      kind: "fence";
      start: number;
      end: number;
      language: string;
      content: string;
      closed: boolean;
    };

/**
 * Top-level blocks: text runs that can be parsed apart, and fences at column 0.
 * Text is cut only before an unindented line that follows a blank line (so no list
 * item, quote, paragraph or indented code continues across the cut), and never inside
 * a fence or display math. Concatenating every block gives back the message.
 */
function blocksOf(text: string): Block[] {
  const lines = linesOf(text);
  const blocks: Block[] = [];
  let textStart = 0;
  const cut = (at: number) => {
    if (at > textStart) blocks.push({ kind: "text", start: textStart, end: at });
    textStart = at;
  };
  let nested: OpenFence | null = null;
  let math: { closer: "$$" | "\\]"; start: number } | null = null;
  let previousBlank = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (nested) {
      if (closesFence(line.text, nested)) nested = null;
      previousBlank = false;
      continue;
    }
    const opener = fenceOpener(line.text);
    if (math) {
      const current = line.text.trim();
      // An unclosed opener is text (prepareMathMarkdown) after the longest block one parse can hold.
      if (opener || line.start - math.start > MAX_MARKDOWN_CHUNK_LENGTH) math = null;
      else {
        if (current.endsWith(math.closer) || (current === "" && math.closer === "\\]")) {
          math = null;
        }
        previousBlank = current === "";
        continue;
      }
    }
    if (opener && opener.indent === 0) {
      // A column-0 fence interrupts any paragraph, list or quote: it is its own block.
      cut(line.start);
      const body: string[] = [];
      let end = text.length;
      let closed = false;
      for (index++; index < lines.length; index++) {
        const inner = lines[index]!;
        if (closesFence(inner.text, opener)) {
          end = inner.end;
          closed = true;
          break;
        }
        body.push(inner.text);
      }
      blocks.push({
        kind: "fence",
        start: line.start,
        end,
        language: opener.info.trim().split(/\s+/)[0] ?? "",
        content: body.join("\n"),
        closed,
      });
      textStart = end;
      previousBlank = false;
      continue;
    }
    if (opener) {
      // An indented fence (in a list item): never cut inside it.
      nested = opener;
      previousBlank = false;
      continue;
    }
    const blank = line.text.trim() === "";
    if (previousBlank && !blank && !/^[ \t]/.test(line.text)) cut(line.start);
    const closer = displayMathCloser(line.text);
    if (closer) math = { closer, start: line.start };
    previousBlank = blank;
  }
  cut(text.length);
  return blocks;
}

function textSegment(source: string): MarkdownSegment {
  const prepared = prepareBoundedMarkdown(source);
  return prepared ? { kind: "markdown", source, prepared } : { kind: "plain", source };
}

/**
 * How to draw a message: one Markdown parse when it fits, bounded chunks when it is
 * long, or null when it is too long to format at all (plain-text pages).
 */
export function markdownSegments(text: string): MarkdownSegment[] | null {
  if (text.length > MAX_MARKDOWN_LENGTH) return null;
  const whole = prepareBoundedMarkdown(text);
  if (whole) return [{ kind: "markdown", source: text, prepared: whole }];
  const segments: MarkdownSegment[] = [];
  let chunk: { start: number; end: number } | null = null;
  const flush = () => {
    if (chunk) segments.push(textSegment(text.slice(chunk.start, chunk.end)));
    chunk = null;
  };
  for (const block of blocksOf(text)) {
    if (block.kind === "fence") {
      flush();
      const { language, content, closed } = block;
      segments.push({
        kind: "fence",
        source: text.slice(block.start, block.end),
        language,
        content,
        closed,
      });
    } else if (chunk && block.end - chunk.start <= CHUNK_TARGET_LENGTH) {
      chunk.end = block.end;
    } else {
      flush();
      chunk = { start: block.start, end: block.end };
    }
  }
  flush();
  return segments;
}

// Leave one code unit of headroom to keep surrogate pairs together without
// scanning/splitting the entire message or exceeding the per-page bound.
const PAGE_LENGTH = MAX_MARKDOWN_CHUNK_LENGTH - 1;

export function plainTextPage(text: string, requestedPage: number) {
  const count = Math.max(1, Math.ceil(text.length / PAGE_LENGTH));
  const index = Math.max(0, Math.min(requestedPage, count - 1));
  const boundary = (offset: number) => {
    const before = text.charCodeAt(offset - 1);
    const after = text.charCodeAt(offset);
    return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
      ? offset - 1
      : offset;
  };
  return {
    index,
    count,
    text: text.slice(boundary(index * PAGE_LENGTH), boundary((index + 1) * PAGE_LENGTH)),
  };
}
