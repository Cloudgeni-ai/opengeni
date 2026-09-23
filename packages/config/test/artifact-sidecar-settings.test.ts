import { describe, expect, test } from "bun:test";
import {
  getArtifactMaterializerSettings,
  getArtifactOutboxSettings,
  getSettings,
  resolveNatsControlPlaneAuth,
} from "../src";

const managedModal = {
  OPENGENI_ENVIRONMENT: "production",
  OPENGENI_PRODUCT_ACCESS_MODE: "managed",
  OPENGENI_SANDBOX_BACKEND: "modal",
  OPENGENI_PUBLIC_BASE_URL: "https://agents.example.test",
};

describe("artifact service configuration boundary", () => {
  test("shared managed/Modal config does not require unrelated secrets for either sidecar", () => {
    for (const read of [getArtifactOutboxSettings, getArtifactMaterializerSettings]) {
      const settings = read(managedModal);
      expect(settings.environment).toBe("production");
      expect(settings).not.toHaveProperty("betterAuthSecret");
      expect(settings).not.toHaveProperty("modalTokenSecret");
      expect(settings).not.toHaveProperty("databaseUrl");
      expect(settings).not.toHaveProperty("productAccessMode");
      expect(settings).not.toHaveProperty("authRequired");
    }
    // The full API/worker contract is deliberately unchanged.
    expect(() => getSettings(managedModal)).toThrow("OPENGENI_BETTER_AUTH_SECRET");
    expect(() =>
      getSettings({
        OPENGENI_ENVIRONMENT: "production",
        OPENGENI_PRODUCT_ACCESS_MODE: "configured",
        OPENGENI_SANDBOX_BACKEND: "none",
      }),
    ).toThrow("OPENGENI_DELEGATION_SECRET");
  });

  test("defaults and explicit common settings match the canonical runtime parser", () => {
    for (const source of [
      {},
      {
        OPENGENI_SERVICE_NAME: "artifact-test",
        OPENGENI_ENVIRONMENT: "test",
        OPENGENI_DEPLOYMENT_REVISION: "revision-123",
        OPENGENI_DB_SCHEMA: "artifacts",
        OPENGENI_RLS_STRATEGY: "force",
        OPENGENI_OBSERVABILITY_STRUCTURED_LOGS: "true",
        OPENGENI_OBSERVABILITY_METRICS_ENABLED: "false",
        OPENGENI_OTEL_EXPORTER_OTLP_ENDPOINT: "https://telemetry.example.test",
        OPENGENI_OTEL_EXPORTER_OTLP_HEADERS: "x-test=value",
      },
    ]) {
      const full = getSettings(source);
      for (const read of [getArtifactOutboxSettings, getArtifactMaterializerSettings]) {
        for (const [key, value] of Object.entries(read(source))) {
          expect(value).toEqual(full[key as keyof typeof full]);
        }
      }
    }
  });

  test("honors explicit environment rather than ambient credentials", () => {
    const source = {
      ...managedModal,
      SOURCE_VERSION: "source-version",
      GITHUB_SHA: "github-version",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.test",
      OPENGENI_NATS_URL: "nats://broker.example.test:4222",
      OPENGENI_SELFHOSTED_NATS_CONTROL_USER: "dispatcher",
      OPENGENI_SELFHOSTED_NATS_CONTROL_PASSWORD: "synthetic-password",
      OPENGENI_BETTER_AUTH_SECRET: "must-not-be-carried",
      OPENGENI_MODAL_TOKEN_SECRET: "must-not-be-carried",
      OPENGENI_MCP_SERVERS: "deliberately-invalid-unrelated-json",
      OPENGENI_OBJECT_STORAGE_AZURE_CONNECTION_STRING: "unrelated-to-outbox",
    };
    const settings = getArtifactOutboxSettings(source);
    expect(settings.deploymentRevision).toBe("source-version");
    expect(settings.observabilityOtlpEndpoint).toBe(source.OTEL_EXPORTER_OTLP_ENDPOINT);
    expect(settings.natsUrl).toBe(source.OPENGENI_NATS_URL);
    expect(resolveNatsControlPlaneAuth(settings)).toEqual({
      user: "dispatcher",
      password: "synthetic-password",
    });
    expect(settings).not.toHaveProperty("objectStorageAzureConnectionString");
    expect(settings).not.toHaveProperty("betterAuthSecret");
    expect(getArtifactOutboxSettings({}).selfhostedNatsControlPassword).toBeUndefined();
    expect(getArtifactOutboxSettings({ GITHUB_SHA: "fallback" }).deploymentRevision).toBe(
      "fallback",
    );
  });

  test("partial NATS credentials fail closed instead of silently becoming anonymous", () => {
    for (const source of [
      { OPENGENI_SELFHOSTED_NATS_CONTROL_USER: "dispatcher" },
      { OPENGENI_SELFHOSTED_NATS_CONTROL_PASSWORD: "synthetic-password" },
      {
        OPENGENI_SELFHOSTED_NATS_CONTROL_USER: " ",
        OPENGENI_SELFHOSTED_NATS_CONTROL_PASSWORD: "synthetic-password",
      },
    ])
      expect(() => getArtifactOutboxSettings(source)).toThrow("configured together");
    expect(resolveNatsControlPlaneAuth(getArtifactOutboxSettings({}))).toBeNull();
  });

  test("sidecars still validate their schema and telemetry fields", () => {
    for (const read of [getArtifactOutboxSettings, getArtifactMaterializerSettings]) {
      expect(() => read({ OPENGENI_DB_SCHEMA: "invalid;schema" })).toThrow("Postgres identifier");
      expect(() => read({ OPENGENI_OTEL_EXPORTER_OTLP_ENDPOINT: "not-a-url" })).toThrow();
      expect(() => read({ OPENGENI_RLS_STRATEGY: "none" })).toThrow();
    }
  });

  test("materializer retains provider validation without sandbox/auth configuration", () => {
    const storage = {
      ...managedModal,
      OPENGENI_OBJECT_STORAGE_ENDPOINT: "https://storage.example.test",
      OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID: "synthetic-id",
      OPENGENI_OBJECT_STORAGE_SECRET_ACCESS_KEY: "synthetic-key",
    };
    expect(getArtifactMaterializerSettings(storage).objectStorageEndpoint).toBe(
      storage.OPENGENI_OBJECT_STORAGE_ENDPOINT,
    );
    expect(() =>
      getArtifactMaterializerSettings({
        ...storage,
        OPENGENI_OBJECT_STORAGE_SECRET_ACCESS_KEY: "",
      }),
    ).toThrow("both be set");
    expect(() =>
      getArtifactMaterializerSettings({
        ...managedModal,
        OPENGENI_OBJECT_STORAGE_BACKEND: "azure-blob",
      }),
    ).toThrow("Azure Blob storage requires");
    expect(() =>
      getArtifactMaterializerSettings({
        ...storage,
        OPENGENI_OBJECT_STORAGE_BACKEND: "azure-blob",
      }),
    ).toThrow("not S3-compatible");
    expect(() =>
      getArtifactMaterializerSettings({
        ...managedModal,
        OPENGENI_OBJECT_STORAGE_BACKEND: "gcs",
        OPENGENI_OBJECT_STORAGE_GCS_CREDENTIALS_JSON: "invalid",
      }),
    ).toThrow();
    expect(
      getArtifactMaterializerSettings({
        ...managedModal,
        OPENGENI_OBJECT_STORAGE_BACKEND: "azure-blob",
        OPENGENI_OBJECT_STORAGE_AZURE_ACCOUNT_NAME: "synthetic",
        OPENGENI_OBJECT_STORAGE_AZURE_ACCOUNT_KEY: "synthetic",
      }).objectStorageBackend,
    ).toBe("azure-blob");
  });
});
