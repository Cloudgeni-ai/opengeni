import { describe, expect, test } from "bun:test";
import {
  MAX_MARKDOWN_CHUNK_LENGTH,
  MAX_MARKDOWN_LENGTH,
  createMarkdownSegmenter,
  markdownItMathRanges,
  markdownSegments as segmentWith,
  mountedSegmentCount,
  type MarkdownSegment,
  plainTextPage,
  prepareBoundedMarkdown,
} from "../src/timeline/markdown-limit";
import { markdownItMath } from "../src/timeline/markdown-math-parser";
import { prepareMathMarkdown } from "@opengeni/react/markdown-math";

const rendererPath = Bun.resolveSync(
  "react-native-markdown-display/src/lib/parser.js",
  import.meta.dir,
);
const { default: MarkdownIt } = await import(Bun.resolveSync("markdown-it", rendererPath));
const parser = MarkdownIt();
// As in the renderer: one parser cuts, a math parser draws normalized math.
const segmentParser = MarkdownIt().use(markdownItMathRanges);
const mathParser = MarkdownIt().use(markdownItMath);
const markdownSegments = (text: string) => segmentWith(text, segmentParser);

describe("bounded native Markdown", () => {
  test("ordinary replies and the exact limit retain Markdown", () => {
    for (const text of ["", "A **short** reply.", "x".repeat(MAX_MARKDOWN_CHUNK_LENGTH)]) {
      expect(prepareBoundedMarkdown(text)).toEqual({ text, hasMath: false });
    }
  });

  test("one character over the limit bypasses all Markdown preparation", () => {
    expect(prepareBoundedMarkdown("x".repeat(MAX_MARKDOWN_CHUNK_LENGTH + 1))).toBeNull();
  });

  test("math normalization cannot expand beyond the parser budget", () => {
    expect(prepareBoundedMarkdown("Let $x$ be given.")).toEqual({
      text: "Let $$x$$ be given.",
      hasMath: true,
    });
    const source = "$x$ ".repeat(MAX_MARKDOWN_CHUNK_LENGTH / 4);
    expect(source.length).toBe(MAX_MARKDOWN_CHUNK_LENGTH);
    expect(prepareBoundedMarkdown(source)).toBeNull();
  });

  test.each(['[x](y "', "a://", "a@b.co\n", "\\[x\\] ", "`", " "])(
    "oversized crafted %j input never reaches a parser",
    (pattern) => {
      expect(prepareBoundedMarkdown(pattern.repeat(100_000))).toBeNull();
    },
  );
});

const kinds = (segments: MarkdownSegment[] | null) => segments?.map((segment) => segment.kind);
const joined = (segments: MarkdownSegment[] | null) =>
  segments?.map((segment) => segment.source).join("");

type Token = { type: string; info: string; content: string };
/** The leaf blocks the renderer draws for a text, in order (math normalized first). */
const leaves = (text: string): string[] => {
  const prepared = prepareMathMarkdown(text);
  return ((prepared.hasMath ? mathParser : parser).parse(prepared.text, {}) as Token[])
    .filter((token) => ["fence", "code_block", "inline", "hr", "math_block"].includes(token.type))
    .map((token) => `${token.type}:${token.info}:${token.content}`);
};

/** Parsing every segment on its own draws the same blocks as parsing the whole message. */
function expectParity(text: string, segments: MarkdownSegment[] | null) {
  expect(segments!.flatMap((segment) => leaves(segment.source))).toEqual(leaves(text));
}

function expectBounded(text: string, segments: MarkdownSegment[] | null) {
  expect(segments).not.toBeNull();
  expect(joined(segments)).toBe(text);
  for (const segment of segments!) {
    if (segment.kind !== "markdown") continue;
    expect(segment.source.length).toBeLessThanOrEqual(MAX_MARKDOWN_CHUNK_LENGTH);
  }
}

