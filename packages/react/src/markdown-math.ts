/* Math in chat markdown, shared by the web and native renderers.

   Agents write TeX with any of the usual delimiters: `$…$`, `$$…$$`, `\(…\)` and
   `\[…\]`. CommonMark treats `\(` and `\[` as escaped punctuation, so without help the
   backslashes vanish and the reader sees bare brackets. `prepareMathMarkdown` rewrites
   every math span to the one form the renderers parse: `$$…$$` inside a line for inline
   math, and a `$$` fence block for display math. Single dollars follow Pandoc's rule (an
   opening `$` has a non-space after it, a closing `$` has a non-space before it and no
   digit after it), so prices such as `$5 and $10` or `$5-$10` stay text. Code spans and
   fenced code blocks are never touched. A display block that has not closed yet (still
   streaming) stays text until its closing delimiter arrives. */

export type PreparedMathMarkdown = {
  /** Markdown with every math span in `$$` form; the input itself when there is none. */
  text: string;
  /** Whether the text contains math the renderer should typeset. */
  hasMath: boolean;
};

/** Cheap check before the full scan: no `$`, `\(` or `\[` means no math. */
export function mayContainMath(text: string): boolean {
  return text.includes("$") || text.includes("\\(") || text.includes("\\[");
}

const FENCE = /^( {0,3})(`{3,}|~{3,})/;

/** Rewrite the math in `text` to `$$` form and report whether there is any. */
export function prepareMathMarkdown(text: string): PreparedMathMarkdown {
  if (!mayContainMath(text)) return { text, hasMath: false };
  const lines = text.split("\n");
  const out: string[] = [];
  let hasMath = false;
  let fence: { char: string; length: number } | null = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (fence) {
      out.push(line);
      const close = FENCE.exec(line);
      if (
        close &&
        close[2]![0] === fence.char &&
        close[2]!.length >= fence.length &&
        line.slice(close[0].length).trim() === ""
      ) {
        fence = null;
      }
      continue;
    }
    const open = FENCE.exec(line);
    if (open) {
      fence = { char: open[2]![0]!, length: open[2]!.length };
      out.push(line);
      continue;
    }
    const block = displayBlock(lines, index);
    if (block) {
      if (block.body !== null) {
        hasMath = true;
        out.push(`${block.indent}$$`, ...block.body.map((body) => `${block.indent}${body}`));
        out.push(`${block.indent}$$`);
      } else {
        // Unclosed: keep the opener as text until the closing delimiter streams in.
        out.push(`${block.indent}${block.opener === "$$" ? "\\$\\$" : "\\\\["}${block.rest}`);
      }
      index = block.end;
      continue;
    }
    const inline = inlineMath(line);
    hasMath ||= inline.hasMath;
    out.push(inline.text);
  }
  return { text: out.join("\n"), hasMath };
}

type DisplayBlock = {
  indent: string;
  opener: "$$" | "\\[";
  /** Text after an unclosed opener on its line. */
  rest: string;
  /** Math lines, or null when the block never closes. */
  body: string[] | null;
  /** Index of the last source line the block covers. */
  end: number;
};

/**
 * A display block starting at `lines[start]`: `$$` or `\[` on a line of its own (math on
 * the following lines up to a matching `$$` or `\]` line), or a whole line that is
 * `$$…$$` or `\[…\]`.
 */
function displayBlock(lines: string[], start: number): DisplayBlock | null {
  const line = lines[start]!;
  const indent = /^\s*/.exec(line)![0];
  const trimmed = line.trim();
  const opener = trimmed.startsWith("$$") ? "$$" : trimmed.startsWith("\\[") ? "\\[" : null;
  if (!opener) return null;
  const closer = opener === "$$" ? "$$" : "\\]";
  const rest = trimmed.slice(2);
  // One line: `$$ x $$` or `\[ x \]`.
  if (rest.trimEnd().endsWith(closer) && rest.trim().length > closer.length) {
    const body = rest.trimEnd().slice(0, -closer.length).trim();
    if (body !== "" && !body.includes(closer)) {
      return { indent, opener, rest, body: [body], end: start };
    }
    return null;
  }
  // Multi-line: the opener line may carry the first math after it, the closer line the last.
  if (opener === "$$" && rest.includes("$")) return null;
  if (opener === "\\[" && rest.includes("\\]")) return null;
  const body: string[] = rest.trim() === "" ? [] : [rest.trim()];
  for (let index = start + 1; index < lines.length; index++) {
    const current = lines[index]!.trim();
    if (FENCE.test(lines[index]!)) break;
    if (current.endsWith(closer)) {
      const last = current.slice(0, -closer.length).trim();
      if (last !== "") body.push(last);
      if (body.length === 0) return null;
      return { indent, opener, rest, body, end: index };
    }
    // A blank line ends a `\[` paragraph in Markdown; `$$` math may contain blank lines.
    if (current === "" && opener === "\\[") break;
    body.push(current);
  }
  return { indent, opener, rest, body: null, end: start };
}

/** Rewrite the inline math of one line, leaving code spans alone. */
function inlineMath(line: string): { text: string; hasMath: boolean } {
  if (!mayContainMath(line)) return { text: line, hasMath: false };
  let out = "";
  let hasMath = false;
  let index = 0;
  while (index < line.length) {
    const char = line[index]!;
    if (char === "`") {
      const run = /^`+/.exec(line.slice(index))![0];
      const close = findBacktickRun(line, index + run.length, run.length);
      const end = close === -1 ? index + run.length : close + run.length;
      out += line.slice(index, end);
      index = end;
      continue;
    }
    if (char === "\\") {
      const next = line[index + 1];
      if (next === "(" || next === "[") {
        const closer = next === "(" ? "\\)" : "\\]";
        const close = line.indexOf(closer, index + 2);
        const body = close === -1 ? "" : line.slice(index + 2, close).trim();
        if (body !== "" && !body.includes("$")) {
          out += next === "(" ? `$$${body}$$` : `$$\\displaystyle ${body}$$`;
          hasMath = true;
          index = close + 2;
          continue;
        }
      }
      // Any other escape (`\$`, `\\`, `\*`) passes through as a pair.
      out += line.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (char === "$") {
      if (line[index + 1] === "$") {
        const close = line.indexOf("$$", index + 2);
        if (close !== -1 && line.slice(index + 2, close).trim() !== "") {
          out += line.slice(index, close + 2);
          hasMath = true;
          index = close + 2;
          continue;
        }
        out += "\\$\\$";
        index += 2;
        continue;
      }
      const close = singleDollarClose(line, index);
      if (close !== -1) {
        out += `$$${line.slice(index + 1, close)}$$`;
        hasMath = true;
        index = close + 1;
        continue;
      }
      out += "$";
      index += 1;
      continue;
    }
    out += char;
    index += 1;
  }
  return { text: out, hasMath };
}

/** The closing `$` for an opening `$` at `open` under Pandoc's rule, or -1. */
function singleDollarClose(line: string, open: number): number {
  const first = line[open + 1];
  if (first === undefined || /\s/.test(first)) return -1;
  for (let index = open + 1; index < line.length; index++) {
    const char = line[index]!;
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "`") return -1;
    if (char !== "$") continue;
    if (line[index + 1] === "$") return -1;
    const before = line[index - 1]!;
    const after = line[index + 1];
    if (index > open + 1 && !/\s/.test(before) && (after === undefined || !/\d/.test(after))) {
      return index;
    }
  }
  return -1;
}

function findBacktickRun(line: string, from: number, length: number): number {
  for (let index = from; index < line.length; index++) {
    if (line[index] !== "`") continue;
    const run = /^`+/.exec(line.slice(index))![0];
    if (run.length === length) return index;
    index += run.length - 1;
  }
  return -1;
}
