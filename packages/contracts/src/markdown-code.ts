/**
 * Markdown code, found so text rewriters can leave it exactly as written.
 * Fenced blocks (``` or ~~~, closed by a fence of the same character at least
 * as long, or running to the end) and inline spans (backtick runs of equal
 * length) are code; everything else is prose. Joining the segments' text gives
 * back the input.
 */

export type MarkdownSegment = { text: string; code: boolean };

const FENCE = /^[ \t]*(`{3,}|~{3,})/u;

/** Split Markdown into code (fenced blocks, inline spans) and everything else. */
export function splitMarkdownCode(text: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
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

function splitInlineCode(text: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  // A span opens and closes with backtick runs of the same length.
  const span = /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/gu;
  let start = 0;
  for (const match of text.matchAll(span)) {
    segments.push({ text: text.slice(start, match.index), code: false });
    segments.push({ text: match[0], code: true });
    start = match.index! + match[0].length;
  }
  segments.push({ text: text.slice(start), code: false });
  return segments;
}
