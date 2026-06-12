import { describe, expect, test } from "bun:test";
import { composeSendInput, shouldSubmitOnKey } from "../src/hooks/use-composer";

describe("composeSendInput", () => {
  test("sends bare text with the idempotency key when no extras are configured", () => {
    expect(composeSendInput("hello", "ce-1", undefined)).toEqual({ text: "hello", clientEventId: "ce-1" });
  });

  test("merges static extras under the text", () => {
    expect(composeSendInput("hello", "ce-1", { model: "gpt-5.5", tools: [{ kind: "mcp", id: "opengeni" }] })).toEqual({
      text: "hello",
      clientEventId: "ce-1",
      model: "gpt-5.5",
      tools: [{ kind: "mcp", id: "opengeni" }],
    });
  });

  test("evaluates function extras at send time and never lets them override text or clientEventId", () => {
    const extras = () => ({
      reasoningEffort: "low" as const,
      resources: [{ kind: "file" as const, fileId: "file-1" }],
      // hostile extras must not clobber the draft or the idempotency key
      ...({ text: "evil", clientEventId: "evil" } as unknown as Record<string, never>),
    });
    const input = composeSendInput("real draft", "ce-2", extras);
    expect(input.text).toBe("real draft");
    expect(input.clientEventId).toBe("ce-2");
    expect(input.reasoningEffort).toBe("low");
    expect(input.resources).toEqual([{ kind: "file", fileId: "file-1" }]);
  });
});

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
