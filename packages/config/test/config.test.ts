import { describe, expect, test } from "bun:test";
import {
  collectGitIdentityEnvironment,
  configuredEntitlements,
  collectSandboxEnvironment,
  configuredStaticUsageLimits,
  configuredAllowedModels,
  configuredAllowedReasoningEfforts,
  environmentsEncryptionKeyBytes,
  getSettings,
  parseStaticEntitlementsJson,
  parseStaticUsageLimitsJson,
  parseMcpServers,
  retryStartupDependency,
  sandboxEnvironmentVariableNames,
  sandboxLifecycleHookIds,
  startupRetryOptions,
} from "../src";

describe("sandbox preparation profiles", () => {
  test("defaults to no sandbox environment exposure or lifecycle hooks", () => {
    const settings = withEnv({}, () => getSettings());
    expect(settings.sandboxPreparationProfiles).toBe("none");
    expect(sandboxEnvironmentVariableNames(settings)).toEqual([]);
    expect(sandboxLifecycleHookIds(settings)).toEqual([]);
  });

  test("collects profile and allowlist environment values", () => {
    const settings = withEnv({}, () => getSettings());
    const env = {
      ARM_CLIENT_ID: "arm-client",
      GITHUB_TOKEN: "github-token",
      GIT_AUTHOR_NAME: "Local Author",
      CUSTOM_PROVIDER_TOKEN: "custom",
    };
    const names = sandboxEnvironmentVariableNames({
      ...settings,
      sandboxPreparationProfiles: "azure,github",
      sandboxEnvAllowlist: "CUSTOM_PROVIDER_TOKEN",
    });
    expect(names).toContain("ARM_CLIENT_ID");
    expect(names).toContain("GITHUB_TOKEN");
    expect(names).toContain("GIT_AUTHOR_NAME");
    expect(names).toContain("CUSTOM_PROVIDER_TOKEN");
    expect(sandboxLifecycleHookIds({
      ...settings,
      sandboxPreparationProfiles: "azure,github",
    })).toEqual(["azure-cli-login"]);
    expect(collectSandboxEnvironment({
      ...settings,
      sandboxPreparationProfiles: "azure,github",
      sandboxEnvAllowlist: "CUSTOM_PROVIDER_TOKEN",
    }, env)).toEqual({
      ARM_CLIENT_ID: "arm-client",
      GITHUB_TOKEN: "github-token",
      GIT_AUTHOR_NAME: "Local Author",
      CUSTOM_PROVIDER_TOKEN: "custom",
    });
  });

  test("rejects combining none with other profiles", () => {
    const settings = withEnv({}, () => getSettings());
    expect(() => sandboxEnvironmentVariableNames({
      ...settings,
      sandboxPreparationProfiles: "none,github",
    })).toThrow("cannot combine none");
  });

  test("ignores old sandbox env configuration names", () => {
    const settings = withEnv({
      OPENGENI_SANDBOX_ENV_PROFILES: "azure,github",
      OPENGENI_SANDBOX_ENV_EXTRA_VARS: "CUSTOM_PROVIDER_TOKEN",
      OPENGENI_SANDBOX_ENV_VARS: "GH_TOKEN",
    }, () => getSettings());
    expect(settings.sandboxPreparationProfiles).toBe("none");
    expect(sandboxEnvironmentVariableNames(settings)).toEqual([]);
    expect(sandboxLifecycleHookIds(settings)).toEqual([]);
  });

  test("returns client model and reasoning options with current defaults included", () => {
    const settings = {
      ...withEnv({}, () => getSettings()),
      openaiModel: "custom-model",
      openaiAllowedModels: "gpt-5.5",
      openaiReasoningEffort: "xhigh" as const,
      openaiAllowedReasoningEfforts: "low,medium,high",
    };
    expect(configuredAllowedModels(settings)).toEqual(["custom-model", "gpt-5.5"]);
    expect(configuredAllowedReasoningEfforts(settings)).toEqual(["xhigh", "low", "medium", "high"]);
  });

  test("defaults managed transactional email to the verified mail subdomain sender", () => {
    const settings = withEnv({}, () => getSettings());

    expect(settings.emailFrom).toBe("OpenGeni <auth@mail.opengeni.ai>");
  });

  test("parses startup dependency retry settings", () => {
    const settings = withEnv({
      OPENGENI_STARTUP_DEPENDENCY_RETRY_ATTEMPTS: "5",
      OPENGENI_STARTUP_DEPENDENCY_RETRY_INITIAL_DELAY_MS: "10",
      OPENGENI_STARTUP_DEPENDENCY_RETRY_MAX_DELAY_MS: "50",
    }, () => getSettings());
    expect(startupRetryOptions(settings)).toEqual({
      attempts: 5,
      initialDelayMs: 10,
      maxDelayMs: 50,
    });
  });

  test("parses boolean environment values without treating false as true", () => {
    const settings = withEnv({
      OPENGENI_OBSERVABILITY_STRUCTURED_LOGS: "false",
      OPENGENI_OBSERVABILITY_METRICS_ENABLED: "true",
      OPENGENI_DISABLE_OPENAI_TRACING: "false",
      OPENGENI_OBJECT_STORAGE_FORCE_PATH_STYLE: "0",
      OPENGENI_AUTH_REQUIRED: "true",
      OPENGENI_ACCESS_KEY: "test-access-key",
      OPENGENI_AUTH_ALLOW_HEALTH: "yes",
      OPENGENI_AUTH_ALLOW_METRICS: "no",
    }, () => getSettings());

    expect(settings.observabilityStructuredLogs).toBe(false);
    expect(settings.observabilityMetricsEnabled).toBe(true);
    expect(settings.disableOpenaiTracing).toBe(false);
    expect(settings.objectStorageForcePathStyle).toBe(false);
    expect(settings.authRequired).toBe(true);
    expect(settings.accessKey).toBe("test-access-key");
    expect(settings.authAllowHealth).toBe(true);
    expect(settings.authAllowMetrics).toBe(false);
  });

  test("requires an access key when shared-key auth is enabled", () => {
    expect(() => withEnv({
      OPENGENI_AUTH_REQUIRED: "true",
    }, () => getSettings())).toThrow("OPENGENI_ACCESS_KEY is required");
  });

  test("requires configured mode to have an auth boundary outside local and test", () => {
    expect(() => withEnv({
      OPENGENI_ENVIRONMENT: "production",
      OPENGENI_PRODUCT_ACCESS_MODE: "configured",
      OPENGENI_DELEGATION_SECRET: "",
      OPENGENI_AUTH_REQUIRED: "false",
    }, () => getSettings())).toThrow("OPENGENI_PRODUCT_ACCESS_MODE=configured requires OPENGENI_DELEGATION_SECRET or OPENGENI_AUTH_REQUIRED=true outside local/test");

    expect(withEnv({
      OPENGENI_ENVIRONMENT: "production",
      OPENGENI_PRODUCT_ACCESS_MODE: "configured",
      OPENGENI_DELEGATION_SECRET: "configured-delegation-secret",
    }, () => getSettings()).productAccessMode).toBe("configured");

    expect(withEnv({
      OPENGENI_ENVIRONMENT: "production",
      OPENGENI_PRODUCT_ACCESS_MODE: "configured",
      OPENGENI_DELEGATION_SECRET: "",
      OPENGENI_AUTH_REQUIRED: "true",
      OPENGENI_ACCESS_KEY: "configured-shared-key",
    }, () => getSettings()).productAccessMode).toBe("configured");
  });

  test("retries startup dependency operations with bounded backoff", async () => {
    const retries: string[] = [];
    let calls = 0;
    const result = await retryStartupDependency("NATS", async () => {
      calls += 1;
      if (calls < 3) {
        throw new Error(`not ready ${calls}`);
      }
      return "connected";
    }, {
      attempts: 4,
      initialDelayMs: 0,
      maxDelayMs: 0,
      onRetry: (event) => retries.push(`${event.label}:${event.attempt}/${event.attempts}:${event.delayMs}`),
    });

    expect(result).toBe("connected");
    expect(calls).toBe(3);
    expect(retries).toEqual(["NATS:1/4:0", "NATS:2/4:0"]);
  });

  test("throws the final startup dependency error after all attempts fail", async () => {
    let calls = 0;
    await expect(retryStartupDependency("Temporal", async () => {
      calls += 1;
      throw new Error("still down");
    }, {
      attempts: 2,
      initialDelayMs: 0,
      maxDelayMs: 0,
    })).rejects.toThrow("still down");
    expect(calls).toBe(2);
  });

  test("collects git identity settings for sandbox pass-through", () => {
    const settings = withEnv({
      OPENGENI_GIT_AUTHOR_NAME: "OpenGeni Agent",
      OPENGENI_GIT_AUTHOR_EMAIL: "infra@example.com",
    }, () => getSettings());
    expect(collectGitIdentityEnvironment(settings)).toEqual({
      GIT_AUTHOR_NAME: "OpenGeni Agent",
      GIT_AUTHOR_EMAIL: "infra@example.com",
      GIT_COMMITTER_NAME: "OpenGeni Agent",
      GIT_COMMITTER_EMAIL: "infra@example.com",
    });
  });

  test("does not collect ambient host git identity by default", () => {
    const settings = withEnv({
      GIT_AUTHOR_NAME: "Host Author",
      GIT_AUTHOR_EMAIL: "host@example.com",
      GIT_COMMITTER_NAME: "Host Committer",
      GIT_COMMITTER_EMAIL: "committer@example.com",
    }, () => getSettings());
    expect(collectGitIdentityEnvironment(settings)).toEqual({});
    expect(collectSandboxEnvironment(settings, {
      GIT_AUTHOR_NAME: "Host Author",
      GIT_AUTHOR_EMAIL: "host@example.com",
    })).toEqual({});
  });

  test("passes ambient git identity only through the github preparation profile", () => {
    const settings = withEnv({}, () => getSettings());
    expect(collectSandboxEnvironment({
      ...settings,
      sandboxPreparationProfiles: "github",
    }, {
      GIT_AUTHOR_NAME: "Host Author",
      GIT_AUTHOR_EMAIL: "host@example.com",
      GIT_COMMITTER_NAME: "Host Committer",
      GIT_COMMITTER_EMAIL: "committer@example.com",
    })).toEqual({
      GIT_AUTHOR_NAME: "Host Author",
      GIT_AUTHOR_EMAIL: "host@example.com",
      GIT_COMMITTER_NAME: "Host Committer",
      GIT_COMMITTER_EMAIL: "committer@example.com",
    });
  });

  test("parses MCP server registry JSON", () => {
    const parsed = parseMcpServers('[{"id":"docs","name":"Document Search","url":"http://127.0.0.1:8787/mcp","allowedTools":["search_documents"]}]');
    const settings = {
      ...withEnv({}, () => getSettings()),
      mcpServers: parsed as ReturnType<typeof getSettings>["mcpServers"],
    };
    expect(settings.mcpServers[0]?.id).toBe("docs");
    expect(settings.mcpServers[0]?.allowedTools).toEqual(["search_documents"]);
  });

  test("registers built-in MCP profiles by default", () => {
    const settings = withEnv({}, () => getSettings());
    expect(settings.mcpServers.find((server) => server.id === "opengeni")).toMatchObject({
      name: "OpenGeni",
      url: `http://127.0.0.1:${settings.apiPort}/v1/workspaces/{workspaceId}/mcp`,
    });
    expect(settings.mcpServers.find((server) => server.id === "files")).toMatchObject({
      name: "Files",
      url: `http://127.0.0.1:${settings.apiPort}/v1/workspaces/{workspaceId}/mcp`,
      allowedTools: ["files_get_download_url"],
    });
    expect(settings.mcpServers.find((server) => server.id === "docs")).toMatchObject({
      name: "Document Search",
      url: `http://127.0.0.1:${settings.apiPort}/v1/workspaces/{workspaceId}/mcp/docs`,
      allowedTools: ["search_documents", "fetch_document_chunk", "list_document_bases"],
    });
  });

  test("derives built-in document MCP URL from OPENGENI_MCP_URL", () => {
    const settings = withEnv({
      OPENGENI_MCP_URL: "http://opengeni-api.opengeni.svc.cluster.local:8000/v1/workspaces/{workspaceId}/mcp",
    }, () => getSettings());
    expect(settings.mcpServers.find((server) => server.id === "opengeni")?.url).toBe("http://opengeni-api.opengeni.svc.cluster.local:8000/v1/workspaces/{workspaceId}/mcp");
    expect(settings.mcpServers.find((server) => server.id === "docs")?.url).toBe("http://opengeni-api.opengeni.svc.cluster.local:8000/v1/workspaces/{workspaceId}/mcp/docs");
  });

  test("does not duplicate a custom files MCP profile", () => {
    withEnv({
      OPENGENI_MCP_SERVERS: '[{"id":"files","name":"Custom Files","url":"http://127.0.0.1:8787/mcp","allowedTools":["custom_download"]}]',
    }, () => {
      const settings = getSettings();
      const ids = settings.mcpServers.map((server) => server.id);
      expect(ids.filter((id) => id === "files")).toHaveLength(1);
      expect(settings.mcpServers.find((server) => server.id === "files")).toMatchObject({
        name: "Custom Files",
        url: "http://127.0.0.1:8787/mcp",
        allowedTools: ["custom_download"],
      });
    });
  });

  test("ignores pre-OpenGeni environment variable names", () => {
    withEnv({
      INFRA_AGENT_SERVICE_NAME: "legacy-service",
      INFRA_AGENT_DATABASE_URL: "postgres://legacy:legacy@127.0.0.1:5432/legacy",
      INFRA_AGENT_OBJECT_STORAGE_BUCKET: "legacy-files",
    }, () => {
      const settings = getSettings();

      expect(settings.serviceName).toBe("opengeni");
      expect(settings.databaseUrl).toBe("postgres://opengeni:opengeni@127.0.0.1:5432/opengeni");
      expect(settings.objectStorageBucket).toBe("opengeni-files");
    });
  });

  test("rejects non-array MCP server registry JSON", () => {
    expect(() => parseMcpServers('{"id":"docs"}')).toThrow("must be a JSON array");
  });

  test("parses object storage settings and rejects incomplete credentials", () => {
    withEnv({
      OPENGENI_OBJECT_STORAGE_BACKEND: "s3-compatible",
      OPENGENI_OBJECT_STORAGE_ENDPOINT: "http://127.0.0.1:9000",
      OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID: "minioadmin",
      OPENGENI_OBJECT_STORAGE_SECRET_ACCESS_KEY: "minioadmin",
    }, () => {
      const settings = getSettings();
      expect(settings.objectStorageBackend).toBe("s3-compatible");
      expect(settings.objectStorageEndpoint).toBe("http://127.0.0.1:9000");
      expect(settings.objectStorageBucket).toBe("opengeni-files");
      expect(settings.objectStorageForcePathStyle).toBe(true);
    });

    withEnv({
      OPENGENI_OBJECT_STORAGE_ENDPOINT: "http://127.0.0.1:9000",
      OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID: "minioadmin",
    }, () => {
      expect(() => getSettings()).toThrow("both be set or both omitted");
    });
  });

  test("parses Azure Blob object storage settings", () => {
    withEnv({
      OPENGENI_OBJECT_STORAGE_BACKEND: "azure-blob",
      OPENGENI_OBJECT_STORAGE_BUCKET: "opengeni-files",
      OPENGENI_OBJECT_STORAGE_AZURE_ACCOUNT_NAME: "opengeni",
      OPENGENI_OBJECT_STORAGE_AZURE_ACCOUNT_KEY: "storage-key",
    }, () => {
      const settings = getSettings();
      expect(settings.objectStorageBackend).toBe("azure-blob");
      expect(settings.objectStorageBucket).toBe("opengeni-files");
      expect(settings.objectStorageAzureAccountName).toBe("opengeni");
      expect(settings.objectStorageAzureAccountKey).toBe("storage-key");
    });

    withEnv({
      OPENGENI_OBJECT_STORAGE_BACKEND: "azure-blob",
    }, () => {
      expect(() => getSettings()).toThrow("Azure Blob storage requires");
    });

    withEnv({
      OPENGENI_OBJECT_STORAGE_BACKEND: "azure-blob",
      OPENGENI_OBJECT_STORAGE_ENDPOINT: "http://127.0.0.1:9000",
      OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID: "minioadmin",
      OPENGENI_OBJECT_STORAGE_SECRET_ACCESS_KEY: "minioadmin",
      OPENGENI_OBJECT_STORAGE_AZURE_CONNECTION_STRING: "UseDevelopmentStorage=true",
    }, () => {
      expect(() => getSettings()).toThrow("Azure Blob storage uses OPENGENI_OBJECT_STORAGE_AZURE");
    });
  });

  test("parses native AWS S3 object storage without static key assumptions", () => {
    withEnv({
      OPENGENI_OBJECT_STORAGE_BACKEND: "aws-s3",
      OPENGENI_OBJECT_STORAGE_BUCKET: "opengeni-files",
      OPENGENI_OBJECT_STORAGE_REGION: "us-east-1",
    }, () => {
      const settings = getSettings();
      expect(settings.objectStorageBackend).toBe("aws-s3");
      expect(settings.objectStorageBucket).toBe("opengeni-files");
      expect(settings.objectStorageRegion).toBe("us-east-1");
      expect(settings.objectStorageAccessKeyId).toBeUndefined();
    });
  });

  test("parses GCS object storage settings and validates inline credentials JSON", () => {
    withEnv({
      OPENGENI_OBJECT_STORAGE_BACKEND: "gcs",
      OPENGENI_OBJECT_STORAGE_BUCKET: "opengeni-files",
      OPENGENI_OBJECT_STORAGE_GCS_PROJECT_ID: "opengeni-test",
    }, () => {
      const settings = getSettings();
      expect(settings.objectStorageBackend).toBe("gcs");
      expect(settings.objectStorageBucket).toBe("opengeni-files");
      expect(settings.objectStorageGcsProjectId).toBe("opengeni-test");
    });

    withEnv({
      OPENGENI_OBJECT_STORAGE_BACKEND: "gcs",
      OPENGENI_OBJECT_STORAGE_GCS_CREDENTIALS_JSON: "not-json",
    }, () => {
      expect(() => getSettings()).toThrow("GCS_CREDENTIALS_JSON must be valid JSON");
    });

    withEnv({
      OPENGENI_OBJECT_STORAGE_BACKEND: "gcs",
      OPENGENI_OBJECT_STORAGE_ENDPOINT: "http://127.0.0.1:9000",
    }, () => {
      expect(() => getSettings()).toThrow("GCS object storage uses OPENGENI_OBJECT_STORAGE_GCS");
    });
  });

  test("parses document indexing settings", () => {
    withEnv({
      OPENGENI_DOCUMENT_CHUNK_SIZE: "2000",
      OPENGENI_DOCUMENT_CHUNK_OVERLAP: "200",
      OPENGENI_DOCUMENT_EMBEDDING_PROVIDER: "deterministic",
      OPENGENI_DOCUMENT_EMBEDDING_MODEL: "local-test",
      OPENGENI_DOCUMENT_EMBEDDING_DIMENSIONS: "3072",
    }, () => {
      const settings = getSettings();
      expect(settings.documentParser).toBe("liteparse");
      expect(settings.documentChunkSize).toBe(2000);
      expect(settings.documentChunkOverlap).toBe(200);
      expect(settings.documentEmbeddingProvider).toBe("deterministic");
      expect(settings.documentEmbeddingModel).toBe("local-test");
      expect(settings.documentEmbeddingDimensions).toBe(3072);
    });
  });

  test("rejects invalid document chunk overlap", () => {
    withEnv({
      OPENGENI_DOCUMENT_CHUNK_SIZE: "100",
      OPENGENI_DOCUMENT_CHUNK_OVERLAP: "100",
    }, () => {
      expect(() => getSettings()).toThrow("must be smaller");
    });
  });

  test("parses static usage limits and rejects empty static mode", () => {
    const limits = parseStaticUsageLimitsJson('{"maxWorkspacesPerAccount":2,"maxFileUploadBytes":1048576}');
    expect(limits).toEqual({ maxWorkspacesPerAccount: 2, maxFileUploadBytes: 1048576 });

    withEnv({
      OPENGENI_USAGE_LIMITS_MODE: "static",
      OPENGENI_STATIC_USAGE_LIMITS_JSON: '{"maxApiKeysPerWorkspace":1}',
    }, () => {
      expect(configuredStaticUsageLimits(getSettings())).toEqual({ maxApiKeysPerWorkspace: 1 });
    });

    withEnv({ OPENGENI_USAGE_LIMITS_MODE: "static" }, () => {
      expect(() => getSettings()).toThrow("STATIC_USAGE_LIMITS_JSON");
    });
  });

  test("parses static and managed entitlement overlays", () => {
    expect(parseStaticEntitlementsJson('{"github":true,"models":["gpt-5.5"]}')).toEqual({
      github: true,
      models: ["gpt-5.5"],
    });

    withEnv({
      OPENGENI_ENTITLEMENTS_MODE: "static",
      OPENGENI_STATIC_ENTITLEMENTS_JSON: '{"github":true}',
    }, () => {
      expect(configuredEntitlements(getSettings())).toEqual({ github: true });
    });

    withEnv({
      OPENGENI_ENTITLEMENTS_MODE: "managed",
      OPENGENI_STATIC_ENTITLEMENTS_JSON: '{"custom.feature":"enabled"}',
    }, () => {
      expect(configuredEntitlements(getSettings())).toMatchObject({
        "managed.auth.email_password": true,
        "managed.api_keys": true,
        "custom.feature": "enabled",
      });
    });

    withEnv({ OPENGENI_ENTITLEMENTS_MODE: "static" }, () => {
      expect(() => getSettings()).toThrow("STATIC_ENTITLEMENTS_JSON");
    });
  });
});

