import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { McpServerConnectionRef as ContractMcpServerConnectionRef } from "@opengeni/contracts";
import {
  collectGitIdentityEnvironment,
  configuredEntitlements,
  collectSandboxEnvironment,
  effectiveModalIdleTimeoutSeconds,
  configuredStaticUsageLimits,
  configuredAllowedModels,
  configuredAllowedReasoningEfforts,
  environmentsEncryptionKeyBytes,
  getSettings,
  parseStaticEntitlementsJson,
  parseStaticUsageLimitsJson,
  parseMcpServers,
  McpServerConnectionRefSchema,
  requiredSandboxEnvForBackend,
  resolveStreamTokenSecret,
  retryStartupDependency,
  SANDBOX_REQUIRED_ENV,
  sandboxArchiveCaptureTimeoutMs,
  sandboxEnvironmentVariableNames,
  sandboxLifecycleHookIds,
  stableSandboxEnvironmentForRun,
  startupRetryOptions,
  streamTokenDegraded,
  temporalConnectionOptions,
} from "../src";

describe(".env.example", () => {
  test("shell-sources and validates with the stock example values", () => {
    const envPath = fileURLToPath(new URL("../../../.env.example", import.meta.url));
    const source = spawnSync("bash", ["-c", 'set -a; . "$1"; env -0', "bash", envPath], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    if (source.status !== 0) {
      throw new Error(`.env.example failed to source:\n${source.stderr}`);
    }

    const sourcedEnv: NodeJS.ProcessEnv = {};
    for (const entry of source.stdout.split("\0")) {
      if (!entry) {
        continue;
      }
      const equals = entry.indexOf("=");
      if (equals <= 0) {
        continue;
      }
      sourcedEnv[entry.slice(0, equals)] = entry.slice(equals + 1);
    }

    expect(() => withEnv(sourcedEnv, () => getSettings())).not.toThrow();
  });
});

describe("browser analytics configuration", () => {
  test("is disabled and consent-gated by default", () => {
    const settings = withEnv({}, () => getSettings());
    expect(settings.analyticsEnabled).toBe(false);
    expect(settings.analyticsConsentRequired).toBe(true);
    expect(settings.analyticsReoClientId).toBeUndefined();
  });

  test("parses public provider identifiers without treating them as credentials", () => {
    const settings = withEnv(
      {
        OPENGENI_ANALYTICS_ENABLED: "true",
        OPENGENI_ANALYTICS_CONSENT_REQUIRED: "true",
        OPENGENI_ANALYTICS_REO_CLIENT_ID: "reo_client-1",
        OPENGENI_ANALYTICS_POSTHOG_PROJECT_KEY: "phc_test",
        OPENGENI_ANALYTICS_POSTHOG_HOST: "https://eu.i.posthog.com",
        OPENGENI_ANALYTICS_GA4_MEASUREMENT_ID: "G-ABC123",
      },
      () => getSettings(),
    );

    expect(settings.analyticsEnabled).toBe(true);
    expect(settings.analyticsReoClientId).toBe("reo_client-1");
    expect(settings.analyticsPosthogHost).toBe("https://eu.i.posthog.com");
    expect(settings.analyticsGa4MeasurementId).toBe("G-ABC123");
  });

  test("bounds public provider identifiers before exposing them to browsers", () => {
    expect(() =>
      withEnv({ OPENGENI_ANALYTICS_REO_CLIENT_ID: "r".repeat(129) }, () => getSettings()),
    ).toThrow();
    expect(() =>
      withEnv({ OPENGENI_ANALYTICS_POSTHOG_PROJECT_KEY: "p".repeat(257) }, () => getSettings()),
    ).toThrow();
    expect(() =>
      withEnv({ OPENGENI_ANALYTICS_GA4_MEASUREMENT_ID: `G-${"A".repeat(31)}` }, () =>
        getSettings(),
      ),
    ).toThrow();
  });
});

describe("Codex progressive tool disclosure", () => {
  test("is enabled by default and supports an explicit emergency opt-out", () => {
    expect(withEnv({}, () => getSettings()).codexToolSearchEnabled).toBe(true);
    expect(
      withEnv({ OPENGENI_CODEX_TOOL_SEARCH_ENABLED: "false" }, () => getSettings())
        .codexToolSearchEnabled,
    ).toBe(false);
  });
});

describe("Google Drive integration settings", () => {
  test("loads the split localhost browser and API origins", () => {
    const settings = withEnv(
      {
        OPENGENI_ENVIRONMENT: "local",
        OPENGENI_INTEGRATIONS_ENABLED: "true",
        OPENGENI_PUBLIC_BASE_URL: "http://127.0.0.1:8000",
        OPENGENI_WEB_BASE_URL: "http://127.0.0.1:3000",
        OPENGENI_INTEGRATIONS_STATE_SECRET: "state-secret",
        OPENGENI_GOOGLE_DRIVE_CLIENT_ID: "client.apps.googleusercontent.com",
        OPENGENI_GOOGLE_DRIVE_CLIENT_SECRET: "client-secret",
      },
      () => getSettings(),
    );
    expect(settings.publicBaseUrl).toBe("http://127.0.0.1:8000");
    expect(settings.webBaseUrl).toBe("http://127.0.0.1:3000");
    expect(settings.googleDriveClientId).toBe("client.apps.googleusercontent.com");
    expect(settings.googleDriveClientSecret).toBe("client-secret");
  });

  test("requires the Google OAuth client id and secret together", () => {
    expect(() =>
      withEnv(
        {
          OPENGENI_GOOGLE_DRIVE_CLIENT_ID: "client.apps.googleusercontent.com",
        },
        () => getSettings(),
      ),
    ).toThrow(
      "OPENGENI_GOOGLE_DRIVE_CLIENT_ID and OPENGENI_GOOGLE_DRIVE_CLIENT_SECRET must be configured together",
    );
  });
});

describe("OpenGeni Slack interaction settings", () => {
  const slackEnv = {
    OPENGENI_ENVIRONMENT: "local",
    OPENGENI_PUBLIC_BASE_URL: "http://127.0.0.1:8000",
    OPENGENI_INTEGRATIONS_STATE_SECRET: "state-secret",
    OPENGENI_SLACK_CLIENT_ID: "slack-client-id",
    OPENGENI_SLACK_CLIENT_SECRET: "slack-client-secret",
  };

  test("requires the request signing secret whenever the Slack app is configured", () => {
    expect(() => withEnv(slackEnv, () => getSettings())).toThrow(
      "OPENGENI_SLACK_SIGNING_SECRET is required when the OpenGeni Slack app is configured",
    );
  });

  test("loads the signing secret without projecting it into any public contract", () => {
    const settings = withEnv(
      { ...slackEnv, OPENGENI_SLACK_SIGNING_SECRET: "slack-signing-secret" },
      () => getSettings(),
    );
    expect(settings.slackSigningSecret).toBe("slack-signing-secret");
  });
});

describe("Docker workspace materialization", () => {
  test("parses the optional shared workspace base directory", () => {
    expect(
      withEnv(
        {
          OPENGENI_DOCKER_WORKSPACE_BASE_DIR: "/var/lib/opengeni/docker-workspaces",
        },
        () => getSettings(),
      ).dockerWorkspaceBaseDir,
    ).toBe("/var/lib/opengeni/docker-workspaces");
  });
});

describe("agent stable release selection", () => {
  test("uses an exact stable version and supports an explicit operator promotion", () => {
    expect(withEnv({}, () => getSettings()).agentStableVersion).toBe("0.1.13");
    expect(
      withEnv({ OPENGENI_AGENT_STABLE_VERSION: "1.4.2" }, () => getSettings()).agentStableVersion,
    ).toBe("1.4.2");
  });

  test("rejects moving labels, prereleases, and malformed versions", () => {
    for (const value of ["latest", "v1.2.3", "1.2", "1.2.3-rc.1", "01.2.3"]) {
      expect(() =>
        withEnv({ OPENGENI_AGENT_STABLE_VERSION: value }, () => getSettings()),
      ).toThrow();
    }
  });
});

describe("rig verification lease ownership rollout", () => {
  test("is default-off and parses explicit false and true without truthy-string coercion", () => {
    expect(withEnv({}, () => getSettings()).rigVerificationLeaseOwnershipEnabled).toBe(false);
    expect(
      withEnv({ OPENGENI_RIG_VERIFICATION_LEASE_OWNERSHIP_ENABLED: "false" }, () => getSettings())
        .rigVerificationLeaseOwnershipEnabled,
    ).toBe(false);
    expect(
      withEnv({ OPENGENI_RIG_VERIFICATION_LEASE_OWNERSHIP_ENABLED: "true" }, () => getSettings())
        .rigVerificationLeaseOwnershipEnabled,
    ).toBe(true);
  });
});

describe("Temporal connection security", () => {
  test("keeps the local default plaintext and enables TLS for an API key", () => {
    expect(temporalConnectionOptions(withEnv({}, () => getSettings()))).toEqual({
      address: "127.0.0.1:7233",
    });

    expect(
      temporalConnectionOptions(
        withEnv({ OPENGENI_TEMPORAL_TLS_ENABLED: "true" }, () => getSettings()),
      ),
    ).toEqual({
      address: "127.0.0.1:7233",
      tls: true,
    });

    const secured = withEnv(
      {
        OPENGENI_TEMPORAL_HOST: "namespace.account.tmprl.cloud:7233",
        OPENGENI_TEMPORAL_API_KEY: "temporal-test-key",
      },
      () => getSettings(),
    );
    expect(temporalConnectionOptions(secured)).toEqual({
      address: "namespace.account.tmprl.cloud:7233",
      tls: true,
      apiKey: "temporal-test-key",
    });
  });

  test("supports server-auth TLS, custom roots, SNI override, and mTLS", () => {
    const rootCa = Buffer.from("root-ca".repeat(20));
    const clientCertificate = Buffer.from("client-certificate");
    const clientPrivateKey = Buffer.from("client-private-key");
    const settings = withEnv(
      {
        OPENGENI_TEMPORAL_TLS_ENABLED: "true",
        OPENGENI_TEMPORAL_TLS_SERVER_NAME: "temporal.internal",
        OPENGENI_TEMPORAL_TLS_ROOT_CA_CERTIFICATE_BASE64: rootCa
          .toString("base64")
          .match(/.{1,76}/g)
          ?.join("\n"),
        OPENGENI_TEMPORAL_TLS_CLIENT_CERTIFICATE_BASE64: clientCertificate.toString("base64"),
        OPENGENI_TEMPORAL_TLS_CLIENT_PRIVATE_KEY_BASE64: clientPrivateKey.toString("base64"),
      },
      () => getSettings(),
    );

    expect(temporalConnectionOptions(settings)).toEqual({
      address: "127.0.0.1:7233",
      tls: {
        serverNameOverride: "temporal.internal",
        serverRootCACertificate: new Uint8Array(rootCa),
        clientCertPair: {
          crt: new Uint8Array(clientCertificate),
          key: new Uint8Array(clientPrivateKey),
        },
      },
    });
  });

  test("rejects incomplete or malformed mTLS material without echoing it", () => {
    expect(() =>
      withEnv(
        {
          OPENGENI_TEMPORAL_TLS_CLIENT_CERTIFICATE_BASE64:
            Buffer.from("client-certificate").toString("base64"),
        },
        () => getSettings(),
      ),
    ).toThrow("must both be set or both omitted");

    const malformed = "not-a-secret!";
    expect(() =>
      withEnv({ OPENGENI_TEMPORAL_TLS_ROOT_CA_CERTIFICATE_BASE64: malformed }, () => getSettings()),
    ).toThrow("OPENGENI_TEMPORAL_TLS_ROOT_CA_CERTIFICATE_BASE64 must contain valid base64");
    try {
      withEnv({ OPENGENI_TEMPORAL_TLS_ROOT_CA_CERTIFICATE_BASE64: malformed }, () => getSettings());
    } catch (error) {
      expect(String(error)).not.toContain(malformed);
    }
  });
});

describe("turn worker concurrency", () => {
  test("keeps the ordinary deployment default fixed", () => {
    const settings = withEnv({}, () => getSettings());
    expect(settings.turnWorkerConcurrencyMode).toBe("fixed");
    expect(settings.turnWorkerMaxConcurrentTurns).toBe(16);
    expect(settings.turnWorkerTargetCpuUsage).toBe(0.8);
    expect(settings.turnWorkerTargetMemoryUsage).toBe(0.75);
    expect(settings.turnWorkerMemoryGuardIntervalMs).toBe(5_000);
    expect(settings.turnWorkerMemoryGuardSustainMs).toBe(30_000);
  });

  test("parses a bounded resource-based machine profile", () => {
    const settings = withEnv(
      {
        OPENGENI_TURN_WORKER_CONCURRENCY_MODE: "resource-based",
        OPENGENI_TURN_WORKER_MAX_CONCURRENT_TURNS: "256",
        OPENGENI_TURN_WORKER_TARGET_CPU_USAGE: "0.85",
        OPENGENI_TURN_WORKER_TARGET_MEMORY_USAGE: "0.8",
        OPENGENI_TURN_WORKER_MEMORY_GUARD_INTERVAL_MS: "2500",
        OPENGENI_TURN_WORKER_MEMORY_GUARD_SUSTAIN_MS: "15000",
      },
      () => getSettings(),
    );
    expect(settings.turnWorkerConcurrencyMode).toBe("resource-based");
    expect(settings.turnWorkerMaxConcurrentTurns).toBe(256);
    expect(settings.turnWorkerTargetCpuUsage).toBe(0.85);
    expect(settings.turnWorkerTargetMemoryUsage).toBe(0.8);
    expect(settings.turnWorkerMemoryGuardIntervalMs).toBe(2_500);
    expect(settings.turnWorkerMemoryGuardSustainMs).toBe(15_000);
  });

  test("rejects invalid modes, ceilings, and resource targets", () => {
    for (const env of [
      { OPENGENI_TURN_WORKER_CONCURRENCY_MODE: "automatic" },
      { OPENGENI_TURN_WORKER_MAX_CONCURRENT_TURNS: "0" },
      { OPENGENI_TURN_WORKER_MAX_CONCURRENT_TURNS: "2001" },
      { OPENGENI_TURN_WORKER_TARGET_CPU_USAGE: "1.1" },
      { OPENGENI_TURN_WORKER_TARGET_MEMORY_USAGE: "0.81" },
      { OPENGENI_TURN_WORKER_MEMORY_GUARD_INTERVAL_MS: "999" },
      { OPENGENI_TURN_WORKER_MEMORY_GUARD_SUSTAIN_MS: "4999" },
    ]) {
      expect(() => withEnv(env, () => getSettings())).toThrow();
    }
  });
});

describe("runtime database role posture", () => {
  test("defaults to the restricted standalone role and accepts an explicit role", () => {
    expect(withEnv({}, () => getSettings()).runtimeDatabaseRole).toBe("opengeni_app");
    expect(
      withEnv({ OPENGENI_RUNTIME_DATABASE_ROLE: "runtime_test" }, () => getSettings())
        .runtimeDatabaseRole,
    ).toBe("runtime_test");
  });
});

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
    expect(
      sandboxLifecycleHookIds({
        ...settings,
        sandboxPreparationProfiles: "azure,github",
      }),
    ).toEqual(["azure-cli-login"]);
    expect(
      collectSandboxEnvironment(
        {
          ...settings,
          sandboxPreparationProfiles: "azure,github",
          sandboxEnvAllowlist: "CUSTOM_PROVIDER_TOKEN",
        },
        env,
      ),
    ).toEqual({
      ARM_CLIENT_ID: "arm-client",
      GITHUB_TOKEN: "github-token",
      GIT_AUTHOR_NAME: "Local Author",
      CUSTOM_PROVIDER_TOKEN: "custom",
    });
  });

  test("rejects combining none with other profiles", () => {
    const settings = withEnv({}, () => getSettings());
    expect(() =>
      sandboxEnvironmentVariableNames({
        ...settings,
        sandboxPreparationProfiles: "none,github",
      }),
    ).toThrow("cannot combine none");
  });

  test("ignores old sandbox env configuration names", () => {
    const settings = withEnv(
      {
        OPENGENI_SANDBOX_ENV_PROFILES: "azure,github",
        OPENGENI_SANDBOX_ENV_EXTRA_VARS: "CUSTOM_PROVIDER_TOKEN",
        OPENGENI_SANDBOX_ENV_VARS: "GH_TOKEN",
      },
      () => getSettings(),
    );
    expect(settings.sandboxPreparationProfiles).toBe("none");
    expect(sandboxEnvironmentVariableNames(settings)).toEqual([]);
    expect(sandboxLifecycleHookIds(settings)).toEqual([]);
  });

  test("offers GPT-5.6 max reasoning by default", () => {
    const settings = withEnv({}, () => getSettings());
    expect(configuredAllowedReasoningEfforts(settings)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  test("returns client model and reasoning options with current defaults included", () => {
    const settings = {
      ...withEnv({}, () => getSettings()),
      openaiModel: "custom-model",
      openaiAllowedModels: "gpt-5.6-sol",
      openaiReasoningEffort: "xhigh" as const,
      openaiAllowedReasoningEfforts: "low,medium,high",
    };
    expect(configuredAllowedModels(settings)).toEqual(["custom-model", "gpt-5.6-sol"]);
    expect(configuredAllowedReasoningEfforts(settings)).toEqual(["xhigh", "low", "medium", "high"]);
  });

  test("defaults managed transactional email to the verified mail subdomain sender", () => {
    const settings = withEnv({}, () => getSettings());

    expect(settings.emailFrom).toBe("OpenGeni <auth@mail.opengeni.ai>");
  });

  test("parses startup dependency retry settings", () => {
    const settings = withEnv(
      {
        OPENGENI_STARTUP_DEPENDENCY_RETRY_ATTEMPTS: "5",
        OPENGENI_STARTUP_DEPENDENCY_RETRY_INITIAL_DELAY_MS: "10",
        OPENGENI_STARTUP_DEPENDENCY_RETRY_MAX_DELAY_MS: "50",
      },
      () => getSettings(),
    );
    expect(startupRetryOptions(settings)).toEqual({
      attempts: 5,
      initialDelayMs: 10,
      maxDelayMs: 50,
    });
  });

  test("rig setup timeout defaults to 10min and parses OPENGENI_RIG_SETUP_TIMEOUT_MS", () => {
    expect(withEnv({}, () => getSettings()).rigSetupTimeoutMs).toBe(600_000);
    expect(
      withEnv({ OPENGENI_RIG_SETUP_TIMEOUT_MS: "2000" }, () => getSettings()).rigSetupTimeoutMs,
    ).toBe(2_000);
  });

  test("selfhosted exec defaults to unbounded while control stays at 30s", () => {
    const defaults = withEnv({}, () => getSettings());
    expect(defaults.sandboxSelfhostedExecTimeoutMs).toBe(0);
    expect(defaults.sandboxSelfhostedControlTimeoutMs).toBe(30_000);
    const overridden = withEnv(
      {
        OPENGENI_SANDBOX_SELFHOSTED_EXEC_TIMEOUT_MS: "600000",
        OPENGENI_SANDBOX_SELFHOSTED_CONTROL_TIMEOUT_MS: "45000",
      },
      () => getSettings(),
    );
    expect(overridden.sandboxSelfhostedExecTimeoutMs).toBe(600_000);
    expect(overridden.sandboxSelfhostedControlTimeoutMs).toBe(45_000);
  });

  test("parses boolean environment values without treating false as true", () => {
    const settings = withEnv(
      {
        OPENGENI_OBSERVABILITY_STRUCTURED_LOGS: "false",
        OPENGENI_OBSERVABILITY_METRICS_ENABLED: "true",
        OPENGENI_DISABLE_OPENAI_TRACING: "false",
        OPENGENI_OBJECT_STORAGE_FORCE_PATH_STYLE: "0",
        OPENGENI_AUTH_REQUIRED: "true",
        OPENGENI_ACCESS_KEY: "test-access-key",
        OPENGENI_AUTH_ALLOW_HEALTH: "yes",
        OPENGENI_AUTH_ALLOW_METRICS: "no",
      },
      () => getSettings(),
    );

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
    expect(() =>
      withEnv(
        {
          OPENGENI_AUTH_REQUIRED: "true",
        },
        () => getSettings(),
      ),
    ).toThrow("OPENGENI_ACCESS_KEY is required");
  });

  test("requires configured mode to have an auth boundary outside local and test", () => {
    expect(() =>
      withEnv(
        {
          OPENGENI_ENVIRONMENT: "production",
          OPENGENI_PRODUCT_ACCESS_MODE: "configured",
          OPENGENI_DELEGATION_SECRET: "",
          OPENGENI_AUTH_REQUIRED: "false",
        },
        () => getSettings(),
      ),
    ).toThrow(
      "OPENGENI_PRODUCT_ACCESS_MODE=configured requires OPENGENI_DELEGATION_SECRET or OPENGENI_AUTH_REQUIRED=true outside local/test",
    );

    expect(
      withEnv(
        {
          OPENGENI_ENVIRONMENT: "production",
          OPENGENI_PRODUCT_ACCESS_MODE: "configured",
          OPENGENI_DELEGATION_SECRET: "configured-delegation-secret",
        },
        () => getSettings(),
      ).productAccessMode,
    ).toBe("configured");

    expect(
      withEnv(
        {
          OPENGENI_ENVIRONMENT: "production",
          OPENGENI_PRODUCT_ACCESS_MODE: "configured",
          OPENGENI_DELEGATION_SECRET: "",
          OPENGENI_AUTH_REQUIRED: "true",
          OPENGENI_ACCESS_KEY: "configured-shared-key",
        },
        () => getSettings(),
      ).productAccessMode,
    ).toBe("configured");
  });

  test("stream-token secret resolves explicit first, then falls back to delegationSecret", () => {
    const explicit = withEnv(
      {
        OPENGENI_DELEGATION_SECRET: "delegation",
        OPENGENI_STREAM_TOKEN_SECRET: "stream-explicit",
      },
      () => getSettings(),
    );
    expect(resolveStreamTokenSecret(explicit)).toBe("stream-explicit");

    const fallback = withEnv(
      {
        OPENGENI_DELEGATION_SECRET: "delegation-only",
      },
      () => getSettings(),
    );
    expect(resolveStreamTokenSecret(fallback)).toBe("delegation-only");

    const neither = withEnv({}, () => getSettings());
    expect(resolveStreamTokenSecret(neither)).toBeUndefined();
  });

  test("desktop enabled WITHOUT a stream-token secret GRACEFULLY DEGRADES (boots + warns, no throw)", () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      // The whole point of stream-token availability contract: desktop on + no secret is NOT a boot-fail.
      // getSettings() returns settings (does not throw), emits a loud warning,
      // and streamTokenDegraded() flags the runtime degrade to transport:null.
      const settings = withEnv(
        {
          OPENGENI_SANDBOX_DESKTOP_ENABLED: "true",
          OPENGENI_DELEGATION_SECRET: "",
        },
        () => getSettings(),
      );
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
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const settings = withEnv(
        {
          OPENGENI_SANDBOX_DESKTOP_ENABLED: "true",
          OPENGENI_STREAM_TOKEN_SECRET: "stream-secret",
        },
        () => getSettings(),
      );
      expect(streamTokenDegraded(settings)).toBe(false);
      expect(warnings.some((line) => line.includes("GRACEFULLY DEGRADE"))).toBe(false);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("streamControlEnabled defaults to false (the input plane is OFF in v1)", () => {
    expect(withEnv({}, () => getSettings()).streamControlEnabled).toBe(false);
    expect(
      withEnv({ OPENGENI_STREAM_CONTROL_ENABLED: "true" }, () => getSettings())
        .streamControlEnabled,
    ).toBe(true);
  });

  test("agent op-stream transport defaults on and can be explicitly disabled", () => {
    expect(withEnv({}, () => getSettings()).agentOpStreamEnabled).toBe(true);
    expect(
      withEnv({ OPENGENI_AGENT_OP_STREAM_ENABLED: "false" }, () => getSettings())
        .agentOpStreamEnabled,
    ).toBe(false);
  });

  test("retries startup dependency operations with bounded backoff", async () => {
    const retries: string[] = [];
    let calls = 0;
    const result = await retryStartupDependency(
      "NATS",
      async () => {
        calls += 1;
        if (calls < 3) {
          throw new Error(`not ready ${calls}`);
        }
        return "connected";
      },
      {
        attempts: 4,
        initialDelayMs: 0,
        maxDelayMs: 0,
        onRetry: (event) =>
          retries.push(`${event.label}:${event.attempt}/${event.attempts}:${event.delayMs}`),
      },
    );

    expect(result).toBe("connected");
    expect(calls).toBe(3);
    expect(retries).toEqual(["NATS:1/4:0", "NATS:2/4:0"]);
  });

  test("throws the final startup dependency error after all attempts fail", async () => {
    let calls = 0;
    await expect(
      retryStartupDependency(
        "Temporal",
        async () => {
          calls += 1;
          throw new Error("still down");
        },
        {
          attempts: 2,
          initialDelayMs: 0,
          maxDelayMs: 0,
        },
      ),
    ).rejects.toThrow("still down");
    expect(calls).toBe(2);
  });

  test("collects git identity settings for sandbox pass-through", () => {
    const settings = withEnv(
      {
        OPENGENI_GIT_AUTHOR_NAME: "OpenGeni Agent",
        OPENGENI_GIT_AUTHOR_EMAIL: "infra@example.com",
      },
      () => getSettings(),
    );
    expect(collectGitIdentityEnvironment(settings)).toEqual({
      GIT_AUTHOR_NAME: "OpenGeni Agent",
      GIT_AUTHOR_EMAIL: "infra@example.com",
      GIT_COMMITTER_NAME: "OpenGeni Agent",
      GIT_COMMITTER_EMAIL: "infra@example.com",
    });
  });

  test("does not collect ambient host git identity by default", () => {
    const settings = withEnv(
      {
        GIT_AUTHOR_NAME: "Host Author",
        GIT_AUTHOR_EMAIL: "host@example.com",
        GIT_COMMITTER_NAME: "Host Committer",
        GIT_COMMITTER_EMAIL: "committer@example.com",
      },
      () => getSettings(),
    );
    expect(collectGitIdentityEnvironment(settings)).toEqual({});
    expect(
      collectSandboxEnvironment(settings, {
        GIT_AUTHOR_NAME: "Host Author",
        GIT_AUTHOR_EMAIL: "host@example.com",
      }),
    ).toEqual({});
  });

  test("passes ambient git identity only through the github preparation profile", () => {
    const settings = withEnv({}, () => getSettings());
    expect(
      collectSandboxEnvironment(
        {
          ...settings,
          sandboxPreparationProfiles: "github",
        },
        {
          GIT_AUTHOR_NAME: "Host Author",
          GIT_AUTHOR_EMAIL: "host@example.com",
          GIT_COMMITTER_NAME: "Host Committer",
          GIT_COMMITTER_EMAIL: "committer@example.com",
        },
      ),
    ).toEqual({
      GIT_AUTHOR_NAME: "Host Author",
      GIT_AUTHOR_EMAIL: "host@example.com",
      GIT_COMMITTER_NAME: "Host Committer",
      GIT_COMMITTER_EMAIL: "committer@example.com",
    });
  });

  test("parses MCP server registry JSON", () => {
    const parsed = parseMcpServers(
      '[{"id":"docs","name":"Document Search","url":"http://127.0.0.1:8787/mcp","allowedTools":["search_documents"]}]',
    );
    const settings = {
      ...withEnv({}, () => getSettings()),
      mcpServers: parsed as ReturnType<typeof getSettings>["mcpServers"],
    };
    expect(settings.mcpServers[0]?.id).toBe("docs");
    expect(settings.mcpServers[0]?.allowedTools).toEqual(["search_documents"]);
  });

  test("keeps config and wire connection-ref schemas in lockstep", () => {
    const cases: unknown[] = [
      {
        connectionId: "cloud-connection:github:42",
        providerDomain: "github.com",
        provider: "github",
        kind: "app_install",
        scopes: ["repo"],
        selectedResources: [{ kind: "repository", id: "42" }],
        subjectScope: "subject",
      },
      {
        connectionId: "azure-one",
        providerDomain: "dev.azure.com",
        provider: "azure_devops",
        selectedResources: [
          { kind: "repository", id: "repo-1" },
          { kind: "repository", id: "repo-1" },
        ],
      },
      { providerDomain: "gitlab.example" },
      { connectionId: "opaque", providerDomain: "" },
      { providerDomain: "github.com", unexpected: true },
      null,
    ];
    for (const candidate of cases) {
      expect(McpServerConnectionRefSchema.safeParse(candidate).success).toBe(
        ContractMcpServerConnectionRef.safeParse(candidate).success,
      );
    }
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
      url: `http://127.0.0.1:${settings.apiPort}/v1/workspaces/{workspaceId}/mcp/files`,
      // Dedicated endpoint plus exact allowedTools keeps this surface
      // permission-invariant and prevents broad-server exposure.
      allowedTools: ["files_get_download_url"],
    });
    expect(settings.mcpServers.find((server) => server.id === "docs")).toMatchObject({
      name: "Document Search",
      url: `http://127.0.0.1:${settings.apiPort}/v1/workspaces/{workspaceId}/mcp/docs`,
      allowedTools: [
        "search_documents",
        "fetch_document_chunk",
        "list_document_bases",
        "knowledge_search",
        "knowledge_fetch",
        "memory_search",
        "memory_propose",
      ],
    });
  });

  test("derives built-in document MCP URL from OPENGENI_MCP_URL", () => {
    const settings = withEnv(
      {
        OPENGENI_MCP_URL:
          "http://opengeni-api.opengeni.svc.cluster.local:8000/v1/workspaces/{workspaceId}/mcp",
      },
      () => getSettings(),
    );
    expect(settings.mcpServers.find((server) => server.id === "opengeni")?.url).toBe(
      "http://opengeni-api.opengeni.svc.cluster.local:8000/v1/workspaces/{workspaceId}/mcp",
    );
    expect(settings.mcpServers.find((server) => server.id === "docs")?.url).toBe(
      "http://opengeni-api.opengeni.svc.cluster.local:8000/v1/workspaces/{workspaceId}/mcp/docs",
    );
    expect(settings.mcpServers.find((server) => server.id === "files")?.url).toBe(
      "http://opengeni-api.opengeni.svc.cluster.local:8000/v1/workspaces/{workspaceId}/mcp/files",
    );
  });

  test("defaults toolspace off and only adds sandbox pointers when enabled", () => {
    const off = withEnv({}, () => getSettings());
    expect(off.toolspaceEnabled).toBe(false);
    expect(off.toolspaceMaxCallsPerTurn).toBe(200);
    expect(off.ogtoolPackageSpec).toBeUndefined();
    expect(
      stableSandboxEnvironmentForRun(off, {}, { workspaceId: "ws-1" })
        .OPENGENI_TOOLSPACE_TOKEN_FILE,
    ).toBeUndefined();
    expect(
      stableSandboxEnvironmentForRun(off, {}, { workspaceId: "ws-1" }).OPENGENI_TOOLSPACE_URL,
    ).toBeUndefined();

    const on = withEnv(
      {
        OPENGENI_TOOLSPACE_ENABLED: "true",
        OPENGENI_TOOLSPACE_MAX_CALLS_PER_TURN: "17",
        OPENGENI_OGTOOL_PACKAGE_SPEC: "@opengeni/ogtool@0.1.0",
        OPENGENI_DELEGATION_SECRET: "delegation-secret",
      },
      () => getSettings(),
    );
    expect(on.toolspaceEnabled).toBe(true);
    expect(on.toolspaceMaxCallsPerTurn).toBe(17);
    expect(stableSandboxEnvironmentForRun(on, {}, { workspaceId: "ws-1" })).toMatchObject({
      OPENGENI_TOOLSPACE_TOKEN_FILE: "/workspace/.opengeni/toolspace-token",
      OPENGENI_TOOLSPACE_URL: "http://127.0.0.1:8000/v1/workspaces/ws-1/mcp",
      OPENGENI_OGTOOL_PACKAGE_SPEC: "@opengeni/ogtool@0.1.0",
    });
  });

  test("rejects floating or malformed ogtool package specs", () => {
    for (const value of [
      "@opengeni/ogtool@latest",
      "@opengeni/ogtool@1",
      "@opengeni/ogtool@1.2.3-beta.1",
      "other-package@1.2.3",
    ]) {
      expect(() =>
        withEnv(
          {
            OPENGENI_OGTOOL_PACKAGE_SPEC: value,
          },
          () => getSettings(),
        ),
      ).toThrow();
    }
  });

  test("adds stable git credential pointers and provider CLI wrapper PATH for provisioned sandboxes", () => {
    const settings = withEnv({}, () => getSettings());
    const env = stableSandboxEnvironmentForRun(settings, {}, { workspaceId: "ws-1" });

    expect(env.OPENGENI_GIT_CREDENTIALS_DIR).toBe("/workspace/.opengeni/git-credentials");
    expect(env.OPENGENI_GIT_TOKEN_FILE).toBe("/workspace/.opengeni/git-token");
    expect(env.OPENGENI_GIT_CLI_WRAPPER_DIR).toBe("/workspace/.opengeni/bin");
    expect(env.PATH?.split(":")[0]).toBe("/workspace/.opengeni/bin");
    expect(Object.values(env)).not.toContain("ghs_liveToken123");
  });

  test("does not add git credential pointers or wrapper PATH for selfhosted sandboxes", () => {
    const settings = withEnv({ OPENGENI_SANDBOX_BACKEND: "selfhosted" }, () => getSettings());
    const env = stableSandboxEnvironmentForRun(settings, {}, { workspaceId: "ws-1" });

    expect(env).toEqual({});
    expect(env.OPENGENI_GIT_CREDENTIALS_DIR).toBeUndefined();
    expect(env.OPENGENI_GIT_TOKEN_FILE).toBeUndefined();
    expect(env.OPENGENI_GIT_CLI_WRAPPER_DIR).toBeUndefined();
    expect(env.PATH).toBeUndefined();
  });

  test("adds no Toolspace pointers for selfhosted", () => {
    const settings = withEnv(
      {
        OPENGENI_SANDBOX_BACKEND: "selfhosted",
        OPENGENI_TOOLSPACE_ENABLED: "true",
        OPENGENI_DELEGATION_SECRET: "delegation-secret",
      },
      () => getSettings(),
    );
    const env = stableSandboxEnvironmentForRun(settings, {}, { workspaceId: "ws-1" });

    expect(env).toEqual({});
  });

  test("requires a delegation secret when toolspace is enabled", () => {
    expect(() =>
      withEnv(
        {
          OPENGENI_TOOLSPACE_ENABLED: "true",
        },
        () => getSettings(),
      ),
    ).toThrow("OPENGENI_DELEGATION_SECRET is required when OPENGENI_TOOLSPACE_ENABLED=true");
  });

  test("resolves a local-only first-party delegation secret without weakening configured mode", async () => {
    const { resolveFirstPartyDelegationSecret } = await import("../src/index");
    const local = withEnv({}, () => getSettings());
    const configured = withEnv({ OPENGENI_PRODUCT_ACCESS_MODE: "configured" }, () => getSettings());
    const explicit = withEnv({ OPENGENI_DELEGATION_SECRET: "operator-secret" }, () =>
      getSettings(),
    );

    expect(resolveFirstPartyDelegationSecret(local)).toBeTruthy();
    expect(resolveFirstPartyDelegationSecret(configured)).toBeUndefined();
    expect(resolveFirstPartyDelegationSecret(explicit)).toBe("operator-secret");
  });

  test("does not duplicate a custom files MCP profile", () => {
    withEnv(
      {
        OPENGENI_MCP_SERVERS:
          '[{"id":"files","name":"Custom Files","url":"http://127.0.0.1:8787/mcp","allowedTools":["custom_download"]}]',
      },
      () => {
        const settings = getSettings();
        const ids = settings.mcpServers.map((server) => server.id);
        expect(ids.filter((id) => id === "files")).toHaveLength(1);
        expect(settings.mcpServers.find((server) => server.id === "files")).toMatchObject({
          name: "Custom Files",
          url: "http://127.0.0.1:8787/mcp",
          allowedTools: ["custom_download"],
        });
      },
    );
  });

  test("ignores pre-OpenGeni environment variable names", () => {
    withEnv(
      {
        INFRA_AGENT_SERVICE_NAME: "legacy-service",
        INFRA_AGENT_DATABASE_URL: "postgres://legacy:legacy@127.0.0.1:5432/legacy",
        INFRA_AGENT_OBJECT_STORAGE_BUCKET: "legacy-files",
      },
      () => {
        const settings = getSettings();

        expect(settings.serviceName).toBe("opengeni");
        expect(settings.databaseUrl).toBe("postgres://opengeni:opengeni@127.0.0.1:5432/opengeni");
        expect(settings.objectStorageBucket).toBe("opengeni-files");
      },
    );
  });

  test("rejects non-array MCP server registry JSON", () => {
    expect(() => parseMcpServers('{"id":"docs"}')).toThrow("must be a JSON array");
  });

  test("parses object storage settings and rejects incomplete credentials", () => {
    withEnv(
      {
        OPENGENI_OBJECT_STORAGE_BACKEND: "s3-compatible",
        OPENGENI_OBJECT_STORAGE_ENDPOINT: "http://127.0.0.1:9000",
        OPENGENI_OBJECT_STORAGE_INTERNAL_ENDPOINT: "http://minio:9000",
        OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID: "minioadmin",
        OPENGENI_OBJECT_STORAGE_SECRET_ACCESS_KEY: "minioadmin",
      },
      () => {
        const settings = getSettings();
        expect(settings.objectStorageBackend).toBe("s3-compatible");
        expect(settings.objectStorageEndpoint).toBe("http://127.0.0.1:9000");
        expect(settings.objectStorageInternalEndpoint).toBe("http://minio:9000");
        expect(settings.objectStorageBucket).toBe("opengeni-files");
        expect(settings.objectStorageForcePathStyle).toBe(true);
      },
    );

    withEnv(
      {
        OPENGENI_OBJECT_STORAGE_ENDPOINT: "http://127.0.0.1:9000",
        OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID: "minioadmin",
      },
      () => {
        expect(() => getSettings()).toThrow("both be set or both omitted");
      },
    );
  });

  test("parses Azure Blob object storage settings", () => {
    withEnv(
      {
        OPENGENI_OBJECT_STORAGE_BACKEND: "azure-blob",
        OPENGENI_OBJECT_STORAGE_BUCKET: "opengeni-files",
        OPENGENI_OBJECT_STORAGE_AZURE_ACCOUNT_NAME: "opengeni",
        OPENGENI_OBJECT_STORAGE_AZURE_ACCOUNT_KEY: "storage-key",
      },
      () => {
        const settings = getSettings();
        expect(settings.objectStorageBackend).toBe("azure-blob");
        expect(settings.objectStorageBucket).toBe("opengeni-files");
        expect(settings.objectStorageAzureAccountName).toBe("opengeni");
        expect(settings.objectStorageAzureAccountKey).toBe("storage-key");
      },
    );

    withEnv(
      {
        OPENGENI_OBJECT_STORAGE_BACKEND: "azure-blob",
      },
      () => {
        expect(() => getSettings()).toThrow("Azure Blob storage requires");
      },
    );

    withEnv(
      {
        OPENGENI_OBJECT_STORAGE_BACKEND: "azure-blob",
        OPENGENI_OBJECT_STORAGE_ENDPOINT: "http://127.0.0.1:9000",
        OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID: "minioadmin",
        OPENGENI_OBJECT_STORAGE_SECRET_ACCESS_KEY: "minioadmin",
        OPENGENI_OBJECT_STORAGE_AZURE_CONNECTION_STRING: "UseDevelopmentStorage=true",
      },
      () => {
        expect(() => getSettings()).toThrow(
          "Azure Blob storage uses OPENGENI_OBJECT_STORAGE_AZURE",
        );
      },
    );
  });

  test("parses native AWS S3 object storage without static key assumptions", () => {
    withEnv(
      {
        OPENGENI_OBJECT_STORAGE_BACKEND: "aws-s3",
        OPENGENI_OBJECT_STORAGE_BUCKET: "opengeni-files",
        OPENGENI_OBJECT_STORAGE_REGION: "us-east-1",
      },
      () => {
        const settings = getSettings();
        expect(settings.objectStorageBackend).toBe("aws-s3");
        expect(settings.objectStorageBucket).toBe("opengeni-files");
        expect(settings.objectStorageRegion).toBe("us-east-1");
        expect(settings.objectStorageAccessKeyId).toBeUndefined();
      },
    );
  });

  test("parses GCS object storage settings and validates inline credentials JSON", () => {
    withEnv(
      {
        OPENGENI_OBJECT_STORAGE_BACKEND: "gcs",
        OPENGENI_OBJECT_STORAGE_BUCKET: "opengeni-files",
        OPENGENI_OBJECT_STORAGE_GCS_PROJECT_ID: "opengeni-test",
      },
      () => {
        const settings = getSettings();
        expect(settings.objectStorageBackend).toBe("gcs");
        expect(settings.objectStorageBucket).toBe("opengeni-files");
        expect(settings.objectStorageGcsProjectId).toBe("opengeni-test");
      },
    );

    withEnv(
      {
        OPENGENI_OBJECT_STORAGE_BACKEND: "gcs",
        OPENGENI_OBJECT_STORAGE_GCS_CREDENTIALS_JSON: "not-json",
      },
      () => {
        expect(() => getSettings()).toThrow("GCS_CREDENTIALS_JSON must be valid JSON");
      },
    );

    withEnv(
      {
        OPENGENI_OBJECT_STORAGE_BACKEND: "gcs",
        OPENGENI_OBJECT_STORAGE_ENDPOINT: "http://127.0.0.1:9000",
      },
      () => {
        expect(() => getSettings()).toThrow("GCS object storage uses OPENGENI_OBJECT_STORAGE_GCS");
      },
    );
  });

  test("parses document indexing settings", () => {
    withEnv(
      {
        OPENGENI_DOCUMENT_CHUNK_SIZE: "2000",
        OPENGENI_DOCUMENT_CHUNK_OVERLAP: "200",
        OPENGENI_DOCUMENT_EMBEDDING_PROVIDER: "deterministic",
        OPENGENI_DOCUMENT_EMBEDDING_MODEL: "local-test",
        OPENGENI_DOCUMENT_EMBEDDING_DIMENSIONS: "3072",
      },
      () => {
        const settings = getSettings();
        expect(settings.documentParser).toBe("liteparse");
        expect(settings.documentChunkSize).toBe(2000);
        expect(settings.documentChunkOverlap).toBe(200);
        expect(settings.documentEmbeddingProvider).toBe("deterministic");
        expect(settings.documentEmbeddingModel).toBe("local-test");
        expect(settings.documentEmbeddingDimensions).toBe(3072);
      },
    );
  });

  test("rejects invalid document chunk overlap", () => {
    withEnv(
      {
        OPENGENI_DOCUMENT_CHUNK_SIZE: "100",
        OPENGENI_DOCUMENT_CHUNK_OVERLAP: "100",
      },
      () => {
        expect(() => getSettings()).toThrow("must be smaller");
      },
    );
  });

  test("parses static usage limits and rejects empty static mode", () => {
    const limits = parseStaticUsageLimitsJson(
      '{"maxWorkspacesPerAccount":2,"maxFileUploadBytes":1048576}',
    );
    expect(limits).toEqual({
      maxWorkspacesPerAccount: 2,
      maxFileUploadBytes: 1048576,
    });

    withEnv(
      {
        OPENGENI_USAGE_LIMITS_MODE: "static",
        OPENGENI_STATIC_USAGE_LIMITS_JSON: '{"maxApiKeysPerWorkspace":1}',
      },
      () => {
        expect(configuredStaticUsageLimits(getSettings())).toEqual({
          maxApiKeysPerWorkspace: 1,
        });
      },
    );

    withEnv({ OPENGENI_USAGE_LIMITS_MODE: "static" }, () => {
      expect(() => getSettings()).toThrow("STATIC_USAGE_LIMITS_JSON");
    });
  });

  test("parses static and managed entitlement overlays", () => {
    expect(parseStaticEntitlementsJson('{"github":true,"models":["gpt-5.6-sol"]}')).toEqual({
      github: true,
      models: ["gpt-5.6-sol"],
    });

    withEnv(
      {
        OPENGENI_ENTITLEMENTS_MODE: "static",
        OPENGENI_STATIC_ENTITLEMENTS_JSON: '{"github":true}',
      },
      () => {
        expect(configuredEntitlements(getSettings())).toEqual({ github: true });
      },
    );

    withEnv(
      {
        OPENGENI_ENTITLEMENTS_MODE: "managed",
        OPENGENI_STATIC_ENTITLEMENTS_JSON: '{"custom.feature":"enabled"}',
      },
      () => {
        expect(configuredEntitlements(getSettings())).toMatchObject({
          "managed.auth.email_password": true,
          "managed.api_keys": true,
          "custom.feature": "enabled",
        });
      },
    );

    withEnv({ OPENGENI_ENTITLEMENTS_MODE: "static" }, () => {
      expect(() => getSettings()).toThrow("STATIC_ENTITLEMENTS_JSON");
    });
  });
});

