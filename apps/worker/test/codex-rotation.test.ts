import { describe, expect, test } from "bun:test";
import type { CodexAccountStatus } from "@opengeni/db";
import {
  availableAt,
  chooseRotationActive,
  computeIdleDelayMs,
  DEFAULT_RESET_COOLDOWN_MS,
  MIN_IDLE_MS,
} from "../src/activities/codex-rotation";

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

// P3 all-capped infinite-loop bugfix. The original availableAt() seeded EPOCH0 (1970)
// and used it as the fallback for a null/elapsed reset, so an over-threshold account
// with a NULL or already-elapsed cached reset yielded a PAST instant; earliestReset MINs
// across accounts → allCapped.earliestResetAt in the deep past → continueDelayMs =
// max(0, past − now) = 0 → a tight CPU/DB-hammering re-dispatch loop (invariant 4 violated).
const MAX_RESUME_MS = 60 * 60_000; // mirrors CODEX_USAGE_LIMIT_MAX_RESUME_MS (1h)

describe("P3 all-capped idle — POSITIVE bounded delay, never 0 (invariant 4: NO THRASH)", () => {
  test("(a) all-capped with a NULL resetAt → future earliestReset → positive bounded delay (>= MIN_IDLE_MS), never 0", () => {
    const accounts = [
      acct("a", { primaryUsedPercent: 99, primaryResetAt: null }), // over-threshold, unknown reset
      acct("b", { primaryUsedPercent: 99, primaryResetAt: null }),
    ];
    const decision = chooseRotationActive({ ...base, activeCredentialId: "a", accounts });
    expect(decision.kind).toBe("allCapped");
    if (decision.kind === "allCapped") {
      // Pre-fix this was EPOCH0 (1970) — a PAST instant. It must now be in the FUTURE.
      expect(decision.earliestResetAt.getTime()).toBeGreaterThan(NOW.getTime());
      const delay = computeIdleDelayMs(decision.earliestResetAt, NOW, MAX_RESUME_MS);
      expect(delay).toBeGreaterThanOrEqual(MIN_IDLE_MS);
      expect(delay).toBeGreaterThan(0);
    }
  });

  test("(b) all-capped with an ELAPSED resetAt → future earliestReset → positive bounded delay, never 0", () => {
    const accounts = [
      acct("a", { primaryUsedPercent: 99, primaryResetAt: new Date(NOW.getTime() - HOUR) }),       // 5h reset already passed
      acct("b", { secondaryUsedPercent: 99, secondaryResetAt: new Date(NOW.getTime() - 5 * HOUR) }), // weekly reset already passed
    ];
    const decision = chooseRotationActive({ ...base, activeCredentialId: "a", accounts });
    expect(decision.kind).toBe("allCapped");
    if (decision.kind === "allCapped") {
      expect(decision.earliestResetAt.getTime()).toBeGreaterThan(NOW.getTime());
      const delay = computeIdleDelayMs(decision.earliestResetAt, NOW, MAX_RESUME_MS);
      expect(delay).toBeGreaterThanOrEqual(MIN_IDLE_MS);
      expect(delay).toBeGreaterThan(0);
    }
  });

  test("computeIdleDelayMs clamps into [MIN_IDLE_MS, max]: a past instant floors to MIN_IDLE_MS, never 0 or negative", () => {
    expect(computeIdleDelayMs(new Date(NOW.getTime() - HOUR), NOW, MAX_RESUME_MS)).toBe(MIN_IDLE_MS);
    expect(computeIdleDelayMs(NOW, NOW, MAX_RESUME_MS)).toBe(MIN_IDLE_MS);
    expect(computeIdleDelayMs(new Date(NOW.getTime() + 5 * HOUR), NOW, MAX_RESUME_MS)).toBe(MAX_RESUME_MS); // capped
    expect(computeIdleDelayMs(new Date(NOW.getTime() + 10 * 60_000), NOW, MAX_RESUME_MS)).toBe(10 * 60_000);
  });
});