describe("long messages are drawn in bounded segments", () => {
  const paragraph = (index: number) => `Paragraph ${index} with **bold** text. `.repeat(8).trim();

  test("a message that fits one parse stays one Markdown segment", () => {
    const text = "A **short** reply.\n\n```opengeni-html\n<p>hi</p>\n```";
    expect(markdownSegments(text)).toEqual([{ kind: "markdown", source: text }]);
  });

  test("a long message splits at block boundaries and its visual is its own unit", () => {
    const visual = "<style>" + "#a{color:red}\n".repeat(900) + "</style>";
    const text = `**Intro**\n\n- **one**\n- two\n\n\`\`\`opengeni-html\n${visual}\n\`\`\`\n\nAfter.`;
    const segments = markdownSegments(text);
    expectBounded(text, segments);
    expect(kinds(segments)).toEqual(["markdown", "fence", "markdown"]);
    expect(segments![1]).toMatchObject({
      language: "opengeni-html",
      content: visual,
      closed: true,
    });
  });

  test("chunks are cut only between top-level blocks", () => {
    const blocks = Array.from({ length: 200 }, (_, index) =>
      index % 3 === 0
        ? `- item ${index}\n\n  continued ${index}\n\n      indented code ${index}`
        : index % 3 === 1
          ? `> quote ${index}\nlazy ${index}`
          : paragraph(index),
    );
    const text = blocks.join("\n\n");
    const segments = markdownSegments(text);
    expectBounded(text, segments);
    expect(segments!.length).toBeGreaterThan(4);
    for (const segment of segments!.slice(1)) {
      // Every chunk starts at an unindented line after a blank one.
      expect(segment.source).toMatch(/^[^\s]/);
    }
    for (const segment of segments!.slice(0, -1)) expect(segment.source).toMatch(/\n\n$/);
  });

  test("never cuts inside nested fences or display math", () => {
    const nested = "1. step\n\n   ```sh\n   echo a\n\n   not a cut\n   ```";
    const math = "$$\na = b\n\nc = d\n$$";
    const text = Array.from({ length: 120 }, (_, index) =>
      index % 2 ? `${nested}\n\n${paragraph(index)}` : `${math}\n\n${paragraph(index)}`,
    ).join("\n\n");
    const segments = markdownSegments(text);
    expectBounded(text, segments);
    for (const segment of segments!) {
      expect(segment.source.startsWith("   not a cut")).toBe(false);
      expect(segment.source.startsWith("c = d")).toBe(false);
      expect(segment.source.split("```").length % 2).toBe(1);
      expect(segment.source.split("$$").length % 2).toBe(1);
    }
    expectParity(text, segments);
    expect(
      segments!.some(
        (segment) => segment.kind === "markdown" && prepareBoundedMarkdown(segment.source)?.hasMath,
      ),
    ).toBe(true);
  });

  test("an unclosed fence at the end is still streaming", () => {
    const half = "<div>\n" + "<p>half</p>\n".repeat(500) + "<p>ha";
    const text = `${paragraph(1)}\n\n`.repeat(40) + "```opengeni-html\n" + half;
    const segments = markdownSegments(text);
    expectBounded(text, segments);
    expect(segments!.at(-1)).toMatchObject({
      kind: "fence",
      language: "opengeni-html",
      content: half,
      closed: false,
    });
  });

  test("a single block too long for one parse becomes plain-text pages", () => {
    const giant = "word ".repeat(MAX_MARKDOWN_CHUNK_LENGTH / 2);
    const text = `**Intro**\n\n${giant}\n\n**Outro**`;
    const segments = markdownSegments(text);
    expectBounded(text, segments);
    expect(kinds(segments)).toEqual(["markdown", "plain", "markdown"]);
  });

  test("the formatted limit is exact", () => {
    const unit = `${paragraph(1)}\n\n`;
    let text = unit
      .repeat(Math.ceil(MAX_MARKDOWN_LENGTH / unit.length))
      .slice(0, MAX_MARKDOWN_LENGTH);
    expectBounded(text, markdownSegments(text));
    text += "x";
    expect(markdownSegments(text)).toBeNull();
  });

  test.each([
    '[x](y "',
    "a://",
    "a@b.co\n",
    "\\[x\\] ",
    "$$ a\n",
    "$a ",
    "$$\n",
    "\\[\n",
    "```\n",
    "   ```\n",
    "- a\n\n",
    "> a\n\n",
    "\n",
    "`",
    " ",
  ])("crafted %j input at the limit stays bounded and linear", (pattern) => {
    const text = pattern.repeat(Math.floor(MAX_MARKDOWN_LENGTH / pattern.length));
    const started = performance.now();
    const segments = markdownSegments(text);
    // Drawing prepares every chunk's math too: that is bounded and linear as well.
    for (const segment of segments ?? []) {
      if (segment.kind === "markdown") prepareBoundedMarkdown(segment.source);
    }
    const elapsed = performance.now() - started;
    expectBounded(text, segments);
    // Linear work on 64K: generous for slow CI machines, far below a quadratic blow-up.
    expect(elapsed).toBeLessThan(1_000);
    // Over the limit costs nothing: the length check comes first.
    expect(markdownSegments(pattern.repeat(1_000_000))).toBeNull();
  });
});

