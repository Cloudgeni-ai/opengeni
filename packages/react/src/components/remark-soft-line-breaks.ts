/**
 * remark: render a single newline inside prose as a line break.
 *
 * CommonMark folds a lone line ending inside a paragraph into a space, so an
 * agent writing `1\n2\n3` shows "1 2 3". Chat surfaces (ChatGPT, GitHub
 * comments) keep the line, which is what message authors expect. This plugin
 * turns every line ending inside an mdast `text` node into a `break` node — the
 * same result as `remark-breaks` — while leaving code (`code` / `inlineCode`
 * carry `value`, not `text` children), raw HTML, and block structure (lists,
 * tables, blockquotes, headings, blank-line paragraphs) untouched.
 *
 * Unlike `remark-breaks` (built on `mdast-util-find-and-replace`, which drops
 * positions on the split nodes), every split text node keeps a source position.
 * Streaming tip ink (`rehypeStreamReveal`) keys fade-in on those offsets, so a
 * positionless line would render without ink and snap in at the stream tail.
 *
 * Structural local types keep the module dependency-free, like
 * `stream-reveal.ts`; the renderer casts once at the plugin seam.
 */

type MdPoint = {
  line?: number | undefined;
  column?: number | undefined;
  offset?: number | undefined;
};

type MdPosition = { start?: MdPoint | undefined; end?: MdPoint | undefined };

type MdNode = {
  type: string;
  value?: string | undefined;
  position?: MdPosition | undefined;
  children?: MdNode[] | undefined;
};

type ExactPoint = { line: number; column: number; offset: number };

const LINE_ENDING = /\r\n|\r|\n/g;
const HAS_LINE_ENDING = /[\r\n]/;
/** Line-start syntax the parser strips from text values: indentation and blockquote markers. */
const LINE_PREFIX = /[\t >]*/y;

export function remarkSoftLineBreaks() {
  return (tree: MdNode, file?: { value?: unknown } | undefined) => {
    walk(tree, typeof file?.value === "string" ? file.value : undefined);
  };
}

function walk(node: MdNode, source: string | undefined): void {
  if (!node.children) {
    return;
  }
  let next: MdNode[] | null = null;
  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index]!;
    if (
      child.type === "text" &&
      typeof child.value === "string" &&
      HAS_LINE_ENDING.test(child.value)
    ) {
      next ??= node.children.slice(0, index);
      next.push(...splitText(child, child.value, source));
      continue;
    }
    walk(child, source);
    next?.push(child);
  }
  if (next !== null) {
    node.children = next;
  }
}

function splitText(node: MdNode, value: string, source: string | undefined): MdNode[] {
  const segments: { value: string; index: number }[] = [];
  let cursor = 0;
  for (const match of value.matchAll(LINE_ENDING)) {
    segments.push({ value: value.slice(cursor, match.index), index: cursor });
    cursor = match.index + match[0].length;
  }
  segments.push({ value: value.slice(cursor), index: cursor });

  const starts = segmentStarts(node, segments, source);
  const nodeEnd = exactPoint(node.position?.end);
  const out: MdNode[] = [];
  segments.forEach((segment, k) => {
    const start = starts?.[k];
    const isLast = k === segments.length - 1;
    const end =
      start === undefined
        ? undefined
        : isLast && nodeEnd !== undefined
          ? nodeEnd
          : {
              line: start.line,
              column: start.column + segment.value.length,
              offset: start.offset + segment.value.length,
            };
    if (segment.value.length > 0) {
      out.push({
        type: "text",
        value: segment.value,
        ...(start !== undefined && end !== undefined ? { position: { start, end } } : {}),
      });
    }
    if (!isLast) {
      const nextStart = starts?.[k + 1];
      out.push({
        type: "break",
        ...(end !== undefined && nextStart !== undefined
          ? { position: { start: end, end: nextStart } }
          : {}),
      });
    }
  });
  return out;
}

/**
 * Source start of each line segment. Text values drop each continuation line's
 * indentation / `>` prefix, so offsets are re-anchored on the real source line
 * when the node's source slice has the same number of line endings; otherwise
 * (e.g. a newline produced by a character reference) fall back to the value
 * index, the same approximation tip ink already makes within one text node.
 */
function segmentStarts(
  node: MdNode,
  segments: readonly { index: number }[],
  source: string | undefined,
): ExactPoint[] | undefined {
  const start = exactPoint(node.position?.start);
  if (start === undefined) {
    return undefined;
  }
  const endOffset = node.position?.end?.offset;
  const lineStarts: number[] = [];
  if (source !== undefined && endOffset !== undefined && endOffset >= start.offset) {
    for (const match of source.slice(start.offset, endOffset).matchAll(LINE_ENDING)) {
      lineStarts.push(start.offset + match.index + match[0].length);
    }
  }
  const anchoredSource = lineStarts.length === segments.length - 1 ? source : undefined;
  return segments.map((segment, k) => {
    if (k === 0) {
      return start;
    }
    if (anchoredSource !== undefined) {
      const lineStart = lineStarts[k - 1]!;
      LINE_PREFIX.lastIndex = lineStart;
      const prefix = LINE_PREFIX.exec(anchoredSource)?.[0].length ?? 0;
      return { line: start.line + k, column: prefix + 1, offset: lineStart + prefix };
    }
    return { line: start.line + k, column: 1, offset: start.offset + segment.index };
  });
}

function exactPoint(point: MdPoint | undefined): ExactPoint | undefined {
  if (
    point === undefined ||
    typeof point.line !== "number" ||
    typeof point.column !== "number" ||
    typeof point.offset !== "number"
  ) {
    return undefined;
  }
  return { line: point.line, column: point.column, offset: point.offset };
}
