import { describe, expect, test } from "bun:test";
import type { OrganizationUsageSummary } from "@opengeni/contracts";
import {
  formatExactUsage,
  formatUsageAmount,
  organizationPrivateRows,
  organizationUsageChart,
  organizationUsageRows,
} from "./organization-usage-dashboard";
import type { AccessContext } from "@/types";
import { usageMetricLabel, usageUnitLabel } from "@/lib/usage-metric";

describe("organization usage presentation", () => {
  test("human labels preserve unknown metrics and distinct accounting units", () => {
    expect(usageMetricLabel("model.cost")).toBe("Model spend");
    expect(usageMetricLabel("model.tokens")).toBe("Model tokens");
    expect(usageMetricLabel("sandbox.warm_seconds")).toBe("Warm sandbox time");
    expect(usageMetricLabel("custom.metric")).toBe("custom.metric");
    expect(usageUnitLabel("usd_micros")).toBe("USD");
    expect(usageUnitLabel("tokens")).toBe("tokens");
  });
  test("keeps exact micros and negative corrections without number coercion", () => {
    expect(formatExactUsage("9007199254740993", "usd_micros")).toBe("$9,007,199,254.740993");
    expect(formatExactUsage("-1", "usd_micros")).toBe("-$0.000001");
    expect(formatExactUsage("9007199254740993", "tokens")).toBe("9,007,199,254,740,993 tokens");
  });
  test("reads money in cents and says when an amount is under a cent", () => {
    expect(formatUsageAmount("12345678", "usd_micros")).toBe("$12.35");
    expect(formatUsageAmount("9007199254740993", "usd_micros")).toBe("$9,007,199,254.74");
    expect(formatUsageAmount("100", "usd_micros")).toBe("< $0.01");
    expect(formatUsageAmount("0", "usd_micros")).toBe("$0.00");
    expect(formatUsageAmount("-2500000", "usd_micros")).toBe("-$2.50");
    expect(formatUsageAmount("1200", "tokens")).toBe("1,200 tokens");
  });
  test("fills UTC gaps and keeps units separate", () => {
    const selected = {
      eventType: "model.cost",
      unit: "usd_micros",
      quantity: "3000000",
      eventCount: "2",
    };
    const summary: OrganizationUsageSummary = {
      accountId: crypto.randomUUID(),
      period: "today",
      since: "2026-09-14T00:00:00.000Z",
      until: "2026-09-14T03:30:00.000Z",
      granularity: "hour",
      totals: [selected],
      workspaces: [],
      nextWorkspaceCursor: null,
      personalWorkspaces: [],
      personalWorkspaceCount: 0,
      buckets: [
        {
          bucket: "2026-09-14T01:00",
          totals: [
            { ...selected, quantity: "3000000" },
            { ...selected, unit: "different", quantity: "9999" },
          ],
        },
      ],
    };
    expect(organizationUsageChart(summary, selected)).toEqual({
      labels: ["2026-09-14T00:00", "2026-09-14T01:00", "2026-09-14T02:00", "2026-09-14T03:00"],
      values: [0, 3, 0, 0],
    });
  });

  test("lists Personal workspaces by owner, amounts only, and links only what you administer", () => {
    const cost = (quantity: string) => [
      { eventType: "model.cost", unit: "usd_micros", quantity, eventCount: "1" },
    ];
    const adminOf = "11111111-1111-4111-8111-111111111111";
    const memberOf = "22222222-2222-4222-8222-222222222222";
    const ownPersonal = "33333333-3333-4333-8333-333333333333";
    const maria = "44444444-4444-4444-8444-444444444444";
    const you = "55555555-5555-4555-8555-555555555555";
    const unknown = "66666666-6666-4666-8666-666666666666";
    const grant = (workspaceId: string, permissions: string[]) => ({
      accountId: "account",
      workspaceId,
      subjectId: "user:you",
      permissions,
    });
    const accessContext = {
      mode: "managed",
      subjectId: "user:you",
      accountGrants: [],
      workspaceGrants: [
        grant(adminOf, ["workspace:admin"]),
        grant(memberOf, ["workspace:read", "sessions:read"]),
        // Owning a Personal workspace grants no workspace:admin, so no Insights.
        grant(ownPersonal, ["workspace:read"]),
      ],
    } as unknown as AccessContext;
    const rows = organizationUsageRows({
      shared: [
        { workspaceId: adminOf, name: "Platform", totals: cost("2000000") },
        { workspaceId: memberOf, name: "Finance", totals: [] },
      ],
      personal: [
        { membershipId: maria, totals: cost("5000000") },
        { membershipId: you, totals: cost("1000000") },
        { membershipId: unknown, totals: cost("3000000") },
      ],
      selected: { eventType: "model.cost", unit: "usd_micros" },
      members: [
        { id: maria, name: "Maria Chen", email: "maria@acme.dev" },
        { id: you, name: null, email: "you@acme.dev" },
      ],
      youMembershipId: you,
      accessContext,
    });
    expect(rows.map((row) => [row.title, row.kind, row.quantity, row.you])).toEqual([
      ["Maria Chen", "personal", "5000000", false],
      ["Organization member", "personal", "3000000", false],
      ["Platform", "shared", "2000000", false],
      ["you@acme.dev", "personal", "1000000", true],
      ["Finance", "shared", "0", false],
    ]);
    expect(rows.find((row) => row.title === "Platform")?.insightsWorkspaceId).toBe(adminOf);
    expect(rows.find((row) => row.title === "Finance")?.insightsWorkspaceId).toBeNull();
    expect(
      rows.filter((row) => row.kind === "personal").map((row) => row.insightsWorkspaceId),
    ).toEqual([null, null, null]);
    // Personal rows are keyed by membership; no Personal workspace id reaches the page.
    expect(JSON.stringify(rows)).not.toContain(ownPersonal);
  });
  test("other people's private chats are a name, a workspace and an amount, largest first", () => {
    const cost = (quantity: string) => [
      { eventType: "model.cost", unit: "usd_micros", quantity, eventCount: "1" },
    ];
    const summary = {
      privateChats: [
        { workspaceId: "w1", membershipId: "m1", name: "Server name", totals: cost("3020000") },
        { workspaceId: "w2", membershipId: null, name: null, totals: cost("12400000") },
        { workspaceId: "w1", membershipId: "m2", name: "Idle", totals: cost("0") },
      ],
      privateChatsTruncated: true,
    } as unknown as OrganizationUsageSummary;
    const { rows, truncated } = organizationPrivateRows({
      summary,
      selected: { eventType: "model.cost", unit: "usd_micros" },
      members: [{ id: "m1", name: "Ola Nordmann", email: "ola@example.com" }],
      workspaceNames: new Map([["w1", "Product"]]),
    });
    expect(truncated).toBe(true);
    expect(rows.map((row) => [row.person, row.workspace, row.quantity])).toEqual([
      ["Organization member", "a workspace", "12400000"],
      ["Ola Nordmann", "Product", "3020000"],
    ]);
    expect(JSON.stringify(rows)).not.toContain("session");
    expect(
      organizationPrivateRows({
        summary: {} as OrganizationUsageSummary,
        selected: { eventType: "model.cost", unit: "usd_micros" },
        members: [],
        workspaceNames: new Map(),
      }).rows,
    ).toEqual([]);
  });
});
