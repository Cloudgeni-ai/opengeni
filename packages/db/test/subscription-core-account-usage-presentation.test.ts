import { afterAll, beforeAll, expect, test } from "bun:test";
import { projectSubscriptionCoreAccountUsage } from "../src/subscription-core/account-usage-presentation";

const at = "2026-10-12T09:00:00.000Z";
const reset = Date.parse("2026-10-12T14:00:00.000Z");
const row = (
  quota: unknown = {
    windows: [{ id: "five_hour", usedPercent: 42, resetsAt: reset, status: "ok" }],
    modelCooldowns: {},
    exhaustedUntil: null,
    exhaustedKind: null,
    source: "response_headers",
  },
) => ({
  quota,
  quota_revision: 7,
  quota_observed_refresh_generation: 3,
  quota_updated_at: at,
});
const realFetch = globalThis.fetch;
let networkCalls = 0;
beforeAll(() => {
  globalThis.fetch = (async () => {
    networkCalls += 1;
    throw new Error("Pure projection cannot use the network");
  }) as unknown as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  expect(networkCalls).toBe(0);
});

test("projects only normalized cached observation fields", () => {
  const input = {
    ...row(),
    credential_encrypted: "private fixture",
    provider_state: { secret: "private" },
    last_error: "private failure",
  };
  expect(projectSubscriptionCoreAccountUsage(input)).toEqual({
    observedAt: at,
    source: "response_headers",
    windows: [
      { id: "five_hour", usedPercent: 42, resetsAt: "2026-10-12T14:00:00.000Z", status: "ok" },
    ],
    exhaustedUntil: null,
    exhaustedKind: null,
  });
});

test.each(
  [
    null,
    [],
    "raw payload",
    {},
    { windows: [], modelCooldowns: null },
    {
      windows: [{ id: "window", usedPercent: Number.NaN, resetsAt: null, status: "ok" }],
      modelCooldowns: {},
    },
  ].map((quota) => ({ quota })),
)("missing or malformed observations remain unknown: %j", ({ quota }) => {
  expect(projectSubscriptionCoreAccountUsage(row(quota))).toBeNull();
});

test("an unfenced observation is not exposed; old fenced observations remain cached", () => {
  expect(
    projectSubscriptionCoreAccountUsage({ ...row(), quota_observed_refresh_generation: null }),
  ).toBeNull();
  expect(
    projectSubscriptionCoreAccountUsage({ ...row(), quota_observed_refresh_generation: 1 }),
  ).toEqual(projectSubscriptionCoreAccountUsage(row()));
});

test("preserves unknown percentages and non-capacity window statuses without inventing zero", () => {
  const output = projectSubscriptionCoreAccountUsage(
    row({
      windows: [
        { id: "seven_day_opus", usedPercent: 100, resetsAt: reset, status: "unknown" },
        { id: "overage", usedPercent: 125, resetsAt: null, status: "unknown" },
        { id: "billing", usedPercent: null, resetsAt: null, status: "unknown" },
        { id: "invalid", usedPercent: -2, resetsAt: null, status: "unknown" },
      ],
      modelCooldowns: { "private-model": reset },
      source: "usage_endpoint",
    }),
  );
  expect(output?.windows.map((window) => window.usedPercent)).toEqual([100, 125, null, null]);
  expect(output?.windows.every((window) => window.status === "unknown")).toBe(true);
  expect(JSON.stringify(output)).not.toContain("private-model");
});

test("past reset and stale observation remain historical, never a fresh full allowance", () => {
  const old = "2020-01-01T00:00:00.000Z";
  const output = projectSubscriptionCoreAccountUsage({
    ...row({
      windows: [
        { id: "primary", usedPercent: 100, resetsAt: Date.parse(old), status: "exhausted" },
      ],
      modelCooldowns: {},
      exhaustedUntil: Date.parse(old),
      exhaustedKind: "quota",
      source: "refusal",
    }),
    quota_updated_at: old,
  });
  expect(output).toMatchObject({
    observedAt: old,
    source: "refusal",
    exhaustedUntil: old,
    exhaustedKind: "quota",
    windows: [{ id: "primary", usedPercent: 100, resetsAt: old, status: "exhausted" }],
  });
});

test("an empty observation with a rate limit is distinct from no observation", () => {
  expect(
    projectSubscriptionCoreAccountUsage(
      row({
        windows: [],
        modelCooldowns: {},
        exhaustedUntil: reset,
        exhaustedKind: "rate_limit",
        source: "refusal",
      }),
    ),
  ).toMatchObject({
    windows: [],
    exhaustedUntil: "2026-10-12T14:00:00.000Z",
    exhaustedKind: "rate_limit",
  });
});

test("partial observations are not completed or relabeled; no per-window timestamps invented", () => {
  const output = projectSubscriptionCoreAccountUsage(
    row({
      windows: [{ id: "secondary", usedPercent: 17, resetsAt: null, status: "warning" }],
      modelCooldowns: {},
      source: "usage_endpoint",
    }),
  );
  expect(output?.windows).toEqual([
    { id: "secondary", usedPercent: 17, resetsAt: null, status: "warning" },
  ]);
  expect(output).not.toHaveProperty("complete");
  expect(output?.windows[0]).not.toHaveProperty("observedAt");
});

test("null or invalid timestamps remain unknown without dropping real readings or throwing", () => {
  for (const value of [null, "invalid date", new Date(Number.NaN), new Date(1e15)]) {
    const output = projectSubscriptionCoreAccountUsage({ ...row(), quota_updated_at: value });
    expect(output?.observedAt).toBeNull();
    expect(output?.windows[0]?.usedPercent).toBe(42);
  }
  const output = projectSubscriptionCoreAccountUsage(
    row({
      windows: [{ id: "billing", usedPercent: 9, resetsAt: 1e100, status: "ok" }],
      modelCooldowns: {},
      exhaustedUntil: 1e100,
      exhaustedKind: "quota",
    }),
  );
  expect(output?.windows[0]?.resetsAt).toBeNull();
  expect(output?.exhaustedUntil).toBeNull();
});

test("does not mutate the authorized input or share mutable windows", () => {
  const input = row();
  const before = structuredClone(input);
  const output = projectSubscriptionCoreAccountUsage(input)!;
  output.windows[0]!.usedPercent = 99;
  expect(input).toEqual(before);
  expect(projectSubscriptionCoreAccountUsage(input)?.windows[0]?.usedPercent).toBe(42);
});
