import { describe, expect, test } from "bun:test";
import { HTTPException } from "hono/http-exception";
import { testSettings } from "@opengeni/testing";
import { assertConfiguredModel } from "@opengeni/core";

describe("assertConfiguredModel — codex subscription models", () => {
  test("rejects a codex model when the feature is disabled", () => {
    let thrown: unknown;
    try {
      assertConfiguredModel(testSettings({ codexSubscriptionEnabled: false }), "codex/gpt-5.6-sol");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HTTPException);
    expect((thrown as HTTPException).status).toBe(422);
    expect((thrown as HTTPException).message).toBe("model is not available: codex/gpt-5.6-sol");
  });

  test("accepts a codex model at the edge when the feature is enabled", () => {
    expect(() =>
      assertConfiguredModel(testSettings({ codexSubscriptionEnabled: true }), "codex/gpt-5.6-sol"),
    ).not.toThrow();
  });

  test("still rejects a non-codex unknown model even when the feature is enabled", () => {
    expect(() =>
      assertConfiguredModel(
        testSettings({ codexSubscriptionEnabled: true }),
        "totally-bogus-model",
      ),
    ).toThrow(HTTPException);
  });

  test("a normal deployment-allowed model is unaffected", () => {
    expect(() => assertConfiguredModel(testSettings(), "gpt-5.6-sol")).not.toThrow();
  });
});

describe("assertConfiguredModel — SuperGrok subscription models", () => {
  test("rejects a SuperGrok model when the feature is disabled", () => {
    expect(() =>
      assertConfiguredModel(
        testSettings({ supergrokSubscriptionEnabled: false }),
        "supergrok/grok-4.6",
      ),
    ).toThrow(HTTPException);
  });

  test("accepts Grok 4.6 when the feature is enabled", () => {
    expect(() =>
      assertConfiguredModel(
        testSettings({ supergrokSubscriptionEnabled: true }),
        "supergrok/grok-4.6",
      ),
    ).not.toThrow();
  });
});
