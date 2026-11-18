import { describe, expect, test } from "bun:test";
import { DEFAULT_SANDBOX_PLAN_LIMITS } from "@opengeni/config";
import type { Database, NoTurnWarmLease } from "@opengeni/db";
import {
  resetSandboxFleetState,
  SandboxOrganizationBoxLimitError,
  SandboxLeaseTransitionError,
} from "@opengeni/db";
import { testSettings } from "@opengeni/testing/settings";
import { agentRunFailurePayload } from "../src/activities/agent-turn/errors";
import { isLazySandboxProvisionRetryable } from "../src/activities/agent-turn/sandbox-provision";
import { initializeWorkerOutcomeMetrics } from "../src/observability-metrics";
import {
  observeUnpaidSandboxFleet,
  organizationHasComputeBounds,
  planComputeBoundsDrains,
  unpaidSandboxFleetState,
  youngOrganizationTurnless,
} from "../src/activities/sandbox-compute-bounds";

const observedAt = new Date("2026-11-17T12:00:00.000Z");

function lease(overrides: Partial<NoTurnWarmLease> = {}): NoTurnWarmLease {
  return {
    accountId: "org-a",
    workspaceId: "ws-a",
    sandboxGroupId: "group-a",
    leaseEpoch: 3,
    viewerHolders: 0,
    lastActiveAt: new Date(observedAt.getTime() - 60_000),
    observedAt,
    interactionReported: false,
    openSessionWork: false,
    transitioning: false,
    holders: 1,
    commandHolders: 1,
    backend: "modal",
    ...overrides,
  };
}

const free = DEFAULT_SANDBOX_PLAN_LIMITS.free!;
const restricted = DEFAULT_SANDBOX_PLAN_LIMITS.restricted!;

