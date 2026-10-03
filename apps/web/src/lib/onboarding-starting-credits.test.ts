import { describe, expect, mock, test } from "bun:test";
import { OpenGeniApiError } from "@opengeni/sdk/browser";
import type { WorkspaceModelCatalogModel } from "@opengeni/sdk";

import {
  creditsBilledDefaultModel,
  loadModelAccessOnboarding,
  startingCreditsForOnboarding,
} from "./onboarding-starting-credits";

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

const FREE_DEFAULT = catalogModel({
  id: "free-default",
  cost: "free",
  billing: { upstreamPayer: "deployment", metering: "external" },
});
const CREDITS_FIRST = catalogModel({ id: "credits-first", label: "Zeta credits" });
const CODEX = catalogModel({
  id: "codex/model",
  provider: "codex-subscription",
  providerLabel: "Codex",
  source: "codex",
  cost: "subscription",
  billing: { upstreamPayer: "connected_subscription", metering: "external" },
});

describe("starting credits in the post-signup model step", () => {
  const trialBilling = {
    mode: "stripe" as const,
    balance: {
      accountId: "organization-a",
      balanceMicros: 10_000_000,
      currency: "usd" as const,
      updatedAt: "2026-09-25T00:00:00.000Z",
    },
  };
  const creditsDefault = {
    models: [FREE_DEFAULT, CREDITS_FIRST],
    defaultSelection: {
      model: "credits-first",
      reasoningEffort: "high" as const,
      source: "credits" as const,
    },
  };

  test("the trial balance and the resolved credits default lead the step", () => {
    expect(
      startingCreditsForOnboarding({ catalog: creditsDefault, billing: trialBilling }),
    ).toEqual({
      balance: { balanceMicros: 10_000_000, currency: "usd" },
      model: { id: "credits-first", label: "Zeta credits", reasoningEffort: "high" },
    });
  });

  test("an already credits-billed deployment default counts while the balance is positive", () => {
    const catalog = {
      ...creditsDefault,
      defaultSelection: { ...creditsDefault.defaultSelection, source: "deployment" as const },
    };
    expect(startingCreditsForOnboarding({ catalog, billing: trialBilling })?.model.id).toBe(
      "credits-first",
    );
    // Without a readable balance the deployment source proves nothing.
    expect(startingCreditsForOnboarding({ catalog, billing: null })).toBeNull();
  });

  test("a zero or negative balance keeps the free-model step", () => {
    for (const balanceMicros of [0, -2_000_000]) {
      expect(
        startingCreditsForOnboarding({
          catalog: creditsDefault,
          billing: { ...trialBilling, balance: { ...trialBilling.balance, balanceMicros } },
        }),
      ).toBeNull();
    }
    expect(
      startingCreditsForOnboarding({
        catalog: creditsDefault,
        billing: { ...trialBilling, mode: "disabled" },
      }),
    ).toBeNull();
  });

  test("an unreadable balance still follows a credits-sourced resolved default", () => {
    expect(startingCreditsForOnboarding({ catalog: creditsDefault, billing: null })).toEqual({
      balance: null,
      model: { id: "credits-first", label: "Zeta credits", reasoningEffort: "high" },
    });
  });

  test("only a selectable credits-billed resolved default qualifies", () => {
    expect(creditsBilledDefaultModel({ models: [FREE_DEFAULT, CREDITS_FIRST] })).toBeNull();
    expect(
      creditsBilledDefaultModel({
        models: [FREE_DEFAULT, CREDITS_FIRST],
        defaultSelection: { model: "free-default", reasoningEffort: "low", source: "deployment" },
      }),
    ).toBeNull();
    expect(
      creditsBilledDefaultModel({
        models: [CODEX, CREDITS_FIRST],
        defaultSelection: { model: "codex/model", reasoningEffort: "low", source: "subscription" },
      }),
    ).toBeNull();
    expect(
      creditsBilledDefaultModel({
        models: [
          {
            ...CREDITS_FIRST,
            availability: {
              status: "unavailable",
              selectable: false,
              reason: "missing_credential",
              checkedAt: null,
            },
          } as WorkspaceModelCatalogModel,
        ],
        defaultSelection: creditsDefault.defaultSelection,
      }),
    ).toBeNull();
  });

  test("loading reads the balance only when the resolved default is billed in credits", async () => {
    const getBilling = mock(async (_options: { accountId?: string }) => trialBilling);
    const input = {
      organizationId: "organization-a",
      workspaceId: "personal-workspace",
      billingMode: "stripe" as const,
      includedCandidate: { id: "free-default", label: "Free Default", free: true },
    };
    const free = await loadModelAccessOnboarding(
      {
        getWorkspaceModelCatalog: async () => ({
          models: [FREE_DEFAULT, CREDITS_FIRST],
          defaultSelection: { model: "free-default", reasoningEffort: "low", source: "deployment" },
        }),
        getBilling,
      } as never,
      input,
    );
    expect(free).toEqual({ includedModel: input.includedCandidate, startingCredits: null });
    expect(getBilling).not.toHaveBeenCalled();

    const trial = await loadModelAccessOnboarding(
      { getWorkspaceModelCatalog: async () => creditsDefault, getBilling } as never,
      input,
    );
    expect(getBilling).toHaveBeenCalledWith({ accountId: "organization-a" });
    expect(trial.includedModel).toEqual(input.includedCandidate);
    expect(trial.startingCredits?.balance).toEqual({ balanceMicros: 10_000_000, currency: "usd" });

    // Self-hosted deployments that do not bill credits never read billing.
    getBilling.mockClear();
    const selfHosted = await loadModelAccessOnboarding(
      { getWorkspaceModelCatalog: async () => creditsDefault, getBilling } as never,
      { ...input, billingMode: "disabled" },
    );
    expect(selfHosted.startingCredits).toBeNull();
    expect(getBilling).not.toHaveBeenCalled();
  });

  test("a failed balance read degrades without an amount; a failed catalog confirms nothing", async () => {
    const input = {
      organizationId: "organization-a",
      workspaceId: "personal-workspace",
      billingMode: "stripe" as const,
      includedCandidate: null,
    };
    const deniedBilling = await loadModelAccessOnboarding(
      {
        getWorkspaceModelCatalog: async () => creditsDefault,
        getBilling: async () => {
          throw new OpenGeniApiError(403, "missing permission: billing:read");
        },
      } as never,
      input,
    );
    expect(deniedBilling.startingCredits).toEqual({
      balance: null,
      model: { id: "credits-first", label: "Zeta credits", reasoningEffort: "high" },
    });
    expect(
      await loadModelAccessOnboarding(
        {
          getWorkspaceModelCatalog: async () => {
            throw new Error("unavailable");
          },
        } as never,
        input,
      ),
    ).toEqual({ includedModel: null, startingCredits: null });
  });
});
