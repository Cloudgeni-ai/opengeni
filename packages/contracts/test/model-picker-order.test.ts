import { describe, expect, test } from "bun:test";
import {
  CreateWorkspaceGatewayCustomModelRequest,
  CreateWorkspaceOpenRouterCustomModelRequest,
} from "../src";
import {
  compareModelPickerOrder,
  modelLabelDistinctions,
  modelPickerBillingClassFor,
} from "../src/model-picker-order";

describe("model picker shared ordering", () => {
  test("groups deployment models together independently of upstream settlement", () => {
    for (const cost of ["free", "credits", undefined] as const) {
      for (const metering of ["external", "opengeni_credits"] as const) {
        expect(
          modelPickerBillingClassFor({
            cost,
            billing: { upstreamPayer: "deployment", metering },
            credentialSource: { kind: "deployment" },
          }),
        ).toBe("opengeni_credits");
      }
    }
    expect(modelPickerBillingClassFor({ cost: "free" })).toBe("opengeni_credits");
    expect(modelPickerBillingClassFor({ cost: "workspace" })).toBe("byok");
    expect(modelPickerBillingClassFor({ cost: "organization" })).toBe("organization_byok");
    expect(modelPickerBillingClassFor({ cost: "subscription", source: "codex" })).toBe(
      "codex_subscription",
    );
    expect(modelPickerBillingClassFor({ cost: "subscription", source: "supergrok" })).toBe(
      "supergrok_subscription",
    );
  });
  test("orders by billing rail, selectability, and label", () => {
    const rows = [
      { billingClass: "byok" as const, selectable: true, label: "Zulu" },
      { billingClass: "opengeni_credits" as const, selectable: false, label: "Beta" },
      { billingClass: "opengeni_credits" as const, selectable: true, label: "Alpha" },
      { billingClass: "external" as const, selectable: true, label: "External" },
      { billingClass: "codex_subscription" as const, selectable: true, label: "Codex" },
      { billingClass: "supergrok_subscription" as const, selectable: true, label: "SuperGrok" },
    ];
    expect([...rows].sort(compareModelPickerOrder).map((row) => row.label)).toEqual([
      "Alpha",
      "Beta",
      "External",
      "Codex",
      "SuperGrok",
      "Zulu",
    ]);
  });

  test("uses deterministic code-unit label ordering instead of the host locale", () => {
    const rows = ["ä", "a", "Å", "Z"].map((label) => ({
      billingClass: "opengeni_credits" as const,
      selectable: true,
      label,
    }));
    expect([...rows].sort(compareModelPickerOrder).map((row) => row.label)).toEqual([
      "Z",
      "a",
      "Å",
      "ä",
    ]);
  });

  test("derives the same billing rail from public model attribution", () => {
    expect(
      modelPickerBillingClassFor({
        billing: { upstreamPayer: "deployment", metering: "external" },
      }),
    ).toBe("opengeni_credits");
    expect(
      modelPickerBillingClassFor({
        cost: "credits",
        source: "openrouter",
        billing: { upstreamPayer: "deployment", metering: "external" },
      }),
    ).toBe("opengeni_credits");
    expect(
      modelPickerBillingClassFor({
        credentialSource: { kind: "connected_subscription", provider: "xai" },
      }),
    ).toBe("supergrok_subscription");
    expect(modelPickerBillingClassFor({ credentialSource: { kind: "workspace_connection" } })).toBe(
      "byok",
    );
  });
});

describe("workspace Gateway upstream slug", () => {
  test("rejects field separators while preserving exact printable provider slugs", () => {
    expect(
      CreateWorkspaceGatewayCustomModelRequest.safeParse({
        operationId: crypto.randomUUID(),
        upstreamModelId: "anthropic/claude-sonnet-4.6",
      }).success,
    ).toBe(true);
    expect(
      CreateWorkspaceGatewayCustomModelRequest.safeParse({
        operationId: crypto.randomUUID(),
        upstreamModelId: "anthropic|claude",
      }).success,
    ).toBe(false);
  });

  test("applies the same exact printable-slug boundary to workspace OpenRouter", () => {
    expect(
      CreateWorkspaceOpenRouterCustomModelRequest.safeParse({
        operationId: crypto.randomUUID(),
        upstreamModelId: "anthropic/claude-sonnet-4.6",
      }).success,
    ).toBe(true);
    expect(
      CreateWorkspaceOpenRouterCustomModelRequest.safeParse({
        operationId: crypto.randomUUID(),
        upstreamModelId: "anthropic|claude",
      }).success,
    ).toBe(false);
  });
});

describe("model label distinctions", () => {
  const eu = { geography: "eu" };
  const unknown = { geography: "unknown" };

  test("models with unique names get nothing", () => {
    expect(
      modelLabelDistinctions([
        { id: "a/sol", label: "GPT-6.1 Sol", residency: eu },
        { id: "a/terra", label: "GPT-6.1 Terra", residency: unknown },
      ]).size,
    ).toBe(0);
  });

  test("twins that differ by a known geography name it, and the other keeps its name", () => {
    expect([
      ...modelLabelDistinctions([
        {
          id: "azure-sol/gpt-6.1-sol",
          label: "GPT-6.1 Sol",
          providerLabel: "P",
          residency: unknown,
        },
        { id: "azure-eu/gpt-6.1-sol", label: "GPT-6.1 Sol", providerLabel: "P", residency: eu },
        {
          id: "us/gpt-6.1-sol",
          label: "gpt-6.1 sol ",
          providerLabel: "P",
          residency: { geography: "us" },
        },
      ]),
    ]).toEqual([
      ["azure-eu/gpt-6.1-sol", { geography: "eu" }],
      ["us/gpt-6.1-sol", { geography: "us" }],
    ]);
  });

  test("twins in the same place fall back to the provider, and names alone never claim a place", () => {
    expect([
      ...modelLabelDistinctions([
        { id: "x/m", label: "M", providerLabel: "X", residency: unknown },
        { id: "y/m", label: "M", providerLabel: "Y" },
        { id: "eu-1/m", label: "M (EU)", providerLabel: "X", residency: unknown },
      ]),
    ]).toEqual([
      ["x/m", { providerLabel: "X" }],
      ["y/m", { providerLabel: "Y" }],
    ]);
    expect([
      ...modelLabelDistinctions([
        { id: "a/m", label: "M", providerLabel: "A", residency: eu },
        { id: "b/m", label: "M", providerLabel: "B", residency: eu },
        { id: "c/m", label: "M", providerLabel: "A" },
      ]),
    ]).toEqual([
      ["a/m", { geography: "eu", providerLabel: "A" }],
      ["b/m", { geography: "eu", providerLabel: "B" }],
    ]);
  });

  test("identical twins and models in different groups get nothing", () => {
    expect(
      modelLabelDistinctions([
        { id: "a/m", label: "M", providerLabel: "P" },
        { id: "b/m", label: "M", providerLabel: "P" },
        { id: "c/m", label: "N", group: "credits", residency: eu },
        { id: "d/m", label: "N", group: "keys", residency: unknown },
      ]).size,
    ).toBe(0);
  });
});
