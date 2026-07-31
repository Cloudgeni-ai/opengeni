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
          efforts: ["low", "high"],
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
    expect(effortOptionsForModel(model)).toEqual(["low", "high"]);
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
