import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_OPENROUTER_MODEL_ID,
  WORKSPACE_OPENROUTER_MODEL_ID_PREFIX,
} from "@opengeni/config";
import { testSettings } from "@opengeni/testing";
import { z } from "zod";
import { buildWorkspaceModelCatalog } from "../src/model-catalog";

const previousClientModelSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    provider: z.string(),
    providerLabel: z.string(),
    api: z.enum(["responses", "chat"]),
    source: z.enum(["opengeni", "codex", "supergrok", "workspace_gateway"]).optional(),
    credentialSource: z
      .union([
        z
          .object({
            kind: z.literal("deployment"),
            mechanism: z.enum(["api_key", "azure_ad_bearer"]),
          })
          .strict(),
        z
          .object({
            kind: z.literal("connected_subscription"),
            provider: z.enum(["codex", "xai"]),
          })
          .strict(),
        z
          .object({ kind: z.literal("workspace_connection"), mechanism: z.literal("api_key") })
          .strict(),
      ])
      .optional(),
  })
  .passthrough();

describe("workspace model catalog availability", () => {
  test("projects anonymous providers as ready external routes", () => {
    const settings = testSettings({
      codexSubscriptionEnabled: false,
      modelProvidersJson: JSON.stringify([
        {
          kind: "anonymous",
          id: "opencode-zen",
          label: "OpenCode Zen",
          api: "chat",
          baseUrl: "https://opencode.ai/zen/v1",
          models: [
            {
              id: "opencode/x-preview-f-free",
              upstreamModelId: "x-preview-f-free",
              label: "OpenCode Ox Alpha",
            },
          ],
        },
      ]),
    });
    const model = buildWorkspaceModelCatalog({
      settings,
      policy: null,
      codexSubscriptionActive: false,
    }).models.find((candidate) => candidate.id === "opencode/x-preview-f-free")!;

    expect(model).toMatchObject({
      provider: "opencode-zen",
      providerLabel: "OpenCode Zen",
      billing: { upstreamPayer: "deployment", metering: "external" },
      credentialReadiness: {
        status: "ready",
        reason: null,
        basis: "configuration",
        checkedAt: null,
      },
      availability: { status: "unknown", selectable: true, reason: null },
    });
    expect(model.source).toBeUndefined();
    expect(model.credentialSource).toBeUndefined();
    expect(() => previousClientModelSchema.parse(model)).not.toThrow();
  });

  test("SuperGrok definitions use a distinct public rail and workspace readiness", () => {
    const settings = testSettings({ supergrokSubscriptionEnabled: true });
    const unavailable = buildWorkspaceModelCatalog({
      settings,
      policy: null,
      codexSubscriptionActive: false,
      xaiSubscriptionActive: false,
    });
    const blocked = unavailable.models.find((model) => model.id === "supergrok/grok-4.6")!;
    expect(blocked).toMatchObject({
      provider: "supergrok",
      providerLabel: "SuperGrok",
      source: "supergrok",
      credentialReadiness: { status: "not_ready", reason: "needs_reauth" },
      availability: { status: "unavailable", selectable: false, reason: "needs_reauth" },
      policyAllowed: true,
    });

    const available = buildWorkspaceModelCatalog({
      settings,
      policy: null,
      codexSubscriptionActive: false,
      xaiSubscriptionActive: true,
    });
    expect(available.models.find((model) => model.id === "supergrok/grok-4.6")).toMatchObject({
      credentialReadiness: { status: "ready", basis: "connection" },
      availability: { status: "unknown", selectable: true },
    });
  });

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
    const gemini = disconnected.models.find((model) => model.id === "gemini-3.7-flash")!;
    const glm = disconnected.models.find((model) => model.id === "glm-5.3")!;
    expect(gemini).toMatchObject({
      label: "Gemini 3.7 Flash",
      shortLabel: "3.7 Flash",
      source: "opengeni",
      executionLimits: { contextWindowTokens: 1_000_000 },
      capabilities: {
        reasoning: { efforts: ["low", "medium", "high", "xhigh"] },
      },
    });
    expect(glm).toMatchObject({
      label: "GLM 5.3",
      shortLabel: "GLM 5.3",
      source: "opengeni",
      executionLimits: {
        contextWindowTokens: 1_000_000,
        effectiveContextWindowTokens: 900_000,
        autoCompactTokenLimit: 850_000,
      },
      capabilities: {
        reasoning: { efforts: ["low", "medium", "high", "xhigh"] },
      },
    });
    expect(gemini.capabilities.reasoning.efforts).not.toContain("max");
    expect(glm.capabilities.reasoning.efforts).not.toContain("max");
    const publicManagedModel = JSON.stringify(managed);
    const publicNewModels = JSON.stringify([gemini, glm]);
    for (const internalName of [
      "baseten",
      "novita",
      "deepinfra",
      "fireworks",
      "google",
      "vertex",
      "zai",
      "ai-gateway.vercel.sh",
    ]) {
      expect(publicManagedModel).not.toContain(internalName);
      expect(publicNewModels).not.toContain(internalName);
    }

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

  test("gates stored workspace Gateway custom models on the same connection readiness", () => {
    const input = {
      settings: testSettings({ codexSubscriptionEnabled: false }),
      policy: null,
      codexSubscriptionActive: false,
      workspaceGatewayCustomModels: [
        { upstreamModelId: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6" },
      ],
    } as const;
    const disconnected = buildWorkspaceModelCatalog({
      ...input,
      workspaceGatewayConnectionActive: false,
    }).models.find((model) => model.id === "workspace-gateway/anthropic/claude-sonnet-4.6")!;
    expect(disconnected).toMatchObject({
      label: "Claude Sonnet 4.6",
      cost: "workspace",
      credentialReadiness: { status: "not_ready", reason: "needs_reauth" },
      availability: { status: "unavailable", selectable: false, reason: "needs_reauth" },
    });

    const connected = buildWorkspaceModelCatalog({
      ...input,
      workspaceGatewayConnectionActive: true,
    }).models.find((model) => model.id === "workspace-gateway/anthropic/claude-sonnet-4.6")!;
    expect(connected).toMatchObject({
      credentialReadiness: { status: "ready" },
      availability: { status: "unknown", selectable: true, reason: null },
    });
  });

  test("makes managed OpenRouter selectable from deployment configuration alone", () => {
    const model = buildWorkspaceModelCatalog({
      settings: testSettings({ openrouterApiKey: "openrouter-workspace-secret" }),
      policy: null,
      codexSubscriptionActive: false,
      workspaceGatewayConnectionActive: false,
    }).models.find((candidate) => candidate.id === DEFAULT_OPENROUTER_MODEL_ID)!;
    expect(model).toMatchObject({
      provider: "openrouter",
      cost: "free",
      credentialReadiness: { status: "ready", basis: "configuration" },
      availability: { status: "unknown", selectable: true, reason: null },
    });
    expect(model).not.toHaveProperty("source");
    expect(JSON.stringify(model)).not.toContain("openrouter-workspace-secret");
  });

  test("projects the workspace OpenRouter rail without a deployment key and gates it independently", () => {
    const settings = testSettings({
      codexSubscriptionEnabled: false,
      openrouterApiKey: undefined,
    });
    const curatedWorkspaceId = `${WORKSPACE_OPENROUTER_MODEL_ID_PREFIX}${DEFAULT_OPENROUTER_MODEL_ID.slice("openrouter/".length)}`;
    const disconnected = buildWorkspaceModelCatalog({
      settings,
      policy: null,
      codexSubscriptionActive: false,
      workspaceGatewayConnectionActive: true,
      workspaceOpenRouterConnectionActive: false,
      workspaceOpenRouterCustomModels: [
        { upstreamModelId: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6" },
      ],
    });
    expect(disconnected.models.some((model) => model.id === DEFAULT_OPENROUTER_MODEL_ID)).toBe(
      false,
    );
    expect(disconnected.models.find((model) => model.id === curatedWorkspaceId)).toMatchObject({
      provider: "workspace-openrouter",
      providerLabel: "Your OpenRouter",
      cost: "workspace",
      billing: { upstreamPayer: "workspace", metering: "external" },
      credentialReadiness: { status: "not_ready", reason: "needs_reauth" },
      availability: { status: "unavailable", selectable: false, reason: "needs_reauth" },
    });
    expect(
      disconnected.models.find(
        (model) =>
          model.id === `${WORKSPACE_OPENROUTER_MODEL_ID_PREFIX}anthropic/claude-sonnet-4.6`,
      ),
    ).toMatchObject({ label: "Claude Sonnet 4.6", cost: "workspace" });

    const connected = buildWorkspaceModelCatalog({
      settings,
      policy: null,
      codexSubscriptionActive: false,
      workspaceGatewayConnectionActive: false,
      workspaceOpenRouterConnectionActive: true,
    });
    expect(connected.models.find((model) => model.id === curatedWorkspaceId)).toMatchObject({
      credentialReadiness: { status: "ready", basis: "connection" },
      availability: { status: "unknown", selectable: true, reason: null },
    });
    expect(
      connected.models.find((model) => model.id === "workspace-gateway/deepseek-v4-flash-0731"),
    ).toMatchObject({ credentialReadiness: { status: "not_ready" } });
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
    expect(blocked.policyAllowed).toBe(false);

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
    expect(handler.indexOf("workspaceXaiSubscriptionActive")).toBeGreaterThan(grant);
    expect(handler).toContain("xaiSubscriptionActive,");
    expect(handler).toContain('"private, no-store"');
  });
});
