import { describe, expect, test } from "bun:test";
import type { CodexAccountStatus } from "@opengeni/db";
import { chooseRotationActive } from "../src/activities/codex-rotation";

// Multi-account P3 — the PURE rotation ranker. All rotation correctness (most_remaining
// selection, healthy-active no-op, cooldown exclusion, all-capped earliest-reset,
// boundedness) reduces to this function over the metadata-only account list.

const NOW = new Date("2026-06-30T12:00:00.000Z");
const HOUR = 3_600_000;

function acct(id: string, over: Partial<CodexAccountStatus> = {}): CodexAccountStatus {
  return {
    id,
    chatgptAccountId: `cg-${id}`,
    label: id,
    accountEmail: null,
    planType: "pro",
    status: "active",
    isActive: false,
    expiresAt: null,
    lastRefreshAt: null,
    lastError: null,
    primaryUsedPercent: 0,
    primaryResetAt: null,
    secondaryUsedPercent: 0,
    secondaryResetAt: null,
    usageCheckedAt: null,
    exhaustedUntil: null,
    ...over,
  };
}

const base = {
  rotationStrategy: "most_remaining" as const,
  priorCredentialId: null,
  nearExhaustionPct: 90,
  now: NOW,
};

describe("chooseRotationActive — most_remaining", () => {
  test("no accounts → none (preserves the relogin-fail path)", () => {
    expect(chooseRotationActive({ ...base, activeCredentialId: null, accounts: [] }))
      .toEqual({ kind: "none" });
  });

  test("healthy active account → no rotation, no move (minimal churn)", () => {
    const accounts = [acct("a", { primaryUsedPercent: 10 }), acct("b", { primaryUsedPercent: 5 })];
    expect(chooseRotationActive({ ...base, activeCredentialId: "a", accounts }))
      .toEqual({ kind: "active", credentialId: "a", moved: false });
  });

  test("active near-capped → rotate to the account with the most remaining quota", () => {
    const accounts = [
      acct("a", { primaryUsedPercent: 95 }),  // active, near-cap → ineligible
      acct("b", { primaryUsedPercent: 40 }),  // 60 remaining
      acct("c", { primaryUsedPercent: 10 }),  // 90 remaining ← winner
    ];
    expect(chooseRotationActive({ ...base, activeCredentialId: "a", accounts }))
      .toEqual({ kind: "active", credentialId: "c", moved: true });
  });

  test("weekly window binds as hard as 5h (worst-window used pct)", () => {
    const accounts = [
      acct("a", { primaryUsedPercent: 99 }),                              // active, capped
      acct("b", { primaryUsedPercent: 10, secondaryUsedPercent: 95 }),    // weekly near-cap → ineligible
      acct("c", { primaryUsedPercent: 50, secondaryUsedPercent: 50 }),    // eligible (50 remaining)
    ];
    expect(chooseRotationActive({ ...base, activeCredentialId: "a", accounts }))
      .toEqual({ kind: "active", credentialId: "c", moved: true });
  });

  test("remaining = min across windows (the scarcer window wins the ranking)", () => {
    const accounts = [
      acct("a", { primaryUsedPercent: 99 }),                            // active, capped
      acct("b", { primaryUsedPercent: 10, secondaryUsedPercent: 70 }),  // remaining = min(90,30)=30
      acct("c", { primaryUsedPercent: 20, secondaryUsedPercent: 20 }),  // remaining = min(80,80)=80 ← winner
    ];
    expect(chooseRotationActive({ ...base, activeCredentialId: "a", accounts }))
      .toEqual({ kind: "active", credentialId: "c", moved: true });
  });

  test("a cooling account is excluded even when it has the most remaining quota", () => {
    const accounts = [
      acct("a", { primaryUsedPercent: 99 }),                                          // active, capped
      acct("b", { primaryUsedPercent: 0, exhaustedUntil: new Date(NOW.getTime() + HOUR) }), // most remaining BUT cooling
      acct("c", { primaryUsedPercent: 40 }),                                          // eligible
    ];
    expect(chooseRotationActive({ ...base, activeCredentialId: "a", accounts }))
      .toEqual({ kind: "active", credentialId: "c", moved: true });
  });

  test("a cooldown in the past does NOT exclude (self-clears via now comparison)", () => {
    const accounts = [
      acct("a", { primaryUsedPercent: 99 }),                                              // active, capped
      acct("b", { primaryUsedPercent: 10, exhaustedUntil: new Date(NOW.getTime() - HOUR) }), // expired cooldown → eligible
    ];
    expect(chooseRotationActive({ ...base, activeCredentialId: "a", accounts }))
      .toEqual({ kind: "active", credentialId: "b", moved: true });
  });

  test("needs_relogin / error accounts are never eligible", () => {
    const accounts = [
      acct("a", { primaryUsedPercent: 99 }),                          // active, capped
      acct("b", { status: "needs_relogin", primaryUsedPercent: 0 }),  // unusable
      acct("c", { status: "error", primaryUsedPercent: 0 }),          // unusable
    ];
    const decision = chooseRotationActive({ ...base, activeCredentialId: "a", accounts });
    expect(decision.kind).toBe("allCapped");
  });

  test("ties broken deterministically by list (created_at) order", () => {
    const accounts = [
      acct("a", { primaryUsedPercent: 99 }),   // active, capped
      acct("b", { primaryUsedPercent: 30 }),   // 70 remaining ← first in order wins the tie
      acct("c", { primaryUsedPercent: 30 }),   // 70 remaining
    ];
    expect(chooseRotationActive({ ...base, activeCredentialId: "a", accounts }))
      .toEqual({ kind: "active", credentialId: "b", moved: true });
  });

  test("all eligible accounts capped → allCapped with the EARLIEST reset across all", () => {
    const accounts = [
      acct("a", { primaryUsedPercent: 99, primaryResetAt: new Date(NOW.getTime() + 3 * HOUR) }),
      acct("b", { primaryUsedPercent: 99, primaryResetAt: new Date(NOW.getTime() + 1 * HOUR) }), // soonest
      acct("c", { exhaustedUntil: new Date(NOW.getTime() + 2 * HOUR) }),
    ];
    const decision = chooseRotationActive({ ...base, activeCredentialId: "a", accounts });
    expect(decision.kind).toBe("allCapped");
    if (decision.kind === "allCapped") {
      expect(decision.earliestResetAt.getTime()).toBe(NOW.getTime() + 1 * HOUR);
    }
  });

  test("boundedness: each successive capped account drains to allCapped (walk once each)", () => {
    // Simulate the reactive walk: a, then b cooled; only b/c-style remains. After every
    // account is cooled the engine returns allCapped — never re-picks a cooled account.
    const cool = (until: number) => new Date(NOW.getTime() + until);
    const accounts = [
      acct("a", { exhaustedUntil: cool(HOUR) }),
      acct("b", { exhaustedUntil: cool(2 * HOUR) }),
      acct("c", { exhaustedUntil: cool(3 * HOUR) }),
    ];
    const decision = chooseRotationActive({ ...base, activeCredentialId: "a", accounts });
    expect(decision.kind).toBe("allCapped");
    if (decision.kind === "allCapped") {
      expect(decision.earliestResetAt.getTime()).toBe(NOW.getTime() + HOUR);
    }
  });
});

