import { expect, test } from "bun:test";
import {
  parseRealtimeVoicePricingJson,
  parseRealtimeVoicePricingTableJson,
  realtimeVoiceMinuteCreditMicros,
  realtimeVoiceStartedMinutes,
} from "@opengeni/config";
import { spendableCreditMicros, VOICE_CREDIT_USAGE } from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import {
  deploymentRealtimeVoice,
  realtimeVoiceOfferProblem,
  voiceCreditStanding,
  voiceInsufficientCreditsMessage,
} from "../src";

test("live voice pricing: strict JSON, margin rounds up, every started minute", () => {
  expect(parseRealtimeVoicePricingJson(undefined)).toBeNull();
  expect(() => parseRealtimeVoicePricingJson("{")).toThrow("must be valid JSON");
  expect(() => parseRealtimeVoicePricingJson('{"microsPerMinute":0}')).toThrow("invalid");
  expect(() => parseRealtimeVoicePricingJson('{"microsPerMinute":1,"extra":1}')).toThrow();
  expect(() => parseRealtimeVoicePricingTableJson('{"m":{"microsPerMinute":-1}}')).toThrow();
  expect(realtimeVoiceMinuteCreditMicros({ microsPerMinute: 50_000, marginBps: 500 })).toEqual({
    providerCostMicros: 50_000,
    creditCostMicros: 52_500,
  });
  expect(realtimeVoiceMinuteCreditMicros({ microsPerMinute: 3, marginBps: 1 })).toEqual({
    providerCostMicros: 3,
    creditCostMicros: 4,
  });
  const start = new Date("2026-10-05T07:00:00.000Z");
  const at = (ms: number) => new Date(start.getTime() + ms);
  expect(realtimeVoiceStartedMinutes(start, start)).toBe(1);
  expect(realtimeVoiceStartedMinutes(start, at(60_000))).toBe(1);
  expect(realtimeVoiceStartedMinutes(start, at(60_001))).toBe(2);
  expect(realtimeVoiceStartedMinutes(start, at(-5_000))).toBe(1);
});

test("only deployment-funded voice is gated; enabled without pricing is unavailable", () => {
  const settings = testSettings({
    billingMode: "stripe",
    vercelAiGatewayApiKey: "key",
    azureLiveEndpoint: "https://voice.example.test",
    azureLiveApiKey: "key",
    azureLivePricingJson: '{"microsPerMinute":50000}',
  });
  for (const model of [
    "gpt-live-1-boulder-alpha",
    "supergrok/grok-voice-think-fast-2.0",
    "workspace-gateway/openai/gpt-realtime-2.1",
  ]) {
    expect(deploymentRealtimeVoice(settings, model)).toBeNull();
  }
  const azure = deploymentRealtimeVoice(settings, "opengeni-azure/gpt-live-1")!;
  expect(azure).toMatchObject({ provider: "azure-live", configured: true });
  expect(realtimeVoiceOfferProblem(settings, azure)).toBeNull();
  const gateway = deploymentRealtimeVoice(settings, "opengeni-gateway/openai/gpt-realtime-mini")!;
  expect(gateway).toMatchObject({ provider: "ai-gateway", configured: true, pricing: null });
  expect(realtimeVoiceOfferProblem(settings, gateway)?.code).toBe("pricing_unconfigured");
  // Without credit billing (self-hosted), a configured provider needs no price.
  const selfHosted = {
    ...settings,
    billingMode: "disabled" as const,
    usageLimitsMode: "none" as const,
  };
  expect(realtimeVoiceOfferProblem(selfHosted, gateway)).toBeNull();
  const unconfigured = deploymentRealtimeVoice(
    { ...settings, azureLiveApiKey: undefined },
    "opengeni-azure/gpt-live-1",
  )!;
  expect(realtimeVoiceOfferProblem(settings, unconfigured)?.code).toBe("not_configured");
  // Malformed pricing withholds the model rather than throwing (no boot failure).
  const malformed = deploymentRealtimeVoice(
    { ...settings, azureLivePricingJson: "{not json" },
    "opengeni-azure/gpt-live-1",
  )!;
  expect(malformed.pricing).toBeNull();
  expect(realtimeVoiceOfferProblem(settings, malformed)?.code).toBe("pricing_unconfigured");
});

test("promotional chat-only credits are named, not reported as no credits", () => {
  expect(voiceCreditStanding({ balanceMicros: 1 })).toBe("spendable");
  expect(voiceCreditStanding({ balanceMicros: 0, promotionalCredits: [] })).toBe("none");
  expect(
    voiceCreditStanding({
      balanceMicros: 0,
      promotionalCredits: [{ remainingMicros: 10_000_000 }],
    }),
  ).toBe("promotional_only");
  expect(voiceInsufficientCreditsMessage("Live voice", "promotional_only")).toBe(
    "Promotional credits don't cover live voice. Add credits to use it.",
  );
  expect(voiceInsufficientCreditsMessage("Voice input", "none")).toBe(
    "Voice input needs Opengeni credits. Add credits to continue.",
  );
});

test("signup credits are spendable for voice; other scoped grants are not", () => {
  const grant = (remainingMicros: number, coversVoice: boolean) => ({
    grantId: crypto.randomUUID(),
    label: coversVoice ? "Signup credits" : "Coupon credits",
    eligibleModelIds: ["gpt-chat-only"],
    remainingMicros,
    coversVoice,
  });
  const balance = {
    accountId: crypto.randomUUID(),
    balanceMicros: 7_000,
    generalBalanceMicros: 0,
    promotionalCredits: [grant(4_000, false), grant(3_000, true)],
    currency: "usd" as const,
    updatedAt: new Date(0).toISOString(),
  };
  expect(spendableCreditMicros(balance, VOICE_CREDIT_USAGE)).toBe(3_000);
  expect(spendableCreditMicros(balance, "gpt-chat-only")).toBe(7_000);
  expect(spendableCreditMicros(balance)).toBe(0);
  expect(
    voiceCreditStanding({
      ...balance,
      balanceMicros: spendableCreditMicros(balance, VOICE_CREDIT_USAGE),
    }),
  ).toBe("spendable");
  const couponOnly = { ...balance, promotionalCredits: [grant(4_000, false)] };
  expect(
    voiceCreditStanding({
      ...couponOnly,
      balanceMicros: spendableCreditMicros(couponOnly, VOICE_CREDIT_USAGE),
    }),
  ).toBe("promotional_only");
});
