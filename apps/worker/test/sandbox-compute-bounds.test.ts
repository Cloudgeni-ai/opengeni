import { describe, expect, test } from "bun:test";
import { DEFAULT_SANDBOX_PLAN_LIMITS } from "@opengeni/config";
import type { NoTurnWarmLease } from "@opengeni/db";
import { SandboxOrganizationBoxLimitError, SandboxLeaseTransitionError } from "@opengeni/db";
import { agentRunFailurePayload } from "../src/activities/agent-turn/errors";
import { isLazySandboxProvisionRetryable } from "../src/activities/agent-turn/sandbox-provision";
import {
  organizationHasComputeBounds,
  planComputeBoundsDrains,
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
        [lease({ lastActiveAt: idle, openSessionWork: true })],
        organizations,
        { idleDrainMs: 1_800_000 },
      ),
    ).toEqual([]);
    // 0 disables idle draining.
    expect(
      planComputeBoundsDrains([lease({ lastActiveAt: idle })], organizations, { idleDrainMs: 0 }),
    ).toEqual([]);
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