describe("chooseRotationActive — round_robin / drain_then_next", () => {
  test("round_robin picks the next eligible after the prior account (wraps)", () => {
    const accounts = [acct("a"), acct("b"), acct("c")];
    expect(chooseRotationActive({ ...base, rotationStrategy: "round_robin", activeCredentialId: "a", priorCredentialId: "a", accounts }))
      .toEqual({ kind: "active", credentialId: "b", moved: true });
    expect(chooseRotationActive({ ...base, rotationStrategy: "round_robin", activeCredentialId: "a", priorCredentialId: "c", accounts }))
      .toEqual({ kind: "active", credentialId: "a", moved: false });
  });

  test("round_robin skips a cooling/capped successor", () => {
    const accounts = [acct("a"), acct("b", { primaryUsedPercent: 99 }), acct("c")];
    expect(chooseRotationActive({ ...base, rotationStrategy: "round_robin", activeCredentialId: "a", priorCredentialId: "a", accounts }))
      .toEqual({ kind: "active", credentialId: "c", moved: true });
  });

  test("drain_then_next stays on the prior account while eligible, else first eligible", () => {
    const accounts = [acct("a"), acct("b")];
    expect(chooseRotationActive({ ...base, rotationStrategy: "drain_then_next", activeCredentialId: "a", priorCredentialId: "b", accounts }))
      .toEqual({ kind: "active", credentialId: "b", moved: true });
    const capped = [acct("a", { primaryUsedPercent: 99 }), acct("b")];
    expect(chooseRotationActive({ ...base, rotationStrategy: "drain_then_next", activeCredentialId: "a", priorCredentialId: "a", accounts: capped }))
      .toEqual({ kind: "active", credentialId: "b", moved: true });
  });
});
