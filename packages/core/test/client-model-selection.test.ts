import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import { isWorkspaceModelAdmissible, resolveWorkspaceModelSelection } from "../src/model-catalog";
import { admissibleWorkspaceModel } from "../src/default-session-model";

describe("fresh caller model selection", () => {
  test("rejects disconnected and invented Codex ids instead of accepting their prefix", () => {
    const selections = resolveWorkspaceModelSelection({
      settings: testSettings({ codexSubscriptionEnabled: true }),
      policy: null,
      codexSubscriptionActive: false,
    });
    expect(admissibleWorkspaceModel(selections, "codex/gpt-6-sol")).toBeUndefined();
    expect(admissibleWorkspaceModel(selections, "codex/not-a-model")).toBeUndefined();
    expect(admissibleWorkspaceModel(selections, "gpt-5.6-sol")?.model.id).toBe("gpt-5.6-sol");
  });

  test("ready subscriptions still obey exact connection and workspace policy permissions", () => {
    const input = {
      settings: testSettings({ codexSubscriptionEnabled: true }),
      policy: null,
      codexSubscriptionActive: true,
      connectionModelRestrictions: { "codex/": ["codex/gpt-6-sol"] },
    };
    const selections = resolveWorkspaceModelSelection(input);
    expect(admissibleWorkspaceModel(selections, "codex/gpt-6-sol")?.model.id).toBe(
      "codex/gpt-6-sol",
    );
    expect(admissibleWorkspaceModel(selections, "codex/gpt-6-astra")).toBeUndefined();
    expect(
      admissibleWorkspaceModel(
        resolveWorkspaceModelSelection({
          ...input,
          policy: { allowedProviders: ["openai"], allowedModels: null },
        }),
        "codex/gpt-6-sol",
      ),
    ).toBeUndefined();
  });

  test("aliases resolve to the same selectable canonical definition", () => {
    const selections = resolveWorkspaceModelSelection({
      settings: testSettings({
        modelProvidersJson: JSON.stringify([
          {
            id: "fixture",
            kind: "anonymous",
            baseUrl: "https://fixture.example/v1",
            models: [{ id: "fixture/model", aliases: ["fixture-alias"] }],
          },
        ]),
      }),
      policy: null,
      codexSubscriptionActive: false,
    });
    expect(admissibleWorkspaceModel(selections, "fixture-alias")?.model.id).toBe("fixture/model");
  });

  test("unknown, degraded and unavailable provider health never reject stable admission", () => {
    const input = {
      settings: testSettings(),
      policy: null,
      codexSubscriptionActive: false,
    };
    const baseline = resolveWorkspaceModelSelection(input)[0]!;
    const checkedAt = "2026-09-30T12:00:00.000Z";
    for (const observation of [
      undefined,
      { status: "available", reason: null, checkedAt },
      { status: "degraded", reason: null, checkedAt },
      { status: "unavailable", reason: "provider_unhealthy", checkedAt },
      { status: "unavailable", reason: "not_entitled", checkedAt },
    ] as const) {
      const selections = resolveWorkspaceModelSelection({
        ...input,
        observations: observation ? { [baseline.model.definitionVersion]: observation } : {},
      });
      const selection = admissibleWorkspaceModel(selections, baseline.model.id)!;
      expect(selection).toBeDefined();
      expect(selection.availability.status).toBe(observation?.status ?? "unknown");
      expect(selection.availability.reason).toBe(observation?.reason ?? null);
    }
  });

  test("missing, stale, failed and reauth deployment resolver observations never reject admission", () => {
    const input = {
      settings: testSettings({
        openaiProvider: "azure",
        azureOpenaiBaseUrl: "https://fixture.openai.azure.com/openai/v1",
        azureOpenaiApiKey: undefined,
        azureOpenaiAdToken: undefined,
      }),
      policy: null,
      codexSubscriptionActive: false,
      now: new Date("2026-09-30T12:00:00.000Z"),
    };
    const baseline = resolveWorkspaceModelSelection(input)[0]!;
    for (const observation of [
      undefined,
      { status: "ready", checkedAt: "2026-09-29T12:00:00.000Z" },
      { status: "error", checkedAt: "2026-09-30T12:00:00.000Z" },
      { status: "not_ready", reason: "needs_reauth", checkedAt: "2026-09-30T12:00:00.000Z" },
    ] as const) {
      const selection = admissibleWorkspaceModel(
        resolveWorkspaceModelSelection({
          ...input,
          credentialReadinessObservations: observation
            ? { [baseline.model.definitionVersion]: observation }
            : {},
        }),
        baseline.model.id,
      )!;
      expect(selection).toBeDefined();
      expect(selection.credentialReadiness.basis).toBe("resolver");
      expect(selection.availability.selectable).toBe(false);
      expect(selection.availability.reason).toBe(
        observation?.status === "not_ready" ? "needs_reauth" : "credential_not_ready",
      );
    }
  });

  test("xAI freshness is only an availability hint, not a model admission blocker", () => {
    const settings = testSettings({
      modelProvidersJson: JSON.stringify([
        {
          id: "xai",
          apiKey: "fixture-key",
          baseUrl: "https://api.x.ai/v1",
          models: [{ id: "xai/grok-4.5" }],
        },
      ]),
    });
    const input = {
      settings,
      policy: null,
      codexSubscriptionActive: false,
      now: new Date("2026-09-30T12:00:00.000Z"),
    };
    const baseline = resolveWorkspaceModelSelection(input).find(
      (selection) => selection.model.id === "xai/grok-4.5",
    )!;
    for (const observation of [
      undefined,
      { status: "available", reason: null, checkedAt: "2026-09-29T12:00:00.000Z" },
      {
        status: "unavailable",
        reason: "provider_unhealthy",
        checkedAt: "2026-09-30T12:00:00.000Z",
      },
    ] as const) {
      const selection = admissibleWorkspaceModel(
        resolveWorkspaceModelSelection({
          ...input,
          observations: observation ? { [baseline.model.definitionVersion]: observation } : {},
        }),
        baseline.model.id,
      )!;
      expect(selection).toBeDefined();
      expect(selection.availability).toMatchObject({
        status: "unavailable",
        selectable: false,
        reason: "provider_unhealthy",
      });
    }
  });

  test("unsupported definition, missing deployment API key and connection reauth remain stable blockers", () => {
    const baseline = resolveWorkspaceModelSelection({
      settings: testSettings(),
      policy: null,
      codexSubscriptionActive: false,
    })[0]!;
    expect(
      isWorkspaceModelAdmissible({
        ...baseline,
        model: {
          ...baseline.model,
          capabilities: {
            ...baseline.model.capabilities,
            transports: {
              ...baseline.model.capabilities.transports,
              sse: { ...baseline.model.capabilities.transports.sse, runnable: false },
            },
          },
        },
      }),
    ).toBe(false);
    const missingKey = resolveWorkspaceModelSelection({
      settings: testSettings({ openaiApiKey: undefined }),
      policy: null,
      codexSubscriptionActive: false,
    });
    expect(missingKey.every((selection) => !isWorkspaceModelAdmissible(selection))).toBe(true);
    for (const source of [
      { kind: "connected_subscription", provider: "codex" },
      { kind: "workspace_connection", mechanism: "api_key" },
      { kind: "organization_connection", mechanism: "api_key" },
    ] as const) {
      expect(
        isWorkspaceModelAdmissible({
          ...baseline,
          model: { ...baseline.model, credentialSource: source },
          credentialReadiness: {
            status: "not_ready",
            reason: "needs_reauth",
            basis: "connection",
            checkedAt: null,
          },
        }),
      ).toBe(false);
    }
  });
});
