import { describe, expect, test } from "bun:test";
import {
  composeSendInput,
  shouldSteerOnKey,
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
      composeSendInput(
        "hello",
        "ce-1",
        {
          controlEtag: "control-1",
          expectedDraftRevision: 3,
        },
        { model: "gpt-5.6-sol" },
      ),
    ).toEqual({
      text: "hello",
      clientEventId: "ce-1",
      model: "gpt-5.6-sol",
      controlEtag: "control-1",
      expectedDraftRevision: 3,
    });
  });

  test("binds the composer-owned model independently of host extras", () => {
    let selectedModel = "gpt-5.6-sol";
    expect(composeSendInput("hi", "ce-a", undefined, { model: selectedModel }).model).toBe(
      "gpt-5.6-sol",
    );
    selectedModel = "accounts/fireworks/models/glm-5p2";
    expect(composeSendInput("hi again", "ce-b", undefined, { model: selectedModel }).model).toBe(
      "accounts/fireworks/models/glm-5p2",
    );
  });

  test("evaluates function extras at send time and never lets them override text or clientEventId", () => {
    const extras = () => ({
      resources: [{ kind: "file" as const, fileId: "file-1" }],
      // hostile extras must not clobber the draft or the idempotency key
      ...({ text: "evil", clientEventId: "evil" } as unknown as Record<string, never>),
    });
    const input = composeSendInput("real draft", "ce-2", extras, {
      reasoningEffort: "low",
    });
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

describe("shouldSteerOnKey", () => {
  test("plain Enter appends the prompt to the queue", () => {
    expect(shouldSteerOnKey({})).toBe(false);
  });

  test("Cmd+Enter steers", () => {
    expect(shouldSteerOnKey({ metaKey: true })).toBe(true);
  });

  test("Ctrl+Enter steers", () => {
    expect(shouldSteerOnKey({ ctrlKey: true })).toBe(true);
  });
});
