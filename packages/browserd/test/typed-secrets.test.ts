import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { TypedSecretMemory } from "../src/typed-secrets";

describe("TypedSecretMemory", () => {
  test("one session shares its memory across controllers, and sessions stay apart", () => {
    const sessionId = randomUUID();
    TypedSecretMemory.forSession("browser", sessionId).remember({
      "Vault|Item|password": "pa55word-xyz",
    });
    expect(TypedSecretMemory.forSession("browser", sessionId).redact("is pa55word-xyz")).toBe(
      "is [secret]",
    );
    expect(TypedSecretMemory.forSession("computer", sessionId).redact("is pa55word-xyz")).toBe(
      "is pa55word-xyz",
    );
    expect(TypedSecretMemory.forSession("browser", randomUUID()).redact("pa55word-xyz")).toBe(
      "pa55word-xyz",
    );
  });

  test("a typed one-time code stays hidden after the action that typed it", () => {
    const memory = new TypedSecretMemory();
    memory.remember({ "Vault|Item|otp": "482913" });
    expect(memory.redact({ value: "482913" })).toEqual({ value: "[secret]" });
  });

  test("controllers created before a value was typed see it, and sessions are never evicted", () => {
    const sessionId = randomUUID();
    const earlier = TypedSecretMemory.forSession("browser", sessionId);
    const typing = TypedSecretMemory.forSession("browser", sessionId);
    typing.remember({ "Vault|Item|password": "pa55word-early" });
    expect(earlier.redact("pa55word-early")).toBe("[secret]");
    for (let index = 0; index < 2_000; index += 1) {
      TypedSecretMemory.forSession("browser", randomUUID()).remember({
        "Vault|Item|password": `other-${index}`,
      });
    }
    expect(TypedSecretMemory.forSession("browser", sessionId).redact("pa55word-early")).toBe(
      "[secret]",
    );
  });
});
