import { describe, expect, test } from "bun:test";
import { fetchCodexModels } from "@opengeni/codex";
import { configuredModels, withCodexCatalogProvider } from "@opengeni/config";
import type * as dbApi from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { loadWorkspaceCodexCatalogReadiness } from "../src/codex-model-availability";
import { resolveWorkspaceModelSelection } from "../src/model-catalog";

const settings = testSettings({ codexSubscriptionEnabled: true });
const codexModels = configuredModels(withCodexCatalogProvider(settings)).filter(
  (model) =>
    model.credentialSource.kind === "connected_subscription" &&
    model.credentialSource.provider === "codex",
);
const ultrafastModel = codexModels.find((model) =>
  model.capabilities.latencyModes.some((mode) => mode.id === "ultrafast" && mode.runnable),
)!;
const slug = ultrafastModel.upstreamModelId;
const db = {} as dbApi.Database;

function connection(
  ownership: "shared" | "personal",
  slugs: string[] | null,
): dbApi.SubscriptionCoreCodexServingConnection {
  const now = Date.now();
  return {
    connectionId: crypto.randomUUID(),
    ownership,
    planType: "pro",
    allowedModelIds: null,
    excludedModelIds: [],
    assignments: null,
    pools: ["organization"],
    cooledDownModelIds: [],
    modelCatalog: slugs ? { slugs, observedAt: now - 1_000, expiresAt: now + 60_000 } : null,
  };
}

async function selection(connections: dbApi.SubscriptionCoreCodexServingConnection[]) {
  const context = {
    accountId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    subjectId: "user:ultrafast",
  };
  const read = await loadWorkspaceCodexCatalogReadiness(db, settings, context, {}, {
    recordModels: async () => true,
    disposition: async () => "core",
    listServing: async () => connections,
    fetchModels: fetchCodexModels,
    // An account without a cached list is unreadable here.
    getCoreToken: async () => null,
  } as NonNullable<Parameters<typeof loadWorkspaceCodexCatalogReadiness>[4]>);
  return resolveWorkspaceModelSelection({
    settings,
    policy: null,
    codexSubscriptionActive: read.active,
    observations: read.observations,
  }).find((row) => row.model.id === ultrafastModel.id)!;
}

describe("Ultrafast availability follows the serving accounts' plans", () => {
  test("the model's catalog declares Ultrafast", () => {
    expect(ultrafastModel).toBeDefined();
  });

  test("accounts that list the model but not the tier hide only Ultrafast", async () => {
    const row = await selection([connection("shared", [slug, `${slug}@priority`])]);
    expect(row.availability.selectable).toBe(true);
    expect(row.unavailableLatencyModes).toEqual(["ultrafast"]);
  });

  test("any serving account offering the tier keeps Ultrafast", async () => {
    const row = await selection([
      connection("shared", [slug]),
      connection("shared", [slug, `${slug}@ultrafast`]),
    ]);
    expect(row.availability.selectable).toBe(true);
    expect(row.unavailableLatencyModes).toBeUndefined();
  });

  test("the tier must be offered for this model, not another", async () => {
    const row = await selection([connection("shared", [slug, "other-model@ultrafast"])]);
    expect(row.unavailableLatencyModes).toEqual(["ultrafast"]);
  });

  test("an account whose list is unknown never hides it", async () => {
    for (const unknown of [connection("shared", null), connection("personal", null)]) {
      const row = await selection([connection("shared", [slug]), unknown]);
      expect(row.unavailableLatencyModes).toBeUndefined();
    }
  });
});
