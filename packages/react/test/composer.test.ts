import { describe, expect, test } from "bun:test";
import {
  composeSendInput,
  composerModeForKey,
  FILE_ONLY_MESSAGE_TEXT,
  resolveSendExtras,
  shouldSubmitOnKey,
} from "../src/hooks/use-composer";

describe("composeSendInput", () => {
  test("sends bare text with the idempotency key when no extras are configured", () => {
    expect(composeSendInput("hello", "ce-1", undefined)).toEqual({
      text: "hello",
      clientEventId: "ce-1",
    });
  });

  test("merges static extras under the text", () => {
    expect(
      composeSendInput("hello", "ce-1", {
        model: "gpt-5.6-sol",
        tools: [{ kind: "mcp", id: "opengeni" }],
      }),
    ).toEqual({
      text: "hello",
      clientEventId: "ce-1",
      model: "gpt-5.6-sol",
      tools: [{ kind: "mcp", id: "opengeni" }],
    });
  });

  test("carries the model selected in the picker (deferred extras read the current selection)", () => {
    // Mirrors the ChatComposer + <ModelPicker> wiring: the host holds the
    // selected model in state and threads it via a sendExtras closure, so the
    // input composed at send time carries whichever model is selected then.
    let selectedModel = "gpt-5.6-sol";
    const sendExtras = () => ({ model: selectedModel });
    expect(composeSendInput("hi", "ce-a", sendExtras).model).toBe("gpt-5.6-sol");
    // Operator switches the picker to GLM 5.2 before the next send.
    selectedModel = "accounts/fireworks/models/glm-5p2";
    expect(composeSendInput("hi again", "ce-b", sendExtras).model).toBe(
      "accounts/fireworks/models/glm-5p2",
    );
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

describe("resolveSendExtras", () => {
  test("returns an empty bag for undefined extras", () => {
    expect(resolveSendExtras(undefined)).toEqual({});
  });

  test("evaluates a function and surfaces its resources", () => {
    const resolved = resolveSendExtras(() => ({ resources: [{ kind: "file", fileId: "f1" }] }));
    expect(resolved.resources).toEqual([{ kind: "file", fileId: "f1" }]);
  });
});

describe("FILE_ONLY_MESSAGE_TEXT", () => {
  test("is non-empty so the wire contract (text.min(1)) and worker guard accept a file-only message", () => {
    expect(FILE_ONLY_MESSAGE_TEXT.trim().length).toBeGreaterThan(0);
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
    expect(
      shouldSubmitOnKey({ key: "Enter", shiftKey: false, nativeEvent: { isComposing: true } }),
    ).toBe(false);
  });

  test("other keys never submit", () => {
    expect(shouldSubmitOnKey({ key: "a", shiftKey: false })).toBe(false);
  });
});

describe("composerModeForKey", () => {
  test("plain Enter appends the prompt to the queue", () => {
    expect(composerModeForKey({})).toBe("queue");
  });

  test("Cmd+Enter steers", () => {
    expect(composerModeForKey({ metaKey: true })).toBe("steer");
  });

  test("Ctrl+Enter steers", () => {
    expect(composerModeForKey({ ctrlKey: true })).toBe("steer");
  });
});