describe("workspace environments encryption key", () => {
  const validKey = Buffer.alloc(32, 7).toString("base64");

  test("decodes a base64 key of exactly 32 bytes", () => {
    const settings = withEnv({ OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY: validKey }, () =>
      getSettings(),
    );
    const key = environmentsEncryptionKeyBytes(settings);
    expect(key).not.toBeNull();
    expect(key!.length).toBe(32);
  });

  test("returns null when the key is unset", () => {
    const settings = withEnv({}, () => getSettings());
    expect(environmentsEncryptionKeyBytes(settings)).toBeNull();
  });

  test("rejects keys that do not decode to 32 bytes at boot", () => {
    expect(() =>
      withEnv(
        {
          OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString("base64"),
        },
        () => getSettings(),
      ),
    ).toThrow("OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY must be base64 for exactly 32 bytes");
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
    expect(() => withEnv(managedEnv, () => getSettings())).toThrow(
      "OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY is required for managed mode outside local/test",
    );
    expect(
      withEnv(
        {
          ...managedEnv,
          OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY: validKey,
        },
        () => getSettings(),
      ).environmentsEncryptionKey,
    ).toBe(validKey);
    expect(
      withEnv(
        {
          OPENGENI_PRODUCT_ACCESS_MODE: "managed",
          OPENGENI_PUBLIC_BASE_URL: "https://managed.example.test",
          OPENGENI_BETTER_AUTH_SECRET: "managed-better-auth-secret",
          OPENGENI_DELEGATION_SECRET: "managed-delegation-secret",
        },
        () => getSettings(),
      ).environmentsEncryptionKey,
    ).toBeUndefined();
  });
});

