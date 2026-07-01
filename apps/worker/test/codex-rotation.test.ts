import { describe, expect, test } from "bun:test";
import type { CodexAccountStatus } from "@opengeni/db";
import {
  availableAt,
  chooseRotationActive,
  computeIdleDelayMs,
  computeReactiveRotationResume,
  DEFAULT_RESET_COOLDOWN_MS,
  MIN_IDLE_MS,
  REACTIVE_CIRCUIT_BREAKER_IDLE_MS,
  REACTIVE_PERSISTENCE_FAULT_FLOOR_MS,
  REACTIVE_ROTATION_MARGIN,
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
    connectorNamespaces: null,
    connectorsCheckedAt: null,
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

// P4 — connector-aware rotation (prefer-not-require). The ranker PREFERS a failover
// target whose connector set COVERS the leaving session's used connectors, but still
// fails over to a lesser-coverage account when that is the only one with quota. When
// usedConnectors is empty the ranker is byte-identical to P3.
describe("chooseRotationActive — connector-aware (P4, most_remaining)", () => {
  test("empty usedConnectors → byte-identical to P3 (max remaining wins, no dropped note)", () => {
    const accounts = [
      acct("a", { primaryUsedPercent: 95 }),                                    // active, near-cap
      acct("b", { primaryUsedPercent: 40, connectorNamespaces: ["github"] }),   // 60 remaining
      acct("c", { primaryUsedPercent: 10, connectorNamespaces: [] }),           // 90 remaining ← winner
    ];
    expect(chooseRotationActive({ ...base, activeCredentialId: "a", accounts, usedConnectors: [] }))
      .toEqual({ kind: "active", credentialId: "c", moved: true });
  });

  test("PREFERS a covering target even when a non-covering one has MORE remaining quota", () => {
    const accounts = [
      acct("a", { primaryUsedPercent: 95, connectorNamespaces: ["github"] }),                 // active, near-cap (leaving)
      acct("b", { primaryUsedPercent: 50, connectorNamespaces: ["github", "gmail"] }),        // covers github, 50 remaining ← winner
      acct("c", { primaryUsedPercent: 5, connectorNamespaces: ["gmail"] }),                   // 95 remaining BUT lacks github
    ];
    // Session used github (the leaving account's set). c has the most quota but can't
    // cover github → Tier 1 = {b}; b is chosen despite less remaining. No dropped note.
    expect(chooseRotationActive({ ...base, activeCredentialId: "a", accounts, usedConnectors: ["github"] }))
      .toEqual({ kind: "active", credentialId: "b", moved: true });
  });

  test("FAILS OVER to a non-covering account when it is the ONLY one with quota (+ dropped note)", () => {
    const accounts = [
      acct("a", { primaryUsedPercent: 99, connectorNamespaces: ["github"] }),                 // active, capped (leaving)
      acct("b", { primaryUsedPercent: 99, connectorNamespaces: ["github", "gmail"] }),        // covers BUT also capped
      acct("c", { primaryUsedPercent: 10, connectorNamespaces: ["gmail"] }),                  // eligible BUT lacks github
    ];
    // Tier 1 (covering) is empty among eligibles → Tier 2 = {c}: failover preserved,
    // and the dropped-connector note surfaces github so the pill can warn.
    expect(chooseRotationActive({ ...base, activeCredentialId: "a", accounts, usedConnectors: ["github"] }))
      .toEqual({ kind: "active", credentialId: "c", moved: true, droppedConnectors: ["github"] });
  });

  test("null (never-probed) connector set is UNKNOWN: never Tier 1, never excluded, dropped note lists the used set", () => {
    const accounts = [
      acct("a", { primaryUsedPercent: 99, connectorNamespaces: ["github"] }), // active, capped (leaving)
      acct("b", { primaryUsedPercent: 10, connectorNamespaces: null }),       // unprobed → Tier 2 only, but eligible
    ];
    // No covering eligible (b is unknown) → Tier 2 picks b (failover), and since we
    // can't prove b covers github, the note surfaces it.
    expect(chooseRotationActive({ ...base, activeCredentialId: "a", accounts, usedConnectors: ["github"] }))
      .toEqual({ kind: "active", credentialId: "b", moved: true, droppedConnectors: ["github"] });
  });

  test("healthy-active fast path is UNCHANGED by coverage (no switch for connectors)", () => {
    const accounts = [
      acct("a", { primaryUsedPercent: 10, connectorNamespaces: [] }),                  // active, healthy, lacks github
      acct("b", { primaryUsedPercent: 5, connectorNamespaces: ["github"] }),           // covers github, more remaining
    ];
    // Even though b covers github and a does not, the still-eligible active account
    // never switches for coverage — no-thrash. No move, no dropped note.
    expect(chooseRotationActive({ ...base, activeCredentialId: "a", accounts, usedConnectors: ["github"] }))
      .toEqual({ kind: "active", credentialId: "a", moved: false });
  });

  test("a covering target that is a strict SUPERSET covers (multi-connector session)", () => {
    const accounts = [
      acct("a", { primaryUsedPercent: 99, connectorNamespaces: ["github", "linear"] }),                 // capped (leaving)
      acct("b", { primaryUsedPercent: 50, connectorNamespaces: ["github", "linear", "gmail"] }),        // superset ← covers
      acct("c", { primaryUsedPercent: 5, connectorNamespaces: ["github"] }),                            // most quota but missing linear
    ];
    expect(chooseRotationActive({ ...base, activeCredentialId: "a", accounts, usedConnectors: ["github", "linear"] }))
      .toEqual({ kind: "active", credentialId: "b", moved: true });
  });
});

// Finding 1 (reactive-rotation boundedness). computeReactiveRotationResume bounds the
// reactive 429 failover's otherwise-0-delay re-dispatch against two second-order faults
// so a double-fault (cooldown write not persisted + a header-less cap 429 that re-picks
// the SAME account every proactive rank) degrades to a positive, bounded retry instead
// of a model-paced hot loop that hammers the capped backend + DB (invariant 4: NO THRASH).
describe("computeReactiveRotationResume — the reactive failover is bounded", () => {
  test("(4) happy path: a confirmed cooldown + first failover → 0-delay fast re-dispatch (byte-identical to P3)", () => {
    // A single rotation onto a live candidate: the just-served account IS cooling, so
    // the next rank cannot re-pick it. Re-dispatch NOW, no hold, no idleUntilReset.
    expect(computeReactiveRotationResume({ cooldownPersisted: true, priorConsecutiveRotations: 0, connectedAccountCount: 3 }))
      .toEqual({ continueDelayMs: 0, idleUntilReset: false });
  });

  test("(1a) persistence fault: cooldown NOT confirmed persisted → POSITIVE slow-retry floor, never 0", () => {
    const resume = computeReactiveRotationResume({ cooldownPersisted: false, priorConsecutiveRotations: 0, connectedAccountCount: 3 });
    expect(resume.continueDelayMs).toBe(REACTIVE_PERSISTENCE_FAULT_FLOOR_MS);
    expect(resume.continueDelayMs).toBeGreaterThan(0);   // the crux: a persistence fault never yields a 0-delay hot loop
    expect(resume.idleUntilReset).toBe(false);           // a slow retry, not a mandatory long hold
  });

  test("(1b) double-fault below the bound still floors positive (persistence fault dominates the 0)", () => {
    // 2 prior + this = streak 3, bound = 2 accounts + margin(2) = 4 → in bounds, but the
    // unpersisted cooldown still forces the positive floor rather than a 0.
    const resume = computeReactiveRotationResume({ cooldownPersisted: false, priorConsecutiveRotations: 2, connectedAccountCount: 2 });
    expect(resume.continueDelayMs).toBe(REACTIVE_PERSISTENCE_FAULT_FLOOR_MS);
    expect(resume.continueDelayMs).toBeGreaterThan(0);
  });

  test("(1b) once consecutive failovers EXCEED accounts + margin → FIXED mandatory idle (circuit breaker), never another 0", () => {
    const accounts = 2;
    const bound = accounts + REACTIVE_ROTATION_MARGIN; // 4
    // Walk the streak up to and past the bound; the double-fault keeps cooldown unpersisted.
    const at = (prior: number) => computeReactiveRotationResume({ cooldownPersisted: false, priorConsecutiveRotations: prior, connectedAccountCount: accounts });
    // streak = prior+1. In bounds (streak ≤ 4): positive slow-retry floor, not the breaker.
    expect(at(bound - 1)).toEqual({ continueDelayMs: REACTIVE_PERSISTENCE_FAULT_FLOOR_MS, idleUntilReset: false }); // streak 4 == bound
    // Over the bound (streak 5): the circuit breaker fires — a FIXED positive MANDATORY idle.
    const broken = at(bound); // streak 5 > 4
    expect(broken.continueDelayMs).toBe(REACTIVE_CIRCUIT_BREAKER_IDLE_MS);
    expect(broken.continueDelayMs).toBeGreaterThan(0);
    expect(broken.idleUntilReset).toBe(true);   // MANDATORY hold — session.ts can never collapse it to a 0-delay re-dispatch
  });

  test("(1b) the circuit breaker fires even when the cooldown DID persist (header-less caps can still re-pick)", () => {
    // Boundedness must not depend on the persistence result: an unbounded streak trips the breaker regardless.
    const broken = computeReactiveRotationResume({ cooldownPersisted: true, priorConsecutiveRotations: 10, connectedAccountCount: 2 });
    expect(broken.idleUntilReset).toBe(true);
    expect(broken.continueDelayMs).toBe(REACTIVE_CIRCUIT_BREAKER_IDLE_MS);
  });

  test("(2) a RESET streak (priorConsecutiveRotations back to 0 after a successful turn) returns to the 0-delay happy path", () => {
    // The DB counter resets to 0 on a successful turn (turn.completed anchor); the pure
    // decision must then behave exactly like a fresh first failover — no lingering hold.
    expect(computeReactiveRotationResume({ cooldownPersisted: true, priorConsecutiveRotations: 0, connectedAccountCount: 1 }))
      .toEqual({ continueDelayMs: 0, idleUntilReset: false });
  });

  test("more connected accounts raise the bound proportionally (a legit N-account walk never trips the breaker)", () => {
    // With N accounts a legitimate walk cools one per failover; the bound N+margin absorbs it.
    const accounts = 5;
    // streak N (== accounts) with cooldowns persisting stays on the fast path.
    expect(computeReactiveRotationResume({ cooldownPersisted: true, priorConsecutiveRotations: accounts - 1, connectedAccountCount: accounts }))
      .toEqual({ continueDelayMs: 0, idleUntilReset: false });
  });
});
