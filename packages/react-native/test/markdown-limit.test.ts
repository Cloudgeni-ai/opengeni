import { describe, expect, test } from "bun:test";
import {
  MAX_MARKDOWN_LENGTH,
  plainTextPage,
  prepareBoundedMarkdown,
} from "../src/timeline/markdown-limit";

describe("bounded native Markdown", () => {
  test("ordinary replies and the exact limit retain Markdown", () => {
    for (const text of ["", "A **short** reply.", "x".repeat(MAX_MARKDOWN_LENGTH)]) {
      expect(prepareBoundedMarkdown(text)).toEqual({ text, hasMath: false });
    }
  });

  test("one character over the limit bypasses all Markdown preparation", () => {
    expect(prepareBoundedMarkdown("x".repeat(MAX_MARKDOWN_LENGTH + 1))).toBeNull();
  });

  test("math normalization cannot expand beyond the parser budget", () => {
    expect(prepareBoundedMarkdown("Let $x$ be given.")).toEqual({
      text: "Let $$x$$ be given.",
      hasMath: true,
    });
    const source = "$x$ ".repeat(MAX_MARKDOWN_LENGTH / 4);
    expect(source.length).toBe(MAX_MARKDOWN_LENGTH);
    expect(prepareBoundedMarkdown(source)).toBeNull();
  });

  test.each(['[x](y "', "a://", "a@b.co\n", "\\[x\\] ", "`", " "])(
    "oversized crafted %j input never reaches a parser",
    (pattern) => {
      expect(prepareBoundedMarkdown(pattern.repeat(100_000))).toBeNull();
    },
  );
});

describe("bounded plain-text pages", () => {
  test.each([
    "",
    "A **short** reply.",
    "x".repeat(MAX_MARKDOWN_LENGTH),
    "x".repeat(MAX_MARKDOWN_LENGTH * 3),
    "x".repeat(MAX_MARKDOWN_LENGTH - 2) + "😀" + "y".repeat(MAX_MARKDOWN_LENGTH),
    "😀".repeat(MAX_MARKDOWN_LENGTH * 2),
  ])("every character remains readable without splitting surrogate pairs (%#)", (source) => {
    const { count } = plainTextPage(source, 0);
    const pages = Array.from({ length: count }, (_, index) => plainTextPage(source, index));
    for (const page of pages) {
      expect(page.text.length).toBeLessThanOrEqual(MAX_MARKDOWN_LENGTH);
      expect(page.text).not.toMatch(/^[\udc00-\udfff]|[\ud800-\udbff]$/);
    }
    expect(pages.map((page) => page.text).join("")).toBe(source);
  });

  test("clamps navigation when streamed/replaced text shrinks", () => {
    expect(plainTextPage("short", 9)).toEqual({ index: 0, count: 1, text: "short" });
    expect(plainTextPage("short", -1).index).toBe(0);
  });
});
