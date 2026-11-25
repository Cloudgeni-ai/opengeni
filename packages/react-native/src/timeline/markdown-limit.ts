import {
  displayMathBlockEnds,
  prepareMathMarkdown,
  type PreparedMathMarkdown,
} from "@opengeni/react/markdown-math";

/*
 * Bounds for drawing assistant Markdown in the native timeline.
 *
 * One Markdown parse never sees more than MAX_MARKDOWN_CHUNK_LENGTH UTF-16 code units
 * (about 1,300 words, after math normalization). A longer message is cut into chunks at
 * top-level block boundaries outside code fences and display math, and each chunk is
 * prepared and parsed on its own, so the work grows linearly with the message and
 * crafted input can never cost more than one bounded parse per chunk. While a message
 * streams, chunks whose text did not change are not prepared or parsed again.
 *
 * In a long message, a code fence at the beginning of a line that is too long to share
 * a chunk is its own unit, drawn directly (code block, interactive preview or
 * interactive answer) without Markdown, so an `opengeni-html` visual of any length
 * still renders. Smaller fences stay in their chunk and render through Markdown's
 * fence rule, which draws them the same way. A message therefore has at most about
 * 2 × MAX_MARKDOWN_LENGTH / CHUNK_TARGET_LENGTH segments.
 *
 * A long message is mounted a bounded slice at a time (mountedSegmentCount), one slice
 * per frame, so no frame parses or mounts more than one chunk of Markdown. A code block
 * longer than one chunk is shown as plain-text pages; a large preview loads in its own
 * web view.
 *
 * A message longer than MAX_MARKDOWN_LENGTH, and a single text block longer than one
 * chunk (one giant paragraph), are shown as selectable plain-text pages instead.
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
  /** At most one chunk of Markdown (a parse after math normalization, or plain pages). */
  | { kind: "markdown"; source: string }
  /** A top-level code fence, drawn without Markdown. `closed` is false while it streams. */
  | { kind: "fence"; source: string; language: string; content: string; closed: boolean }
  /** A block too long for one parse, shown as plain-text pages. */
  | { kind: "plain"; source: string };

/** A source line without its ending. Lines end as markdown-it reads them: LF, CRLF or CR. */
type Line = { start: number; end: number; text: string };

function linesOf(text: string): Line[] {
  const lines: Line[] = [];
  const ending = /\r\n?|\n/g;
  let start = 0;
  while (start < text.length) {
    ending.lastIndex = start;
    const match = ending.exec(text);
    const stop = match ? match.index : text.length;
    const end = match ? stop + match[0].length : text.length;
    lines.push({ start, end, text: text.slice(start, stop) });
    start = end;
  }
  return lines;
}

// The info string may hold any character but a line ending (U+2028 included).
const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})([\s\S]*)$/;
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

/**
 * Whether a fence opened at line `index` has a closer anywhere after it: for each fence
 * character, the longest closer at or after each line, built once (linear).
 */
function fenceClosers(lines: Line[]): (index: number, fence: OpenFence) => boolean {
  const longest = { "`": new Int32Array(lines.length + 1), "~": new Int32Array(lines.length + 1) };
  for (let index = lines.length - 1; index >= 0; index--) {
    longest["`"][index] = longest["`"][index + 1]!;
    longest["~"][index] = longest["~"][index + 1]!;
    const match = FENCE_CLOSE.exec(lines[index]!.text);
    if (match) {
      const char = match[1]![0] as "`" | "~";
      longest[char][index] = Math.max(longest[char][index]!, match[1]!.length);
    }
  }
  return (index, fence) => longest[fence.char as "`" | "~"][index + 1]! >= fence.length;
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
 * a fence or a display math block (found by the same rule the math pass uses).
 * Concatenating every block gives back the message. Linear in the message length.
 */
function blocksOf(text: string): Block[] {
  const lines = linesOf(text);
  const mathEnd = displayMathBlockEnds(lines.map((line) => line.text));
  const closable = fenceClosers(lines);
  const blocks: Block[] = [];
  let textStart = 0;
  const cut = (at: number) => {
    if (at > textStart) blocks.push({ kind: "text", start: textStart, end: at });
    textStart = at;
  };
  let nested: (OpenFence & { start: number; closable: boolean }) | null = null;
  let previousBlank = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (nested) {
      // An indented fence that never closes runs to the end of its list item; past one
      // chunk it cannot be drawn formatted anyway, so stop protecting it and let the rest
      // of the message still be. A fence that does close stays whole, however long.
      if (
        closesFence(line.text, nested) ||
        (!nested.closable && line.start - nested.start > MAX_MARKDOWN_CHUNK_LENGTH)
      ) {
        nested = null;
      }
      previousBlank = false;
      continue;
    }
    const opener = fenceOpener(line.text);
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
      nested = { ...opener, start: line.start, closable: closable(index, opener) };
      previousBlank = false;
      continue;
    }
    const blank = line.text.trim() === "";
    if (previousBlank && !blank && !/^[ \t]/.test(line.text)) cut(line.start);
    const math = mathEnd(index);
    if (math !== null) {
      // A closed display block stays whole; its last line ends with its closer.
      index = math;
      previousBlank = false;
      continue;
    }
    previousBlank = blank;
  }
  cut(text.length);
  return blocks;
}

/**
 * How to draw a message: one Markdown segment when it fits one parse, bounded segments
 * when it is long, or null when it is too long to format at all (plain-text pages).
 * Linear in the message length; math normalization happens per chunk when it is drawn.
 */
export function markdownSegments(text: string): MarkdownSegment[] | null {
  if (text.length > MAX_MARKDOWN_LENGTH) return null;
  if (text.length <= MAX_MARKDOWN_CHUNK_LENGTH) return [{ kind: "markdown", source: text }];
  const segments: MarkdownSegment[] = [];
  let chunk: { start: number; end: number } | null = null;
  const flush = () => {
    if (chunk) {
      const source = text.slice(chunk.start, chunk.end);
      segments.push({
        kind: source.length <= MAX_MARKDOWN_CHUNK_LENGTH ? "markdown" : "plain",
        source,
      });
    }
    chunk = null;
  };
  for (const block of blocksOf(text)) {
    if (block.kind === "fence" && block.end - block.start > CHUNK_TARGET_LENGTH) {
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

/** Segments mounted per frame: about one chunk of text, and a few at most. */
const MOUNT_LENGTH_PER_FRAME = CHUNK_TARGET_LENGTH;
const MOUNT_SEGMENTS_PER_FRAME = 8;

/**
 * How many leading segments to have mounted after one more frame, starting from
 * `mounted`: at least one more, then more while they fit one frame's budget. The first
 * frame takes up to one full chunk, the bound a single message had before chunking.
 */
export function mountedSegmentCount(segments: readonly MarkdownSegment[], mounted: number) {
  if (mounted >= segments.length) return segments.length;
  const budget = mounted === 0 ? MAX_MARKDOWN_CHUNK_LENGTH : MOUNT_LENGTH_PER_FRAME;
  let next = mounted;
  let length = 0;
  while (next < segments.length && next - mounted < MOUNT_SEGMENTS_PER_FRAME) {
    length += segments[next]!.source.length;
    if (next > mounted && length > budget) break;
    next++;
  }
  return next;
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
