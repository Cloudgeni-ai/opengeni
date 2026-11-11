import { describe, expect, test } from "bun:test";
import type { Settings } from "@opengeni/config";
import { testSettings } from "@opengeni/testing/settings";
import {
  InferenceRegionRestrictedError,
  assertSideFeatureRoute,
  sideFeatureRegionRestrictedError,
  sideFeatureRequiresEu,
  sideFeatureRouteFetch,
  sideFeatureRouteRunnable,
  withInferenceResidency,
} from "../src";

const euSelfHosted = {
  geography: "eu",
  deploymentType: "self_hosted",
  regions: ["fsn1"],
  evidence: {
    source: "operator_declaration",
    reference: "SearXNG on the deployment's own host",
    verifiedAt: "2026-10-26",
  },
} as const;

function settings(overrides: Partial<Settings> = {}): Settings {
  return testSettings(overrides);
}

const eu = (overrides: Partial<Settings> = {}) =>
  settings({ requiredModelGeography: "eu", ...overrides });

function countingFetch() {
  const calls: string[] = [];
  const inner = (async (input: Parameters<typeof fetch>[0]) => {
    calls.push(String(input));
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return { calls, inner };
}

describe("side-feature route gates", () => {
  test("without the EU requirement every route runs", () => {
    expect(sideFeatureRequiresEu(settings())).toBe(false);
    expect(sideFeatureRouteRunnable(settings(), "image_generation.openai_hosted")).toBe(true);
    expect(() => assertSideFeatureRoute(settings(), "web_search.hosted")).not.toThrow();
  });

  test("under EU a route without an EU record is refused with region_restricted", () => {
    expect(sideFeatureRouteRunnable(eu(), "image_generation.openai_hosted")).toBe(false);
    let caught: unknown;
    try {
      assertSideFeatureRoute(eu(), "image_generation.openai_hosted");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InferenceRegionRestrictedError);
    expect((caught as InferenceRegionRestrictedError).code).toBe("region_restricted");
    expect((caught as Error).message).toBe("Image generation is not supported in EU.");
  });

  test("under EU a declarable route runs only once declared EU", () => {
    const searxng = { route: "web_search.searxng", endpoint: "http://searxng.internal" } as const;
    expect(sideFeatureRouteRunnable(eu(), searxng)).toBe(false);
    const declared = eu({
      sideFeatureResidencyJson: JSON.stringify({
        "web_search.searxng": { endpoint: searxng.endpoint, residency: euSelfHosted },
      }),
    });
    expect(sideFeatureRouteRunnable(declared, searxng)).toBe(true);
    expect(() => assertSideFeatureRoute(declared, searxng)).not.toThrow();
    // The declaration is for that endpoint only.
    expect(
      sideFeatureRouteRunnable(declared, { ...searxng, endpoint: "https://elsewhere.example" }),
    ).toBe(false);
  });

  test("a guarded declarable route checks each request's own URL", async () => {
    const { calls, inner } = countingFetch();
    const declared = eu({
      sideFeatureResidencyJson: JSON.stringify({
        "decision_model.openai": {
          endpoint: "https://decide.example.com",
          residency: euSelfHosted,
        },
      }),
    });
    const guarded = sideFeatureRouteFetch(declared, "decision_model.openai", inner);
    await guarded("https://decide.example.com/v1/chat/completions");
    expect(calls).toHaveLength(1);
    await expect(guarded("https://api.openai.com/v1/chat/completions")).rejects.toBeInstanceOf(
      InferenceRegionRestrictedError,
    );
    expect(calls).toHaveLength(1);
  });

  test("the guarded transport never sends a byte on a refused route", async () => {
    const { calls, inner } = countingFetch();
    const guarded = sideFeatureRouteFetch(eu(), "transcription.openai", inner);
    await expect(guarded("https://api.openai.com/v1/audio/transcriptions")).rejects.toBeInstanceOf(
      InferenceRegionRestrictedError,
    );
    expect(calls).toEqual([]);
    const open = sideFeatureRouteFetch(settings(), "transcription.openai", inner);
    await open("https://api.openai.com/v1/audio/transcriptions");
    expect(calls).toHaveLength(1);
  });

  test("an EU run context applies even when the passed settings are not EU", () => {
    withInferenceResidency(eu(), () => {
      expect(sideFeatureRequiresEu(settings())).toBe(true);
      expect(() => assertSideFeatureRoute(settings(), "video_generation.ai_gateway")).toThrow(
        InferenceRegionRestrictedError,
      );
    });
  });

  test("an unresolved run context fails closed", () => {
    withInferenceResidency(null, () => {
      expect(sideFeatureRequiresEu(settings())).toBe(true);
      expect(sideFeatureRouteRunnable(settings(), "decision_model.jev")).toBe(false);
    });
    withInferenceResidency(settings(), () => {
      expect(sideFeatureRequiresEu(settings())).toBe(false);
    });
  });

  test("the refusal names the feature", () => {
    expect(sideFeatureRegionRestrictedError("realtime_voice").message).toBe(
      "Live voice is not supported in EU.",
    );
  });
});
