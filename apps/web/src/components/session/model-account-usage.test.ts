import { expect, test } from "bun:test";
import type { ModelAccountUsageSnapshot } from "@opengeni/sdk";
import { modelAccountUsage } from "./model-account-usage";

const snapshot = (windows: ModelAccountUsageSnapshot["windows"]): ModelAccountUsageSnapshot => ({
  windows,
  observedAt: null,
  source: null,
  exhaustedUntil: null,
  exhaustedKind: null,
});
test("omitted, absent and empty snapshots retain distinct unknown meanings", () => {
  expect(modelAccountUsage(undefined).message).toBe("Usage not reported");
  expect(modelAccountUsage(null).message).toBe("No stored usage");
  expect(modelAccountUsage(snapshot([]))).toMatchObject({
    message: "No usage windows recorded",
    note: "Cached observation · Time unknown",
  });
});
test("partial and unknown windows are never completed, aggregated or assigned a made-up percent", () => {
  const view = modelAccountUsage(
    snapshot([
      { id: "seven_day_opus", usedPercent: null, resetsAt: null, status: "unknown" },
      { id: "overage", usedPercent: 125, resetsAt: null, status: "unknown" },
      { id: "custom", usedPercent: 8, resetsAt: null, status: "warning" },
    ]),
  );
  expect(view.windows?.map((window) => window.usedPercent)).toEqual([null, 125, 8]);
  expect(view.windows?.map((window) => window.label)).toEqual(["Week · Opus", "Overage", "custom"]);
  expect(view.windows?.every((window) => window.remaining === undefined)).toBe(true);
  expect(view.summary).not.toContain("NaN");
  expect(view.summary).toStartWith("Cached");
  expect(view.windows?.[0]?.detail).toContain("Status unknown");
});
test("recorded account-wide rate limits without windows remain historical observations", () => {
  const view = modelAccountUsage({
    ...snapshot([]),
    exhaustedKind: "rate_limit",
    exhaustedUntil: "2020-01-01T09:00:00Z",
  });
  expect(view.message).toContain("Recorded rate limit");
  expect(view.message).toContain("2020");
  expect(view.windows).toEqual([]);
  expect(view.note).toContain("Cached observation");
});
test("past resets remain historical; future resets do not make snapshots live", () => {
  const value = snapshot([
    { id: "primary", usedPercent: 100, resetsAt: "2026-10-12T12:00:00Z", status: "exhausted" },
  ]);
  const before = modelAccountUsage(value, Date.parse("2026-10-12T11:00:00Z"));
  const after = modelAccountUsage(value, Date.parse("2026-10-12T13:00:00Z"));
  expect(before.windows?.[0]?.detail).toContain("Resets");
  // The neutral primary/secondary IDs do not supply a window duration.
  expect(before.windows?.[0]?.label).toBe("Primary");
  expect(after.windows?.[0]?.detail).toContain("Reset time passed; current usage unknown");
  expect(after.windows?.[0]?.usedPercent).toBe(100);
  expect(after.windows?.[0]?.detail).toContain("Observed exhausted");
  expect(before.note).toContain("Cached observation");
});
