import { describe, expect, test } from "bun:test";
import type { WorkspaceModelCatalogModel } from "@opengeni/sdk";

import {
  advancedSourceSummary,
  billingClassForModel,
  coerceReasoningEffortForModel,
  effortOptionsForModel,
  groupPickerRowsByBillingClass,
  payerSummaryForModel,
  modelUsesCredits,
  projectPickerRows,
} from "../src/model-policy";

function catalogModel(
  overrides: Partial<WorkspaceModelCatalogModel> & Pick<WorkspaceModelCatalogModel, "id" | "label">,
): WorkspaceModelCatalogModel {
  return {
    provider: "openai",
    providerLabel: "OpenAI",
    api: "responses",
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
    ...overrides,
  };
}

describe("model-policy", () => {
  test.each([
    {
      name: "free-only with blocked paid",
      paid: false,
      codex: true,
      free: true,
      codexOnly: false,
      first: "Codex",
    },
    {
      name: "selectable paid",
      paid: true,
      codex: true,
      free: true,
      codexOnly: false,
      first: "Models",
    },
    {
      name: "no usable Codex",
      paid: false,
      codex: false,
      free: true,
      codexOnly: false,
      first: "Models",
    },
    {
      name: "no selectable OpenGeni",
      paid: false,
      codex: true,
      free: false,
      codexOnly: false,
      first: "Models",
    },
    {
      name: "Codex-only session",
      paid: false,
      codex: true,
      free: false,
      codexOnly: true,
      first: "Codex",
    },
    {
      name: "Codex-only without usable Codex",
      paid: false,
      codex: false,
      free: false,
      codexOnly: true,
      first: "Models",
    },
  ])("conditionally promotes the UI group: $name", ({ paid, codex, free, codexOnly, first }) => {
    const rows = projectPickerRows([
      catalogModel({ id: "free", label: "Free", source: "opengeni", cost: "free" }),
      catalogModel({ id: "paid", label: "Paid", source: "opengeni", cost: "credits" }),
      catalogModel({ id: "codex/test", label: "Codex", source: "codex", cost: "subscription" }),
    ]).map((row, index) => ({
      ...row,
      selectable: [free, paid, codex][index]!,
      unavailableReason: [free, paid, codex][index] ? null : "Blocked by workspace policy",
    }));
    const snapshot = structuredClone(rows);
    const groups = groupPickerRowsByBillingClass(rows, { codexOnly });
    expect(groups[0]?.label).toBe(first);
    expect(groups.flatMap((group) => group.rows)).toHaveLength(3);
    expect(groups.flatMap((group) => group.rows).find((row) => row.id === "paid")).toEqual(rows[1]);
    expect(rows).toEqual(snapshot);
    expect(groupPickerRowsByBillingClass(rows.slice(0, 2))[0]?.label).toBe("Models");
  });

  test("unknown legacy cost is not treated as free", () => {
    const rows = projectPickerRows([
      catalogModel({ id: "legacy", label: "Legacy", source: "opengeni" }),
      catalogModel({ id: "codex/test", label: "Codex", source: "codex" }),
    ]);
    expect(groupPickerRowsByBillingClass(rows).map((group) => group.label)).toEqual([
      "Models",
      "Codex",
    ]);
  });

  test("credit notices follow cost policy rather than the OpenGeni group", () => {
    for (const cost of ["free", "credits", "workspace", "organization", "subscription"] as const) {
      const model = catalogModel({
        id: "model",
        label: "Model",
        cost,
        billing: { upstreamPayer: "deployment", metering: "opengeni_credits" },
      });
      expect(modelUsesCredits(model)).toBe(cost === "credits");
    }
    expect(modelUsesCredits(undefined)).toBe(false);
    expect(
      modelUsesCredits(
        catalogModel({
          id: "legacy",
          label: "Legacy",
          billing: { upstreamPayer: "deployment", metering: "external" },
        }),
      ),
    ).toBe(false);
    expect(
      modelUsesCredits(
        catalogModel({
          id: "legacy",
          label: "Legacy",
          billing: { upstreamPayer: "deployment", metering: "opengeni_credits" },
        }),
      ),
    ).toBe(true);
  });
  test("omits deployment models that have no credential", () => {
    const model = catalogModel({
      id: "openrouter/starter:free",
      label: "Starter",
      cost: "free",
      billing: { upstreamPayer: "deployment", metering: "external" },
      credentialReadiness: {
        status: "not_ready",
        reason: "missing_credential",
        basis: "configuration",
        checkedAt: null,
      },
      availability: {
        status: "unavailable",
        selectable: false,
        reason: "missing_credential",
        checkedAt: null,
      },
    });
    expect(projectPickerRows([model])).toEqual([]);
  });
  test("labels organization API keys like workspace ones, without connection scope", () => {
    const model = catalogModel({
      id: "organization-openrouter/openai/gpt-org",
      label: "Org GPT",
      provider: "organization-openrouter",
      providerLabel: "Organization OpenRouter",
      credentialSource: { kind: "organization_connection", mechanism: "api_key" },
      billing: { upstreamPayer: "organization", metering: "external" },
      cost: "organization",
    });
    expect(billingClassForModel(model)).toBe("organization_byok");
    expect(projectPickerRows([model])[0]?.billingClassLabel).toBe("API keys");
    expect(payerSummaryForModel(model)).toBe("Billed to the organization OpenRouter account");
    expect(payerSummaryForModel({ ...model, cost: undefined })).toBe(
      "Billed to the organization OpenRouter account",
    );
    expect(payerSummaryForModel({ ...model, provider: "organization-gateway" })).toBe(
      "Billed to the organization Vercel account",
    );
  });
  test("omits disconnected subscription and workspace Gateway rails", () => {
    const rows = projectPickerRows([
      catalogModel({ id: "managed", label: "Managed", source: "opengeni" }),
      catalogModel({
        id: "codex/gpt-5.6-sol",
        label: "Codex",
        source: "codex",
        credentialReadiness: {
          status: "not_ready",
          reason: "needs_reauth",
          basis: "connection",
          checkedAt: null,
        },
      }),
      catalogModel({
        id: "workspace-gateway/deepseek-v4-flash-0731",
        label: "DeepSeek",
        source: "workspace_gateway",
        credentialReadiness: {
          status: "not_ready",
          reason: "needs_reauth",
          basis: "connection",
          checkedAt: null,
        },
      }),
    ]);
    expect(rows.map((row) => row.id)).toEqual(["managed"]);
  });

  test("labels a connected workspace Gateway as a workspace provider", () => {
    const rows = projectPickerRows([
      catalogModel({
        id: "workspace-gateway/kimi-k3",
        label: "Kimi K3",
        provider: "workspace-gateway",
        source: "workspace_gateway",
        cost: "workspace",
      }),
    ]);
    expect(rows[0]).toMatchObject({
      billingClass: "byok",
      billingClassLabel: "API keys",
    });
    expect(payerSummaryForModel(rows[0]!.catalog)).toBe("Billed to the workspace Vercel account");
  });

  test("keeps workspace OpenRouter billing separate from deployment OpenRouter", () => {
    const workspaceModel = catalogModel({
      id: "workspace-openrouter/anthropic/claude-sonnet-4.6",
      label: "Claude Sonnet 4.6",
      provider: "workspace-openrouter",
      providerLabel: "Workspace OpenRouter",
      source: "openrouter",
      cost: "workspace",
      credentialSource: { kind: "workspace_connection", mechanism: "api_key" },
    });
    const deploymentModel = catalogModel({
      id: "openrouter/anthropic/claude-sonnet-4.6:free",
      label: "Claude Sonnet 4.6 Free",
      provider: "openrouter",
      providerLabel: "OpenRouter",
      source: "openrouter",
      cost: "free",
      billing: { upstreamPayer: "deployment", metering: "external" },
    });

    expect(billingClassForModel(workspaceModel)).toBe("byok");
    expect(payerSummaryForModel(workspaceModel)).toBe("Billed to the workspace OpenRouter account");
    expect(advancedSourceSummary(workspaceModel)).toBe("Workspace OpenRouter connection");
    expect(billingClassForModel(deploymentModel)).toBe("opengeni_credits");
    expect(payerSummaryForModel(deploymentModel)).toBe("Free in this deployment");
  });

  test("groups an anonymous deployment route under OpenGeni without assuming free access", () => {
    const model = catalogModel({
      id: "opencode/x-preview-f-free",
      label: "OpenCode Ox Alpha",
      billing: { upstreamPayer: "deployment", metering: "external" },
    });
    expect(billingClassForModel(model)).toBe("opengeni_credits");
    expect(projectPickerRows([model])[0]).toMatchObject({
      billingClass: "opengeni_credits",
      billingClassLabel: "Models",
    });
    expect(advancedSourceSummary(model)).toBe("Deployment-provided connection");
    expect(payerSummaryForModel(model)).toBe("Opengeni · no model credits");
  });

  test("uses deployment cost before upstream settlement in the payer summary", () => {
    const externallySettled = {
      billing: { upstreamPayer: "deployment", metering: "external" },
      source: "openrouter",
    } as const;

    expect(
      payerSummaryForModel(
        catalogModel({
          id: "openrouter/model:free",
          label: "OpenRouter model",
          ...externallySettled,
          cost: "free",
        }),
      ),
    ).toBe("Free in this deployment");
    expect(
      payerSummaryForModel(
        catalogModel({
          id: "openrouter/model:free",
          label: "OpenRouter model",
          ...externallySettled,
          cost: "credits",
        }),
      ),
    ).toBe("Opengeni credits");
  });

  test("uses explicit ownership cost labels independently of legacy billing metadata", () => {
    expect(
      payerSummaryForModel(
        catalogModel({
          id: "supergrok/grok",
          label: "Grok",
          source: "supergrok",
          cost: "subscription",
          billing: { upstreamPayer: "deployment", metering: "opengeni_credits" },
        }),
      ),
    ).toBe("SuperGrok subscription · external billing");
    expect(
      payerSummaryForModel(
        catalogModel({
          id: "workspace-gateway/model",
          label: "Gateway model",
          provider: "workspace-gateway",
          source: "workspace_gateway",
          cost: "workspace",
          billing: { upstreamPayer: "deployment", metering: "opengeni_credits" },
        }),
      ),
    ).toBe("Billed to the workspace Vercel account");
  });

  test("projects curated shortLabel into picker rows", () => {
    const rows = projectPickerRows([
      catalogModel({
        id: "gpt-5.6-sol",
        label: "GPT-5.6 Sol",
        shortLabel: "5.6 Sol",
      }),
      catalogModel({
        id: "deepseek-v4-flash-0731",
        label: "DeepSeek V4 Flash 0731",
        shortLabel: "V4 Flash",
      }),
    ]);
    expect(rows.find((row) => row.id === "gpt-5.6-sol")?.shortLabel).toBe("5.6 Sol");
    expect(rows.find((row) => row.id === "deepseek-v4-flash-0731")?.shortLabel).toBe("V4 Flash");
  });

  test("groups catalog rows by billing class", () => {
    const rows = projectPickerRows([
      catalogModel({
        id: "gpt-5.6-sol",
        label: "Sol",
        billing: { upstreamPayer: "deployment", metering: "opengeni_credits" },
      }),
      catalogModel({
        id: "codex/gpt-5.6-sol",
        label: "Codex Sol",
        credentialSource: { kind: "connected_subscription", provider: "codex" },
        billing: { upstreamPayer: "connected_subscription", metering: "external" },
      }),
      catalogModel({
        id: "supergrok/grok-4.6",
        label: "Grok 4.6",
        source: "supergrok",
        credentialSource: { kind: "connected_subscription", provider: "xai" },
        billing: { upstreamPayer: "connected_subscription", metering: "external" },
      }),
    ]);
    const groups = groupPickerRowsByBillingClass(rows);
    expect(groups.map((group) => group.billingClass)).toEqual([
      "opengeni_credits",
      "codex_subscription",
      "supergrok_subscription",
    ]);
  });

  test("uses per-model reasoning efforts and coerces invalid selections", () => {
    const model = catalogModel({
      id: "gpt-5.6-sol",
      label: "Sol",
      capabilities: {
        reasoning: {
          upstream: "supported",
          runnable: true,
          efforts: ["low", "high", "max"],
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
    });
    expect(effortOptionsForModel(model)).toEqual(["low", "high", "max"]);
    expect(coerceReasoningEffortForModel(model, "xhigh")).toBe("low");
    expect(billingClassForModel(model)).toBe("opengeni_credits");
  });

  test("marks blocked models non-selectable in picker rows", () => {
    const rows = projectPickerRows([
      catalogModel({
        id: "blocked",
        label: "Blocked",
        availability: {
          status: "unavailable",
          selectable: false,
          reason: "policy_blocked",
          checkedAt: null,
        },
      }),
    ]);
    expect(rows[0]?.selectable).toBe(false);
    expect(rows[0]?.unavailableReason).toBe("Blocked by workspace policy");
  });
});

describe("model display across connection scopes", () => {
  const claude = (scope: "organization" | "workspace", upstream: string, label = upstream) =>
    catalogModel({
      id: `${scope}-claude-subscription/${upstream}`,
      label,
      provider: `${scope}-claude-subscription`,
      providerLabel: "Claude subscription",
      cost: scope,
    });
  const anthropic = (scope: "organization" | "workspace", upstream: string) =>
    catalogModel({
      id: `${scope}-anthropic/${upstream}`,
      label: upstream,
      provider: `${scope}-anthropic`,
      providerLabel: "Anthropic API",
      cost: scope,
    });

  test("rows carry the clean display name, never the raw catalog label", () => {
    const rows = projectPickerRows([
      claude("organization", "claude-opus-4-8"),
      anthropic("workspace", "claude-haiku-4-5-20251001"),
    ]);
    expect(rows.map((row) => row.label)).toEqual(["Claude Opus 4.8", "Claude Haiku 4.5"]);
  });

  test("org- and workspace-connected copies collapse to one row, keeping the selection", () => {
    const rows = projectPickerRows([
      claude("organization", "claude-opus-5-5", "Claude Opus 5.5"),
      claude("workspace", "claude-opus-5-5", "Claude Opus 5.5"),
      anthropic("organization", "claude-sonnet-4-6"),
      anthropic("workspace", "claude-sonnet-4-6"),
    ]);
    const groups = groupPickerRowsByBillingClass(rows, {
      selectedId: "workspace-claude-subscription/claude-opus-5-5",
    });
    expect(groups.map((group) => group.label)).toEqual(["Claude subscription", "API keys"]);
    expect(groups[0]!.rows.map((row) => row.id)).toEqual([
      "workspace-claude-subscription/claude-opus-5-5",
    ]);
    expect(groups[1]!.rows.map((row) => row.label)).toEqual(["Claude Sonnet 4.6"]);
  });

  test("Claude rows get a compact family-free label for narrow triggers", () => {
    const rows = projectPickerRows([claude("organization", "claude-opus-5-5", "Claude Opus 5.5")]);
    expect(rows[0]?.shortLabel).toBe("Opus 5.5");
  });

  test("deployment models with the same name stay separate choices", () => {
    const rows = projectPickerRows([
      catalogModel({ id: "azure/gpt-6-sol", label: "GPT-6 Sol", cost: "credits" }),
      catalogModel({ id: "openai/gpt-6-sol", label: "GPT-6 Sol", cost: "credits" }),
    ]);
    expect(groupPickerRowsByBillingClass(rows)[0]!.rows).toHaveLength(2);
  });
});

describe("scope collapse never merges different accounts", () => {
  const row = (id: string, provider: string, label: string, cost: "organization" | "workspace") =>
    catalogModel({ id, label, provider, providerLabel: provider, cost });

  test("the same model through OpenRouter and the Anthropic API stays two rows", () => {
    const rows = projectPickerRows([
      row(
        "workspace-openrouter/anthropic/claude-sonnet-4.6",
        "workspace-openrouter",
        "Claude Sonnet 4.6",
        "workspace",
      ),
      row(
        "organization-anthropic/claude-sonnet-4.6",
        "organization-anthropic",
        "Claude Sonnet 4.6",
        "organization",
      ),
      row(
        "workspace-anthropic/claude-sonnet-4.6",
        "workspace-anthropic",
        "Claude Sonnet 4.6",
        "workspace",
      ),
    ]);
    const [keys] = groupPickerRowsByBillingClass(rows);
    expect(keys!.label).toBe("API keys");
    // Org + workspace Anthropic collapse; OpenRouter is a different account.
    expect(
      keys!.rows
        .map((candidate) => candidate.provider.replace(/^(organization|workspace)-/, ""))
        .sort(),
    ).toEqual(["anthropic", "openrouter"]);
  });

  test("collapseScopes false keeps every row and scoped groups", () => {
    const rows = projectPickerRows([
      row(
        "organization-anthropic/claude-sonnet-4.6",
        "organization-anthropic",
        "Claude Sonnet 4.6",
        "organization",
      ),
      row(
        "workspace-anthropic/claude-sonnet-4.6",
        "workspace-anthropic",
        "Claude Sonnet 4.6",
        "workspace",
      ),
    ]);
    const groups = groupPickerRowsByBillingClass(rows, { collapseScopes: false });
    expect(groups.map((group) => group.billingClass)).toEqual(["byok", "organization_byok"]);
  });
});
