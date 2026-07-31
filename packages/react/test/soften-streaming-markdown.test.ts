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

  test("closes an open fence", () => {
    const open = "Intro\n\n```ts\nconst x = 1;";
    const softened = softenStreamingMarkdown(open);
    expect(softened.endsWith("\n```")).toBe(true);
    expect(countFences(softened) % 2).toBe(0);
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
});

function countFences(text: string): number {
  return text.split("\n").filter((line) => /^ {0,3}```/.test(line)).length;
}
