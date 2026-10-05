import { describe, expect, test } from "bun:test";
import type { LatencyMode, ReasoningEffort, WorkspaceModelCatalogModel } from "@opengeni/sdk";

import { resolveAgentBrainPromptModel } from "@/lib/agent-brain-prompt-model";

const supported = { upstream: "supported", runnable: true } as const;
const unsupported = { upstream: "unsupported", runnable: false } as const;

function catalogModel(
  id: string,
  overrides: {
    selectable?: boolean;
    source?: WorkspaceModelCatalogModel["source"];
    cost?: WorkspaceModelCatalogModel["cost"];
    billing?: WorkspaceModelCatalogModel["billing"];
    efforts?: ReasoningEffort[];
    defaultEffort?: ReasoningEffort | null;
    latencyModes?: Array<{ id: LatencyMode; runnable: boolean }>;
  } = {},
): WorkspaceModelCatalogModel {
  const selectable = overrides.selectable ?? true;
  const source =
    overrides.source ??
    (id.startsWith("codex/") ? "codex" : id.startsWith("supergrok/") ? "supergrok" : "opengeni");
  return {
    id,
    label: id === "gpt-5.5" ? "GPT-5.5" : id === "codex/gpt-5.6-luna" ? "GPT-5.6 Luna" : id,
    provider: source,
    providerLabel: source === "codex" ? "Codex" : source === "supergrok" ? "SuperGrok" : "OpenGeni",
    source,
    api: "responses",
    ...(overrides.cost ? { cost: overrides.cost } : {}),
    ...(overrides.billing ? { billing: overrides.billing } : {}),
    credentialReadiness: {
      status: "ready",
      reason: null,
      basis: "configuration",
      checkedAt: null,
    },
    policyAllowed: selectable,
    availability: {
      status: selectable ? "available" : "unavailable",
      selectable,
      reason: selectable ? null : "policy_blocked",
      checkedAt: null,
    },
    ...(overrides.efforts || overrides.latencyModes
      ? {
          capabilities: {
            reasoning: {
              upstream: "supported",
              runnable: true,
              efforts: overrides.efforts ?? ["low", "medium", "high"],
              defaultEffort: overrides.defaultEffort ?? "medium",
              required: false,
            },
            functionCalling: supported,
            structuredOutput: supported,
            hostedTools: {
              webSearch: unsupported,
              xSearch: unsupported,
              codeExecution: unsupported,
            },
            inputModalities: ["text"],
            outputModalities: ["text"],
            transports: {
              sse: supported,
              responsesWebSocket: unsupported,
              realtimeAudio: unsupported,
            },
            latencyModes: (overrides.latencyModes ?? [{ id: "standard", runnable: true }]).map(
              (mode) => ({ ...mode, upstream: mode.runnable ? "supported" : "unsupported" }),
            ),
          } satisfies NonNullable<WorkspaceModelCatalogModel["capabilities"]>,
        }
      : {}),
  };
}

