import { describe, expect, test } from "bun:test";
import { getSettings } from "../src";

// Managed deployment billing OpenGeni credits through Stripe; the default
// OpenAI catalog prices gpt-6-astra, gpt-6-sol and gpt-6-luna as credits.
const stripeEnv = {
  OPENGENI_ENVIRONMENT: "production",
  OPENGENI_PRODUCT_ACCESS_MODE: "managed",
  OPENGENI_PUBLIC_BASE_URL: "https://managed.example.test",
  OPENGENI_BETTER_AUTH_SECRET: "managed-better-auth-secret",
  OPENGENI_DELEGATION_SECRET: "managed-delegation-secret",
  OPENGENI_RESEND_API_KEY: "re_test",
  OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  OPENGENI_BILLING_MODE: "stripe",
  OPENGENI_STRIPE_SECRET_KEY: "sk_test",
  OPENGENI_STRIPE_WEBHOOK_SECRET: "whsec_test",
  OPENGENI_OPENAI_API_KEY: "sk-test",
  OPENGENI_OPENAI_ALLOWED_MODELS: "gpt-6-astra,gpt-6-sol,gpt-6-luna",
};

describe("credits default model settings", () => {
  test("default to GPT-6 Luna at extra high reasoning", () => {
    const settings = getSettings({});
    expect(settings.creditsDefaultModel).toBe("gpt-6-luna");
    expect(settings.creditsDefaultReasoningEffort).toBe("xhigh");
  });

  test("are deployment-configurable", () => {
    const settings = getSettings({
      OPENGENI_CREDITS_DEFAULT_MODEL: " gpt-6-sol ",
      OPENGENI_CREDITS_DEFAULT_REASONING_EFFORT: "high",
    });
    expect(settings.creditsDefaultModel).toBe("gpt-6-sol");
    expect(settings.creditsDefaultReasoningEffort).toBe("high");
  });

  test("reject an unknown effort or a malformed model id at boot", () => {
    expect(() => getSettings({ OPENGENI_CREDITS_DEFAULT_REASONING_EFFORT: "extreme" })).toThrow();
    expect(() => getSettings({ OPENGENI_CREDITS_DEFAULT_MODEL: "gpt-6-luna|other" })).toThrow();
  });

  test("an explicit credits default must be a credits-billed catalog model", () => {
    expect(
      getSettings({ ...stripeEnv, OPENGENI_CREDITS_DEFAULT_MODEL: "gpt-6-sol" })
        .creditsDefaultModel,
    ).toBe("gpt-6-sol");
    expect(() =>
      getSettings({ ...stripeEnv, OPENGENI_CREDITS_DEFAULT_MODEL: "gpt-6-lunaa" }),
    ).toThrow("OPENGENI_CREDITS_DEFAULT_MODEL gpt-6-lunaa is not a credits-billed model");
    // The built-in default is not enforced: a catalog without GPT-6 Luna keeps
    // the documented fallback to the first selectable credits model.
    expect(
      getSettings({ ...stripeEnv, OPENGENI_OPENAI_ALLOWED_MODELS: "gpt-6-astra,gpt-6-sol" })
        .creditsDefaultModel,
    ).toBe("gpt-6-luna");
  });
});
