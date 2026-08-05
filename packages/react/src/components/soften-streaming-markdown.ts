/**
 * Display-only softener for mid-stream markdown.
 *
 * While tokens are still arriving, incomplete markers (`**bold`, an open
 * fence, a half-finished link) would otherwise render as raw punctuation —
 * the hard "breaking" flash. This closes a small set of common unfinished
 * constructs so the parse looks settled; the SOURCE string is never mutated
 * (callers pass the softened copy only into the markdown parser).
 *
 * When the real closers land, the softened and true parses converge and the
 * crystallize breath covers the remount.
 */

export function softenStreamingMarkdown(source: string): string {
  if (source.length === 0) {
    return source;
  }
  let text = source;

  // Unclosed fenced code block: an odd count of ``` line-openers means the
  // trailing fence is still in flight. Always soft-close — including an empty
  // opener — so code chrome (padding/tint) appears once at ``` and lines only
  // grow the body. Stripping empty openers deferred chrome until the first
  // body line, which landed as one fat height spike (yank around fences).
  //
  // If the body already ends with `\n`, append only ``` — a second `\n``` would
  // invent a blank line that vanishes when the real closer lands (height shrink
  // → tip-follow compensate + mid soft-rise cancel = up/down flicker).
  if (countFences(text) % 2 === 1) {
    text += text.endsWith("\n") ? "```" : "\n```";
  }

  // Work outside fenced blocks so we don't "fix" markers that are literal
  // code content.
  const segments = splitByFences(text);
  for (const segment of segments) {
    if (segment.kind === "fence") {
      continue;
    }
    segment.value = closeInlineMarkers(segment.value);
  }
  let result = segments.map((segment) => segment.value).join("");
  // split("\n") drops a trailing newline into an empty final line; restore it
  // so balanced finished fences round-trip byte-identical.
  if (text.endsWith("\n") && !result.endsWith("\n")) {
    result += "\n";
  }
  return result;
}

function countFences(text: string): number {
  let count = 0;
  for (const line of text.split("\n")) {
    if (/^ {0,3}```/.test(line)) {
      count += 1;
    }
  }
  return count;
}

type Segment = { kind: "prose" | "fence"; value: string };

function splitByFences(text: string): Segment[] {
  const segments: Segment[] = [];
  const lines = text.split("\n");
  let buf: string[] = [];
  let inFence = false;
  /**
   * `boundary`: prose → fence. `join` alone drops a blank line before ```
   * (`["a",""].join` → `"a\n"`, need `"a\n\n"`), so append an extra `\n`.
   * `end`: final segment. Trailing `""` from `split("\n")` already encodes a
   * terminating newline — do NOT append another (that was inventing `\n\n`
   * on every streamed line and shrinking it away at crystallize).
   */
  const flush = (kind: Segment["kind"], mode: "boundary" | "end") => {
    if (buf.length === 0) {
      return;
    }
    let value = buf.join("\n");
    if (mode === "boundary") {
      value += "\n";
    }
    segments.push({ kind, value });
    buf = [];
  };
  for (const line of lines) {
    const isFence = /^ {0,3}```/.test(line);
    if (isFence) {
      if (inFence) {
        buf.push(line);
        flush("fence", "end");
        inFence = false;
      } else {
        flush("prose", "boundary");
        buf.push(line);
        inFence = true;
      }
      continue;
    }
    buf.push(line);
  }
  flush(inFence ? "fence" : "prose", "end");
  return segments;
}

/**
 * Close unmatched **, *, ~~, and ` in prose. Order matters: handle the
 * longer bold/strike markers before single `*` so we don't steal from `**`.
 */
function closeInlineMarkers(prose: string): string {
  let text = prose;
  text = closeDelimiter(text, "~~");
  text = closeDelimiter(text, "**");
  text = closeDelimiter(text, "__");
  text = closeSingleBackticks(text);
  text = closeSingleAsterisks(text);
  text = closeUnfinishedLink(text);
  return text;
}

function closeDelimiter(text: string, delimiter: string): string {
  // Count occurrences that aren't escaped. Odd → append a closer.
  let count = 0;
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\\" && i + 1 < text.length) {
      i += 2;
      continue;
    }
    if (text.startsWith(delimiter, i)) {
      count += 1;
      i += delimiter.length;
      continue;
    }
    i += 1;
  }
  return count % 2 === 1 ? insertBeforeTrailingNewlines(text, delimiter) : text;
}

/** Soft closers belong before trailing `\n`s so restore/round-trip stay stable. */
function insertBeforeTrailingNewlines(text: string, suffix: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === "\n") {
    end -= 1;
  }
  return text.slice(0, end) + suffix + text.slice(end);
}

function closeSingleBackticks(text: string): string {
  // Ignore ``` (fences already stripped) and even pairs. A trailing unmatched
  // ` is the common "inline code still typing" case.
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\\" && i + 1 < text.length) {
      i += 1;
      continue;
    }
    if (text[i] === "`") {
      // Skip triple backticks if any leaked into prose.
      if (text.startsWith("```", i)) {
        i += 2;
        continue;
      }
      count += 1;
    }
  }
  return count % 2 === 1 ? insertBeforeTrailingNewlines(text, "`") : text;
}

function closeSingleAsterisks(text: string): string {
  // Count `*` that are NOT part of `**` (already handled). Odd → close italic.
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\\" && i + 1 < text.length) {
      i += 1;
      continue;
    }
    if (text[i] === "*" && text[i + 1] === "*") {
      i += 1;
      continue;
    }
    if (text[i] === "*") {
      count += 1;
    }
  }
  return count % 2 === 1 ? insertBeforeTrailingNewlines(text, "*") : text;
}

function closeUnfinishedLink(text: string): string {
  // `[label](url` without the trailing `)` — close it. Bare `[label` without
  // `](` is left alone (too ambiguous with footnotes / prose brackets).
  const open = text.lastIndexOf("](");
  if (open === -1) {
    return text;
  }
  const after = text.slice(open + 2);
  if (after.includes(")")) {
    return text;
  }
  // Don't close if a later `[` started something else after.
  if (after.includes("[")) {
    return text;
  }
  return insertBeforeTrailingNewlines(text, ")");
}
