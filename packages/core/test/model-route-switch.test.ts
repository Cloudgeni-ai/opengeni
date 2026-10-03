import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { resolveTurnExecutionPolicyV1 } from "@opengeni/config";
import * as opengeniDb from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { resolveCatalogSettings } from "../src/model-catalog";

const PRODUCT = "gpt-5.6-luna";
const env = testSettings({ modelCatalogSource: "database", vercelAiGatewayApiKey: "vck_test" });
const document = {
  schemaVersion: 1,
  defaultModel: PRODUCT,
  builtInModels: [PRODUCT],
  fallbackRoutes: [
    {
      productId: PRODUCT,
      via: "opengeni-gateway",
      upstreamModelId: "openai/gpt-5.6-luna",
      providers: ["openai"],
    },
  ],
};
const request = {
  modelId: PRODUCT,
  requestedModelId: null,
  modelSource: "session" as const,
  reasoningEffort: "low" as const,
  reasoningSource: "session" as const,
};

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

function catalog(documentValue: unknown) {
  spies.push(
    spyOn(opengeniDb, "getDeploymentModelCatalog").mockResolvedValue({
      document: documentValue,
      version: 7,
      updatedAt: new Date(),
    }),
  );
}

describe("credits model route switch resolution", () => {
  test("the newest switch revision routes new turns without a deploy, and flips back", async () => {
    catalog(document);
    const states = spyOn(opengeniDb, "readModelRouteSwitchStates");
    spies.push(states);
    const db = {} as opengeniDb.Database;

    states.mockResolvedValue([]);
    const primary = await resolveCatalogSettings(db, env);
    expect(resolveTurnExecutionPolicyV1(primary.settings, request).providerId).toBe("openai");

    states.mockResolvedValue([
      { productModelId: PRODUCT, route: "fallback", revision: 3, changedAt: new Date() },
      // A revision for a product without a declared route is inert.
      { productModelId: "unknown/model", route: "fallback", revision: 4, changedAt: new Date() },
    ]);
    const switched = await resolveCatalogSettings(db, env);
    expect(resolveTurnExecutionPolicyV1(switched.settings, request)).toMatchObject({
      productModelId: PRODUCT,
      providerId: "opengeni-gateway",
      upstreamModelId: "openai/gpt-5.6-luna",
      billing: { upstreamPayer: "deployment", metering: "opengeni_credits" },
    });
    expect(switched.version).toBe(7);

    states.mockResolvedValue([
      { productModelId: PRODUCT, route: "primary", revision: 5, changedAt: new Date() },
    ]);
    const back = await resolveCatalogSettings(db, env);
    expect(resolveTurnExecutionPolicyV1(back.settings, request).providerId).toBe("openai");
  });

  test("a catalog without declared routes never reads the switch", async () => {
    const { fallbackRoutes: _routes, ...withoutRoutes } = document;
    catalog(withoutRoutes);
    const states = spyOn(opengeniDb, "readModelRouteSwitchStates").mockImplementation(async () => {
      throw new Error("the switch must not be read without a declared route");
    });
    spies.push(states);
    const resolved = await resolveCatalogSettings({} as opengeniDb.Database, env);
    expect(resolveTurnExecutionPolicyV1(resolved.settings, request).providerId).toBe("openai");
    expect(states).not.toHaveBeenCalled();
  });
});
