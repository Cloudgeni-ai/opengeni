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
  requiredSandboxEnvForBackend,
  resolveStreamTokenSecret,
  retryStartupDependency,
  SANDBOX_REQUIRED_ENV,
  sandboxEnvironmentVariableNames,
  sandboxLifecycleHookIds,
  startupRetryOptions,
  streamTokenDegraded,
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

  test("stream-token secret resolves explicit first, then falls back to delegationSecret", () => {
    const explicit = withEnv({
      OPENGENI_DELEGATION_SECRET: "delegation",
      OPENGENI_STREAM_TOKEN_SECRET: "stream-explicit",
    }, () => getSettings());
    expect(resolveStreamTokenSecret(explicit)).toBe("stream-explicit");

    const fallback = withEnv({
      OPENGENI_DELEGATION_SECRET: "delegation-only",
    }, () => getSettings());
    expect(resolveStreamTokenSecret(fallback)).toBe("delegation-only");

    const neither = withEnv({}, () => getSettings());
    expect(resolveStreamTokenSecret(neither)).toBeUndefined();
  });

  test("desktop enabled WITHOUT a stream-token secret GRACEFULLY DEGRADES (boots + warns, no throw)", () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      // The whole point of I8/OD-8: desktop on + no secret is NOT a boot-fail.
      // getSettings() returns settings (does not throw), emits a loud warning,
      // and streamTokenDegraded() flags the runtime degrade to transport:null.
      const settings = withEnv({
        OPENGENI_SANDBOX_DESKTOP_ENABLED: "true",
        OPENGENI_DELEGATION_SECRET: "",
      }, () => getSettings());
      expect(settings.sandboxDesktopEnabled).toBe(true);
      expect(streamTokenDegraded(settings)).toBe(true);
      expect(warnings.some((line) => line.includes("GRACEFULLY DEGRADE"))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("desktop enabled WITH a stream-token secret does not degrade and does not warn", () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      const settings = withEnv({
        OPENGENI_SANDBOX_DESKTOP_ENABLED: "true",
        OPENGENI_STREAM_TOKEN_SECRET: "stream-secret",
      }, () => getSettings());
      expect(streamTokenDegraded(settings)).toBe(false);
      expect(warnings.some((line) => line.includes("GRACEFULLY DEGRADE"))).toBe(false);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("streamControlEnabled defaults to false (the input plane is OFF in v1)", () => {
    expect(withEnv({}, () => getSettings()).streamControlEnabled).toBe(false);
    expect(withEnv({ OPENGENI_STREAM_CONTROL_ENABLED: "true" }, () => getSettings()).streamControlEnabled).toBe(true);
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
      // The opengeni server's tools/list is permission-scoped (varies by the
      // caller's delegated grant). The Agents SDK caches tools/list in a
      // process-global map keyed by server name, so caching here would let one
      // session's grant dictate every later session's tool visibility. Must
      // stay uncached.
      cacheToolsList: false,
    });
    expect(settings.mcpServers.find((server) => server.id === "files")).toMatchObject({
      name: "Files",
      url: `http://127.0.0.1:${settings.apiPort}/v1/workspaces/{workspaceId}/mcp`,
      // Safe to cache: allowedTools pins it to a single tool that every grant
      // can see, so its effective tool list is permission-invariant.
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

describe("provider item id policy", () => {
  test("defaults to stripping provider item ids with encrypted reasoning round-trip", () => {
    const settings = withEnv({}, () => getSettings());
    expect(settings.openaiProviderItemIds).toBe("strip");
    expect(settings.openaiReasoningEncryptedContent).toBe(true);
  });

  test("can preserve provider item ids and disable encrypted reasoning", () => {
    const settings = withEnv({
      OPENGENI_OPENAI_PROVIDER_ITEM_IDS: "preserve",
      OPENGENI_OPENAI_REASONING_ENCRYPTED_CONTENT: "false",
    }, () => getSettings());
    expect(settings.openaiProviderItemIds).toBe("preserve");
    expect(settings.openaiReasoningEncryptedContent).toBe(false);
  });

  test("rejects unknown provider item id policies", () => {
    expect(() => withEnv({ OPENGENI_OPENAI_PROVIDER_ITEM_IDS: "sometimes" }, () => getSettings())).toThrow();
  });
});

describe("backend-gated sandbox required-credential validation", () => {
  test("a backend's creds are NOT required when it is not the active backend", () => {
    // sandboxBackend defaults to docker (no creds). Modal/daytona/etc creds may
    // be entirely absent — only the active backend's creds gate boot.
    const settings = withEnv({}, () => getSettings());
    expect(settings.sandboxBackend).toBe("docker");
    expect(settings.modalTokenId).toBeUndefined();
  });

  test("docker/local/none require no sandbox credentials", () => {
    for (const backend of ["docker", "local", "none"]) {
      expect(() => withEnv({ OPENGENI_SANDBOX_BACKEND: backend }, () => getSettings())).not.toThrow();
    }
  });

  test("modal requires the token only when sandboxBackend=modal", () => {
    // Backend=modal WITHOUT the token → fails (gated).
    expect(() => withEnv({ OPENGENI_SANDBOX_BACKEND: "modal" }, () => getSettings()))
      .toThrow("OPENGENI_MODAL_TOKEN_ID is required when OPENGENI_SANDBOX_BACKEND=modal");
    // Backend=modal WITH the token (and app name defaulted) → passes.
    expect(() => withEnv({
      OPENGENI_SANDBOX_BACKEND: "modal",
      OPENGENI_MODAL_TOKEN_ID: "ak-test",
      OPENGENI_MODAL_TOKEN_SECRET: "as-test",
    }, () => getSettings())).not.toThrow();
    // The SAME missing-token config but backend=docker → does NOT fail on modal.
    expect(() => withEnv({ OPENGENI_SANDBOX_BACKEND: "docker" }, () => getSettings())).not.toThrow();
  });

  test("daytona requires its api key only when active", () => {
    expect(() => withEnv({ OPENGENI_SANDBOX_BACKEND: "daytona" }, () => getSettings()))
      .toThrow("OPENGENI_DAYTONA_API_KEY is required when OPENGENI_SANDBOX_BACKEND=daytona");
    expect(() => withEnv({
      OPENGENI_SANDBOX_BACKEND: "daytona",
      OPENGENI_DAYTONA_API_KEY: "dk-test",
    }, () => getSettings())).not.toThrow();
    // daytona creds are irrelevant when modal is active (modal has its own gate).
    expect(() => withEnv({
      OPENGENI_SANDBOX_BACKEND: "modal",
      OPENGENI_MODAL_TOKEN_ID: "ak",
      OPENGENI_MODAL_TOKEN_SECRET: "as",
    }, () => getSettings())).not.toThrow();
  });

  test("vercel requires BOTH the token and the project id when active", () => {
    expect(() => withEnv({ OPENGENI_SANDBOX_BACKEND: "vercel", OPENGENI_VERCEL_TOKEN: "vt" }, () => getSettings()))
      .toThrow("OPENGENI_VERCEL_PROJECT_ID is required when OPENGENI_SANDBOX_BACKEND=vercel");
    expect(() => withEnv({
      OPENGENI_SANDBOX_BACKEND: "vercel",
      OPENGENI_VERCEL_TOKEN: "vt",
      OPENGENI_VERCEL_PROJECT_ID: "prj",
    }, () => getSettings())).not.toThrow();
  });

  test("runloop/e2b/blaxel/cloudflare each gate their own single credential", () => {
    const cases: Array<[string, string, string]> = [
      ["runloop", "OPENGENI_RUNLOOP_API_KEY", "rk"],
      ["e2b", "OPENGENI_E2B_API_KEY", "ek"],
      ["blaxel", "OPENGENI_BLAXEL_API_KEY", "bk"],
      ["cloudflare", "OPENGENI_CLOUDFLARE_WORKER_URL", "https://worker.example.com"],
    ];
    for (const [backend, envKey, value] of cases) {
      expect(() => withEnv({ OPENGENI_SANDBOX_BACKEND: backend }, () => getSettings()))
        .toThrow(`${envKey} is required when OPENGENI_SANDBOX_BACKEND=${backend}`);
      expect(() => withEnv({ OPENGENI_SANDBOX_BACKEND: backend, [envKey]: value }, () => getSettings()))
        .not.toThrow();
    }
  });

  test("the modal token stays a both-or-neither pair regardless of the active backend", () => {
    // Half-configured Modal token while backend=docker: still a misconfig.
    expect(() => withEnv({ OPENGENI_SANDBOX_BACKEND: "docker", OPENGENI_MODAL_TOKEN_ID: "only-id" }, () => getSettings()))
      .toThrow("OPENGENI_MODAL_TOKEN_ID and OPENGENI_MODAL_TOKEN_SECRET must both be set or both omitted");
  });

  test("SANDBOX_REQUIRED_ENV + requiredSandboxEnvForBackend agree", () => {
    expect(requiredSandboxEnvForBackend("modal")).toEqual([
      "OPENGENI_MODAL_APP_NAME",
      "OPENGENI_MODAL_TOKEN_ID",
      "OPENGENI_MODAL_TOKEN_SECRET",
    ]);
    expect(requiredSandboxEnvForBackend("docker")).toEqual([]);
    // every backend in the table maps to a (possibly empty) env list.
    for (const backend of Object.keys(SANDBOX_REQUIRED_ENV)) {
      expect(Array.isArray(requiredSandboxEnvForBackend(backend as keyof typeof SANDBOX_REQUIRED_ENV))).toBe(true);
    }
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