describe("availableAt — never a past instant for an over-threshold account (invariant 4)", () => {
  test("(c) over-threshold account with a NULL reset → now + default cooldown, NOT the past", () => {
    const at = availableAt(acct("a", { primaryUsedPercent: 99, primaryResetAt: null }), 90, NOW);
    expect(at.getTime()).toBe(NOW.getTime() + DEFAULT_RESET_COOLDOWN_MS);
    expect(at.getTime()).toBeGreaterThan(NOW.getTime());
  });

  test("(c) over-threshold account with an ELAPSED reset → future, not the stale past instant", () => {
    const at = availableAt(acct("a", { secondaryUsedPercent: 99, secondaryResetAt: new Date(NOW.getTime() - HOUR) }), 90, NOW);
    expect(at.getTime()).toBeGreaterThan(NOW.getTime());
  });

  test("(c) needs_relogin / error account (ineligible, no quota block) → future cooldown, not EPOCH0", () => {
    expect(availableAt(acct("a", { status: "needs_relogin" }), 90, NOW).getTime()).toBeGreaterThan(NOW.getTime());
    expect(availableAt(acct("b", { status: "error" }), 90, NOW).getTime()).toBeGreaterThan(NOW.getTime());
  });

  test("a KNOWN future reset is honored exactly (the cooldown default only fills unknown/elapsed)", () => {
    const at = availableAt(acct("a", { primaryUsedPercent: 99, primaryResetAt: new Date(NOW.getTime() + 3 * HOUR) }), 90, NOW);
    expect(at.getTime()).toBe(NOW.getTime() + 3 * HOUR);
  });

  test("clears EVERY block: a future cooldown AND a future window reset ⇒ the LATER instant", () => {
    const at = availableAt(
      acct("a", { primaryUsedPercent: 99, primaryResetAt: new Date(NOW.getTime() + HOUR), exhaustedUntil: new Date(NOW.getTime() + 2 * HOUR) }),
      90,
      NOW,
    );
    expect(at.getTime()).toBe(NOW.getTime() + 2 * HOUR);
  });
});

describe("P3 self-heal + bounded reactive walk (invariant 4)", () => {
  test("(d) SELF-HEAL: a refreshed (genuinely-reset) window makes the account eligible again — no permanent idle", () => {
    // Stale cache: both over-threshold → allCapped (the would-be idle).
    const stale = [acct("a", { primaryUsedPercent: 99 }), acct("b", { primaryUsedPercent: 99 })];
    expect(chooseRotationActive({ ...base, activeCredentialId: "a", accounts: stale }).kind).toBe("allCapped");
    // After the all-capped path refreshes usage, b's 5h window has ACTUALLY reset (low pct):
    // the re-rank must now pick b instead of idling forever on the stale percent.
    const healed = [acct("a", { primaryUsedPercent: 99 }), acct("b", { primaryUsedPercent: 5 })];
    expect(chooseRotationActive({ ...base, activeCredentialId: "a", accounts: healed }))
      .toEqual({ kind: "active", credentialId: "b", moved: true });
  });

  test("(e) BOUNDED reactive retry: N accounts ⇒ at most N rotations ⇒ fixed idle (never re-picks a cooled account, no spin)", () => {
    // Simulate the reactive 429 walk: each turn the serving account 429s, gets cooled
    // (exhaustedUntil future), and the engine re-ranks over the fresh list. It must never
    // re-pick a cooled account, so it drains to allCapped in at most N steps — bounded.
    let serving = "a";
    let accounts = [acct("a"), acct("b"), acct("c")];
    let rotations = 0;
    let idled = false;
    for (let step = 0; step < 20; step++) {
      // the serving account just 429'd → stamp its cooldown (the reactive cooldown write).
      accounts = accounts.map((x) => (x.id === serving ? { ...x, exhaustedUntil: new Date(NOW.getTime() + (step + 1) * HOUR) } : x));
      const decision = chooseRotationActive({ ...base, activeCredentialId: serving, priorCredentialId: serving, accounts });
      if (decision.kind === "allCapped") {
        idled = true;
        expect(decision.earliestResetAt.getTime()).toBeGreaterThan(NOW.getTime()); // a real future idle, not 1970
        break;
      }
      expect(decision.kind).toBe("active");
      if (decision.kind === "active") {
        // boundedness guarantee: the engine NEVER re-picks an already-cooled account.
        expect(accounts.find((x) => x.id === decision.credentialId)?.exhaustedUntil ?? null).toBeNull();
        serving = decision.credentialId;
        rotations++;
      }
    }
    expect(idled).toBe(true);            // it terminates in a fixed idle — no infinite spin
    expect(rotations).toBeLessThanOrEqual(3); // at most N rotations for N accounts
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
