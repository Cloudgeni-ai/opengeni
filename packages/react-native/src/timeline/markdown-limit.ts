import {
  displayMathRanges,
  prepareMathMarkdown,
  type PreparedMathMarkdown,
} from "@opengeni/react/markdown-math";

/*
 * Bounds for drawing assistant Markdown in the native timeline.
 *
 * One Markdown parse never sees more than MAX_MARKDOWN_CHUNK_LENGTH UTF-16 code units
 * (about 1,300 words, after math normalization). A longer message is cut into chunks
 * where markdown-it's own block parser starts a top-level block, never inside display
 * math, and each chunk is prepared and parsed on its own: every chunk parses to the
 * blocks a single parse would give, the inline work grows linearly with the message, and
 * crafted input can never cost more than one bounded parse per chunk. The block pass over
 * the whole message is linear; while a message streams, only its last blocks are
 * block-parsed again, and chunks whose text did not change are not prepared or parsed.
 *
 * In a long message, a top-level code fence too long to share a chunk is its own unit,
 * drawn directly (code block, interactive preview or interactive answer) without
 * Markdown, so an `opengeni-html` visual of any length still renders. Smaller fences
 * stay in their chunk and render through Markdown's fence rule, which draws them the
 * same way.
 *
 * A long message is mounted a bounded slice at a time (mountedSegmentCount), one slice
 * per frame, so no frame parses or mounts more than about one chunk of Markdown. A code
 * block longer than one chunk is shown as plain-text pages; a large preview loads in its
 * own web view.
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

/** The fields of a markdown-it block token the segmenter reads. */
type BlockToken = {
  type: string;
  level: number;
  nesting: number;
  map: [number, number] | null;
  info: string;
  content: string;
  markup: string;
};

const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/** A markdown-it instance: the parser whose block structure the cuts follow. */
export type MarkdownBlockParser = {
  block: { parse(src: string, md: never, env: object, tokens: BlockToken[]): void };
};

/** A top-level block as markdown-it parsed it, by line. */
type Unit = {
  line: number;
  fence: { language: string; content: string; closed: boolean } | null;
  /** The lines where the items of a top-level list start. */
  items: number[] | null;
};

/** Top-level blocks of `lines[from…]`, by markdown-it's own block parser. */
function unitsOf(parser: MarkdownBlockParser, lines: Line[], from: number): Unit[] {
  const tokens: BlockToken[] = [];
  const src = lines
    .slice(from)
    .map((line) => line.text)
    .join("\n");
  parser.block.parse(src, parser as never, {}, tokens);
  const units: Unit[] = [];
  let list: Unit | null = null;
  for (const token of tokens) {
    if (!token.map) continue;
    const line = from + token.map[0];
    if (token.level === 0 && token.nesting !== -1) {
      const isList = token.type === "bullet_list_open" || token.type === "ordered_list_open";
      const unit: Unit = { line, fence: null, items: isList ? [] : null };
      if (token.type === "fence") {
        // At the top level, a last line that can close the fence did close it.
        const last = token.map[1] - token.map[0] >= 2 ? lines[from + token.map[1] - 1] : null;
        const closer = last ? FENCE_CLOSE.exec(last.text)?.[1] : undefined;
        unit.fence = {
          language: token.info.trim().split(/\s+/)[0] ?? "",
          content: token.content.endsWith("\n") ? token.content.slice(0, -1) : token.content,
          closed: !!closer && closer[0] === token.markup[0] && closer.length >= token.markup.length,
        };
      }
      units.push(unit);
      list = isList ? unit : null;
    } else if (list && token.level === 1 && token.type === "list_item_open") {
      list.items!.push(line);
    }
  }
  return units;
}

type Piece = { start: number; end: number; fence: Unit["fence"] };