describe("resolveAgentBrainPromptModel", () => {
  test("keeps the preferred model when the workspace catalog marks it selectable", () => {
    const models = [catalogModel("gpt-5.6-sol"), catalogModel("codex/gpt-5.6-luna")];
    expect(
      resolveAgentBrainPromptModel(models, {
        model: "gpt-5.6-sol",
        reasoningEffort: "low",
        latencyMode: "standard",
      }),
    ).toEqual({
      model: "gpt-5.6-sol",
      label: "GPT-5.6 Sol",
      paymentSource: "Opengeni credits",
      reasoningEffort: "low",
      latencyMode: "standard",
    });
  });

  test("falls back to the first selectable catalog model when the preferred model is blocked", () => {
    const models = [
      catalogModel("gpt-5.6-sol", { selectable: false }),
      catalogModel("codex/gpt-5.6-luna"),
      catalogModel("supergrok/grok-4"),
    ];
    const selection = resolveAgentBrainPromptModel(models, {
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
      latencyMode: "standard",
    });
    expect(selection?.model).toBe("codex/gpt-5.6-luna");
  });

  test("uses deployment cost instead of inferring payment from provider settlement", () => {
    const openRouterBilling = {
      upstreamPayer: "deployment",
      metering: "external",
    } as const;
    const free = resolveAgentBrainPromptModel(
      [
        catalogModel("openrouter/nvidia/nemotron-3-super-120b-a12b:free", {
          source: "openrouter",
          cost: "free",
          billing: openRouterBilling,
        }),
      ],
      {
        model: "openrouter/nvidia/nemotron-3-super-120b-a12b:free",
        reasoningEffort: "low",
        latencyMode: "standard",
      },
    );
    const credits = resolveAgentBrainPromptModel(
      [
        catalogModel("openrouter/nvidia/nemotron-3-super-120b-a12b:free", {
          source: "openrouter",
          cost: "credits",
          billing: openRouterBilling,
        }),
      ],
      {
        model: "openrouter/nvidia/nemotron-3-super-120b-a12b:free",
        reasoningEffort: "low",
        latencyMode: "standard",
      },
    );

    expect(free?.paymentSource).toBe("Free in this deployment");
    expect(credits?.paymentSource).toBe("Opengeni credits");
  });

  test("falls back when the preferred model is absent from the catalog", () => {
    const models = [catalogModel("codex/gpt-5.6-luna")];
    expect(
      resolveAgentBrainPromptModel(models, {
        model: "legacy-model",
        reasoningEffort: "low",
        latencyMode: "standard",
      })?.model,
    ).toBe("codex/gpt-5.6-luna");
  });

  test("returns null when no row is selectable", () => {
    const models = [
      catalogModel("gpt-5.6-sol", { selectable: false }),
      catalogModel("codex/gpt-5.6-luna", { selectable: false }),
    ];
    expect(
      resolveAgentBrainPromptModel(models, {
        model: "gpt-5.6-sol",
        reasoningEffort: "low",
        latencyMode: "standard",
      }),
    ).toBeNull();
    expect(
      resolveAgentBrainPromptModel([], {
        model: "gpt-5.6-sol",
        reasoningEffort: "low",
        latencyMode: "standard",
      }),
    ).toBeNull();
  });

  test("coerces reasoning effort and latency mode to what the chosen model supports", () => {
    const models = [
      catalogModel("codex/gpt-5.6-luna", {
        efforts: ["medium", "high"],
        defaultEffort: "high",
        latencyModes: [
          { id: "standard", runnable: true },
          { id: "fast", runnable: false },
        ],
      }),
    ];
    expect(
      resolveAgentBrainPromptModel(models, {
        model: "gpt-5.6-sol",
        reasoningEffort: "low",
        latencyMode: "fast",
      }),
    ).toEqual({
      model: "codex/gpt-5.6-luna",
      label: "GPT-5.6 Luna",
      paymentSource: "ChatGPT plan",
      reasoningEffort: "high",
      latencyMode: "standard",
    });
    expect(
      resolveAgentBrainPromptModel(models, {
        model: "codex/gpt-5.6-luna",
        reasoningEffort: "medium",
        latencyMode: "standard",
      }),
    ).toEqual({
      model: "codex/gpt-5.6-luna",
      label: "GPT-5.6 Luna",
      paymentSource: "ChatGPT plan",
      reasoningEffort: "medium",
      latencyMode: "standard",
    });
  });

  test("keeps a non-standard latency mode only when the chosen model can run it", () => {
    const models = [
      catalogModel("codex/gpt-5.6-luna", {
        efforts: ["low"],
        latencyModes: [
          { id: "standard", runnable: true },
          { id: "priority", runnable: true },
        ],
      }),
    ];
    expect(
      resolveAgentBrainPromptModel(models, {
        model: "codex/gpt-5.6-luna",
        reasoningEffort: "low",
        latencyMode: "priority",
      })?.latencyMode,
    ).toBe("priority");
  });
});
