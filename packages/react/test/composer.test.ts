import { describe, expect, test } from "bun:test";
import { shouldSubmitOnKey } from "../src/hooks/use-composer";

describe("shouldSubmitOnKey", () => {
  test("plain Enter submits", () => {
    expect(shouldSubmitOnKey({ key: "Enter", shiftKey: false })).toBe(true);
  });

  test("Shift+Enter inserts a newline instead", () => {
    expect(shouldSubmitOnKey({ key: "Enter", shiftKey: true })).toBe(false);
  });

  test("IME composition Enter never submits", () => {
    expect(shouldSubmitOnKey({ key: "Enter", shiftKey: false, nativeEvent: { isComposing: true } })).toBe(false);
  });

  test("other keys never submit", () => {
    expect(shouldSubmitOnKey({ key: "a", shiftKey: false })).toBe(false);
  });
});
