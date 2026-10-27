import { describe, expect, test } from "bun:test";
import {
  ModelCallProcessingResidencyV1,
  modelCallProcessingResidency,
  parseModelCallProcessingResidency,
  UNKNOWN_MODEL_RESIDENCY,
} from "../src/model-residency";
import { InsightsCall } from "../src/insights-usage";

const euDataZone = {
  geography: "eu",
  deploymentType: "azure_data_zone",
  regions: ["swedencentral", "germanywestcentral", "swedencentral"],
  evidence: {
    source: "operator_declaration",
    reference: "Deployment gpt-eu on res-neu-internal, sku DataZoneStandard",
    verifiedAt: "2026-10-26",
  },
} as const;
const UNKNOWN: ModelCallProcessingResidencyV1 = {
  geography: "unknown",
  deploymentType: "unknown",
  regions: [],
};

describe("model call processing residency", () => {
  test("a call records the route's claim only, never its evidence", () => {
    const recorded = modelCallProcessingResidency(euDataZone as never);
    expect(recorded).toEqual({
      geography: "eu",
      deploymentType: "azure_data_zone",
      regions: ["germanywestcentral", "swedencentral"],
    });
    expect(JSON.stringify(recorded)).not.toContain("res-neu-internal");
    expect(ModelCallProcessingResidencyV1.parse(recorded)).toEqual(recorded);
  });

  test("a missing or invalid route record is recorded as unknown", () => {
    expect(modelCallProcessingResidency(UNKNOWN_MODEL_RESIDENCY)).toEqual(UNKNOWN);
    expect(modelCallProcessingResidency(null)).toEqual(UNKNOWN);
    expect(modelCallProcessingResidency(undefined)).toEqual(UNKNOWN);
    // An EU claim on a deployment type that can leave the EU is not a record.
    expect(
      modelCallProcessingResidency({ ...euDataZone, deploymentType: "gateway" } as never),
    ).toEqual(UNKNOWN);
    // A known geography without evidence is not a record either.
    expect(
      modelCallProcessingResidency({
        ...euDataZone,
        evidence: { source: "none", reference: null, verifiedAt: null },
      } as never),
    ).toEqual(UNKNOWN);
  });

  test("reading a recorded value: absent is before the change, malformed is unknown", () => {
    expect(parseModelCallProcessingResidency(undefined)).toBeNull();
    expect(parseModelCallProcessingResidency(null)).toBeNull();
    expect(parseModelCallProcessingResidency("eu")).toEqual(UNKNOWN);
    expect(parseModelCallProcessingResidency([])).toEqual(UNKNOWN);
    expect(parseModelCallProcessingResidency({ geography: "eu" })).toEqual(UNKNOWN);
    expect(
      parseModelCallProcessingResidency({
        geography: "mars",
        deploymentType: "azure_regional",
        regions: [],
      }),
    ).toEqual(UNKNOWN);
    // Extra fields, including evidence, are dropped.
    expect(parseModelCallProcessingResidency(euDataZone)).toEqual({
      geography: "eu",
      deploymentType: "azure_data_zone",
      regions: ["germanywestcentral", "swedencentral"],
    });
  });

  test("Insights calls expose the geography, null only for calls recorded before it", () => {
    const call = {
      id: "00000000-0000-4000-8000-000000000001",
      occurredAt: "2026-10-26T10:00:00Z",
      workspaceId: "00000000-0000-4000-8000-000000000002",
      sessionId: null,
      sessionTitle: null,
      sessionKind: "private",
      personKey: null,
      provider: "azure-eu",
      model: "azure-eu/gpt-eu",
      payer: "own_key",
      tokens: null,
      chargedMicros: 0,
      listMicros: null,
      listByClassMicros: null,
    } as const;
    for (const processingGeography of ["eu", "us", "global", "other", "unknown", null] as const) {
      expect(InsightsCall.parse({ ...call, processingGeography }).processingGeography).toBe(
        processingGeography,
      );
    }
    expect(InsightsCall.safeParse({ ...call, processingGeography: "mars" }).success).toBe(false);
    expect(InsightsCall.safeParse(call).success).toBe(false);
  });
});
