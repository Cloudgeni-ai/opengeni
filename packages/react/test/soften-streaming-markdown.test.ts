import { describe, expect, test } from "bun:test";
import { softenStreamingMarkdown } from "../src/components/soften-streaming-markdown";

describe("softenStreamingMarkdown", () => {
  test("closes unmatched bold so raw ** never paints", () => {
    expect(softenStreamingMarkdown("Final note: **bold mid-stream")).toBe(
      "Final note: **bold mid-stream**",
    );
  });

  test("leaves balanced bold alone", () => {
    expect(softenStreamingMarkdown("Here is the **full** shape")).toBe(
      "Here is the **full** shape",
    );
  });

  test("closes an open fence that already has a body", () => {
    const open = "Intro\n\n```ts\nconst x = 1;";
    const softened = softenStreamingMarkdown(open);
    expect(softened.endsWith("\n```")).toBe(true);
    expect(countFences(softened) % 2).toBe(0);
  });

  test("soft-close does not invent a blank line when body already ends with \\n", () => {
    // Real closer is almost always `\n```` after a body newline. A soft `\n```
    // would add an empty code line that vanishes on close → height flicker.
    const open = "```ts\nconst x = 1;\n";
    const softened = softenStreamingMarkdown(open);
    expect(softened).toBe("```ts\nconst x = 1;\n```");
    const closed = "```ts\nconst x = 1;\n```";
    expect(softenStreamingMarkdown(closed)).toBe(closed);
  });

  test("soft-closes an empty fence opener so chrome appears once at ```", () => {
    const open = "## Architecture sketch\n\n```\n";
    const softened = softenStreamingMarkdown(open);
    expect(countFences(softened) % 2).toBe(0);
    // Blank line before the opener must survive soft-close (split/join used to
    // eat it and shift the heading when ``` chrome appeared).
    expect(softened).toBe("## Architecture sketch\n\n```\n```");
  });

  test("does not invent closers inside a finished fence", () => {
    const text = '```ts\nconst star = "**"\n```\n';
    expect(softenStreamingMarkdown(text)).toBe(text);
  });

  test("closes unfinished inline code and links", () => {
    expect(softenStreamingMarkdown("run `bun test")).toBe("run `bun test`");
    expect(softenStreamingMarkdown("see [docs](https://example.com")).toBe(
      "see [docs](https://example.com)",
    );
  });

  test("closing chunk that completes bold needs no extra softener", () => {
    const full = "this phrase is **bold mid-stream** until the closer lands.";
    expect(softenStreamingMarkdown(full)).toBe(full);
  });

  test("does not invent an extra trailing newline on ordinary prose", () => {
    // Regression: end-flush used to append `\n` on top of split's trailing
    // `""`, turning every `hello\n` into `hello\n\n` (blank line flicker).
    expect(softenStreamingMarkdown("hello\n")).toBe("hello\n");
    expect(softenStreamingMarkdown("a\n\nb\n")).toBe("a\n\nb\n");
    expect(softenStreamingMarkdown("**bold\n")).toBe("**bold**\n");
  });
});

function countFences(text: string): number {
  return text.split("\n").filter((line) => /^ {0,3}```/.test(line)).length;
}
