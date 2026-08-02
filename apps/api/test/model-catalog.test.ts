import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { testSettings } from "@opengeni/testing";
import { buildWorkspaceModelCatalog } from "../src/model-catalog";

describe("workspace model catalog availability", () => {
  test("projects OpenGeni topology safely and gates the workspace Gateway rail", () => {
    const settings = testSettings({
      codexSubscriptionEnabled: false,
      modelProvidersJson: "[]",
      vercelAiGatewayApiKey: "vck_managed",
    });
    const disconnected = buildWorkspaceModelCatalog({
      settings,
      policy: null,
      codexSubscriptionActive: false,
      workspaceGatewayConnectionActive: false,
    });
    const managed = disconnected.models.find((model) => model.id === "deepseek-v4-flash-0731")!;
    expect(managed).toMatchObject({
      provider: "opengeni",
      providerLabel: "OpenGeni",
      source: "opengeni",
      billing: { upstreamPayer: "deployment", metering: "opengeni_credits" },
    });
    expect(managed.deployment).toBeUndefined();
    expect(managed.credentialSource).toBeUndefined();
    expect(JSON.stringify(managed)).not.toContain("deepinfra");
    expect(JSON.stringify(managed)).not.toContain("baseten");
    expect(JSON.stringify(managed)).not.toContain("ai-gateway.vercel.sh");

    const workspaceModel = disconnected.models.find(
      (model) => model.id === "workspace-gateway/deepseek-v4-flash-0731",
    )!;
    expect(workspaceModel).toMatchObject({
      provider: "workspace-gateway",
      providerLabel: "Your Gateway",
      source: "workspace_gateway",
      credentialReadiness: { status: "not_ready" },
    });

    const connected = buildWorkspaceModelCatalog({
      settings,
      policy: null,
      codexSubscriptionActive: false,
      workspaceGatewayConnectionActive: true,
    });
    expect(
      connected.models.find((model) => model.id === "workspace-gateway/deepseek-v4-flash-0731")
        ?.credentialReadiness.status,
    ).toBe("ready");
  });

  test("unknown health is selectable only after credential and policy gates pass", () => {
    const settings = testSettings({ codexSubscriptionEnabled: false });
    const allowed = buildWorkspaceModelCatalog({
      settings,
      policy: null,
      codexSubscriptionActive: false,
    });
    const model = allowed.models.find((candidate) => candidate.id === settings.openaiModel)!;
    expect(model.credentialReadiness).toEqual({
      status: "ready",
      reason: null,
      basis: "configuration",
      checkedAt: null,
    });
    expect(model.availability).toEqual({
      status: "unknown",
      selectable: true,
      reason: null,
      checkedAt: null,
    });

    const blocked = buildWorkspaceModelCatalog({
      settings,
      policy: { allowedProviders: [], allowedModels: null },
      codexSubscriptionActive: false,
    }).models.find((candidate) => candidate.id === settings.openaiModel)!;
    expect(blocked.availability).toMatchObject({
      status: "unavailable",
      selectable: false,
      reason: "policy_blocked",
    });

    const missingCredential = buildWorkspaceModelCatalog({
      settings: { ...settings, openaiApiKey: undefined },
      policy: null,
      codexSubscriptionActive: false,
    }).models.find((candidate) => candidate.id === settings.openaiModel)!;
    expect(missingCredential.availability).toMatchObject({
      status: "unavailable",
      selectable: false,
      reason: "missing_credential",
    });
    expect(missingCredential.credentialReadiness).toEqual({
      status: "not_ready",
      reason: "missing_credential",
      basis: "configuration",
      checkedAt: null,
    });
  });

  test("XAI Grok availability requires fresh successful health evidence", () => {
    const settings = testSettings({
      codexSubscriptionEnabled: false,
      modelProvidersJson: JSON.stringify([
        {
          id: "xai",
          label: "xAI",
          api: "responses",
          baseUrl: "https://api.x.ai/v1",
          apiKey: "xai-catalog-test-key",
          models: [{ id: "xai/grok-4.5", label: "Grok 4.5" }],
        },
        {
          id: "acme",
          label: "Acme",
          api: "responses",
          baseUrl: "https://api.acme.test/v1",
          apiKey: "acme-catalog-test-key",
          models: [{ id: "acme/model", label: "Acme model" }],
        },
      ]),
    });
    const now = new Date("2026-07-25T12:00:00.000Z");
    const initial = buildWorkspaceModelCatalog({
      settings,
      policy: null,
      codexSubscriptionActive: false,
      now,
    });
    const grok = initial.models.find((model) => model.id === "xai/grok-4.5")!;
    const acme = initial.models.find((model) => model.id === "acme/model")!;
    expect(grok.credentialReadiness).toEqual({
      status: "ready",
      reason: null,
      basis: "configuration",
      checkedAt: null,
    });
    expect(grok.availability).toMatchObject({
      status: "unavailable",
      selectable: false,
      reason: "provider_unhealthy",
    });
    expect(acme.availability).toEqual({
      status: "unknown",
      selectable: true,
      reason: null,
      checkedAt: null,
    });

    const observationKey = grok.definitionVersion!;
    const catalogFor = (observation: unknown) =>
      buildWorkspaceModelCatalog({
        settings,
        policy: null,
        codexSubscriptionActive: false,
        now,
        observations: { [observationKey]: observation as never },
      }).models.find((model) => model.id === "xai/grok-4.5")!;

    const fresh = catalogFor({
      status: "available",
      reason: null,
      checkedAt: new Date(now.getTime() - 60_000).toISOString(),
    });
    expect(fresh).toMatchObject({
      credentialReadiness: { status: "ready", basis: "configuration" },
      availability: { status: "available", selectable: true, reason: null },
    });

    const stale = catalogFor({
      status: "available",
      reason: null,
      checkedAt: new Date(now.getTime() - 10 * 60_000).toISOString(),
    });
    const future = catalogFor({
      status: "available",
      reason: null,
      checkedAt: new Date(now.getTime() + 60_000).toISOString(),
    });
    const malformed = catalogFor({
      status: "available",
      reason: null,
      checkedAt: "not-a-timestamp",
    });
    const unavailable = catalogFor({
      status: "unavailable",
      reason: "provider_unhealthy",
      checkedAt: now.toISOString(),
    });
    const error = catalogFor({
      status: "error",
      reason: null,
      checkedAt: now.toISOString(),
    });
    for (const model of [stale, future, malformed, unavailable, error]) {
      expect(model.credentialReadiness).toMatchObject({ status: "ready" });
      expect(model.availability).toMatchObject({ status: "unavailable", selectable: false });
    }
  });

  test("consumes typed available, degraded, unavailable, and entitlement observations", () => {
    const settings = testSettings({ codexSubscriptionEnabled: false });
    const baseline = buildWorkspaceModelCatalog({
      settings,
      policy: null,
      codexSubscriptionActive: false,
    }).models[0]!;
    const checkedAt = "2026-07-18T12:00:00.000Z";
    for (const [observation, expected] of [
      [
        { status: "available", reason: null, checkedAt },
        { status: "available", selectable: true, reason: null },
      ],
      [
        { status: "degraded", reason: null, checkedAt },
        { status: "degraded", selectable: true, reason: null },
      ],
      [
        { status: "unavailable", reason: "provider_unhealthy", checkedAt },
        { status: "unavailable", selectable: false, reason: "provider_unhealthy" },
      ],
      [
        { status: "unavailable", reason: "not_entitled", checkedAt },
        { status: "unavailable", selectable: false, reason: "not_entitled" },
      ],
    ] as const) {
      const projected = buildWorkspaceModelCatalog({
        settings,
        policy: null,
        codexSubscriptionActive: false,
        observations: { [baseline.definitionVersion!]: observation },
      }).models[0]!;
      expect(projected.availability).toMatchObject(expected);
      expect(projected.availability.checkedAt).toBe(checkedAt);
    }
  });

  test("Codex definitions remain external-billed and require the existing connection readiness seam", () => {
    const settings = testSettings({ codexSubscriptionEnabled: true });
    const disconnected = buildWorkspaceModelCatalog({
      settings,
      policy: null,
      codexSubscriptionActive: false,
    });
    const codexDisconnected = disconnected.models.find((model) => model.id.startsWith("codex/"))!;
    expect(codexDisconnected).toMatchObject({
      provider: "codex",
      providerLabel: "Codex",
      source: "codex",
      billing: { upstreamPayer: "connected_subscription", metering: "external" },
      credentialReadiness: {
        status: "not_ready",
        reason: "needs_reauth",
        basis: "connection",
      },
      availability: {
        status: "unavailable",
        selectable: false,
        reason: "needs_reauth",
      },
    });
    expect(codexDisconnected.credentialSource).toBeUndefined();

    const connected = buildWorkspaceModelCatalog({
      settings,
      policy: null,
      codexSubscriptionActive: true,
    }).models.find((model) => model.id === codexDisconnected.id)!;
    expect(connected.credentialReadiness).toEqual({
      status: "ready",
      reason: null,
      basis: "connection",
      checkedAt: null,
    });
    expect(connected.availability).toEqual({
      status: "unknown",
      selectable: true,
      reason: null,
      checkedAt: null,
    });
  });

  test("Azure AD bearer readiness requires a fresh successful resolver observation", () => {
    const settings = testSettings({
      codexSubscriptionEnabled: false,
      openaiProvider: "azure",
      azureOpenaiBaseUrl: "https://example.openai.azure.com/openai/v1",
      azureOpenaiApiKey: undefined,
      azureOpenaiAdToken: "static-ad-token-never-project",
    });
    const now = new Date("2026-07-25T12:00:00.000Z");
    const unresolved = buildWorkspaceModelCatalog({
      settings,
      policy: null,
      codexSubscriptionActive: false,
      now,
    }).models.find((candidate) => candidate.id === settings.openaiModel)!;
    expect(unresolved).toMatchObject({
      provider: "opengeni",
      providerLabel: "OpenGeni",
      source: "opengeni",
      credentialReadiness: {
        status: "not_ready",
        reason: "prerequisites_missing",
        basis: "resolver",
        checkedAt: null,
      },
      availability: {
        status: "unavailable",
        selectable: false,
        reason: "credential_not_ready",
        checkedAt: null,
      },
    });
    expect(unresolved.credentialSource).toBeUndefined();
    expect(JSON.stringify(unresolved)).not.toContain("static-ad-token-never-project");

    const ready = buildWorkspaceModelCatalog({
      settings,
      policy: null,
      codexSubscriptionActive: false,
      now,
      credentialReadinessObservations: {
        [unresolved.definitionVersion!]: {
          status: "ready",
          checkedAt: now.toISOString(),
        },
      },
    }).models.find((candidate) => candidate.id === settings.openaiModel)!;
    expect(ready.credentialReadiness).toEqual({
      status: "ready",
      reason: null,
      basis: "resolver",
      checkedAt: now.toISOString(),
    });
    expect(ready.availability).toEqual({
      status: "unknown",
      selectable: true,
      reason: null,
      checkedAt: null,
    });
  });

  test("resolver errors and stale observations fail closed without identity material", () => {
    const settings = testSettings({
      codexSubscriptionEnabled: false,
      openaiProvider: "azure",
      azureOpenaiBaseUrl: "https://example.openai.azure.com/openai/v1",
      azureOpenaiApiKey: undefined,
      azureOpenaiAdToken: "ad-token-do-not-reflect",
    });
    const now = new Date("2026-07-25T12:00:00.000Z");
    const baseline = buildWorkspaceModelCatalog({
      settings,
      policy: null,
      codexSubscriptionActive: false,
      now,
    }).models.find((candidate) => candidate.id === settings.openaiModel)!;
    const definitionVersion = baseline.definitionVersion!;
    const identityMarkers = [
      "token-do-not-reflect",
      "client-id-do-not-reflect",
      "tenant-id-do-not-reflect",
      "account-id-do-not-reflect",
      "credential-row-do-not-reflect",
      "federation-subject-do-not-reflect",
      "assertion-do-not-reflect",
      "provider-error-do-not-reflect",
    ];
    const unsafeErrorObservation = {
      status: "error",
      reason: "resolver_error",
      checkedAt: now.toISOString(),
      token: identityMarkers[0],
      clientId: identityMarkers[1],
      tenantId: identityMarkers[2],
      accountId: identityMarkers[3],
      credentialId: identityMarkers[4],
      federationSubject: identityMarkers[5],
      assertion: identityMarkers[6],
      providerError: { message: identityMarkers[7] },
    } as const;
    const resolverError = buildWorkspaceModelCatalog({
      settings,
      policy: null,
      codexSubscriptionActive: false,
      now,
      credentialReadinessObservations: {
        [definitionVersion]: unsafeErrorObservation,
      },
    }).models.find((candidate) => candidate.id === settings.openaiModel)!;
    expect(resolverError).toMatchObject({
      credentialReadiness: {
        status: "error",
        reason: "resolver_error",
        basis: "resolver",
        checkedAt: now.toISOString(),
      },
      availability: {
        status: "unavailable",
        selectable: false,
        reason: "credential_not_ready",
      },
    });

    const invalidTimestamp = buildWorkspaceModelCatalog({
      settings,
      policy: null,
      codexSubscriptionActive: false,
      now,
      credentialReadinessObservations: {
        [definitionVersion]: {
          status: "ready",
          checkedAt: "not-a-timestamp",
        },
      },
    }).models.find((candidate) => candidate.id === settings.openaiModel)!;
    expect(invalidTimestamp).toMatchObject({
      credentialReadiness: {
        status: "error",
        reason: "resolver_error",
        basis: "resolver",
        checkedAt: null,
      },
      availability: {
        status: "unavailable",
        selectable: false,
        reason: "credential_not_ready",
        checkedAt: null,
      },
    });

    const staleAt = new Date(now.getTime() - 10 * 60_000).toISOString();
    const stale = buildWorkspaceModelCatalog({
      settings,
      policy: null,
      codexSubscriptionActive: false,
      now,
      credentialReadinessObservations: {
        [definitionVersion]: { status: "ready", checkedAt: staleAt },
      },
    }).models.find((candidate) => candidate.id === settings.openaiModel)!;
    expect(stale).toMatchObject({
      credentialReadiness: {
        status: "not_ready",
        reason: "observation_stale",
        basis: "resolver",
        checkedAt: staleAt,
      },
      availability: {
        status: "unavailable",
        selectable: false,
        reason: "credential_not_ready",
        checkedAt: staleAt,
      },
    });

    const serialized = JSON.stringify({ resolverError, invalidTimestamp, stale });
    expect(serialized).not.toContain("ad-token-do-not-reflect");
    for (const marker of identityMarkers) expect(serialized).not.toContain(marker);
  });

  test("an invalid catalog clock safely falls back when evaluating resolver freshness", () => {
    const settings = testSettings({
      codexSubscriptionEnabled: false,
      openaiProvider: "azure",
      azureOpenaiBaseUrl: "https://example.openai.azure.com/openai/v1",
      azureOpenaiApiKey: undefined,
      azureOpenaiAdToken: "ad-token-do-not-reflect",
    });
    const baseline = buildWorkspaceModelCatalog({
      settings,
      policy: null,
      codexSubscriptionActive: false,
    }).models.find((candidate) => candidate.id === settings.openaiModel)!;
    const checkedAt = new Date().toISOString();
    const projected = buildWorkspaceModelCatalog({
      settings,
      policy: null,
      codexSubscriptionActive: false,
      now: new Date(Number.NaN),
      credentialReadinessObservations: {
        [baseline.definitionVersion!]: { status: "ready", checkedAt },
      },
    }).models.find((candidate) => candidate.id === settings.openaiModel)!;
    expect(projected.credentialReadiness).toEqual({
      status: "ready",
      reason: null,
      basis: "resolver",
      checkedAt,
    });
  });

  test("credential, policy, and provider-health blockers have deterministic precedence", () => {
    const settings = testSettings({ codexSubscriptionEnabled: false });
    const baseline = buildWorkspaceModelCatalog({
      settings,
      policy: null,
      codexSubscriptionActive: false,
    }).models.find((candidate) => candidate.id === settings.openaiModel)!;
    const checkedAt = "2026-07-25T12:00:00.000Z";
    const unhealthy = {
      [baseline.definitionVersion!]: {
        status: "unavailable" as const,
        reason: "provider_unhealthy" as const,
        checkedAt,
      },
    };
    const credentialBlocked = buildWorkspaceModelCatalog({
      settings: { ...settings, openaiApiKey: undefined },
      policy: { allowedProviders: [], allowedModels: null },
      codexSubscriptionActive: false,
      observations: unhealthy,
    }).models.find((candidate) => candidate.id === settings.openaiModel)!;
    expect(credentialBlocked.availability).toEqual({
      status: "unavailable",
      selectable: false,
      reason: "missing_credential",
      checkedAt: null,
    });

    const policyBlocked = buildWorkspaceModelCatalog({
      settings,
      policy: { allowedProviders: [], allowedModels: null },
      codexSubscriptionActive: false,
      observations: unhealthy,
    }).models.find((candidate) => candidate.id === settings.openaiModel)!;
    expect(policyBlocked.availability).toEqual({
      status: "unavailable",
      selectable: false,
      reason: "policy_blocked",
      checkedAt: null,
    });

    const providerUnhealthy = buildWorkspaceModelCatalog({
      settings,
      policy: null,
      codexSubscriptionActive: false,
      observations: unhealthy,
    }).models.find((candidate) => candidate.id === settings.openaiModel)!;
    expect(providerUnhealthy.availability).toEqual({
      status: "unavailable",
      selectable: false,
      reason: "provider_unhealthy",
      checkedAt,
    });
  });

  test("a configured definition without runnable text/SSE execution fails closed as unsupported", () => {
    const capabilities = {
      reasoning: {
        upstream: "unknown",
        runnable: false,
        efforts: [],
        defaultEffort: null,
        required: false,
      },
      functionCalling: { upstream: "unknown", runnable: false },
      structuredOutput: { upstream: "unknown", runnable: false },
      hostedTools: {
        webSearch: { upstream: "unknown", runnable: false },
        xSearch: { upstream: "unknown", runnable: false },
        codeExecution: { upstream: "unknown", runnable: false },
      },
      inputModalities: ["text"],
      outputModalities: ["text"],
      transports: {
        sse: { upstream: "supported", runnable: false },
        responsesWebSocket: { upstream: "unknown", runnable: false },
        realtimeAudio: { upstream: "unsupported", runnable: false },
      },
      latencyModes: [{ id: "standard", upstream: "supported", runnable: true }],
    };
    const settings = testSettings({
      codexSubscriptionEnabled: false,
      modelProvidersJson: JSON.stringify([
        {
          id: "acme",
          api: "responses",
          baseUrl: "https://api.acme.test/v1",
          apiKey: "secret-never-project",
          models: [{ id: "acme/not-runnable", capabilities }],
        },
      ]),
    });
    const model = buildWorkspaceModelCatalog({
      settings,
      policy: null,
      codexSubscriptionActive: false,
    }).models.find((candidate) => candidate.id === "acme/not-runnable")!;
    expect(model.availability).toMatchObject({
      status: "unavailable",
      selectable: false,
      reason: "unsupported",
    });
    expect(JSON.stringify(model)).not.toContain("secret-never-project");
  });
});

describe("workspace model catalog route discipline", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(resolve(here, "..", "src", "routes", "workspaces.ts"), "utf8");

  test("requires workspace:read before policy or connection reads", () => {
    const start = source.indexOf('app.get("/v1/workspaces/:workspaceId/model-catalog"');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = source.indexOf("app.get", start + 10);
    const handler = source.slice(start, end);
    const grant = handler.indexOf("requireAccessGrant");
    expect(grant).toBeGreaterThanOrEqual(0);
    expect(handler).toContain('"workspace:read"');
    expect(handler.indexOf("getWorkspaceModelPolicy")).toBeGreaterThan(grant);
    expect(handler.indexOf("workspaceCodexSubscriptionActive")).toBeGreaterThan(grant);
    expect(handler).toContain('"private, no-store"');
  });
});
