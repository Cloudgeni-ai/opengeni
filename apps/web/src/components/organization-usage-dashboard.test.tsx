import { describe, expect, test } from "bun:test";
import type { OrganizationUsageSummary } from "@opengeni/contracts";
import { formatExactUsage, organizationUsageChart } from "./organization-usage-dashboard";

describe("organization usage presentation", () => {
  test("keeps exact micros and negative corrections without number coercion", () => {
    expect(formatExactUsage("9007199254740993", "usd_micros")).toBe("$9,007,199,254.740993");
    expect(formatExactUsage("-1", "usd_micros")).toBe("-$0.000001");
    expect(formatExactUsage("9007199254740993", "tokens")).toBe("9,007,199,254,740,993 tokens");
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
});
