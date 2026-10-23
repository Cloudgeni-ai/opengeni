import { describe, expect, test } from "bun:test";
import { hasActionBlock, splitActionBlocks } from "../src/lib/blocks";

describe("splitActionBlocks", () => {
  test("separates prose from a complete agent block", () => {
    const text = 'Done.\n\n```geni-agent\n{"name":"Runner","icon":"footprints"}\n```\nEnjoy.';
    const segments = splitActionBlocks(text);
    expect(segments.map((segment) => segment.type)).toEqual(["text", "block", "text"]);
    const block = segments[1];
    expect(block?.type === "block" && block.block.kind).toBe("agent");
    expect(block?.type === "block" && block.block.complete).toBe(true);
    expect(block?.type === "block" && block.block.payload).toEqual({
      name: "Runner",
      icon: "footprints",
    });
  });

  test("marks a block that is still streaming as incomplete", () => {
    const segments = splitActionBlocks('One sec.\n```geni-profile\n{"name":"Me');
    const block = segments.at(-1);
    expect(block?.type).toBe("block");
    expect(block?.type === "block" && block.block.complete).toBe(false);
    expect(block?.type === "block" && block.block.payload).toBeNull();
  });

  test("keeps invalid JSON as a complete block without a payload", () => {
    const segments = splitActionBlocks("```geni-agent\nnot json\n```");
    expect(segments[0]?.type === "block" && segments[0].block.payload).toBeNull();
  });

  test("segment offsets are stable while text grows", () => {
    const first = splitActionBlocks("Hi\n```geni-agent\n{}");
    const later = splitActionBlocks("Hi\n```geni-agent\n{}\n```\nMore text");
    expect(first.map((segment) => segment.start)).toEqual(
      later.slice(0, 2).map((segment) => segment.start),
    );
  });

  test("leaves ordinary code fences alone", () => {
    expect(hasActionBlock("```json\n{}\n```")).toBe(false);
    expect(splitActionBlocks("```json\n{}\n```")).toEqual([
      { type: "text", text: "```json\n{}\n```", start: 0 },
    ]);
  });
});