describe("free compute bounds: reaper decisions", () => {
  test("only unpaid tiers call for the pass", () => {
    expect(organizationHasComputeBounds(free)).toBe(true);
    expect(organizationHasComputeBounds(restricted)).toBe(true);
    expect(organizationHasComputeBounds(DEFAULT_SANDBOX_PLAN_LIMITS.none!)).toBe(true);
    expect(organizationHasComputeBounds(DEFAULT_SANDBOX_PLAN_LIMITS.pro ?? {})).toBe(false);
    expect(organizationHasComputeBounds(DEFAULT_SANDBOX_PLAN_LIMITS.embedded ?? {})).toBe(false);
    expect(organizationHasComputeBounds({})).toBe(false);
  });

  test("a closed tier drains every box no turn holds, active or not", () => {
    const decisions = planComputeBoundsDrains(
      [lease({ lastActiveAt: observedAt })],
      new Map([["org-a", { limit: restricted, boxSecondsToday: 0 }]]),
      { idleDrainMs: 1_800_000 },
    );
    expect(decisions.map((decision) => decision.reason)).toEqual(["compute_closed"]);
  });

  test("only a young unpaid organization is read for the turnless bound", async () => {
    const limits = { youngOrganizationAgeMs: 86_400_000, youngTurnlessBoxSeconds: 900 };
    const now = observedAt.getTime();
    // None of these reads the database.
    const db = null as unknown as Parameters<typeof youngOrganizationTurnless>[0];
    const young = new Date(now - 3_600_000);
    expect(
      await youngOrganizationTurnless(db, limits, {
        accountId: "a",
        unpaid: false,
        createdAt: young,
        now,
      }),
    ).toBe(false);
    expect(
      await youngOrganizationTurnless(db, limits, {
        accountId: "a",
        unpaid: true,
        createdAt: new Date(now - 2 * 86_400_000),
        now,
      }),
    ).toBe(false);
    expect(
      await youngOrganizationTurnless(db, limits, {
        accountId: "a",
        unpaid: true,
        createdAt: null,
        now,
      }),
    ).toBe(false);
    expect(
      await youngOrganizationTurnless(
        db,
        { youngOrganizationAgeMs: 86_400_000 },
        { accountId: "a", unpaid: true, createdAt: young, now },
      ),
    ).toBe(false);
  });

  test("a young organization that never started a turn has its turnless boxes drained once idle, never with commands running", () => {
    const bounds = new Map([["org-a", { limit: free, boxSecondsToday: 900, turnlessYoung: true }]]);
    const reasons = (leases: NoTurnWarmLease[]) =>
      planComputeBoundsDrains(leases, bounds, {
        idleDrainMs: 1_800_000,
        turnlessIdleMs: 300_000,
      }).map((decision) => decision.reason);
    const idle = new Date(observedAt.getTime() - 300_000);
    expect(reasons([lease({ lastActiveAt: idle, viewerHolders: 1, commandHolders: 0 })])).toEqual([
      "compute_turnless",
    ]);
    // Someone still using it, or a running command or Browser/ComputerSession, keeps it.
    expect(
      reasons([
        lease({
          lastActiveAt: new Date(observedAt.getTime() - 299_000),
          viewerHolders: 1,
          commandHolders: 0,
        }),
      ]),
    ).toEqual([]);
    expect(reasons([lease({ lastActiveAt: idle, commandHolders: 1 })])).toEqual([]);
    // A turn just queued keeps the box; a compute box keeps its own state.
    expect(
      reasons([lease({ lastActiveAt: idle, openSessionWork: true, commandHolders: 0 })]),
    ).toEqual([]);
    expect(reasons([lease({ lastActiveAt: idle, backend: "compute", commandHolders: 0 })])).toEqual(
      [],
    );
    // Without the flag (it chatted, is older or pays), an active box stays.
    expect(
      planComputeBoundsDrains(
        [lease({ lastActiveAt: observedAt })],
        new Map([["org-a", { limit: free, boxSecondsToday: 900 }]]),
        { idleDrainMs: 1_800_000 },
      ),
    ).toEqual([]);
  });

  test("a compute box drains only when its tier is closed, never for a spent day", () => {
    const box = lease({ backend: "compute", lastActiveAt: observedAt, commandHolders: 0 });
    expect(
      planComputeBoundsDrains(
        [box],
        new Map([["org-a", { limit: free, boxSecondsToday: 1_000_000 }]]),
        { idleDrainMs: 1_800_000 },
      ),
    ).toEqual([]);
    expect(
      planComputeBoundsDrains(
        [box],
        new Map([["org-a", { limit: restricted, boxSecondsToday: 0 }]]),
        { idleDrainMs: 1_800_000 },
      ).map((decision) => decision.reason),
    ).toEqual(["compute_closed"]);
  });

  test("a spent day drains active boxes; an unspent day keeps them", () => {
    const active = lease({ lastActiveAt: observedAt });
    expect(
      planComputeBoundsDrains(
        [active],
        new Map([["org-a", { limit: free, boxSecondsToday: 43_200 }]]),
        { idleDrainMs: 1_800_000 },
      ).map((decision) => decision.reason),
    ).toEqual(["compute_daily_budget"]);
    expect(
      planComputeBoundsDrains(
        [active],
        new Map([["org-a", { limit: free, boxSecondsToday: 43_199 }]]),
        { idleDrainMs: 1_800_000 },
      ),
    ).toEqual([]);
  });

  test("an idle box drains whatever holds it, unless its sessions have open work", () => {
    const idle = new Date(observedAt.getTime() - 1_800_000);
    const organizations = new Map([["org-a", { limit: free, boxSecondsToday: 0 }]]);
    expect(
      planComputeBoundsDrains([lease({ lastActiveAt: idle })], organizations, {
        idleDrainMs: 1_800_000,
      }).map((decision) => decision.reason),
    ).toEqual(["compute_idle"]);
    expect(
      planComputeBoundsDrains(
        [lease({ lastActiveAt: idle, openSessionWork: true, commandHolders: 0 })],
        organizations,
        { idleDrainMs: 1_800_000 },
      ),
    ).toEqual([]);
    // 0 disables idle draining.
    expect(
      planComputeBoundsDrains([lease({ lastActiveAt: idle })], organizations, { idleDrainMs: 0 }),
    ).toEqual([]);
    // A compute box is never drained for being idle; a closed tier still
    // drains it.
    expect(
      planComputeBoundsDrains([lease({ lastActiveAt: idle, backend: "compute" })], organizations, {
        idleDrainMs: 1_800_000,
      }),
    ).toEqual([]);
    expect(
      planComputeBoundsDrains(
        [lease({ lastActiveAt: idle, backend: "compute" })],
        new Map([["org-a", { limit: restricted, boxSecondsToday: 0 }]]),
        { idleDrainMs: 1_800_000 },
      ).map((decision) => decision.reason),
    ).toEqual(["compute_closed"]);
  });

  test("boxes of organizations without bounds and transitioning boxes are left alone", () => {
    expect(
      planComputeBoundsDrains(
        [lease({ accountId: "paid" }), lease({ transitioning: true })],
        new Map([["org-a", { limit: restricted, boxSecondsToday: 0 }]]),
        { idleDrainMs: 1_800_000 },
      ),
    ).toEqual([]);
  });
});