/**
 * How to draw a message: one Markdown segment when it fits one parse, bounded segments
 * when it is long, or null when it is too long to format at all (plain-text pages).
 *
 * Cuts follow markdown-it's own block structure: a long message is cut only where one of
 * its top-level blocks starts (or, inside a list longer than one chunk, where one of its
 * items starts), so every chunk parses to the same blocks a single parse would give, and
 * a fence is a fence exactly when a single parse says so. Display math blocks, as the
 * math pass finds them, are never cut. Linear in the message length.
 *
 * The segmenter keeps the block structure of the last message it saw: when the new text
 * extends it (streaming), only the blocks from the end of the stable part are parsed again.
 */
export function createMarkdownSegmenter(parser: MarkdownBlockParser) {
  let cached: { text: string; lineCount: number; units: Unit[] } | null = null;
  return (text: string): MarkdownSegment[] | null => {
    if (text.length > MAX_MARKDOWN_LENGTH) return null;
    if (text.length <= MAX_MARKDOWN_CHUNK_LENGTH) return [{ kind: "markdown", source: text }];
    const lines = linesOf(text);
    let units: Unit[];
    // A block boundary is decided by the line that starts the next block and the line after
    // it, so every boundary at least two whole lines before the old text's last (possibly
    // partial) line is unchanged, and markdown-it starts afresh at a top-level block.
    let keep = -1;
    if (cached && text.startsWith(cached.text)) {
      const last = cached.lineCount - 1;
      for (let index = cached.units.length - 1; index >= 0; index--) {
        if (cached.units[index]!.line + 2 <= last) {
          keep = index;
          break;
        }
      }
    }
    if (cached && keep > 0) {
      const from = cached.units[keep]!.line;
      units = [...cached.units.slice(0, keep), ...unitsOf(parser, lines, from)];
    } else {
      units = unitsOf(parser, lines, 0);
    }
    cached = { text, lineCount: lines.length, units };
    return segmentsOf(text, lines, units);
  };
}

/** `createMarkdownSegmenter` for a single message. */
export function markdownSegments(
  text: string,
  parser: MarkdownBlockParser,
): MarkdownSegment[] | null {
  return createMarkdownSegmenter(parser)(text);
}

function segmentsOf(text: string, lines: Line[], units: Unit[]): MarkdownSegment[] {
  const offset = (line: number) => (line < lines.length ? lines[line]!.start : text.length);
  // Lines inside a display math block: no cut before them.
  const inMath = new Uint8Array(lines.length);
  for (const { start, end } of displayMathRanges(lines.map((line) => line.text))) {
    inMath.fill(1, start + 1, end + 1);
  }
  const pieces: Piece[] = [];
  const add = (start: number, end: number, fence: Unit["fence"]) => {
    const previous = pieces[pieces.length - 1];
    if (previous && inMath[start]) {
      previous.end = end;
      previous.fence = null;
    } else {
      pieces.push({ start, end, fence });
    }
  };
  units.forEach((unit, index) => {
    const start = index === 0 ? 0 : unit.line;
    const end = units[index + 1]?.line ?? lines.length;
    if (!unit.items || offset(end) - offset(start) <= CHUNK_TARGET_LENGTH) {
      add(start, end, unit.fence);
      return;
    }
    // A list longer than one chunk may be cut between its items.
    const starts = [start, ...unit.items.filter((line) => line > start)];
    starts.forEach((item, at) => add(item, starts[at + 1] ?? end, null));
  });
  if (pieces.length === 0) pieces.push({ start: 0, end: lines.length, fence: null });

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
  for (const piece of pieces) {
    const start = offset(piece.start);
    const end = offset(piece.end);
    if (piece.fence && end - start > CHUNK_TARGET_LENGTH) {
      flush();
      segments.push({ kind: "fence", source: text.slice(start, end), ...piece.fence });
    } else if (chunk && end - chunk.start <= CHUNK_TARGET_LENGTH) {
      chunk.end = end;
    } else {
      flush();
      chunk = { start, end };
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
