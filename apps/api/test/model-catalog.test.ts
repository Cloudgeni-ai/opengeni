import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { testSettings } from "@opengeni/testing";
import { buildWorkspaceModelCatalog } from "../src/model-catalog";

describe("workspace model catalog availability", () => {
  test("unknown health is selectable only after credential and policy gates pass", () => {
    const settings = testSettings({ codexSubscriptionEnabled: false });
    const allowed = buildWorkspaceModelCatalog({
      settings,
      policy: null,
      codexSubscriptionActive: false,
    });
    const model = allowed.models.find((candidate) => candidate.id === settings.openaiModel)!;
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
      provider: "codex-subscription",
      credentialSource: { kind: "connected_subscription", provider: "codex" },
      billing: { upstreamPayer: "connected_subscription", metering: "external" },
      availability: {
        status: "unavailable",
        selectable: false,
        reason: "missing_credential",
      },
    });

    const connected = buildWorkspaceModelCatalog({
      settings,
      policy: null,
      codexSubscriptionActive: true,
    }).models.find((model) => model.id === codexDisconnected.id)!;
    expect(connected.availability).toEqual({
      status: "unknown",
      selectable: true,
      reason: null,
      checkedAt: null,
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