describe("segmentation edge cases", () => {
  const handlers = (count: number) =>
    Array.from(
      { length: count },
      (_, index) => `def handler_${index}(event):\n    return event\n`,
    ).join("\n");

  test("CRLF messages find their fences like LF ones", () => {
    const lf = `Here is the module:\n\n\`\`\`python\n${handlers(200)}\n\`\`\`\n\nDone.\n`;
    const crlf = lf.replaceAll("\n", "\r\n");
    for (const text of [lf, crlf]) {
      const segments = markdownSegments(text);
      expectBounded(text, segments);
      expect(kinds(segments)).toEqual(["markdown", "fence", "markdown"]);
      expect(segments![1]).toMatchObject({ language: "python", closed: true });
      expect((segments![1] as { content: string }).content).not.toContain("\r");
    }
  });

  test("a stray $$ line does not stop the cuts that follow it", () => {
    const body = Array.from({ length: 60 }, (_, index) => `Paragraph ${index}. `.repeat(12));
    const text = ["$$5 per month, billed yearly", ...body].join("\n\n");
    const segments = markdownSegments(text);
    expectBounded(text, segments);
    expect(kinds(segments)!.every((kind) => kind === "markdown")).toBe(true);
  });

  // Text a single parse shows as code must never become a live preview after a cut.
  const filler = Array.from({ length: 400 }, (_, index) => `Line ${index} of the sample.`).join(
    "\n\n",
  );
  const hidden = "```opengeni-html\n<script>alert(1)</script>\n```";
  // What the renderer would draw as a preview: a direct fence, or a fence token in a chunk.
  const hasPreview = (segments: MarkdownSegment[] | null) =>
    segments!.some(
      (segment) =>
        (segment.kind === "fence" && segment.language === "opengeni-html") ||
        (segment.kind === "markdown" &&
          leaves(segment.source).some((leaf) => leaf.startsWith("fence:opengeni-html"))),
    );

  test.each([
    ["U+2028 in the info string", "````text\u2028x\n", "\n````"],
    ["U+2029 in the info string", "````text\u2029x\n", "\n````"],
    ["a lone CR in the info string", "````text\rx\n", "\n````"],
    ["lone CR line endings", "````text\r", "\r````"],
    ["a lone CR before the opener", "intro\r````text\n", "\n````"],
  ])("a fence opened with %s keeps its content code", (_name, open, close) => {
    const text = `intro\n\n${open}${filler}\n\n${hidden}\n\nmore${close}\n\nafter`;
    const segments = markdownSegments(text);
    expectBounded(text, segments);
    expect(hasPreview(segments)).toBe(false);
  });

  test("a long indented fence that closes stays whole", () => {
    const text = `intro\n\n \`\`\`\`text\n${filler}\n\n${hidden}\n\n\`\`\`\`\n\nafter\n\n${filler}`;
    expect(text.indexOf("\n\nafter")).toBeGreaterThan(MAX_MARKDOWN_CHUNK_LENGTH);
    const segments = markdownSegments(text);
    expectBounded(text, segments);
    expect(hasPreview(segments)).toBe(false);
    expectParity(text, segments);
    // Code too long for one parse is paged as source by the renderer; "after" formats again.
    expect(segments!.find((segment) => segment.source.includes(hidden))).toMatchObject({
      kind: "fence",
      language: "text",
      closed: true,
    });
    expect(segments!.some((s) => s.kind === "markdown" && s.source.startsWith("after"))).toBe(true);
  });

  test("a fence in a list item ends with the item, as in a single parse", () => {
    const body = Array.from({ length: 200 }, (_, index) => `Paragraph ${index}. `.repeat(12));
    const text = ["1. step", "   ```sh", "   echo", "", ...body].join("\n\n");
    const segments = markdownSegments(text);
    expectBounded(text, segments);
    expect(segments!.filter((segment) => segment.kind === "markdown").length).toBeGreaterThan(2);
  });

  test("a list-item fence whose body is not indented is code, as in a single parse", () => {
    const html = "<p>quoted</p>\n".repeat(700);
    const text = `1. Install:\n   \`\`\`bash\nnpm install\n   \`\`\`\n\n\`\`\`opengeni-html\n${html}\`\`\`\n\nDone.`;
    expect(text.length).toBeGreaterThan(MAX_MARKDOWN_CHUNK_LENGTH);
    const segments = markdownSegments(text);
    expectBounded(text, segments);
    expectParity(text, segments);
    expect(hasPreview(segments)).toBe(false);
  });

  test("an unclosed indented fence at the top level runs to the end, as in a single parse", () => {
    for (const open of ["  ~~~", "  ````"]) {
      const text = `Intro\n\n${open}\n${filler}\n\n${hidden}\n\nmore`;
      const segments = markdownSegments(text);
      expectBounded(text, segments);
      expectParity(text, segments);
      expect(hasPreview(segments)).toBe(false);
    }
  });

  test("a preview after a list-item fence stays a preview, as in a single parse", () => {
    const html = "<p>shown</p>\n".repeat(800);
    const text = `- step\n  \`\`\`js\n  code\n\`\`\`opengeni-html\n${html}\`\`\`\n\nDone.`;
    const segments = markdownSegments(text);
    expectBounded(text, segments);
    expectParity(text, segments);
    expect(segments!.find((segment) => segment.kind === "fence")).toMatchObject({
      language: "opengeni-html",
      closed: true,
    });
  });

  test("display math that ends a list keeps the following fence where one parse has it", () => {
    const links = Array.from(
      { length: 200 },
      (_, index) => `Paragraph ${index} has a [link](https://example.com/${index}).`,
    ).join("\n\n");
    const text = `1. The relation we use:\n\\[ E = mc^2 \\]\n   \`\`\`bash\n   echo hi\n\`\`\`\n\n${links}\n\n\`\`\`opengeni-html\n<div>chart</div>\n\`\`\`\n\nDone.`;
    expect(text.length).toBeGreaterThan(MAX_MARKDOWN_CHUNK_LENGTH);
    const segments = markdownSegments(text);
    expectBounded(text, segments);
    expectParity(text, segments);
    expect(kinds(segments)!.every((kind) => kind === "markdown")).toBe(true);
    expect(hasPreview(segments)).toBe(true);
  });

  test("a reference title that closes later re-cuts like a fresh parse while streaming", () => {
    // Until its closing quote streams in, a multi-line title is a paragraph of its own, a
    // place to cut; then the whole title belongs to the definition before it.
    const title = Array.from({ length: 24 }, (_, index) => `title line ${index} `.repeat(5));
    const tail = Array.from({ length: 90 }, (_, index) => `Tail ${index}. `.repeat(8));
    for (let pad = 110; pad < 170; pad++) {
      const before = Array.from({ length: pad }, (_, index) => `Lead ${index}. `.repeat(8));
      const open = `${before.join("\n\n")}\n\n[docs]: https://example.com/docs\n'${title.join("\n")}`;
      const text = `${open}'\n\nSee [the docs][docs].\n\n${tail.join("\n\n")}`;
      const segment = createMarkdownSegmenter(segmentParser);
      segment(open);
      expect(segment(text)).toEqual(markdownSegments(text));
    }
  });

  test("display math that closes later re-cuts like a fresh parse while streaming", () => {
    // `$$` math may hold blank lines: until its closer streams in, its lines are paragraphs.
    const inside = Array.from({ length: 30 }, (_, index) => `Inside ${index}. `.repeat(8));
    const tail = Array.from({ length: 60 }, (_, index) => `Tail ${index}. `.repeat(8));
    for (let pad = 110; pad < 170; pad++) {
      const before = Array.from({ length: pad }, (_, index) => `Lead ${index}. `.repeat(8));
      const open = `${before.join("\n\n")}\n\n$$\na = b\n\n${inside.join("\n\n")}`;
      const code = Array.from({ length: 40 }, (_, index) => `    code line ${index}`).join("\n");
      const text = `${open}\n$$\n${code}\n\n${tail.join("\n\n")}`;
      const segment = createMarkdownSegmenter(segmentParser);
      segment(open);
      expect(segment(text)).toEqual(markdownSegments(text));
    }
  });

  // Blocks whose extent depends on what follows them: containers, lazy lines, setext
  // underlines, tables, reference definitions and fences of every indentation.
  const pool = [
    "> quote\n> > nested\nlazy line",
    "- a\n  - b\n    - c\n\n  more a\n- d",
    "1. one\n   ```js\n   x\n   ```\n2. two\n```\nback\n```",
    "| a | b |\n|---|---|\n" + "| 1 | 2 |\n".repeat(40),
    "[ref]: https://example.com\n\nSee [ref].",
    "Title\n=====\n\nSub\n---",
    "  ~~~\nindented tilde\n  ~~~",
    "    indented code\n\n    more",
    "***\n- - -",
    "<div>\nhtml is text here\n</div>",
    "Paragraph with **bold** and a [link](https://example.com). ".repeat(6),
    "```opengeni-html\n<p>preview</p>\n```",
    "   ```\nunclosed?",
    "$$\na = b\n\nc\n$$",
    "- item\n\n      code in item\n- next",
    "> ```\n> quoted fence\n\nafter quote",
    "1. The relation:\n\\[ E = mc^2 \\]\n   ```bash\n   echo hi\n```",
    "- a list\n$$\nx\n$$\nlazy after math",
    "Text with $x$ and \\(y\\) inline.\n\\[\nz\n\\]",
    "[docs]: https://example.com/docs\n'A title\nover lines'\n\nSee [the docs][docs].",
    "[open]: https://example.com\n'unterminated title\nstill going",
  ];
  const random = (seed: number) => () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  const hasMath = (item: string) => /\$|\\[([]/.test(item);
  // The math pass tracks fences by its own simpler rule; where that disagrees with
  // markdown-it (a fence opened inside another fence's text), it may normalize math in
  // code differently. Mix math only with blocks where both agree.
  const fenceTricks = (item: string) => /^ {1,3}(```|~~~)|^> ```|unclosed/m.test(item);
  const document = (next: () => number, length: number, items = pool) => {
    let text = "";
    while (text.length < length) {
      text += items[Math.floor(next() * items.length)]!;
      text += ["\n", "\n\n", "\n\n\n"][Math.floor(next() * 3)]!;
    }
    return text;
  };

  test.each([
    ["without math", pool.filter((item) => !hasMath(item))],
    ["with math", pool.filter((item) => !fenceTricks(item))],
  ])("crafted block mixes %s always parse to the same blocks", (_name, items) => {
    const next = random(7);
    for (let round = 0; round < 40; round++) {
      const text = document(next, 9_000 + Math.floor(next() * 40_000), items);
      const segments = markdownSegments(text);
      expectBounded(text, segments);
      expectParity(text, segments);
    }
  });

  test("streaming re-parses only the end and segments like a fresh parse", () => {
    const next = random(11);
    for (let round = 0; round < 4; round++) {
      const text = document(next, 30_000);
      const segment = createMarkdownSegmenter(segmentParser);
      for (let end = 0; end < text.length; end += 1 + Math.floor(next() * 400)) {
        const prefix = text.slice(0, end);
        expect(segment(prefix)).toEqual(markdownSegments(prefix));
      }
    }
    // Appending to a long message parses only its last blocks again.
    let parsed = 0;
    const counting = {
      block: {
        parse: (src: string, _md: never, env: object, tokens: never[]) => {
          parsed += src.length;
          segmentParser.block.parse(src, segmentParser, env, tokens);
        },
      },
    };
    const segment = createMarkdownSegmenter(counting);
    // (Without unclosed fences, which run to the end and so are always parsed again.)
    const text = document(
      random(3),
      60_000,
      pool.filter((item) => !fenceTricks(item)),
    );
    segment(text.slice(0, 50_000));
    parsed = 0;
    segment(text.slice(0, 50_100));
    expect(parsed).toBeLessThan(2_000);
  });

  test("small fences pack into chunks, so the segment count stays small", () => {
    for (const text of [
      "a\n```\n```\n".repeat(6_500),
      Array.from({ length: 600 }, (_, index) => `Step ${index}:\n\n\`\`\`sh\necho ${index}\n\`\`\``)
        .join("\n\n")
        .slice(0, MAX_MARKDOWN_LENGTH),
    ]) {
      const segments = markdownSegments(text);
      expectBounded(text, segments);
      expect(kinds(segments)!.every((kind) => kind === "markdown")).toBe(true);
      expect(segments!.length).toBeLessThanOrEqual((2 * MAX_MARKDOWN_LENGTH) / 4_096 + 2);
    }
  });

  test("mounting takes one bounded slice per frame until every segment is mounted", () => {
    const report = Array.from(
      { length: 400 },
      (_, index) =>
        `## Section ${index}\n\nText **${index}**.\n\n\`\`\`ts\nconst x = ${index};\n\`\`\``,
    ).join("\n\n");
    const segments = markdownSegments(report.slice(0, MAX_MARKDOWN_LENGTH))!;
    let mounted = 0;
    let frames = 0;
    while (mounted < segments.length) {
      const next = mountedSegmentCount(segments, mounted);
      expect(next).toBeGreaterThan(mounted);
      expect(next - mounted).toBeLessThanOrEqual(8);
      const length = segments.slice(mounted, next).reduce((sum, s) => sum + s.source.length, 0);
      // A slice is one chunk's worth of text, or a single (possibly larger) segment.
      if (next - mounted > 1) expect(length).toBeLessThanOrEqual(MAX_MARKDOWN_CHUNK_LENGTH);
      mounted = next;
      frames++;
    }
    expect(mounted).toBe(segments.length);
    expect(frames).toBeGreaterThan(1);
    expect(mountedSegmentCount(segments, segments.length)).toBe(segments.length);
  });
});

describe("bounded plain-text pages", () => {
  test.each([
    "",
    "A **short** reply.",
    "x".repeat(MAX_MARKDOWN_CHUNK_LENGTH),
    "x".repeat(MAX_MARKDOWN_CHUNK_LENGTH * 3),
    "x".repeat(MAX_MARKDOWN_CHUNK_LENGTH - 2) + "😀" + "y".repeat(MAX_MARKDOWN_CHUNK_LENGTH),
    "😀".repeat(MAX_MARKDOWN_CHUNK_LENGTH * 2),
  ])("every character remains readable without splitting surrogate pairs (%#)", (source) => {
    const { count } = plainTextPage(source, 0);
    const pages = Array.from({ length: count }, (_, index) => plainTextPage(source, index));
    for (const page of pages) {
      expect(page.text.length).toBeLessThanOrEqual(MAX_MARKDOWN_CHUNK_LENGTH);
      expect(page.text).not.toMatch(/^[\udc00-\udfff]|[\ud800-\udbff]$/);
    }
    expect(pages.map((page) => page.text).join("")).toBe(source);
  });

  test("clamps navigation when streamed/replaced text shrinks", () => {
    expect(plainTextPage("short", 9)).toEqual({ index: 0, count: 1, text: "short" });
    expect(plainTextPage("short", -1).index).toBe(0);
  });
});