describe("provider item id policy", () => {
  test("defaults to stripping provider item ids with encrypted reasoning round-trip", () => {
    const settings = withEnv({}, () => getSettings());
    expect(settings.openaiProviderItemIds).toBe("strip");
    expect(settings.openaiReasoningEncryptedContent).toBe(true);
  });

  test("can preserve provider item ids and disable encrypted reasoning", () => {
    const settings = withEnv(
      {
        OPENGENI_OPENAI_PROVIDER_ITEM_IDS: "preserve",
        OPENGENI_OPENAI_REASONING_ENCRYPTED_CONTENT: "false",
      },
      () => getSettings(),
    );
    expect(settings.openaiProviderItemIds).toBe("preserve");
    expect(settings.openaiReasoningEncryptedContent).toBe(false);
  });

  test("rejects unknown provider item id policies", () => {
    expect(() =>
      withEnv({ OPENGENI_OPENAI_PROVIDER_ITEM_IDS: "sometimes" }, () => getSettings()),
    ).toThrow();
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
      expect(() =>
        withEnv({ OPENGENI_SANDBOX_BACKEND: backend }, () => getSettings()),
      ).not.toThrow();
    }
  });

  test("modal requires the token only when sandboxBackend=modal", () => {
    // Backend=modal WITHOUT the token → fails (gated).
    expect(() => withEnv({ OPENGENI_SANDBOX_BACKEND: "modal" }, () => getSettings())).toThrow(
      "OPENGENI_MODAL_TOKEN_ID is required when OPENGENI_SANDBOX_BACKEND=modal",
    );
    // Backend=modal WITH the token (and app name defaulted) → passes.
    expect(() =>
      withEnv(
        {
          OPENGENI_SANDBOX_BACKEND: "modal",
          OPENGENI_MODAL_TOKEN_ID: "ak-test",
          OPENGENI_MODAL_TOKEN_SECRET: "as-test",
        },
        () => getSettings(),
      ),
    ).not.toThrow();
    // The SAME missing-token config but backend=docker → does NOT fail on modal.
    expect(() =>
      withEnv({ OPENGENI_SANDBOX_BACKEND: "docker" }, () => getSettings()),
    ).not.toThrow();
  });

  test("parses and validates an immutable Modal image ID", () => {
    const imageId = "im-1234567890123456789012";
    expect(
      withEnv(
        {
          OPENGENI_MODAL_IMAGE_REF:
            "ghcr.io/example/sandbox@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          OPENGENI_MODAL_IMAGE_ID: imageId,
        },
        () => getSettings(),
      ).modalImageId,
    ).toBe(imageId);
    expect(() =>
      withEnv({ OPENGENI_MODAL_IMAGE_ID: "im-not-a-valid-id" }, () => getSettings()),
    ).toThrow();
  });

  test("daytona requires its api key only when active", () => {
    expect(() => withEnv({ OPENGENI_SANDBOX_BACKEND: "daytona" }, () => getSettings())).toThrow(
      "OPENGENI_DAYTONA_API_KEY is required when OPENGENI_SANDBOX_BACKEND=daytona",
    );
    expect(() =>
      withEnv(
        {
          OPENGENI_SANDBOX_BACKEND: "daytona",
          OPENGENI_DAYTONA_API_KEY: "dk-test",
        },
        () => getSettings(),
      ),
    ).not.toThrow();
    // daytona creds are irrelevant when modal is active (modal has its own gate).
    expect(() =>
      withEnv(
        {
          OPENGENI_SANDBOX_BACKEND: "modal",
          OPENGENI_MODAL_TOKEN_ID: "ak",
          OPENGENI_MODAL_TOKEN_SECRET: "as",
        },
        () => getSettings(),
      ),
    ).not.toThrow();
  });

  test("vercel requires BOTH the token and the project id when active", () => {
    expect(() =>
      withEnv({ OPENGENI_SANDBOX_BACKEND: "vercel", OPENGENI_VERCEL_TOKEN: "vt" }, () =>
        getSettings(),
      ),
    ).toThrow("OPENGENI_VERCEL_PROJECT_ID is required when OPENGENI_SANDBOX_BACKEND=vercel");
    expect(() =>
      withEnv(
        {
          OPENGENI_SANDBOX_BACKEND: "vercel",
          OPENGENI_VERCEL_TOKEN: "vt",
          OPENGENI_VERCEL_PROJECT_ID: "prj",
        },
        () => getSettings(),
      ),
    ).not.toThrow();
  });

  test("runloop/e2b/blaxel/cloudflare each gate their own single credential", () => {
    const cases: Array<[string, string, string]> = [
      ["runloop", "OPENGENI_RUNLOOP_API_KEY", "rk"],
      ["e2b", "OPENGENI_E2B_API_KEY", "ek"],
      ["blaxel", "OPENGENI_BLAXEL_API_KEY", "bk"],
      ["cloudflare", "OPENGENI_CLOUDFLARE_WORKER_URL", "https://worker.example.com"],
    ];
    for (const [backend, envKey, value] of cases) {
      expect(() => withEnv({ OPENGENI_SANDBOX_BACKEND: backend }, () => getSettings())).toThrow(
        `${envKey} is required when OPENGENI_SANDBOX_BACKEND=${backend}`,
      );
      expect(() =>
        withEnv({ OPENGENI_SANDBOX_BACKEND: backend, [envKey]: value }, () => getSettings()),
      ).not.toThrow();
    }
  });

  test("the modal token stays a both-or-neither pair regardless of the active backend", () => {
    // Half-configured Modal token while backend=docker: still a misconfig.
    expect(() =>
      withEnv(
        {
          OPENGENI_SANDBOX_BACKEND: "docker",
          OPENGENI_MODAL_TOKEN_ID: "only-id",
        },
        () => getSettings(),
      ),
    ).toThrow(
      "OPENGENI_MODAL_TOKEN_ID and OPENGENI_MODAL_TOKEN_SECRET must both be set or both omitted",
    );
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
      expect(
        Array.isArray(requiredSandboxEnvForBackend(backend as keyof typeof SANDBOX_REQUIRED_ENV)),
      ).toBe(true);
    }
  });
});

