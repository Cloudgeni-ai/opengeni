import { describe, expect, test } from "bun:test";

import { hasClaudeCiteTag, rewriteClaudeCiteTags } from "../src/claude-cite-tags";

// Built from escapes so no tool that acts on citation tags rewrites this file.
const LT = "\u003c";
const cite = (index: string, inner: string) => `${LT}cite index="${index}">${inner}${LT}/cite>`;
const open = (index: string) => `${LT}cite index="${index}">`;

const SOURCES = [
  "https://x.com/ArtificialAnlys/status/2113424551396934134",
  "https://artificialanalysis.ai/agents/coding-agents",
  "https://www.vals.ai/benchmarks/terminal-bench-4",
];
const resolve = (n: number) => (SOURCES[n - 1] ? { url: SOURCES[n - 1]! } : null);

describe("Claude citation tags", () => {
  test("become their quoted text, never raw markup", () => {
    const text = `The index is new. ${cite("1-2", '"FrontierCode v1.1 replaces DeepSWE v1.1"')} (announcement).`;
    expect(hasClaudeCiteTag(text)).toBe(true);
    expect(rewriteClaudeCiteTags(text)).toBe(
      'The index is new. "FrontierCode v1.1 replaces DeepSWE v1.1" (announcement).',
    );
  });

  test("link to their search result when the index resolves", () => {
    expect(
      rewriteClaudeCiteTags(`Vals: ${cite("3-5", '"a fresh set of 66 tasks"')}.`, resolve),
    ).toBe(`Vals: ["a fresh set of 66 tasks"](${SOURCES[2]}).`);
    // Several ranges: the first one that resolves.
    expect(rewriteClaudeCiteTags(cite("9-1, 2-4", "the average"), resolve)).toBe(
      `[the average](${SOURCES[1]})`,
    );
    // Unresolvable and non-web sources stay plain text.
    expect(rewriteClaudeCiteTags(cite("12-14", "no source"), resolve)).toBe("no source");
    expect(
      rewriteClaudeCiteTags(cite("1-1", "local"), () => ({ url: "javascript:alert(1)" })),
    ).toBe("local");
  });

  test("keep a link valid when the text cannot be a link label", () => {
    expect(rewriteClaudeCiteTags(cite("3-1", "see `tb run` [docs]"), resolve)).toBe(
      `see \`tb run\` [docs] ([vals.ai](${SOURCES[2]}))`,
    );
    expect(
      rewriteClaudeCiteTags(cite("1-1", "page"), () => ({
        url: "https://en.wikipedia.org/wiki/A_(b)",
      })),
    ).toBe("[page](https://en.wikipedia.org/wiki/A_%28b%29)");
  });

  test("leave code blocks and inline code exactly as written", () => {
    const fenced = [
      "Before " + cite("1-1", "x") + ".",
      "```html",
      cite("1-1", "kept"),
      "```",
      "After " + cite("2-1", "y"),
    ].join("\n");
    expect(rewriteClaudeCiteTags(fenced)).toBe(
      ["Before x.", "```html", cite("1-1", "kept"), "```", "After y"].join("\n"),
    );
    const tilde = ["  ~~~~", cite("1-1", "kept"), "  ~~~~", cite("1-1", "z")].join("\n");
    expect(rewriteClaudeCiteTags(tilde)).toBe(
      ["  ~~~~", cite("1-1", "kept"), "  ~~~~", "z"].join("\n"),
    );
    const inline = `Write \`${cite("1-1", "a")}\` for ${cite("1-1", "b")}.`;
    expect(rewriteClaudeCiteTags(inline)).toBe(`Write \`${cite("1-1", "a")}\` for b.`);
    // An unclosed fence runs to the end and stays code.
    const unclosed = ["```", cite("1-1", "kept")].join("\n");
    expect(rewriteClaudeCiteTags(unclosed)).toBe(unclosed);
  });

  test("hide an opening tag that is still streaming", () => {
    expect(rewriteClaudeCiteTags(`Done. ${open("4-2")}"half a quo`)).toBe('Done. "half a quo');
    expect(rewriteClaudeCiteTags(`Done. ${LT}cite ind`)).toBe("Done. ");
    expect(rewriteClaudeCiteTags(`Done. ${LT}cite index="4-`)).toBe("Done. ");
  });

  test("leave text without the exact tag shape unchanged", () => {
    for (const text of [
      "Plain answer with <b>html</b> and a <cite>book title</cite>.",
      `${LT}cite index="a-b">not an index${LT}/cite>`,
      `${LT}cite class="x">styled${LT}/cite>`,
      "Less-than signs: 3 < 4 and the word cite.",
    ])
      expect(rewriteClaudeCiteTags(text)).toBe(text);
    expect(hasClaudeCiteTag("no tags")).toBe(false);
  });

  test("rewrite multiline quotes and many tags in a long answer", () => {
    const text = [
      `- ${cite("1-2", '"line one\nline two"')}`,
      `- ${cite("2-1", "second")} and ${cite("3-1", "third")}`,
    ].join("\n");
    expect(rewriteClaudeCiteTags(text, resolve)).toBe(
      [
        `- "line one\nline two" ([x.com](${SOURCES[0]}))`,
        `- [second](${SOURCES[1]}) and [third](${SOURCES[2]})`,
      ].join("\n"),
    );
  });
});
