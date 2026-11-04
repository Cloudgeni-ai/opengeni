import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { TypedSecretMemory } from "../src/typed-secrets";

describe("TypedSecretMemory", () => {
  test("payment values stay hidden after digit grouping and three-digit codes stay hidden", () => {
    const memory = new TypedSecretMemory();
    memory.remember({ "Test|Card|number": "4242424242424242", "Test|Card|cvc": "731" });
    for (const value of [
      "4242 4242 4242 4242",
      "4242-4242-4242-4242",
      "4242\u00a04242\u00a04242\u00a04242",
      "4242\u202f4242\u202f4242\u202f4242",
      "424242 424242 4242",
      "4242%204242%204242%204242",
      "4242%C2%A04242%C2%A04242%C2%A04242",
      "4242%E2%80%AF4242%E2%80%AF4242%E2%80%AF4242",
    ]) {
      expect(memory.redact({ value })).toEqual({ value: "[secret]" });
    }
    expect(memory.redact({ value: "731", description: "Security code 731" })).toEqual({
      value: "[secret]",
      description: "Security code [secret]",
    });
    expect(memory.redact({ value: "7 3 1" })).toEqual({ value: "[secret]" });
    expect(memory.redact("Order 824601 and total 57.30")).toBe("Order 824601 and total 57.30");
  });

  test("payment image protection survives controller replacement and stays session-scoped", () => {
    const id = randomUUID();
    TypedSecretMemory.forSession("browser", id).protectPaymentImages("tab-a");
    expect(TypedSecretMemory.forSession("browser", id).paymentImagesProtected("tab-a")).toBe(true);
    expect(TypedSecretMemory.forSession("browser", id).paymentImagesProtected("tab-b")).toBe(false);
    expect(
      TypedSecretMemory.forSession("browser", randomUUID()).paymentImagesProtected("tab-a"),
    ).toBe(false);
    expect(TypedSecretMemory.forSession("computer", id).paymentImagesProtected("tab-a")).toBe(
      false,
    );
  });

  test("payment values cannot be evicted by later remembered values", () => {
    const id = randomUUID();
    const memory = TypedSecretMemory.forSession("browser", id);
    memory.remember({ card: "4000000000000002", cvc: "731" });
    for (let index = 0; index < 300; index++)
      memory.remember({ other: `unrelated-value-${index}` });
    const replacement = TypedSecretMemory.forSession("browser", id);
    expect(replacement.redact("4000 0000 0000 0002 / 731")).toBe("[secret] / [secret]");
    expect(replacement.containsPaymentValue(["4000 0000 0000 0002"])).toBe(true);
    expect(replacement.containsPaymentValue(["40123456789012"])).toBe(false);
    expect(Object.values(replacement.merged() ?? {})).toContain("4000000000000002");
    expect(Object.values(replacement.merged() ?? {})).toContain("731");
  });

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