describe("sandbox lease cadence vs box idle timeout (sandbox-file-persistence)", () => {
  test("the durable capture gate outlives provider snapshot settlement but remains bounded", () => {
    expect(sandboxArchiveCaptureTimeoutMs({ sandboxSnapshotTimeoutMs: 10_000 })).toBe(40_000);
    expect(sandboxArchiveCaptureTimeoutMs({ sandboxSnapshotTimeoutMs: 40_000 })).toBe(80_000);
    expect(sandboxArchiveCaptureTimeoutMs({ sandboxSnapshotTimeoutMs: 3_590_000 })).toBe(3_600_000);
  });

  test("idle timeout defaults to the hard lifetime and the default cadence passes boot", () => {
    const settings = withEnv({}, () => getSettings());
    // Default config: idleGrace 900s + reaper 30s = 930s warm window must fit under
    // the effective box idle timeout — which defaults to the hard lifetime (86400s).
    expect(effectiveModalIdleTimeoutSeconds(settings)).toBe(settings.modalTimeoutSeconds);
    expect(effectiveModalIdleTimeoutSeconds(settings)).toBe(86_400);
    expect(settings.sandboxRotationLeadMs).toBe(3_600_000);
    expect(settings.sandboxRotationBatchSize).toBe(1);
    expect(settings.sandboxLeaseReaperPeriodMs + settings.sandboxIdleGraceMs).toBeLessThan(
      effectiveModalIdleTimeoutSeconds(settings) * 1000,
    );
  });

  test("an explicit idle timeout overrides the default", () => {
    const settings = withEnv({ OPENGENI_MODAL_IDLE_TIMEOUT_SECONDS: "1200" }, () => getSettings());
    expect(effectiveModalIdleTimeoutSeconds(settings)).toBe(1200);
  });

  test("rotation lead derives from a short provider lifetime when not explicitly pinned", () => {
    const settings = withEnv({ OPENGENI_MODAL_TIMEOUT_SECONDS: "300" }, () => getSettings());
    expect(settings.sandboxRotationLeadMs).toBe(150_000);
    expect(settings.sandboxIdleGraceMs).toBe(150_000);
  });

  test("an explicit rotation lead overrides the provider-relative default", () => {
    const settings = withEnv(
      {
        OPENGENI_MODAL_TIMEOUT_SECONDS: "900",
        OPENGENI_SANDBOX_ROTATION_LEAD_MS: "300000",
      },
      () => getSettings(),
    );
    expect(settings.sandboxRotationLeadMs).toBe(300_000);
  });

  test("the configured hard lifetime cannot exceed Modal's 24-hour maximum", () => {
    expect(() => withEnv({ OPENGENI_MODAL_TIMEOUT_SECONDS: "86401" }, () => getSettings())).toThrow(
      /<=86400/i,
    );
  });

  test("boot rejects a rotation window outside the finite provider lifetime", () => {
    expect(() =>
      withEnv(
        {
          OPENGENI_MODAL_TIMEOUT_SECONDS: "3600",
          OPENGENI_SANDBOX_ROTATION_LEAD_MS: "3600000",
        },
        () => getSettings(),
      ),
    ).toThrow(/rotation_lead_ms.*strictly less/i);
  });

  test("boot reserves snapshot timeout plus two reaper ticks before rotation", () => {
    expect(() =>
      withEnv({ OPENGENI_SANDBOX_ROTATION_LEAD_MS: "120000" }, () => getSettings()),
    ).toThrow(/must exceed the snapshot timeout/i);
  });

  test("the rotation batch is positive and bounded", () => {
    expect(
      withEnv({ OPENGENI_SANDBOX_ROTATION_BATCH_SIZE: "25" }, () => getSettings())
        .sandboxRotationBatchSize,
    ).toBe(25);
    expect(() =>
      withEnv({ OPENGENI_SANDBOX_ROTATION_BATCH_SIZE: "501" }, () => getSettings()),
    ).toThrow(/<=500/i);
  });

  test("boot fails when reaperPeriod + idleGrace would outlive the box idle timeout", () => {
    // Pin the idle timeout BELOW idleGrace so Modal's idle-reap would kill the box
    // before the reaper waits out the drain grace to snapshot it — the exact
    // failure mode (file lost across box churn). Boot must reject it.
    expect(() =>
      withEnv(
        {
          OPENGENI_MODAL_IDLE_TIMEOUT_SECONDS: "120",
          OPENGENI_SANDBOX_IDLE_GRACE_MS: "900000",
        },
        () => getSettings(),
      ),
    ).toThrow(/idle timeout/i);
  });

  test("boot fails when an explicit idle timeout exceeds the hard lifetime", () => {
    expect(() =>
      withEnv(
        {
          OPENGENI_MODAL_TIMEOUT_SECONDS: "300",
          OPENGENI_MODAL_IDLE_TIMEOUT_SECONDS: "600",
          OPENGENI_SANDBOX_ROTATION_LEAD_MS: "180000",
        },
        () => getSettings(),
      ),
    ).toThrow(/must not exceed the hard provider/i);
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
