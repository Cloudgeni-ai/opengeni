import { describe, expect, mock, test } from "bun:test";
import { OpenGeniApiError } from "@opengeni/sdk/browser";
import type { WorkspaceModelCatalogModel } from "@opengeni/sdk";

import {
  applyConnectedModelToNewSessionDraft,
  isPaymentRequiredError,
  preferredConnectedModelId,
} from "./model-access-onboarding";

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
    ).resolves.toBe("codex/gpt-5.6-sol");
    expect(saveNewSessionDraft).toHaveBeenCalledWith("workspace-a", {
      text: draft.text,
      resources: draft.resources,
      tools: draft.tools,
      toolsProvided: false,
      model: "codex/gpt-5.6-sol",
      reasoningEffort: "low",
      latencyMode: "priority",
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
