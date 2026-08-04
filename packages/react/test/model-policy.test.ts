import { describe, expect, test } from "bun:test";
import type { WorkspaceModelCatalogModel } from "@opengeni/sdk";

import {
  billingClassForModel,
  coerceReasoningEffortForModel,
  effortOptionsForModel,
  groupPickerRowsByBillingClass,
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

  test("labels a connected workspace Gateway as Your Gateway", () => {
    const rows = projectPickerRows([
      catalogModel({
        id: "workspace-gateway/kimi-k3",
        label: "Kimi K3",
        source: "workspace_gateway",
      }),
    ]);
    expect(rows[0]).toMatchObject({ billingClass: "byok", billingClassLabel: "Your Gateway" });
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
    ]);
    const groups = groupPickerRowsByBillingClass(rows);
    expect(groups.map((group) => group.billingClass)).toEqual([
      "opengeni_credits",
      "codex_subscription",
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
