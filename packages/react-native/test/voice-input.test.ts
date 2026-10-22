import { describe, expect, test } from "bun:test";
import { appendDictation } from "../src/voice-input";

describe("appendDictation", () => {
  test("fills an empty draft with the trimmed transcript", () => {
    expect(appendDictation("", "  hello there \n")).toBe("hello there");
  });

  test("separates the transcript from existing text with one space", () => {
    expect(appendDictation("Fix the build", "and run tests")).toBe("Fix the build and run tests");
    expect(appendDictation("Fix the build ", "and run tests")).toBe("Fix the build and run tests");
    expect(appendDictation("First line\n", "second")).toBe("First line\nsecond");
  });

  test("keeps the draft when nothing was heard", () => {
    expect(appendDictation("Draft", "   ")).toBe("Draft");
  });
});
