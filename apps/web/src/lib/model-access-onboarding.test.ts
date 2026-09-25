import { describe, expect, mock, test } from "bun:test";
import { OpenGeniApiError } from "@opengeni/sdk/browser";
import type { WorkspaceModelCatalogModel } from "@opengeni/sdk";

import { projectPickerRows, sortPickerRows } from "@opengeni/react";
import {
  applyConnectedModelToNewSessionDraft,
  composerFallbackModel,
  confirmIncludedModel,
  creditCheckoutSuccessUrl,
  creditsCheckoutModel,
  creditsModelForCheckout,
  includedDefaultModel,
  preferredConnectedModelId,
} from "./model-access-onboarding";
import { isPaymentRequiredError } from "./model-access";

function catalogModel(
  overrides: Partial<WorkspaceModelCatalogModel> & Pick<WorkspaceModelCatalogModel, "id">,
): WorkspaceModelCatalogModel {
  return {
    label: overrides.id,
    provider: "openai",
    providerLabel: "OpenAI",
    api: "responses",
    source: "opengeni",
    cost: "credits",
    credentialReadiness: {
      status: "ready",
      reason: null,
      basis: "configuration",
      checkedAt: null,
    },
    policyAllowed: true,
    availability: {
      status: "available",
      selectable: true,
      reason: null,
      checkedAt: null,
    },
    capabilities: {
      reasoning: {
        upstream: "supported",
        runnable: true,
        efforts: ["low", "medium", "high"],
        defaultEffort: "low",
        required: false,
      },
      functionCalling: { upstream: "supported", runnable: true },
      structuredOutput: { upstream: "supported", runnable: true },
      hostedTools: {
        webSearch: { upstream: "unsupported", runnable: false },
        xSearch: { upstream: "unsupported", runnable: false },
        codeExecution: { upstream: "unsupported", runnable: false },
      },
      inputModalities: ["text"],
      outputModalities: ["text"],
      transports: {
        sse: { upstream: "supported", runnable: true },
        responsesWebSocket: { upstream: "unsupported", runnable: false },
        realtimeAudio: { upstream: "unsupported", runnable: false },
      },
      latencyModes: [{ id: "standard", upstream: "supported", runnable: true }],
    },
    billing: { upstreamPayer: "deployment", metering: "opengeni_credits" },
    ...overrides,
  } as WorkspaceModelCatalogModel;
}

describe("preferredConnectedModelId", () => {
  test("still offers explicitly free deployment models without credit onboarding", () => {
    expect(
      preferredConnectedModelId([
        catalogModel({ id: "paid" }),
        catalogModel({
          id: "free",
          cost: "free",
          billing: { upstreamPayer: "deployment", metering: "external" },
        }),
      ]),
    ).toBe("free");
  });
  test("prefers a selectable connected subscription over OpenGeni credits", () => {
    expect(
      preferredConnectedModelId([
        catalogModel({
          id: "gpt-5.6-sol",
          billing: { upstreamPayer: "deployment", metering: "opengeni_credits" },
        }),
        catalogModel({
          id: "codex/gpt-5.6-sol",
          provider: "codex-subscription",
          providerLabel: "Codex",
          source: "codex",
          cost: "subscription",
          billing: { upstreamPayer: "connected_subscription", metering: "external" },
        }),
      ]),
    ).toBe("codex/gpt-5.6-sol");
  });

  test("ignores a connected model that is not selectable yet", () => {
    expect(
      preferredConnectedModelId([
        catalogModel({
          id: "codex/gpt-5.6-sol",
          provider: "codex-subscription",
          providerLabel: "Codex",
          source: "codex",
          cost: "subscription",
          availability: {
            status: "unavailable",
            selectable: false,
            reason: "missing_credential",
            checkedAt: null,
          },
          credentialReadiness: {
            status: "not_ready",
            reason: "missing_credential",
            basis: "connection",
            checkedAt: null,
          },
          billing: { upstreamPayer: "connected_subscription", metering: "external" },
        }),
      ]),
    ).toBeNull();
  });
});