describe("free compute bounds: turns refused by the plan", () => {
  test("fail with the person-facing reason instead of retrying", () => {
    for (const reason of ["closed", "daily_budget"] as const) {
      const refusal = new SandboxOrganizationBoxLimitError(
        "ws",
        "group",
        reason === "closed" ? 0 : 43_200,
        reason,
      );
      const wrapped = new Error("sandbox establishment failed", { cause: refusal });
      const payload = agentRunFailurePayload(wrapped);
      expect(payload.code).toBe("sandbox_compute_unavailable");
      expect(payload.retryable).toBe(false);
      expect(payload.error).toBe(refusal.message);
      expect(isLazySandboxProvisionRetryable(wrapped)).toBe(false);
    }
  });

  test("a closed tier and a spent day explain themselves", () => {
    expect(new SandboxOrganizationBoxLimitError("ws", "group", 0, "closed").message).not.toBe(
      new SandboxOrganizationBoxLimitError("ws", "group", 43_200, "daily_budget").message,
    );
    expect(
      new SandboxOrganizationBoxLimitError("ws", "group", 43_200, "daily_budget").message,
    ).toContain("12 sandbox hours");
    expect(new SandboxOrganizationBoxLimitError("ws", "group", 2, "running").message).toContain(
      "2",
    );
  });

  test("a full running budget still waits for a slot", () => {
    const fenced = new SandboxLeaseTransitionError(
      "group",
      1,
      "organization_sandbox_capacity",
      "modal",
      null,
      "cold",
      2,
    );
    expect(isLazySandboxProvisionRetryable(fenced)).toBe(false);
  });
});