describe("workspace environments encryption key", () => {
  const validKey = Buffer.alloc(32, 7).toString("base64");

  test("decodes a base64 key of exactly 32 bytes", () => {
    const settings = withEnv({ OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY: validKey }, () => getSettings());
    const key = environmentsEncryptionKeyBytes(settings);
    expect(key).not.toBeNull();
    expect(key!.length).toBe(32);
  });

  test("returns null when the key is unset", () => {
    const settings = withEnv({}, () => getSettings());
    expect(environmentsEncryptionKeyBytes(settings)).toBeNull();
  });

  test("rejects keys that do not decode to 32 bytes at boot", () => {
    expect(() => withEnv({
      OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString("base64"),
    }, () => getSettings())).toThrow("OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY must be base64 for exactly 32 bytes");
  });

  test("requires the key for managed mode outside local/test", () => {
    const managedEnv = {
      OPENGENI_ENVIRONMENT: "production",
      OPENGENI_PRODUCT_ACCESS_MODE: "managed",
      OPENGENI_PUBLIC_BASE_URL: "https://managed.example.test",
      OPENGENI_BETTER_AUTH_SECRET: "managed-better-auth-secret",
      OPENGENI_DELEGATION_SECRET: "managed-delegation-secret",
      OPENGENI_RESEND_API_KEY: "re_test",
    };
    expect(() => withEnv(managedEnv, () => getSettings()))
      .toThrow("OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY is required for managed mode outside local/test");
    expect(withEnv({
      ...managedEnv,
      OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY: validKey,
    }, () => getSettings()).environmentsEncryptionKey).toBe(validKey);
    expect(withEnv({
      OPENGENI_PRODUCT_ACCESS_MODE: "managed",
      OPENGENI_PUBLIC_BASE_URL: "https://managed.example.test",
      OPENGENI_BETTER_AUTH_SECRET: "managed-better-auth-secret",
      OPENGENI_DELEGATION_SECRET: "managed-delegation-secret",
    }, () => getSettings()).environmentsEncryptionKey).toBeUndefined();
  });
});

function withEnv<T>(env: NodeJS.ProcessEnv, fn: () => T): T {
  const original = process.env;
  process.env = { ...env };
  try {
    return fn();
  } finally {
    process.env = original;
  }
}