const FREE_DEFAULT = catalogModel({
  id: "free-default",
  cost: "free",
  billing: { upstreamPayer: "deployment", metering: "external" },
});
const CREDITS_FIRST = catalogModel({ id: "credits-first", label: "Zeta credits" });
const CREDITS_SECOND = catalogModel({ id: "credits-second", label: "Alpha credits" });
const CODEX = catalogModel({
  id: "codex/model",
  provider: "codex-subscription",
  providerLabel: "Codex",
  source: "codex",
  cost: "subscription",
  billing: { upstreamPayer: "connected_subscription", metering: "external" },
});
const SUPERGROK = catalogModel({
  id: "supergrok/model",
  provider: "supergrok",
  providerLabel: "SuperGrok",
  source: "supergrok",
  cost: "subscription",
  billing: { upstreamPayer: "connected_subscription", metering: "external" },
});
const GATEWAY = catalogModel({
  id: "gateway/model",
  provider: "workspace-gateway",
  providerLabel: "Your Gateway",
  source: "workspace_gateway",
  cost: "workspace",
  billing: { upstreamPayer: "workspace", metering: "external" },
});
const ORGANIZATION_GATEWAY = catalogModel({
  id: "organization-gateway/model",
  provider: "organization-gateway",
  providerLabel: "Organization Gateway",
  source: "workspace_gateway",
  cost: "organization",
  billing: { upstreamPayer: "organization", metering: "external" },
});
const OPENROUTER = catalogModel({
  id: "openrouter-byok/model",
  provider: "workspace-openrouter",
  providerLabel: "Your OpenRouter",
  source: undefined,
  cost: "workspace",
  billing: { upstreamPayer: "workspace", metering: "external" },
});

describe("preferredConnectedModelId after a specific connect", () => {
  const catalog = [
    FREE_DEFAULT,
    CREDITS_FIRST,
    CREDITS_SECOND,
    CODEX,
    SUPERGROK,
    GATEWAY,
    OPENROUTER,
  ];

  test("the generic order puts any connected service ahead of the free default", () => {
    expect(preferredConnectedModelId([FREE_DEFAULT, CODEX])).toBe("codex/model");
    expect(preferredConnectedModelId([FREE_DEFAULT, GATEWAY])).toBe("gateway/model");
    expect(preferredConnectedModelId([FREE_DEFAULT, CREDITS_FIRST])).toBe("free-default");
  });

  test("the generic order never moves someone onto organization spend ahead of the free model", () => {
    expect(preferredConnectedModelId([ORGANIZATION_GATEWAY, FREE_DEFAULT])).toBe("free-default");
    expect(preferredConnectedModelId([ORGANIZATION_GATEWAY, CREDITS_FIRST])).toBe(
      "organization-gateway/model",
    );
    expect(preferredConnectedModelId([ORGANIZATION_GATEWAY, SUPERGROK, FREE_DEFAULT])).toBe(
      "supergrok/model",
    );
  });

  test("selects the family the person just connected, never the free default", () => {
    expect(preferredConnectedModelId(catalog, "codex")).toBe("codex/model");
    expect(preferredConnectedModelId(catalog, "supergrok")).toBe("supergrok/model");
    expect(preferredConnectedModelId(catalog, "vercel_gateway")).toBe("gateway/model");
    expect(preferredConnectedModelId(catalog, "openrouter")).toBe("openrouter-byok/model");
  });

  test("a credit purchase prefers the first operator-ordered credits model", () => {
    expect(preferredConnectedModelId(catalog, "credits")).toBe("credits-first");
    expect(preferredConnectedModelId([FREE_DEFAULT], "credits")).toBeNull();
  });

  test("a family that is not selectable yet returns null instead of another model", () => {
    expect(preferredConnectedModelId([FREE_DEFAULT, CREDITS_FIRST], "codex")).toBeNull();
    expect(
      preferredConnectedModelId(
        [
          FREE_DEFAULT,
          {
            ...GATEWAY,
            availability: {
              status: "unavailable",
              selectable: false,
              reason: "missing_credential",
              checkedAt: null,
            },
          } as WorkspaceModelCatalogModel,
        ],
        "vercel_gateway",
      ),
    ).toBeNull();
  });
});

describe("includedDefaultModel", () => {
  test("offers the free deployment default without hardcoding a model", () => {
    expect(
      includedDefaultModel({
        defaultModel: "free-default",
        models: [CREDITS_FIRST, FREE_DEFAULT],
        billingMode: "stripe",
      }),
    ).toEqual({ id: "free-default", label: "free-default", free: true });
  });

  test("treats a deployment-paid default as included when credits are not billed", () => {
    expect(
      includedDefaultModel({
        defaultModel: "credits-first",
        models: [CREDITS_FIRST],
        billingMode: "disabled",
      }),
    ).toEqual({ id: "credits-first", label: "Zeta credits", free: false });
  });

  test("offers nothing when the default needs credits or a connection", () => {
    expect(
      includedDefaultModel({
        defaultModel: "credits-first",
        models: [CREDITS_FIRST],
        billingMode: "stripe",
      }),
    ).toBeNull();
    expect(
      includedDefaultModel({
        defaultModel: "codex/model",
        models: [CODEX],
        billingMode: "disabled",
      }),
    ).toBeNull();
    expect(
      includedDefaultModel({
        defaultModel: "missing",
        models: [FREE_DEFAULT],
        billingMode: "stripe",
      }),
    ).toBeNull();
  });
});

