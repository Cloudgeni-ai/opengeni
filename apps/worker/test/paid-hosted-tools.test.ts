import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing/settings";
import {
  hostedToolsBillCreditsForTurn,
  openAiHostedImageProviderBindingForTurn,
} from "../src/activities/agent-turn/tool-policy";
import { turnWebSearchPlan } from "../src/activities/agent-turn/web-search";

/** CloudGeni's host account, a default legacy billing account. */
const LEGACY_ACCOUNT = "25eacc5d-f383-4f79-910a-b3d11dbf1310";

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

  test("a legacy billing account keeps today's native search and image generation", () => {
    const billed = testSettings({
      billingMode: "stripe",
      webSearchProvider: "exa",
      webSearchApiKey: "exa-key",
      openaiProvider: "openai",
      openaiApiKey: "sk-deployment-test",
      openaiBaseUrl: undefined,
    });
    const hostedSearchModel = {
      configured: { hostedWebSearch: true },
      provider: { kind: "openai" },
    };
    const legacy = hostedToolsBillCreditsForTurn(billed, {
      accountId: LEGACY_ACCOUNT,
      chargesOpenGeniCredits: true,
    });
    expect(legacy).toBe(false);
    // Native hosted search, no metered provider tools.
    expect(turnWebSearchPlan(hostedSearchModel, billed, true, legacy)).toEqual({
      hostedWebSearch: true,
      providerTools: [],
    });
    // OpenAI's hosted image tool on the deployment key, as today.
    expect(openAiHostedImageProviderBindingForTurn(billed, directOpenAi, legacy)).toMatchObject({
      providerId: "openai",
    });
    // Any other account on the same credit-billed turn gets the billed tools.
    const other = hostedToolsBillCreditsForTurn(billed, {
      accountId: "11111111-1111-4111-8111-111111111111",
      chargesOpenGeniCredits: true,
    });
    expect(turnWebSearchPlan(hostedSearchModel, billed, true, other)).toEqual({
      hostedWebSearch: false,
      providerTools: ["web_search", "web_fetch"],
    });
    expect(openAiHostedImageProviderBindingForTurn(billed, directOpenAi, other)).toBeNull();
    // The operator setting overrides the default list.
    expect(
      hostedToolsBillCreditsForTurn(
        { ...billed, billingLegacyAccountIds: [] },
        { accountId: LEGACY_ACCOUNT, chargesOpenGeniCredits: true },
      ),
    ).toBe(true);
  });
});
