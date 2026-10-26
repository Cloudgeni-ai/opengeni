import { describe, expect, test } from "bun:test";
import type { Database } from "@opengeni/db";
import { testSettings } from "@opengeni/testing/settings";
import {
  currentInferenceResidency,
  InferenceRegionRestrictedError,
  withInferenceResidency,
} from "@opengeni/runtime";
import { assertTurnInferenceResidency } from "../src/activities/agent-turn/inference-residency-gate";

const eu = {
  geography: "eu",
  deploymentType: "azure_data_zone",
  regions: ["swedencentral"],
  evidence: { source: "operator_declaration", reference: "x", verifiedAt: "2026-10-26" },
};
const db = {} as Database;

function gate(input: {
  euOnly: boolean;
  residency?: unknown;
  resolved?: boolean;
  required?: boolean;
}) {
  return assertTurnInferenceResidency({
    db,
    accountId: "account",
    workspaceId: "workspace",
    settings: testSettings(input.required ? { requiredModelGeography: "eu" } : {}),
    resolvedModel: input.resolved === false ? null : { configured: { residency: input.residency } },
    productModelId: "model",
    isEuOnly: async () => input.euOnly,
  });
}

describe("worker EU-only gate", () => {
  test("a workspace that is not EU-only is unaffected", async () => {
    await withInferenceResidency(testSettings(), async () => {
      await gate({ euOnly: false });
      expect(currentInferenceResidency()?.requirement).toBeNull();
    });
  });

  test("an EU-only workspace runs an EU route and narrows the attempt to EU", async () => {
    await withInferenceResidency(testSettings(), async () => {
      await gate({ euOnly: true, residency: eu });
      expect(currentInferenceResidency()?.requirement?.geography).toBe("eu");
    });
  });

  test("an EU-only workspace refuses an unknown or unresolved route", async () => {
    await expect(gate({ euOnly: true })).rejects.toThrow(InferenceRegionRestrictedError);
    await expect(gate({ euOnly: true, resolved: false })).rejects.toThrow(
      InferenceRegionRestrictedError,
    );
  });

  test("an EU requirement from the claim applies even if the recheck reads off", async () => {
    await expect(gate({ euOnly: false, required: true })).rejects.toThrow(
      InferenceRegionRestrictedError,
    );
  });
});
