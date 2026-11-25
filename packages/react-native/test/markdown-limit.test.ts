import { describe, expect, test } from "bun:test";
import {
  MAX_MARKDOWN_CHUNK_LENGTH,
  MAX_MARKDOWN_LENGTH,
  markdownSegments,
  type MarkdownSegment,
  plainTextPage,
  prepareBoundedMarkdown,
} from "../src/timeline/markdown-limit";

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

function expectBounded(text: string, segments: MarkdownSegment[] | null) {
  expect(segments).not.toBeNull();
  expect(joined(segments)).toBe(text);
  for (const segment of segments!) {
    if (segment.kind !== "markdown") continue;
    expect(segment.source.length).toBeLessThanOrEqual(MAX_MARKDOWN_CHUNK_LENGTH);
    expect(segment.prepared.text.length).toBeLessThanOrEqual(MAX_MARKDOWN_CHUNK_LENGTH);
  }
}

describe("long messages are drawn in bounded segments", () => {
  const paragraph = (index: number) => `Paragraph ${index} with **bold** text. `.repeat(8).trim();

  test("a message that fits one parse stays one Markdown segment", () => {
    const text = "A **short** reply.\n\n```opengeni-html\n<p>hi</p>\n```";
    expect(markdownSegments(text)).toEqual([
      { kind: "markdown", source: text, prepared: { text, hasMath: false } },
    ]);
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
    const nested = "1. step\n\n   ```sh\n   echo a\n\nnot a cut\n   ```";
    const math = "$$\na = b\n\nc = d\n$$";
    const text = Array.from({ length: 120 }, (_, index) =>
      index % 2 ? `${nested}\n\n${paragraph(index)}` : `${math}\n\n${paragraph(index)}`,
    ).join("\n\n");
    const segments = markdownSegments(text);
    expectBounded(text, segments);
    for (const segment of segments!) {
      expect(segment.source.startsWith("not a cut")).toBe(false);
      expect(segment.source.startsWith("c = d")).toBe(false);
      expect(segment.source.split("```").length % 2).toBe(1);
      expect(segment.source.split("$$").length % 2).toBe(1);
    }
    expect(
      segments!.some((segment) => segment.kind === "markdown" && segment.prepared.hasMath),
    ).toBe(true);
  });

  test("an unclosed fence at the end is still streaming", () => {
    const text = `${paragraph(1)}\n\n`.repeat(40) + "```opengeni-html\n<div>\n<p>half";
    const segments = markdownSegments(text);
    expectBounded(text, segments);
    expect(segments!.at(-1)).toMatchObject({
      kind: "fence",
      language: "opengeni-html",
      content: "<div>\n<p>half",
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
    const elapsed = performance.now() - started;
    expectBounded(text, segments);
    // A linear scan of 64K: generous for slow CI machines, far below a quadratic blow-up.
    expect(elapsed).toBeLessThan(500);
    // Over the limit costs nothing: the length check comes first.
    expect(markdownSegments(pattern.repeat(1_000_000))).toBeNull();
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
