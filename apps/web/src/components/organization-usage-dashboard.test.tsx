import { describe, expect, test } from "bun:test";
import type { OrganizationUsageSummary } from "@opengeni/contracts";
import {
  formatExactUsage,
  formatUsageAmount,
  organizationUsageChart,
} from "./organization-usage-dashboard";
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
