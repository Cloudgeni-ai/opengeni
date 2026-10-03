import { describe, expect, test } from "bun:test";

import { modelPayerHint } from "./model-payer";

describe("modelPayerHint", () => {
  test("names the payer only, never the connection scope", () => {
    expect(modelPayerHint({ billingClass: "codex_subscription" })).toBe("ChatGPT plan");
    expect(modelPayerHint({ billingClass: "claude_subscription" })).toBe("Claude plan");
    expect(modelPayerHint({ billingClass: "opengeni_credits", catalog: { cost: "credits" } })).toBe(
      "Opengeni credits",
    );
    expect(modelPayerHint({ billingClass: "opengeni_credits", catalog: { cost: "free" } })).toBe(
      "Free",
    );
    expect(modelPayerHint({ billingClass: "byok" })).toBe("API key");
    expect(modelPayerHint({ billingClass: "organization_byok" })).toBe("API key");
  });
});