describe("confirmIncludedModel", () => {
  const candidate = { id: "free-default", label: "Free Default", free: true };

  test("keeps the included path when the new workspace can select that free model", () => {
    expect(confirmIncludedModel(candidate, [CODEX, FREE_DEFAULT])).toEqual(candidate);
    const deploymentPaid = { id: "credits-first", label: "Zeta credits", free: false };
    expect(confirmIncludedModel(deploymentPaid, [CREDITS_FIRST])).toEqual(deploymentPaid);
  });

  test("drops the included path when the workspace catalog cannot back the claim", () => {
    expect(confirmIncludedModel(candidate, [CODEX])).toBeNull();
    expect(
      confirmIncludedModel(candidate, [
        {
          ...FREE_DEFAULT,
          availability: {
            status: "unavailable",
            selectable: false,
            reason: "missing_credential",
            checkedAt: null,
          },
        } as WorkspaceModelCatalogModel,
      ]),
    ).toBeNull();
    expect(
      confirmIncludedModel(candidate, [
        { ...FREE_DEFAULT, cost: "credits" } as WorkspaceModelCatalogModel,
      ]),
    ).toBeNull();
  });
});

describe("credit checkout return", () => {
  test("returns to the new-chat composer with the purchased credits model selected", async () => {
    const model = await creditsModelForCheckout(
      {
        getWorkspaceModelCatalog: async () => ({ models: [FREE_DEFAULT, CREDITS_FIRST] }),
      } as never,
      "workspace-a",
    );
    expect(model).toEqual({ id: "credits-first", effort: "low" });
    expect(creditCheckoutSuccessUrl("https://app.example.test", "workspace-a", model)).toBe(
      "https://app.example.test/workspaces/workspace-a/sessions?model=credits-first&effort=low",
    );
  });

  test("a catalog failure still returns to the workspace without a model hint", async () => {
    const model = await creditsModelForCheckout(
      {
        getWorkspaceModelCatalog: async () => {
          throw new Error("catalog unavailable");
        },
      } as never,
      "workspace-a",
    );
    expect(model).toBeNull();
    expect(creditCheckoutSuccessUrl("https://app.example.test", "workspace-a", null)).toBe(
      "https://app.example.test/workspaces/workspace-a/sessions",
    );
  });
});

describe("resolved default in the composer and after a credit purchase", () => {
  const rows = (models: WorkspaceModelCatalogModel[]) => sortPickerRows(projectPickerRows(models));

  test("the composer fallback takes the server-resolved default first", () => {
    const models = [FREE_DEFAULT, CREDITS_FIRST, CREDITS_SECOND];
    expect(
      composerFallbackModel({
        models,
        rows: rows(models),
        defaultSelection: { model: "credits-second", reasoningEffort: "high", source: "credits" },
      }),
    ).toEqual({ id: "credits-second", effort: "high" });
  });

  test("an unavailable resolved default falls back to the connected ranking", () => {
    const models = [FREE_DEFAULT, CODEX];
    expect(
      composerFallbackModel({
        models,
        rows: rows(models),
        defaultSelection: { model: "credits-first", reasoningEffort: "xhigh", source: "credits" },
      }),
    ).toEqual({ id: "codex/model", effort: "low" });
    expect(composerFallbackModel({ models, rows: rows(models), defaultSelection: null })).toEqual({
      id: "codex/model",
      effort: "low",
    });
  });

  test("a credit purchase lands on the server's credits default", () => {
    expect(
      creditsCheckoutModel({
        models: [FREE_DEFAULT, CREDITS_FIRST, CREDITS_SECOND],
        creditsSelection: { model: "credits-second", reasoningEffort: "xhigh", source: "credits" },
      }),
    ).toEqual({ id: "credits-second", effort: "xhigh" });
  });

  test("a purchase keeps a connected subscription or saved default as the default", () => {
    expect(
      creditsCheckoutModel({
        models: [FREE_DEFAULT, CREDITS_FIRST, CODEX],
        creditsSelection: { model: "codex/model", reasoningEffort: "high", source: "subscription" },
      }),
    ).toBeNull();
    expect(creditsCheckoutModel({ models: [FREE_DEFAULT], creditsSelection: null })).toBeNull();
  });

  test("an older server without a resolved default uses the first credits model", () => {
    expect(creditsCheckoutModel({ models: [FREE_DEFAULT, CREDITS_FIRST] })).toEqual({
      id: "credits-first",
      effort: "low",
    });
  });
});

