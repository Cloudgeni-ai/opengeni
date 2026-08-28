import { describe, expect, test } from "bun:test";
import { CreateWorkspaceGatewayCustomModelRequest } from "../src";
import { compareModelPickerOrder, modelPickerBillingClassFor } from "../src/model-picker-order";

describe("model picker shared ordering", () => {
  test("orders by billing rail, selectability, and label", () => {
    const rows = [
      { billingClass: "byok" as const, selectable: true, label: "Zulu" },
      { billingClass: "opengeni_credits" as const, selectable: false, label: "Beta" },
      { billingClass: "opengeni_credits" as const, selectable: true, label: "Alpha" },
      { billingClass: "external" as const, selectable: true, label: "External" },
    ];
    expect([...rows].sort(compareModelPickerOrder).map((row) => row.label)).toEqual([
      "Alpha",
      "Beta",
      "External",
      "Zulu",
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
        upstreamModelId: "anthropic/claude-sonnet-4.6",
      }).success,
    ).toBe(true);
    expect(
      CreateWorkspaceGatewayCustomModelRequest.safeParse({
        upstreamModelId: "anthropic|claude",
      }).success,
    ).toBe(false);
  });
});
