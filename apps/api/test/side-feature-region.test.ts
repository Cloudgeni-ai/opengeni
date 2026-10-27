import { describe, expect, test } from "bun:test";
import type { Settings } from "@opengeni/config";
import { resolveWorkspaceModelSelection } from "@opengeni/core";
import { InferenceRegionRestrictedError } from "@opengeni/runtime";
import { testSettings } from "@opengeni/testing/settings";
import { clientAgentConfig } from "../src/app";
import { regionRestrictedHttpError } from "../src/http/api-error";
import { withRegionAvailability } from "../src/model-catalog";
import { videoGenerationFundingOptions } from "../src/routes/video-generation";
import { siteOutsideModelChoice } from "../src/site-publishing/agent-model";

const euDataZone = {
  geography: "eu",
  deploymentType: "azure_data_zone",
  regions: ["swedencentral"],
  evidence: {
    source: "operator_declaration",
    reference: "Azure deployment gpt-eu, sku DataZoneStandard",
    verifiedAt: "2026-10-26",
  },
} as const;

function catalogSettings(overrides: Partial<Settings> = {}): Settings {
  return testSettings({
    modelProvidersJson: JSON.stringify([
      {
        id: "azure-eu",
        api: "responses",
        wireProfile: "azure-openai",
        baseUrl: "https://res.openai.azure.com/openai/v1",
        apiKey: "key",
        models: [
          { id: "azure-eu/gpt-eu", upstreamModelId: "gpt-eu", residency: euDataZone },
          // Named EU, but nothing declares where it runs: unknown, so not EU.
          { id: "azure-eu/gpt-global-eu", upstreamModelId: "gpt-global-eu" },
        ],
      },
    ]),
    ...overrides,
  });
}

function selections(settings: Settings) {
  return resolveWorkspaceModelSelection({
    settings,
    policy: null,
    codexSubscriptionActive: false,
    xaiSubscriptionActive: false,
  });
}

describe("region refusals over HTTP", () => {
  test("a region refusal is a 422 with region_restricted; other errors are untouched", () => {
    const mapped = regionRestrictedHttpError(new InferenceRegionRestrictedError("web_search"));
    expect(mapped?.status).toBe(422);
    expect(mapped).toMatchObject({
      code: "validation_failed",
      retryable: false,
      details: { code: "region_restricted" },
    });
    expect(regionRestrictedHttpError(new Error("other"))).toBeNull();
  });
});

describe("model availability under EU-only inference", () => {
  test("models without an EU residency record are region_restricted; EU models stay", () => {
    const settings = catalogSettings();
    const all = selections(settings);
    const restricted = withRegionAvailability(all, "eu");
    const byId = new Map(restricted.map((selection) => [selection.model.id, selection]));
    expect(byId.get("azure-eu/gpt-eu")?.availability).toEqual(
      all.find((selection) => selection.model.id === "azure-eu/gpt-eu")!.availability,
    );
    expect(byId.get("azure-eu/gpt-global-eu")?.availability).toMatchObject({
      status: "unavailable",
      selectable: false,
      reason: "region_restricted",
    });
    expect(withRegionAvailability(all, undefined)).toEqual(all);
  });
});

describe("video funding under EU-only inference", () => {
  const configured = {
    managedConfigured: true,
    creditsDisabled: false,
    workspaceGatewayConfigured: true,
    supergrokConfigured: true,
  };

  test("every funding source is switched off with the region reason", () => {
    const options = videoGenerationFundingOptions({
      ...configured,
      residencySettings: testSettings({ requiredModelGeography: "eu" }),
    });
    expect(options).toHaveLength(3);
    for (const option of options) {
      expect(option).toMatchObject({
        available: false,
        unavailableReason: "Not supported in EU",
        unavailableCode: "region_restricted",
      });
    }
  });

  test("outside EU configured sources stay available", () => {
    const options = videoGenerationFundingOptions({
      ...configured,
      residencySettings: testSettings(),
    });
    expect(options.every((option) => option.available)).toBe(true);
    expect(options.some((option) => "unavailableCode" in option)).toBe(false);
  });
});

describe("agent capabilities under EU-only inference", () => {
  test("a capability with no configured EU route carries the region_restricted code", () => {
    const capabilities = (settings: Settings) =>
      new Map(clientAgentConfig(settings).capabilities.map((c) => [c.id, c]));
    const eu = capabilities(
      testSettings({
        requiredModelGeography: "eu",
        webSearchEnabled: true,
        webSearchProvider: "tavily",
        webSearchProviderCredentials: { tavily: { apiKey: "key" } },
      }),
    );
    for (const id of ["webSearch", "media"] as const) {
      expect(eu.get(id)).toEqual({
        id,
        available: false,
        reason: "Not supported in EU",
        code: "region_restricted",
      });
    }
    const open = capabilities(testSettings());
    expect(open.get("webSearch")?.code).toBeUndefined();
  });
});

describe("Site viewer conversations under EU-only inference", () => {
  const defaults = { workspaceDefaults: null, organizationDefaults: null };

  test("a non-EU model is replaced only by an EU model, never by a non-EU fallback", () => {
    const settings = catalogSettings({ requiredModelGeography: "eu" });
    const all = selections(settings).map((selection) => ({
      ...selection,
      model: { ...selection.model, cost: "credits" as const },
    }));
    expect(
      siteOutsideModelChoice({
        settings,
        selections: all,
        agentModel: "azure-eu/gpt-eu",
        ...defaults,
      }),
    ).toEqual({ kind: "same", model: "azure-eu/gpt-eu" });
    const choice = siteOutsideModelChoice({
      settings,
      selections: all,
      agentModel: "azure-eu/gpt-global-eu",
      ...defaults,
    });
    expect(choice).toEqual({ kind: "fallback", model: "azure-eu/gpt-eu" });

    const noEu = all.filter((selection) => selection.model.id !== "azure-eu/gpt-eu");
    expect(
      siteOutsideModelChoice({
        settings,
        selections: noEu,
        agentModel: "azure-eu/gpt-global-eu",
        ...defaults,
      }),
    ).toEqual({ kind: "unavailable" });
  });

  test("outside EU the Site agent's model is used as before", () => {
    const settings = catalogSettings();
    const all = selections(settings).map((selection) => ({
      ...selection,
      model: { ...selection.model, cost: "credits" as const },
    }));
    expect(
      siteOutsideModelChoice({
        settings,
        selections: all,
        agentModel: "azure-eu/gpt-global-eu",
        ...defaults,
      }),
    ).toEqual({ kind: "same", model: "azure-eu/gpt-global-eu" });
  });
});
