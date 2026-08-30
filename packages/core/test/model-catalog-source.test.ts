import { describe, expect, spyOn, test } from "bun:test";
import {
  configuredModels,
  resolveTurnExecutionPolicyV1,
  type ModelCatalogDocument,
} from "@opengeni/config";
import * as opengeniDb from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { canonicalConfiguredModel } from "../src/domain/sessions";
import { resolveCatalogSettings, resolveWorkspaceCatalogSettings } from "../src/model-catalog";

const accountId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";

describe("model catalog source resolution", () => {
  test("fails closed when database mode has no singleton row", async () => {
    const getCatalog = spyOn(opengeniDb, "getDeploymentModelCatalog").mockResolvedValue(null);
    try {
      await expect(
        resolveCatalogSettings(
          {} as opengeniDb.Database,
          testSettings({ modelCatalogSource: "database" }),
        ),
      ).rejects.toThrow("singleton row is missing");
    } finally {
      getCatalog.mockRestore();
    }
  });

  test("fails closed when the database singleton document is invalid", async () => {
    const getCatalog = spyOn(opengeniDb, "getDeploymentModelCatalog").mockResolvedValue({
      document: { schemaVersion: 1, builtInModels: ["gpt-5.6-luna"], billing: {} },
      version: 2,
      updatedAt: new Date("2026-08-27T12:00:00.000Z"),
    });
    try {
      await expect(
        resolveCatalogSettings(
          {} as opengeniDb.Database,
          testSettings({ modelCatalogSource: "database" }),
        ),
      ).rejects.toThrow();
    } finally {
      getCatalog.mockRestore();
    }
  });

  test("applies one validated database document without mutating deployment billing policy", async () => {
    const document: ModelCatalogDocument = {
      schemaVersion: 1,
      builtInModels: ["gpt-5.6-luna"],
      registryProviders: [],
      gatewayModels: [],
      openrouterModels: [],
      modelNotes: { "gpt-5.6-luna": "Database-owned note." },
    };
    const getCatalog = spyOn(opengeniDb, "getDeploymentModelCatalog").mockResolvedValue({
      document,
      version: 7,
      updatedAt: new Date("2026-08-27T12:00:00.000Z"),
    });
    try {
      const resolved = await resolveCatalogSettings(
        {} as opengeniDb.Database,
        testSettings({
          modelCatalogSource: "database",
          modelCostPolicyJson: JSON.stringify({ "gpt-5.6-luna": "free" }),
        }),
      );
      expect(resolved).toMatchObject({
        source: "database",
        version: 7,
        modelNotes: { "gpt-5.6-luna": "Database-owned note." },
      });
      expect(resolved.settings.openaiModel).toBe("gpt-5.6-luna");
      expect(resolved.settings.modelCostPolicyJson).toBe(
        JSON.stringify({ "gpt-5.6-luna": "free" }),
      );
    } finally {
      getCatalog.mockRestore();
    }
  });

  test("accepts a database catalog that omits the code-mode OpenRouter starter", async () => {
    const getCatalog = spyOn(opengeniDb, "getDeploymentModelCatalog").mockResolvedValue({
      document: {
        schemaVersion: 1,
        builtInModels: ["gpt-5.6-luna"],
        registryProviders: [],
        gatewayModels: [],
        openrouterModels: [],
        modelNotes: {},
      },
      version: 8,
      updatedAt: new Date("2026-08-27T12:00:00.000Z"),
    });
    try {
      const resolved = await resolveCatalogSettings(
        {} as opengeniDb.Database,
        testSettings({ modelCatalogSource: "database" }),
      );
      expect(resolved.settings.modelCostPolicyJson).toBe("{}");
      expect(resolved.settings.openaiModel).toBe("gpt-5.6-luna");
    } finally {
      getCatalog.mockRestore();
    }
  });

  test("adds only the workspace's durable custom Gateway rows to executable settings", async () => {
    const listCustom = spyOn(opengeniDb, "listWorkspaceGatewayCustomModels").mockResolvedValue([
      {
        id: "33333333-3333-4333-8333-333333333333",
        accountId,
        workspaceId,
        upstreamModelId: "anthropic/claude-sonnet-4.6",
        label: null,
        version: 1,
        createdBySubjectId: "subject-a",
        createdAt: new Date("2026-08-27T12:00:00.000Z"),
        updatedAt: new Date("2026-08-27T12:00:00.000Z"),
      },
    ]);
    try {
      const resolved = await resolveWorkspaceCatalogSettings(
        {} as opengeniDb.Database,
        testSettings(),
        { accountId, workspaceId },
      );
      const policy = resolveTurnExecutionPolicyV1(resolved.settings, {
        modelId: "workspace-gateway/anthropic/claude-sonnet-4.6",
        requestedModelId: "workspace-gateway/anthropic/claude-sonnet-4.6",
        modelSource: "explicit",
        reasoningEffort: "low",
        reasoningSource: "explicit",
        latencyMode: "standard",
        latencyModeSource: "explicit",
      });

      expect(listCustom).toHaveBeenCalledWith(expect.anything(), { accountId, workspaceId });
      expect(policy).toMatchObject({
        providerId: "workspace-gateway",
        upstreamModelId: "anthropic/claude-sonnet-4.6",
        billing: { upstreamPayer: "workspace", metering: "external" },
      });
      expect(policy.definitionVersion).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(
        canonicalConfiguredModel(
          resolved.settings,
          "workspace-gateway/anthropic/claude-sonnet-4.6",
        ),
      ).toBe("workspace-gateway/anthropic/claude-sonnet-4.6");
      expect(() =>
        canonicalConfiguredModel(resolved.settings, "workspace-gateway/unstored/model"),
      ).toThrow("model is not available");
    } finally {
      listCustom.mockRestore();
    }
  });

  test("lets deployment Gateway membership shadow a colliding custom row", async () => {
    const listCustom = spyOn(opengeniDb, "listWorkspaceGatewayCustomModels").mockResolvedValue([
      {
        id: "33333333-3333-4333-8333-333333333333",
        accountId,
        workspaceId,
        upstreamModelId: "deepseek/deepseek-v4-flash-0731",
        label: "Stale custom label",
        version: 1,
        createdBySubjectId: "subject-a",
        createdAt: new Date("2026-08-27T12:00:00.000Z"),
        updatedAt: new Date("2026-08-27T12:00:00.000Z"),
      },
    ]);
    try {
      const resolved = await resolveWorkspaceCatalogSettings(
        {} as opengeniDb.Database,
        testSettings(),
        { accountId, workspaceId },
      );
      const matching = configuredModels(resolved.settings).filter(
        (model) => model.upstreamModelId === "deepseek/deepseek-v4-flash-0731",
      );
      expect(matching).toHaveLength(1);
      expect(matching[0]).toMatchObject({
        id: "workspace-gateway/deepseek-v4-flash-0731",
        label: expect.not.stringContaining("Stale custom label"),
      });
    } finally {
      listCustom.mockRestore();
    }
  });

  test("retains every distinct retired custom model needed by an existing-session decision", async () => {
    const listCustom = spyOn(opengeniDb, "listWorkspaceGatewayCustomModels").mockResolvedValue([]);
    const getRetained = spyOn(
      opengeniDb,
      "getWorkspaceGatewayCustomModelForExecution",
    ).mockImplementation(async (_db, input) => ({
      id: crypto.randomUUID(),
      accountId,
      workspaceId,
      upstreamModelId: input.upstreamModelId,
      label: null,
      version: 2,
      createdBySubjectId: "subject-a",
      retiredAt: new Date("2026-08-29T12:00:00.000Z"),
      createdAt: new Date("2026-08-27T12:00:00.000Z"),
      updatedAt: new Date("2026-08-29T12:00:00.000Z"),
    }));
    try {
      const inherited = "workspace-gateway/anthropic/claude-opus-4.6";
      const fallback = "workspace-gateway/anthropic/claude-sonnet-4.6";
      const resolved = await resolveWorkspaceCatalogSettings(
        {} as opengeniDb.Database,
        testSettings(),
        {
          accountId,
          workspaceId,
          retainedProductModelIds: [inherited, fallback, inherited, "scripted-model"],
        },
      );

      expect(canonicalConfiguredModel(resolved.settings, inherited)).toBe(inherited);
      expect(canonicalConfiguredModel(resolved.settings, fallback)).toBe(fallback);
      expect(getRetained).toHaveBeenCalledTimes(2);
    } finally {
      getRetained.mockRestore();
      listCustom.mockRestore();
    }
  });
});
