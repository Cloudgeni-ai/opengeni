import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing/settings";
import {
  hostedToolsBillCreditsForTurn,
  openAiHostedImageProviderBindingForTurn,
} from "../src/activities/agent-turn/tool-policy";

// Paid tools the model provider hosts always cost credit when Opengeni pays
// for the turn's model. Turns on the user's own keys or subscriptions, free
// models and billing-off deployments keep the hosted tools unchanged.

describe("hosted tools on Opengeni's bill", () => {
  test("only a credit-billed turn on a billing-active deployment bills hosted tools", () => {
    const turn = (chargesOpenGeniCredits: boolean) => ({
      accountId: "11111111-1111-4111-8111-111111111111",
      chargesOpenGeniCredits,
    });
    expect(hostedToolsBillCreditsForTurn({ billingMode: "stripe" }, turn(true))).toBe(true);
    expect(
      hostedToolsBillCreditsForTurn(
        { billingMode: "disabled", usageLimitsMode: "managed" },
        turn(true),
      ),
    ).toBe(true);
    expect(hostedToolsBillCreditsForTurn({ billingMode: "stripe" }, turn(false))).toBe(false);
    expect(
      hostedToolsBillCreditsForTurn(
        { billingMode: "disabled", usageLimitsMode: "none" },
        turn(true),
      ),
    ).toBe(false);
  });

  const settings = testSettings({
    openaiProvider: "openai",
    openaiApiKey: "sk-deployment-test",
    openaiBaseUrl: undefined,
  });
  const directOpenAi = {
    provider: {
      id: "openai",
      kind: "openai" as const,
      builtin: true,
      baseUrl: "https://api.openai.com/v1",
    },
    configured: {
      capabilities: { hostedTools: { imageGeneration: { runnable: true } } },
    },
  } as unknown as Parameters<typeof openAiHostedImageProviderBindingForTurn>[1];

  test("OpenAI hosted image generation on the deployment key is never offered when it would be free", () => {
    // Unbilled turns keep the hosted image tool exactly as before.
    expect(openAiHostedImageProviderBindingForTurn(settings, directOpenAi, false)).toMatchObject({
      providerId: "openai",
    });
    // A credit-billed turn falls through to the priced Gateway image route.
    expect(openAiHostedImageProviderBindingForTurn(settings, directOpenAi, true)).toBeNull();
  });
});
