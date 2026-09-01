import { describe, expect, spyOn, test } from "bun:test";
import { configuredModels, configuredProviders, type ModelCatalogDocument } from "@opengeni/config";
import { resolveCatalogSettings } from "@opengeni/core";
import * as opengeniDb from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { createSharedActivityServices } from "../src/activity-services";

describe("worker model catalog source settings", () => {
  test("retains host provider credentials for a provider added after worker startup", async () => {
    const hostProvider = {
      id: "live-provider",
      baseUrl: "https://live-provider.example.test/v1",
      apiKey: "host-test-key",
      models: [{ id: "host/placeholder" }],
    };
    let document: ModelCatalogDocument = {
      schemaVersion: 1,
      builtInModels: ["gpt-5.6-luna"],
      registryProviders: [],
      gatewayModels: [],
      openrouterModels: [],
      modelNotes: {},
    };
    const getCatalog = spyOn(opengeniDb, "getDeploymentModelCatalog").mockImplementation(
      async () => ({
        document,
        version: document.registryProviders?.length ? 2 : 1,
        updatedAt: new Date("2026-08-28T12:00:00.000Z"),
      }),
    );
    const settings = testSettings({
      modelCatalogSource: "database",
      modelProvidersJson: JSON.stringify([hostProvider]),
    });

    try {
      const loadServices = createSharedActivityServices({
        settings,
        db: {} as opengeniDb.Database,
        bus: {} as never,
        objectStorage: {} as never,
        observability: {} as never,
        connectionCredentials: {} as never,
      });
      const services = await loadServices();

      expect(
        configuredProviders(services.settings).some((provider) => provider.id === "live-provider"),
      ).toBe(false);
      expect(
        configuredProviders(services.catalogSourceSettings!).some(
          (provider) => provider.id === "live-provider",
        ),
      ).toBe(true);

      document = {
        ...document,
        registryProviders: [
          {
            id: "live-provider",
            baseUrl: "https://live-provider.example.test/v1",
            models: [{ id: "live-provider/new-model" }],
          },
        ],
      };
      const refreshed = await resolveCatalogSettings(services.db, services.catalogSourceSettings!);

      expect(configuredModels(refreshed.settings)).toContainEqual(
        expect.objectContaining({
          id: "live-provider/new-model",
          providerId: "live-provider",
        }),
      );
      expect(
        configuredProviders(refreshed.settings).find((provider) => provider.id === "live-provider"),
      ).toMatchObject({ apiKey: "host-test-key" });
    } finally {
      getCatalog.mockRestore();
    }
  });
});