describe("unpaid fleet limits", () => {
  test("a fleet refusal fails the turn as busy shared capacity, without waiting", () => {
    for (const reason of ["fleet_busy", "fleet_daily_budget"] as const) {
      const refusal = new SandboxOrganizationBoxLimitError("ws", "group", 40, reason);
      expect(refusal.code).toBe("sandbox_capacity_unpaid_busy");
      const wrapped = new Error("sandbox establishment failed", { cause: refusal });
      const payload = agentRunFailurePayload(wrapped);
      expect(payload.code).toBe("sandbox_capacity_unpaid_busy");
      expect(payload.retryable).toBe(false);
      expect(payload.error).toBe(refusal.message);
      expect(isLazySandboxProvisionRetryable(wrapped)).toBe(false);
    }
    expect(new SandboxOrganizationBoxLimitError("ws", "group", 1, "young_running").code).toBe(
      "sandbox_compute_unavailable",
    );
  });

  test("every fleet state is published at zero from start, so its first pass alerts", () => {
    const counters: Array<{ name: string; labels?: Record<string, string>; amount?: number }> = [];
    initializeWorkerOutcomeMetrics({
      incrementCounter: (input: (typeof counters)[number]) => counters.push(input),
    } as unknown as Parameters<typeof initializeWorkerOutcomeMetrics>[0]);
    const fleet = counters.filter(
      (counter) => counter.name === "opengeni_sandbox_unpaid_fleet_checks_total",
    );
    expect(fleet.map((counter) => [counter.labels?.state, counter.amount])).toEqual([
      ["normal", 0],
      ["pressure", 0],
      ["daily_budget_exhausted", 0],
    ]);
  });

  test("the reaper reports a spent day before pressure", () => {
    const limits = { unpaidBoxSecondsPerDay: 100 };
    expect(
      unpaidSandboxFleetState(limits, { pressureEngaged: false, unpaidBoxSecondsToday: 99 }),
    ).toBe("normal");
    expect(
      unpaidSandboxFleetState(limits, { pressureEngaged: true, unpaidBoxSecondsToday: 99 }),
    ).toBe("pressure");
    expect(
      unpaidSandboxFleetState(limits, { pressureEngaged: true, unpaidBoxSecondsToday: 100 }),
    ).toBe("daily_budget_exhausted");
    expect(
      unpaidSandboxFleetState({}, { pressureEngaged: false, unpaidBoxSecondsToday: 1e9 }),
    ).toBe("normal");
    expect(
      unpaidSandboxFleetState(limits, { pressureEngaged: false, unpaidBoxSecondsToday: null }),
    ).toBe("normal");
  });

  test("without subscription plans the reaper neither reads nor reports fleet pressure", async () => {
    // The text of a drizzle query, enough to tell the reads apart.
    const text = (value: unknown): string => {
      if (typeof value === "string") return value;
      if (Array.isArray(value)) return value.map(text).join("");
      if (value && typeof value === "object") {
        const chunk = value as { queryChunks?: unknown; value?: unknown };
        return text(chunk.queryChunks ?? chunk.value ?? "");
      }
      return "";
    };
    // 220 warm leases (on a deployment of Connected Machines), and no fleet
    // definer granted.
    const warmReads: string[] = [];
    const db = {
      execute: async (query: unknown) => {
        const sql = text(query);
        if (sql.includes("has_function_privilege")) return [{ available: false }];
        warmReads.push(sql);
        return [{ liveness: "warm", count: 220 }];
      },
    } as unknown as Database;
    const observe = async (subscriptionPlansEnabled: boolean) => {
      resetSandboxFleetState();
      warmReads.length = 0;
      const counters: Array<{ name: string; labels?: Record<string, string> }> = [];
      const gauges: Array<{ name: string; value: number }> = [];
      const state = await observeUnpaidSandboxFleet({
        db,
        settings: testSettings({ subscriptionPlansEnabled }),
        observability: {
          incrementCounter: (input: (typeof counters)[number]) => counters.push(input),
          setGauge: (input: (typeof gauges)[number]) => gauges.push(input),
          warn: () => {},
        } as unknown as Parameters<typeof observeUnpaidSandboxFleet>[0]["observability"],
      });
      return {
        state,
        reads: warmReads.length,
        checks: counters
          .filter((counter) => counter.name === "opengeni_sandbox_unpaid_fleet_checks_total")
          .map((counter) => counter.labels?.state),
        warmGauge: gauges.find((gauge) => gauge.name === "opengeni_sandbox_fleet_warm_boxes")
          ?.value,
      };
    };
    // No organization is unpaid by its tier there, so pressure limits nobody.
    expect(await observe(false)).toEqual({
      state: "normal",
      reads: 0,
      checks: ["normal"],
      warmGauge: undefined,
    });
    // With plans, the same warm count engages pressure (the default engage
    // level is 50).
    expect(await observe(true)).toEqual({
      state: "pressure",
      reads: 1,
      checks: ["pressure"],
      warmGauge: 220,
    });
    resetSandboxFleetState();
  });
});