describe("applyConnectedModelToNewSessionDraft", () => {
  test("selects the connected model in the private draft while preserving existing content", async () => {
    const saveNewSessionDraft = mock(async () => undefined);
    const draft = {
      revision: 7,
      text: "Keep my unsent message",
      resources: [],
      tools: [],
      toolsProvided: false,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      latencyMode: "priority",
      options: {},
      selectedProjectChannelId: null,
    };
    const client = {
      getWorkspaceModelCatalog: async () => ({
        models: [
          catalogModel({
            id: "gpt-5.6-sol",
            billing: { upstreamPayer: "deployment", metering: "opengeni_credits" },
          }),
          catalogModel({
            id: "codex/gpt-5.6-sol",
            provider: "codex-subscription",
            providerLabel: "Codex",
            source: "codex",
            cost: "subscription",
            billing: { upstreamPayer: "connected_subscription", metering: "external" },
          }),
        ],
      }),
      getNewSessionDraft: async () => draft,
      saveNewSessionDraft,
    };
    await expect(
      applyConnectedModelToNewSessionDraft(client as never, "workspace-a"),
    ).resolves.toEqual({ id: "codex/gpt-5.6-sol", label: "codex/gpt-5.6-sol" });
    expect(saveNewSessionDraft).toHaveBeenCalledWith("workspace-a", {
      text: draft.text,
      resources: draft.resources,
      tools: draft.tools,
      toolsProvided: false,
      model: "codex/gpt-5.6-sol",
      reasoningEffort: "low",
      latencyMode: "priority",
      modelProvided: true,
      options: draft.options,
      selectedProjectChannelId: null,
      expectedRevision: 7,
    });
  });
});

describe("onboarding draft authority", () => {
  test("does not touch the draft when there is no selectable connected model", async () => {
    const getNewSessionDraft = mock(async () => {
      throw new Error("must not read draft");
    });
    const client = { getWorkspaceModelCatalog: async () => ({ models: [] }), getNewSessionDraft };
    expect(
      await applyConnectedModelToNewSessionDraft(client as never, "personal-workspace"),
    ).toBeNull();
    expect(getNewSessionDraft).not.toHaveBeenCalled();
  });

  test("surfaces a concurrent draft edit without retrying or writing workspace settings", async () => {
    const conflict = new Error("draft revision conflict");
    const saveNewSessionDraft = mock(async () => {
      throw conflict;
    });
    const updateWorkspaceSettings = mock(async () => undefined);
    const client = {
      getWorkspaceModelCatalog: async () => ({
        models: [
          catalogModel({
            id: "codex/gpt-5.6-sol",
            provider: "codex-subscription",
            source: "codex",
            cost: "subscription",
            billing: { upstreamPayer: "connected_subscription", metering: "external" },
          }),
        ],
      }),
      getNewSessionDraft: async () => ({
        revision: 2,
        text: "existing draft",
        resources: [],
        tools: [],
        toolsProvided: false,
        model: "gpt-5.6-sol",
        reasoningEffort: "low",
        latencyMode: "standard",
        options: {},
      }),
      saveNewSessionDraft,
      updateWorkspaceSettings,
    };
    await expect(
      applyConnectedModelToNewSessionDraft(client as never, "personal-workspace"),
    ).rejects.toBe(conflict);
    expect(saveNewSessionDraft).toHaveBeenCalledTimes(1);
    expect(updateWorkspaceSettings).not.toHaveBeenCalled();
  });
});

describe("isPaymentRequiredError", () => {
  test("matches the create-turn 402 payment_required contract", () => {
    expect(
      isPaymentRequiredError(
        new OpenGeniApiError(
          402,
          JSON.stringify({
            error: {
              status: 402,
              code: "payment_required",
              message: "insufficient OpenGeni credits",
              retryable: false,
            },
          }),
        ),
      ),
    ).toBe(true);
    expect(isPaymentRequiredError(new Error("insufficient OpenGeni credits"))).toBe(false);
  });
});
