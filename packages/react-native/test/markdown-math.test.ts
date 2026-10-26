import { describe, expect, test } from "bun:test";
import { prepareMathMarkdown } from "@opengeni/react/markdown-math";
import { createMathEngine } from "../src/timeline/math-engine";
import { markdownItMath } from "../src/timeline/markdown-math-parser";

type Node = { type: string; content?: string; children: Node[] };

// The renderer's own parse pipeline (without React Native), with the math parser.
const parserPath = Bun.resolveSync(
  "react-native-markdown-display/src/lib/parser.js",
  import.meta.dir,
);
const { default: parser } = (await import(parserPath)) as {
  default: (source: string, render: (ast: Node[]) => Node[], markdownIt: unknown) => Node[];
};
const markdownItPath = Bun.resolveSync("markdown-it", parserPath);
const { default: MarkdownIt } = (await import(markdownItPath)) as {
  default: (options: object) => { use: (plugin: unknown) => unknown };
};
const markdownIt = MarkdownIt({ typographer: false, linkify: true });
markdownIt.use(markdownItMath);

function mathNodes(source: string): Array<{ type: string; content: string; parent: string }> {
  const found: Array<{ type: string; content: string; parent: string }> = [];
  const walk = (nodes: Node[], parent: string) => {
    for (const node of nodes) {
      if (node.type.startsWith("math_")) {
        found.push({ type: node.type, content: node.content ?? "", parent });
      }
      walk(node.children ?? [], node.type);
    }
  };
  walk(
    parser(prepareMathMarkdown(source).text, (ast) => ast, markdownIt),
    "root",
  );
  return found;
}

describe("native math parsing", () => {
  test("inline and display math become math tokens", () => {
    expect(
      mathNodes("Let \\(\\Omega\\) and $x$ be given.\n\n\\[\n\\boxed{x = 1}\n\\]\n\nDone."),
    ).toEqual([
      { type: "math_inline", content: "\\Omega", parent: "textgroup" },
      { type: "math_inline", content: "x", parent: "textgroup" },
      { type: "math_block", content: "\\boxed{x = 1}", parent: "root" },
    ]);
  });

  test("prices and code are not math", () => {
    expect(mathNodes("It costs $5 and $10.\n\n```\n$$\nx\n$$\n```")).toEqual([]);
  });
});

describe("native math typesetting", () => {
  const typeset = createMathEngine();

  test("TeX becomes an SVG with its size and baseline", () => {
    const math = typeset("\\frac{a}{b}", false);
    expect(math).not.toBeNull();
    expect(math!.svg.startsWith("<svg")).toBe(true);
    expect(math!.svg).not.toContain("<use");
    expect(math!.svg).not.toMatch(/^<svg[^>]* (width|height|style)=/);
    expect(math!.width).toBeGreaterThan(0);
    expect(math!.height).toBeGreaterThan(0);
    expect(math!.depth).toBeGreaterThan(0);
  });

  test("bad TeX returns null so the source shows instead", () => {
    expect(typeset("\\frac{1", false)).toBeNull();
    expect(typeset("\\notacommand{x}", true)).toBeNull();
  });
});
