import { describe, expect, test } from "bun:test";
import type { Database } from "@opengeni/db";
import { testSettings } from "@opengeni/testing/settings";
import {
  currentInferenceResidency,
  InferenceRegionRestrictedError,
  withInferenceResidency,
} from "@opengeni/runtime";
import { agentRunFailurePayload } from "../src/activities/agent-turn/errors";
import {
  assertTurnModelInferenceResidency,
  settingsWithTurnInferenceResidency,
} from "../src/activities/agent-turn/inference-residency-gate";

const eu = {
  geography: "eu",
  deploymentType: "azure_data_zone",
  regions: ["swedencentral"],
  evidence: { source: "operator_declaration", reference: "x", verifiedAt: "2026-10-26" },
};
const db = {} as Database;

function gate(input: { euOnly: boolean; required?: boolean }) {
  return settingsWithTurnInferenceResidency({
    db,
    accountId: "account",
    workspaceId: "workspace",
    settings: testSettings(input.required ? { requiredModelGeography: "eu" } : {}),
    isEuOnly: async () => input.euOnly,
  });
}

describe("worker EU-only gate", () => {
  test("a workspace that is not EU-only is unaffected", async () => {
    await withInferenceResidency(null, async () => {
      const settings = await gate({ euOnly: false });
      expect(settings.requiredModelGeography).toBeUndefined();
      expect(currentInferenceResidency()).toEqual({ requirement: null, resolved: true });
    });
  });

  test("a setting turned on after the claim narrows the returned settings and the attempt", async () => {
    await withInferenceResidency(testSettings(), async () => {
      const settings = await gate({ euOnly: true });
      expect(settings.requiredModelGeography).toBe("eu");
      expect(currentInferenceResidency()?.requirement?.geography).toBe("eu");
    });
  });

  test("an EU requirement from the claim applies even if the recheck reads off", async () => {
    const settings = await gate({ euOnly: false, required: true });
    expect(settings.requiredModelGeography).toBe("eu");
  });

  test("under EU a turn must resolve to an EU route", () => {
    const required = testSettings({ requiredModelGeography: "eu" });
    const check = (resolvedModel: { configured: { residency?: unknown } } | null) => () =>
      assertTurnModelInferenceResidency({
        settings: required,
        resolvedModel,
        productModelId: "model",
      });
    expect(check({ configured: { residency: eu } })).not.toThrow();
    expect(check({ configured: {} })).toThrow(InferenceRegionRestrictedError);
    expect(check(null)).toThrow(InferenceRegionRestrictedError);
    expect(() =>
      assertTurnModelInferenceResidency({
        settings: testSettings(),
        resolvedModel: null,
        productModelId: "model",
      }),
    ).not.toThrow();
  });
});

describe("worker classification of EU-only refusals", () => {
  test("a direct or SDK-wrapped refusal ends the turn as region_restricted, never retried", () => {
    const refusal = new InferenceRegionRestrictedError("gpt-global");
    // The OpenAI SDK's shape when it retried a thrown fetch error.
    const wrapped = Object.assign(new Error("Connection error."), {
      name: "APIConnectionError",
      cause: refusal,
    });
    for (const error of [refusal, wrapped]) {
      expect(agentRunFailurePayload(error)).toMatchObject({
        code: "region_restricted",
        retryable: false,
        model: "gpt-global",
        error: refusal.message,
      });
    }
  });
});
