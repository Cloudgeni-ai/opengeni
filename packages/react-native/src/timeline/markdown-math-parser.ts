/* markdown-it rules for the `$$` math that `prepareMathMarkdown` produces: `$$…$$` inside
   a line becomes a `math_inline` token, a `$$` fence block a `math_block` token. */
import type { MarkdownIt } from "react-native-markdown-display";

type Parser = ReturnType<typeof MarkdownIt>;
type StateInline = {
  src: string;
  pos: number;
  posMax: number;
  push: (type: string, tag: string, nesting: number) => { content: string; markup: string };
};
type StateBlock = {
  src: string;
  bMarks: number[];
  eMarks: number[];
  tShift: number[];
  line: number;
  push: (
    type: string,
    tag: string,
    nesting: number,
  ) => { content: string; markup: string; block: boolean; map: [number, number] };
};

/** markdown-it rules for `$$…$$` inside a line and `$$` fence blocks. */
export function markdownItMath(md: Parser): void {
  md.inline.ruler.before("escape", "math_inline", ((state: StateInline, silent: boolean) => {
    const { src, pos } = state;
    if (src.charCodeAt(pos) !== 0x24 || src.charCodeAt(pos + 1) !== 0x24) return false;
    const close = src.indexOf("$$", pos + 2);
    if (close === -1 || close > state.posMax) return false;
    const content = src.slice(pos + 2, close);
    if (content.trim() === "") return false;
    if (!silent) {
      const token = state.push("math_inline", "math", 0);
      token.content = content.trim();
      token.markup = "$$";
    }
    state.pos = close + 2;
    return true;
  }) as never);
  md.block.ruler.before(
    "fence",
    "math_block",
    ((state: StateBlock, startLine: number, endLine: number, silent: boolean) => {
      const lineText = (line: number) =>
        state.src.slice(state.bMarks[line]! + state.tShift[line]!, state.eMarks[line]!).trim();
      if (lineText(startLine) !== "$$") return false;
      let line = startLine + 1;
      while (line < endLine && lineText(line) !== "$$") line += 1;
      if (line >= endLine) return false;
      if (silent) return true;
      const body: string[] = [];
      for (let index = startLine + 1; index < line; index++) body.push(lineText(index));
      const token = state.push("math_block", "math", 0);
      token.block = true;
      token.content = body.join("\n");
      token.markup = "$$";
      token.map = [startLine, line + 1];
      state.line = line + 1;
      return true;
    }) as never,
    { alt: ["paragraph", "reference", "blockquote", "list"] },
  );
}
