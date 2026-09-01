import { describe, expect, test } from "bun:test";
import {
  CreateWorkspaceGatewayCustomModelRequest,
  CreateWorkspaceOpenRouterCustomModelRequest,
} from "../src";
import { compareModelPickerOrder, modelPickerBillingClassFor } from "../src/model-picker-order";

describe("model picker shared ordering", () => {
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
    ).toBe("external");
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
