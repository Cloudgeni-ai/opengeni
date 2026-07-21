import { describe, expect, test } from "bun:test";
import type { CodexAccountStatus, CodexLeaseAccountStatus } from "@opengeni/db";
import {
  availableAt,
  chooseRotationActive,
  chooseShardedHome,
  classifyCodexPin,
  computeIdleDelayMs,
  computeReactiveRotationResume,
  DEFAULT_RESET_COOLDOWN_MS,
  effectiveRotationStrategy,
  isCodexAccountEligible,
  MIN_IDLE_MS,
  REACTIVE_CIRCUIT_BREAKER_IDLE_MS,
  REACTIVE_PERSISTENCE_FAULT_FLOOR_MS,
  REACTIVE_ROTATION_MARGIN,
  shardCredentialForSession,
  type CodexRotationStrategy,
  selectCodexCredentialLeaseForTurn,
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
    allocatorEnabled: true,
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

function leasedAcct(
  id: string,
  over: Partial<CodexLeaseAccountStatus> = {},
): CodexLeaseAccountStatus {
  return {
    ...acct(id),
    activeLeaseCount: 0,
    selectionCount: 0,
    lastSelectedAt: null,
    ...over,
  };
}

const base = {
  rotationStrategy: "most_remaining" as const,
  priorCredentialId: null,
  now: NOW,
};

describe("chooseRotationActive — most_remaining", () => {
  test("no accounts → none (preserves the relogin-fail path)", () => {
    expect(chooseRotationActive({ ...base, activeCredentialId: null, accounts: [] })).toEqual({
      kind: "none",
    });
  });

  test("allocator-disabled accounts are excluded and an all-disabled pool is not a fake cooldown", () => {
    const disabled = acct("disabled", { allocatorEnabled: false });
    const healthy = acct("healthy");
    expect(
      chooseRotationActive({
        ...base,
        activeCredentialId: disabled.id,
        accounts: [disabled, healthy],
      }),
    ).toMatchObject({ kind: "active", credentialId: healthy.id });
    expect(
      chooseRotationActive({ ...base, activeCredentialId: disabled.id, accounts: [disabled] }),
    ).toEqual({ kind: "none" });
  });

  test("healthy active pointer is not sticky; higher capacity wins", () => {
    const accounts = [acct("a", { primaryUsedPercent: 10 }), acct("b", { primaryUsedPercent: 5 })];
    expect(chooseRotationActive({ ...base, activeCredentialId: "a", accounts })).toEqual({
      kind: "active",
      credentialId: "b",
      moved: true,
    });
  });

  test("new allocation ranks usable accounts by remaining quota without a 90% cliff", () => {
    const accounts = [
      acct("a", { primaryUsedPercent: 95 }), // still eligible, but least remaining
      acct("b", { primaryUsedPercent: 40 }), // 60 remaining
      acct("c", { primaryUsedPercent: 10 }), // 90 remaining ← winner
    ];
    expect(chooseRotationActive({ ...base, activeCredentialId: "a", accounts })).toEqual({
      kind: "active",
      credentialId: "c",
      moved: true,
    });
  });

  test("weekly window binds as hard as 5h (worst-window used pct)", () => {
    const accounts = [
      acct("a", { primaryUsedPercent: 100 }), // active, capped
      acct("b", { primaryUsedPercent: 10, secondaryUsedPercent: 95 }), // still eligible; weekly is binding
      acct("c", { primaryUsedPercent: 50, secondaryUsedPercent: 50 }), // eligible (50 remaining)
    ];
    expect(chooseRotationActive({ ...base, activeCredentialId: "a", accounts })).toEqual({
      kind: "active",
      credentialId: "c",
      moved: true,
    });
  });

  test("remaining = min across windows (the scarcer window wins the ranking)", () => {
    const accounts = [
      acct("a", { primaryUsedPercent: 100 }), // active, capped
      acct("b", { primaryUsedPercent: 10, secondaryUsedPercent: 70 }), // remaining = min(90,30)=30
      acct("c", { primaryUsedPercent: 20, secondaryUsedPercent: 20 }), // remaining = min(80,80)=80 ← winner
    ];
    expect(chooseRotationActive({ ...base, activeCredentialId: "a", accounts })).toEqual({
      kind: "active",
      credentialId: "c",
      moved: true,
    });
  });

  test("a cooling account is excluded even when it has the most remaining quota", () => {
    const accounts = [
      acct("a", { primaryUsedPercent: 100 }), // active, capped
      acct("b", { primaryUsedPercent: 0, exhaustedUntil: new Date(NOW.getTime() + HOUR) }), // most remaining BUT cooling
      acct("c", { primaryUsedPercent: 40 }), // eligible
    ];
    expect(chooseRotationActive({ ...base, activeCredentialId: "a", accounts })).toEqual({
      kind: "active",
      credentialId: "c",
      moved: true,
    });
  });

  test("a cooldown in the past does NOT exclude (self-clears via now comparison)", () => {
    const accounts = [
      acct("a", { primaryUsedPercent: 100 }), // active, capped
      acct("b", { primaryUsedPercent: 10, exhaustedUntil: new Date(NOW.getTime() - HOUR) }), // expired cooldown → eligible
    ];
    expect(chooseRotationActive({ ...base, activeCredentialId: "a", accounts })).toEqual({
      kind: "active",
      credentialId: "b",
      moved: true,
    });
  });

  test("needs_relogin / error accounts are never eligible", () => {
    const accounts = [
      acct("a", { primaryUsedPercent: 100 }), // active, capped
      acct("b", { status: "needs_relogin", primaryUsedPercent: 0 }), // unusable
      acct("c", { status: "error", primaryUsedPercent: 0 }), // unusable
    ];
    const decision = chooseRotationActive({ ...base, activeCredentialId: "a", accounts });
    expect(decision.kind).toBe("allCapped");
  });

  test("ties broken deterministically by list (created_at) order", () => {
    const accounts = [
      acct("a", { primaryUsedPercent: 100 }), // active, capped
      acct("b", { primaryUsedPercent: 30 }), // 70 remaining ← first in order wins the tie
      acct("c", { primaryUsedPercent: 30 }), // 70 remaining
    ];
    expect(chooseRotationActive({ ...base, activeCredentialId: "a", accounts })).toEqual({
      kind: "active",
      credentialId: "b",
      moved: true,
    });
  });

  test("all eligible accounts capped → allCapped with the EARLIEST reset across all", () => {
    const accounts = [
      acct("a", { primaryUsedPercent: 100, primaryResetAt: new Date(NOW.getTime() + 3 * HOUR) }),
      acct("b", { primaryUsedPercent: 100, primaryResetAt: new Date(NOW.getTime() + 1 * HOUR) }), // soonest
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
// and used it as the fallback for a null/elapsed reset, so an exhausted account
// with a NULL or already-elapsed cached reset yielded a PAST instant; earliestReset MINs
// across accounts → allCapped.earliestResetAt in the deep past → continueDelayMs =
// max(0, past − now) = 0 → a tight CPU/DB-hammering re-dispatch loop (invariant 4 violated).
const MAX_RESUME_MS = 60 * 60_000; // mirrors CODEX_USAGE_LIMIT_MAX_RESUME_MS (1h)

describe("P3 all-capped idle — POSITIVE bounded delay, never 0 (invariant 4: NO THRASH)", () => {
  test("(a) all-capped with a NULL resetAt → future earliestReset → positive bounded delay (>= MIN_IDLE_MS), never 0", () => {
    const accounts = [
      acct("a", { primaryUsedPercent: 100, primaryResetAt: null }), // exhausted, unknown reset
      acct("b", { primaryUsedPercent: 100, primaryResetAt: null }),
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

  test("(b) elapsed provider windows clear stale capped cache immediately", () => {
    const accounts = [
      acct("a", { primaryUsedPercent: 100, primaryResetAt: new Date(NOW.getTime() - HOUR) }), // 5h reset already passed
      acct("b", {
        secondaryUsedPercent: 100,
        secondaryResetAt: new Date(NOW.getTime() - 5 * HOUR),
      }), // weekly reset already passed
    ];
    const decision = chooseRotationActive({ ...base, activeCredentialId: "a", accounts });
    expect(decision.kind).toBe("active");
  });

  test("computeIdleDelayMs clamps into [MIN_IDLE_MS, max]: a past instant floors to MIN_IDLE_MS, never 0 or negative", () => {
    expect(computeIdleDelayMs(new Date(NOW.getTime() - HOUR), NOW, MAX_RESUME_MS)).toBe(
      MIN_IDLE_MS,
    );
    expect(computeIdleDelayMs(NOW, NOW, MAX_RESUME_MS)).toBe(MIN_IDLE_MS);
    expect(computeIdleDelayMs(new Date(NOW.getTime() + 5 * HOUR), NOW, MAX_RESUME_MS)).toBe(
      MAX_RESUME_MS,
    ); // capped
    expect(computeIdleDelayMs(new Date(NOW.getTime() + 10 * 60_000), NOW, MAX_RESUME_MS)).toBe(
      10 * 60_000,
    );
  });
});

describe("availableAt — never a past instant for an exhausted account (invariant 4)", () => {
  test("(c) exhausted account with a NULL reset → now + default cooldown, NOT the past", () => {
    const at = availableAt(acct("a", { primaryUsedPercent: 100, primaryResetAt: null }), NOW);
    expect(at.getTime()).toBe(NOW.getTime() + DEFAULT_RESET_COOLDOWN_MS);
    expect(at.getTime()).toBeGreaterThan(NOW.getTime());
  });

  test("(c) exhausted account with an ELAPSED reset → future, not the stale past instant", () => {
    const at = availableAt(
      acct("a", { secondaryUsedPercent: 100, secondaryResetAt: new Date(NOW.getTime() - HOUR) }),
      NOW,
    );
    expect(at.getTime()).toBeGreaterThan(NOW.getTime());
  });

  test("(c) needs_relogin / error account (ineligible, no quota block) → future cooldown, not EPOCH0", () => {
    expect(availableAt(acct("a", { status: "needs_relogin" }), NOW).getTime()).toBeGreaterThan(
      NOW.getTime(),
    );
    expect(availableAt(acct("b", { status: "error" }), NOW).getTime()).toBeGreaterThan(
      NOW.getTime(),
    );
  });

  test("a KNOWN future reset is honored exactly (the cooldown default only fills unknown/elapsed)", () => {
    const at = availableAt(
      acct("a", { primaryUsedPercent: 100, primaryResetAt: new Date(NOW.getTime() + 3 * HOUR) }),
      NOW,
    );
    expect(at.getTime()).toBe(NOW.getTime() + 3 * HOUR);
  });

  test("clears EVERY block: a future cooldown AND a future window reset ⇒ the LATER instant", () => {
    const at = availableAt(
      acct("a", {
        primaryUsedPercent: 100,
        primaryResetAt: new Date(NOW.getTime() + HOUR),
        exhaustedUntil: new Date(NOW.getTime() + 2 * HOUR),
      }),
      NOW,
    );
    expect(at.getTime()).toBe(NOW.getTime() + 2 * HOUR);
  });
});

describe("P3 self-heal + bounded reactive walk (invariant 4)", () => {
  test("(d) SELF-HEAL: a refreshed (genuinely-reset) window makes the account eligible again — no permanent idle", () => {
    // Stale cache: both exhausted → allCapped (the would-be idle).
    const stale = [acct("a", { primaryUsedPercent: 100 }), acct("b", { primaryUsedPercent: 100 })];
    expect(chooseRotationActive({ ...base, activeCredentialId: "a", accounts: stale }).kind).toBe(
      "allCapped",
    );
    // After the all-capped path refreshes usage, b's 5h window has ACTUALLY reset (low pct):
    // the re-rank must now pick b instead of idling forever on the stale percent.
    const healed = [acct("a", { primaryUsedPercent: 100 }), acct("b", { primaryUsedPercent: 5 })];
    expect(chooseRotationActive({ ...base, activeCredentialId: "a", accounts: healed })).toEqual({
      kind: "active",
      credentialId: "b",
      moved: true,
    });
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
      accounts = accounts.map((x) =>
        x.id === serving
          ? { ...x, exhaustedUntil: new Date(NOW.getTime() + (step + 1) * HOUR) }
          : x,
      );
      const decision = chooseRotationActive({
        ...base,
        activeCredentialId: serving,
        priorCredentialId: serving,
        accounts,
      });
      if (decision.kind === "allCapped") {
        idled = true;
        expect(decision.earliestResetAt.getTime()).toBeGreaterThan(NOW.getTime()); // a real future idle, not 1970
        break;
      }
      expect(decision.kind).toBe("active");
      if (decision.kind === "active") {
        // boundedness guarantee: the engine NEVER re-picks an already-cooled account.
        expect(
          accounts.find((x) => x.id === decision.credentialId)?.exhaustedUntil ?? null,
        ).toBeNull();
        serving = decision.credentialId;
        rotations++;
      }
    }
    expect(idled).toBe(true); // it terminates in a fixed idle — no infinite spin
    expect(rotations).toBeLessThanOrEqual(3); // at most N rotations for N accounts
  });
});

describe("effectiveRotationStrategy (OPE-36)", () => {
  test("every stored value — legacy, sharded, or unknown — normalizes to sharded", () => {
    for (const stored of [
      "most_remaining",
      "round_robin",
      "drain_then_next",
      "sharded",
      "",
      "future_strategy",
    ]) {
      expect(effectiveRotationStrategy(stored)).toBe("sharded");
    }
  });
});

describe("chooseRotationActive — legacy strategies normalize to sharded ranking (OPE-36)", () => {
  // The strategy picker is gone: rotation-enabled ALWAYS behaves as sticky-sharded
  // (effectiveRotationStrategy normalizes every stored value). A stored legacy
  // strategy must NOT reproduce its old behavior — it ranks by load like sharded.
  test("stored round_robin does NOT advance to the next account; the load ranker decides", () => {
    const accounts = [acct("a"), acct("b"), acct("c")];
    // Old round_robin picked "b" (next after prior "a"). Normalized: equal-load
    // tie → stable created_at order → "a" (no pointless account hop, cache kept).
    expect(
      chooseRotationActive({
        ...base,
        rotationStrategy: "round_robin",
        activeCredentialId: "a",
        priorCredentialId: "a",
        accounts,
      }),
    ).toEqual({ kind: "active", credentialId: "a", moved: false });
  });

  test("stored round_robin with a capped account still ranks (old behavior picked the successor)", () => {
    const accounts = [acct("a"), acct("b", { primaryUsedPercent: 100 }), acct("c")];
    // Old round_robin skipped capped "b" to pick "c". Normalized: "a" is eligible
    // and first on the equal-load tie — stay.
    expect(
      chooseRotationActive({
        ...base,
        rotationStrategy: "round_robin",
        activeCredentialId: "a",
        priorCredentialId: "a",
        accounts,
      }),
    ).toEqual({ kind: "active", credentialId: "a", moved: false });
  });

  test("round_robin all-capped wake ignores allocator-disabled credentials", () => {
    const enabledReset = new Date(NOW.getTime() + 4 * HOUR);
    const accounts = [
      acct("disabled-healthy", { allocatorEnabled: false }),
      acct("enabled-capped", {
        primaryUsedPercent: 100,
        primaryResetAt: enabledReset,
      }),
    ];
    expect(
      chooseRotationActive({
        ...base,
        rotationStrategy: "round_robin",
        activeCredentialId: "enabled-capped",
        priorCredentialId: "enabled-capped",
        accounts,
      }),
    ).toEqual({ kind: "allCapped", earliestResetAt: enabledReset });
  });

  test("stored drain_then_next no longer sticks to the prior account; capped accounts still fail over", () => {
    // Old drain_then_next stuck to prior "b". Normalized: equal-load tie → "a".
    const accounts = [acct("a"), acct("b")];
    expect(
      chooseRotationActive({
        ...base,
        rotationStrategy: "drain_then_next",
        activeCredentialId: "a",
        priorCredentialId: "b",
        accounts,
      }),
    ).toEqual({ kind: "active", credentialId: "a", moved: false });
    // Cap failover is strategy-independent and must keep working.
    const capped = [acct("a", { primaryUsedPercent: 100 }), acct("b")];
    expect(
      chooseRotationActive({
        ...base,
        rotationStrategy: "drain_then_next",
        activeCredentialId: "a",
        priorCredentialId: "a",
        accounts: capped,
      }),
    ).toEqual({ kind: "active", credentialId: "b", moved: true });
  });
});

// P4 — connector-aware rotation (prefer-not-require). The ranker PREFERS a failover
// target whose connector set COVERS the leaving session's used connectors, but still
// fails over to a lesser-coverage account when that is the only one with quota. When
// usedConnectors is empty the ranker is byte-identical to P3.
describe("chooseRotationActive — connector-aware (P4, most_remaining)", () => {
  test("empty usedConnectors → byte-identical to P3 (max remaining wins, no dropped note)", () => {
    const accounts = [
      acct("a", { primaryUsedPercent: 95 }), // active and still usable
      acct("b", { primaryUsedPercent: 40, connectorNamespaces: ["github"] }), // 60 remaining
      acct("c", { primaryUsedPercent: 10, connectorNamespaces: [] }), // 90 remaining ← winner
    ];
    expect(
      chooseRotationActive({ ...base, activeCredentialId: "a", accounts, usedConnectors: [] }),
    ).toEqual({ kind: "active", credentialId: "c", moved: true });
  });

  test("PREFERS a covering target even when a non-covering one has MORE remaining quota", () => {
    const accounts = [
      acct("a", { primaryUsedPercent: 100, connectorNamespaces: ["github"] }), // exhausted leaving account
      acct("b", { primaryUsedPercent: 50, connectorNamespaces: ["github", "gmail"] }), // covers github, 50 remaining ← winner
      acct("c", { primaryUsedPercent: 5, connectorNamespaces: ["gmail"] }), // 95 remaining BUT lacks github
    ];
    // Session used github (the leaving account's set). c has the most quota but can't
    // cover github → Tier 1 = {b}; b is chosen despite less remaining. No dropped note.
    expect(
      chooseRotationActive({
        ...base,
        activeCredentialId: "a",
        accounts,
        usedConnectors: ["github"],
      }),
    ).toEqual({ kind: "active", credentialId: "b", moved: true });
  });

  test("FAILS OVER to a non-covering account when it is the ONLY one with quota (+ dropped note)", () => {
    const accounts = [
      acct("a", { primaryUsedPercent: 100, connectorNamespaces: ["github"] }), // active, capped (leaving)
      acct("b", { primaryUsedPercent: 100, connectorNamespaces: ["github", "gmail"] }), // covers BUT also capped
      acct("c", { primaryUsedPercent: 10, connectorNamespaces: ["gmail"] }), // eligible BUT lacks github
    ];
    // Tier 1 (covering) is empty among eligibles → Tier 2 = {c}: failover preserved,
    // and the dropped-connector note surfaces github so the pill can warn.
    expect(
      chooseRotationActive({
        ...base,
        activeCredentialId: "a",
        accounts,
        usedConnectors: ["github"],
      }),
    ).toEqual({ kind: "active", credentialId: "c", moved: true, droppedConnectors: ["github"] });
  });

  test("null (never-probed) connector set is UNKNOWN: never Tier 1, never excluded, dropped note lists the used set", () => {
    const accounts = [
      acct("a", { primaryUsedPercent: 100, connectorNamespaces: ["github"] }), // active, capped (leaving)
      acct("b", { primaryUsedPercent: 10, connectorNamespaces: null }), // unprobed → Tier 2 only, but eligible
    ];
    // No covering eligible (b is unknown) → Tier 2 picks b (failover), and since we
    // can't prove b covers github, the note surfaces it.
    expect(
      chooseRotationActive({
        ...base,
        activeCredentialId: "a",
        accounts,
        usedConnectors: ["github"],
      }),
    ).toEqual({ kind: "active", credentialId: "b", moved: true, droppedConnectors: ["github"] });
  });

  test("connector coverage never restores active-pointer stickiness", () => {
    const accounts = [
      acct("a", { primaryUsedPercent: 10, connectorNamespaces: [] }), // active, healthy, lacks github
      acct("b", { primaryUsedPercent: 5, connectorNamespaces: ["github"] }), // covers github, more remaining
    ];
    // The pointer is a cursor, not a reservation; the covering, higher-capacity
    // account wins even while the prior pointer remains healthy.
    expect(
      chooseRotationActive({
        ...base,
        activeCredentialId: "a",
        accounts,
        usedConnectors: ["github"],
      }),
    ).toEqual({ kind: "active", credentialId: "b", moved: true });
  });

  test("a covering target that is a strict SUPERSET covers (multi-connector session)", () => {
    const accounts = [
      acct("a", { primaryUsedPercent: 100, connectorNamespaces: ["github", "linear"] }), // capped (leaving)
      acct("b", { primaryUsedPercent: 50, connectorNamespaces: ["github", "linear", "gmail"] }), // superset ← covers
      acct("c", { primaryUsedPercent: 5, connectorNamespaces: ["github"] }), // most quota but missing linear
    ];
    expect(
      chooseRotationActive({
        ...base,
        activeCredentialId: "a",
        accounts,
        usedConnectors: ["github", "linear"],
      }),
    ).toEqual({ kind: "active", credentialId: "b", moved: true });
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
    expect(
      computeReactiveRotationResume({
        cooldownPersisted: true,
        priorConsecutiveRotations: 0,
        connectedAccountCount: 3,
      }),
    ).toEqual({ continueDelayMs: 0, idleUntilReset: false });
  });

  test("(1a) persistence fault: cooldown NOT confirmed persisted → POSITIVE slow-retry floor, never 0", () => {
    const resume = computeReactiveRotationResume({
      cooldownPersisted: false,
      priorConsecutiveRotations: 0,
      connectedAccountCount: 3,
    });
    expect(resume.continueDelayMs).toBe(REACTIVE_PERSISTENCE_FAULT_FLOOR_MS);
    expect(resume.continueDelayMs).toBeGreaterThan(0); // the crux: a persistence fault never yields a 0-delay hot loop
    expect(resume.idleUntilReset).toBe(false); // a slow retry, not a mandatory long hold
  });

  test("(1b) double-fault below the bound still floors positive (persistence fault dominates the 0)", () => {
    // 2 prior + this = streak 3, bound = 2 accounts + margin(2) = 4 → in bounds, but the
    // unpersisted cooldown still forces the positive floor rather than a 0.
    const resume = computeReactiveRotationResume({
      cooldownPersisted: false,
      priorConsecutiveRotations: 2,
      connectedAccountCount: 2,
    });
    expect(resume.continueDelayMs).toBe(REACTIVE_PERSISTENCE_FAULT_FLOOR_MS);
    expect(resume.continueDelayMs).toBeGreaterThan(0);
  });

  test("(1b) once consecutive failovers EXCEED accounts + margin → FIXED mandatory idle (circuit breaker), never another 0", () => {
    const accounts = 2;
    const bound = accounts + REACTIVE_ROTATION_MARGIN; // 4
    // Walk the streak up to and past the bound; the double-fault keeps cooldown unpersisted.
    const at = (prior: number) =>
      computeReactiveRotationResume({
        cooldownPersisted: false,
        priorConsecutiveRotations: prior,
        connectedAccountCount: accounts,
      });
    // streak = prior+1. In bounds (streak ≤ 4): positive slow-retry floor, not the breaker.
    expect(at(bound - 1)).toEqual({
      continueDelayMs: REACTIVE_PERSISTENCE_FAULT_FLOOR_MS,
      idleUntilReset: false,
    }); // streak 4 == bound
    // Over the bound (streak 5): the circuit breaker fires — a FIXED positive MANDATORY idle.
    const broken = at(bound); // streak 5 > 4
    expect(broken.continueDelayMs).toBe(REACTIVE_CIRCUIT_BREAKER_IDLE_MS);
    expect(broken.continueDelayMs).toBeGreaterThan(0);
    expect(broken.idleUntilReset).toBe(true); // MANDATORY hold — session.ts can never collapse it to a 0-delay re-dispatch
  });

  test("(1b) the circuit breaker fires even when the cooldown DID persist (header-less caps can still re-pick)", () => {
    // Boundedness must not depend on the persistence result: an unbounded streak trips the breaker regardless.
    const broken = computeReactiveRotationResume({
      cooldownPersisted: true,
      priorConsecutiveRotations: 10,
      connectedAccountCount: 2,
    });
    expect(broken.idleUntilReset).toBe(true);
    expect(broken.continueDelayMs).toBe(REACTIVE_CIRCUIT_BREAKER_IDLE_MS);
  });

  test("(2) a RESET streak (priorConsecutiveRotations back to 0 after a successful turn) returns to the 0-delay happy path", () => {
    // The DB counter resets to 0 on a successful turn (turn.completed anchor); the pure
    // decision must then behave exactly like a fresh first failover — no lingering hold.
    expect(
      computeReactiveRotationResume({
        cooldownPersisted: true,
        priorConsecutiveRotations: 0,
        connectedAccountCount: 1,
      }),
    ).toEqual({ continueDelayMs: 0, idleUntilReset: false });
  });

  test("more connected accounts raise the bound proportionally (a legit N-account walk never trips the breaker)", () => {
    // With N accounts a legitimate walk cools one per failover; the bound N+margin absorbs it.
    const accounts = 5;
    // streak N (== accounts) with cooldowns persisting stays on the fast path.
    expect(
      computeReactiveRotationResume({
        cooldownPersisted: true,
        priorConsecutiveRotations: accounts - 1,
        connectedAccountCount: accounts,
      }),
    ).toEqual({ continueDelayMs: 0, idleUntilReset: false });
  });
});

// Sharded strategy — the PURE session→account home selection (AM-6) and the proactive
// home decision (AM-4/AM-7). Reduces the assignment/re-shard/keep logic to functions
// over the metadata-only account list, so it is unit-testable without a worker/db env.
describe("shardCredentialForSession — deterministic session sharding (AM-6)", () => {
  const pool = [acct("a"), acct("b"), acct("c"), acct("d")];

  test("deterministic: the same session id always maps to the same account", () => {
    const first = shardCredentialForSession({
      sessionId: "session-xyz",
      accounts: pool,
      now: NOW,
    });
    for (let i = 0; i < 5; i++) {
      expect(
        shardCredentialForSession({
          sessionId: "session-xyz",
          accounts: pool,
          now: NOW,
        }),
      ).toBe(first);
    }
  });

  test("spreads distinct sessions across the whole pool (not all on one account)", () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 400; i++) {
      const home = shardCredentialForSession({
        sessionId: `s-${i}`,
        accounts: pool,
        now: NOW,
      })!;
      counts.set(home, (counts.get(home) ?? 0) + 1);
    }
    // every account gets a meaningful share (balanced in expectation, ~100 each of 400)
    expect(counts.size).toBe(pool.length);
    for (const account of pool) {
      expect(counts.get(account.id) ?? 0).toBeGreaterThan(40);
    }
  });

  test("keeps every 90–99% account in the deterministic shard set", () => {
    const usable = [
      acct("a", { primaryUsedPercent: 90 }),
      acct("b", { secondaryUsedPercent: 94 }),
      acct("c", { primaryUsedPercent: 99 }),
    ];
    const selected = new Set<string>();
    for (let i = 0; i < 300; i++) {
      selected.add(
        shardCredentialForSession({ sessionId: `remaining-${i}`, accounts: usable, now: NOW })!,
      );
    }
    expect(selected).toEqual(new Set(["a", "b", "c"]));
  });

  test("excludes capped/cooling accounts from the shard set (re-shard picks a survivor)", () => {
    // Cap every account EXCEPT 'c' → every session must shard to 'c'.
    const oneHealthy = [
      acct("a", { primaryUsedPercent: 100 }),
      acct("b", { exhaustedUntil: new Date(NOW.getTime() + HOUR) }),
      acct("c"),
      acct("d", { secondaryUsedPercent: 100 }),
    ];
    for (let i = 0; i < 25; i++) {
      expect(
        shardCredentialForSession({
          sessionId: `s-${i}`,
          accounts: oneHealthy,
          now: NOW,
        }),
      ).toBe("c");
    }
  });

  test("re-shard SPREADS the survivors, never re-concentrates on one first-eligible (AM-5)", () => {
    // 'a' capped; sessions that were on 'a' re-shard over {b,c,d}. Confirm they land on
    // DIFFERENT survivors (a first-eligible pick would send them all to 'b').
    const survivors = [acct("a", { primaryUsedPercent: 100 }), acct("b"), acct("c"), acct("d")];
    const landed = new Set<string>();
    for (let i = 0; i < 60; i++) {
      landed.add(
        shardCredentialForSession({
          sessionId: `hot-${i}`,
          accounts: survivors,
          now: NOW,
        })!,
      );
    }
    expect(landed).not.toContain("a");
    expect(landed.size).toBeGreaterThan(1); // spread, not re-concentrated
  });

  test("all accounts capped → null (caller idles until reset)", () => {
    const allCapped = [
      acct("a", { primaryUsedPercent: 100 }),
      acct("b", { exhaustedUntil: new Date(NOW.getTime() + HOUR) }),
    ];
    expect(
      shardCredentialForSession({
        sessionId: "s",
        accounts: allCapped,
        now: NOW,
      }),
    ).toBeNull();
  });

  test("isCodexAccountEligible keeps 90–99% usable and blocks actual exhaustion", () => {
    expect(isCodexAccountEligible(acct("a"), NOW)).toBe(true);
    expect(isCodexAccountEligible(acct("a", { primaryUsedPercent: 90 }), NOW)).toBe(true);
    expect(isCodexAccountEligible(acct("a", { primaryUsedPercent: 99 }), NOW)).toBe(true);
    expect(isCodexAccountEligible(acct("a", { primaryUsedPercent: 100 }), NOW)).toBe(false);
    expect(
      isCodexAccountEligible(acct("a", { exhaustedUntil: new Date(NOW.getTime() + HOUR) }), NOW),
    ).toBe(false);
    expect(isCodexAccountEligible(acct("a", { status: "needs_relogin" }), NOW)).toBe(false);
  });
});

describe("chooseShardedHome — proactive home decision (AM-4/AM-7)", () => {
  const pool = [acct("a"), acct("b"), acct("c"), acct("d")];

  test("first turn (no policy pin) → lazy assignment, rewrite the pin (AM-7)", () => {
    const decision = chooseShardedHome({
      sessionId: "s1",
      currentPolicyPin: null,
      accounts: pool,
      now: NOW,
    });
    expect(decision.kind).toBe("home");
    if (decision.kind === "home") {
      expect(decision.rewritePin).toBe(true);
      // and it is the deterministic shard for this session id
      expect(decision.credentialId).toBe(
        shardCredentialForSession({
          sessionId: "s1",
          accounts: pool,
          now: NOW,
        }),
      );
    }
  });

  test("eligible policy pin → KEEP it, no rewrite (steady-state cache warmth)", () => {
    // Whatever 's1' shards to is, by construction, eligible → keep it.
    const home = shardCredentialForSession({
      sessionId: "s1",
      accounts: pool,
      now: NOW,
    })!;
    const decision = chooseShardedHome({
      sessionId: "s1",
      currentPolicyPin: home,
      accounts: pool,
      now: NOW,
    });
    expect(decision).toEqual({ kind: "home", credentialId: home, rewritePin: false });
  });

  test("a 99%-used policy home remains sticky and is not re-sharded", () => {
    const accounts = [acct("a", { primaryUsedPercent: 99 }), acct("b")];
    expect(
      chooseShardedHome({
        sessionId: "sticky-near-full",
        currentPolicyPin: "a",
        accounts,
        now: NOW,
      }),
    ).toEqual({ kind: "home", credentialId: "a", rewritePin: false });
  });

  test("capped policy pin → re-shard to a survivor and rewrite the pin durably (AM-4)", () => {
    const accounts = [
      acct("a", { primaryUsedPercent: 100 }), // the exhausted current home
      acct("b"),
      acct("c"),
      acct("d"),
    ];
    const decision = chooseShardedHome({
      sessionId: "s1",
      currentPolicyPin: "a",
      accounts,
      now: NOW,
    });
    expect(decision.kind).toBe("home");
    if (decision.kind === "home") {
      expect(decision.rewritePin).toBe(true);
      expect(decision.credentialId).not.toBe("a");
      // it is the deterministic re-shard over the ELIGIBLE survivors
      expect(decision.credentialId).toBe(
        shardCredentialForSession({ sessionId: "s1", accounts, now: NOW }),
      );
    }
  });

  test("all accounts capped → allCapped with the earliest reset (caller idles)", () => {
    const resetAt = new Date(NOW.getTime() + HOUR);
    const accounts = [
      acct("a", { primaryUsedPercent: 100, primaryResetAt: resetAt }),
      acct("b", { exhaustedUntil: resetAt }),
    ];
    const decision = chooseShardedHome({
      sessionId: "s1",
      currentPolicyPin: "a",
      accounts,
      now: NOW,
    });
    expect(decision.kind).toBe("allCapped");
    if (decision.kind === "allCapped") {
      expect(decision.earliestResetAt.getTime()).toBeGreaterThan(NOW.getTime());
    }
  });

  test("a policy pin that no longer exists (disconnected) → re-shard + rewrite", () => {
    const decision = chooseShardedHome({
      sessionId: "s1",
      currentPolicyPin: "gone",
      accounts: pool,
      now: NOW,
    });
    expect(decision.kind).toBe("home");
    if (decision.kind === "home") {
      expect(decision.rewritePin).toBe(true);
    }
  });
});

describe("OPE-21 deterministic fairness properties", () => {
  test("concurrent reservation simulation chooses every idle identity before reusing one", () => {
    const accounts = [leasedAcct("a"), leasedAcct("b"), leasedAcct("c"), leasedAcct("d")];
    const selected: string[] = [];
    for (let i = 0; i < accounts.length; i += 1) {
      const decision = chooseRotationActive({
        ...base,
        activeCredentialId: selected.at(-1) ?? null,
        accounts,
      });
      expect(decision.kind).toBe("active");
      if (decision.kind !== "active") continue;
      selected.push(decision.credentialId);
      const row = accounts.find((account) => account.id === decision.credentialId)!;
      row.activeLeaseCount += 1;
    }
    expect(new Set(selected).size).toBe(4);
  });

  test("1,003 sequential equal-capacity selections differ by at most one", () => {
    const accounts = [leasedAcct("a"), leasedAcct("b"), leasedAcct("c"), leasedAcct("d")];
    for (let i = 0; i < 1_003; i += 1) {
      const decision = chooseRotationActive({
        ...base,
        activeCredentialId: null,
        accounts,
        now: new Date(NOW.getTime() + i),
      });
      expect(decision.kind).toBe("active");
      if (decision.kind !== "active") continue;
      const row = accounts.find((account) => account.id === decision.credentialId)!;
      row.selectionCount += 1;
      row.lastSelectedAt = new Date(NOW.getTime() + i);
    }
    const counts = accounts.map((account) => account.selectionCount);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  test("fixed-seed randomized candidates always honor lease, capacity, count, recency ordering", () => {
    let seed = 0x5eed1234;
    const random = () => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    for (let sample = 0; sample < 500; sample += 1) {
      const accounts = Array.from({ length: 2 + Math.floor(random() * 7) }, (_, index) =>
        leasedAcct(`c-${sample}-${index}`, {
          activeLeaseCount: Math.floor(random() * 5),
          primaryUsedPercent: Math.floor(random() * 80),
          secondaryUsedPercent: Math.floor(random() * 80),
          selectionCount: Math.floor(random() * 30),
          lastSelectedAt: new Date(NOW.getTime() + Math.floor(random() * 10_000)),
          connectorNamespaces: [],
        }),
      );
      const expected = [...accounts].sort((a, b) => {
        if (a.activeLeaseCount !== b.activeLeaseCount)
          return a.activeLeaseCount - b.activeLeaseCount;
        const remainingA = Math.min(
          100 - (a.primaryUsedPercent ?? 0),
          100 - (a.secondaryUsedPercent ?? 0),
        );
        const remainingB = Math.min(
          100 - (b.primaryUsedPercent ?? 0),
          100 - (b.secondaryUsedPercent ?? 0),
        );
        if (remainingA !== remainingB) return remainingB - remainingA;
        if (a.selectionCount !== b.selectionCount) return a.selectionCount - b.selectionCount;
        return a.lastSelectedAt!.getTime() - b.lastSelectedAt!.getTime();
      })[0]!;
      const decision = chooseRotationActive({ ...base, activeCredentialId: null, accounts });
      expect(decision.kind).toBe("active");
      if (decision.kind === "active") expect(decision.credentialId).toBe(expected.id);
    }
  });
});

describe("classifyCodexPin — pin lifecycle (manual sacrosanct, policy meaningful only under sharded)", () => {
  const NON_SHARDED: CodexRotationStrategy[] = ["most_remaining", "round_robin", "drain_then_next"];
  const ALL: CodexRotationStrategy[] = [...NON_SHARDED, "sharded"];

  test("a MANUAL pin is honored under EVERY strategy, enabled or disabled", () => {
    for (const strategy of ALL) {
      for (const rotationEnabled of [true, false]) {
        expect(
          classifyCodexPin({
            pinnedCredentialId: "acct-1",
            pinSource: "manual",
            strategy,
            rotationEnabled,
          }),
        ).toBe("manual");
      }
    }
  });

  test("DEFENSE-IN-DEPTH: a pin with NULL source is treated as MANUAL under every strategy (never policy-moved)", () => {
    // A pre-backfill row, or any pin written without a label, must fail safe toward
    // sacredness — an unlabeled pin is never re-sharded, only an explicit 'policy' pin is.
    for (const strategy of ALL) {
      for (const rotationEnabled of [true, false]) {
        expect(
          classifyCodexPin({
            pinnedCredentialId: "acct-1",
            pinSource: null,
            strategy,
            rotationEnabled,
          }),
        ).toBe("manual");
      }
    }
  });

  test("OPE-36: a POLICY pin with rotation ENABLED → sharded under EVERY stored strategy (normalized)", () => {
    // Pre-OPE-36 a stored legacy strategy made policy pins "clearStale" — that
    // path is gone: rotation-enabled IS the sharded regime, pins are kept.
    for (const strategy of ALL) {
      expect(
        classifyCodexPin({
          pinnedCredentialId: "home",
          pinSource: "policy",
          strategy,
          rotationEnabled: true,
        }),
      ).toBe("sharded");
    }
  });

  test("a POLICY pin with rotation DISABLED → clearStale under every stored strategy", () => {
    // Rotation off is the one remaining non-sharded regime: a leftover policy
    // pin is stale residue and must be ignored + lazily cleared.
    for (const strategy of ALL) {
      expect(
        classifyCodexPin({
          pinnedCredentialId: "ex-home",
          pinSource: "policy",
          strategy,
          rotationEnabled: false,
        }),
      ).toBe("clearStale");
    }
  });

  test("a POLICY pin under an ACTIVE sharded policy → sharded (keep / re-shard, never clear)", () => {
    expect(
      classifyCodexPin({
        pinnedCredentialId: "home",
        pinSource: "policy",
        strategy: "sharded",
        rotationEnabled: true,
      }),
    ).toBe("sharded");
  });

  test("an UNPINNED session under active sharded → sharded (first-turn lazy assignment)", () => {
    expect(
      classifyCodexPin({
        pinnedCredentialId: null,
        pinSource: null,
        strategy: "sharded",
        rotationEnabled: true,
      }),
    ).toBe("sharded");
  });

  test("an UNPINNED session with rotation ENABLED → sharded under every stored strategy (lazy home assignment)", () => {
    for (const strategy of ALL) {
      expect(
        classifyCodexPin({
          pinnedCredentialId: null,
          pinSource: null,
          strategy,
          rotationEnabled: true,
        }),
      ).toBe("sharded");
    }
  });

  test("an UNPINNED session with rotation DISABLED → unpinned (workspace active pointer governs)", () => {
    for (const strategy of ALL) {
      expect(
        classifyCodexPin({
          pinnedCredentialId: null,
          pinSource: null,
          strategy,
          rotationEnabled: false,
        }),
      ).toBe("unpinned");
    }
  });
});

describe("OPE-21 pin and rollout policy", () => {
  const context = (
    accounts: CodexLeaseAccountStatus[],
    existingCredentialId: string | null = null,
  ) => ({
    accounts,
    activeCredentialId: "a",
    rotationEnabled: true,
    leaseRotationEnabled: true,
    rotationStrategy: "most_remaining",
    existingCredentialId,
    policyScope: null,
    unavailableDiagnostics: [],
  });

  test("a healthy explicit pin wins", () => {
    const selected = selectCodexCredentialLeaseForTurn({
      context: context([leasedAcct("a", { primaryUsedPercent: 60 }), leasedAcct("b")]),
      leasingEnabled: true,
      sessionId: "session-test",
      sessionPinSource: "manual",
      sessionPinnedCredentialId: "a",
      sessionLastCredentialId: null,
      now: NOW,
    });
    expect(selected.credentialId).toBe("a");
  });

  test("a 99%-used manual pin remains usable and never waits or switches early", () => {
    const selected = selectCodexCredentialLeaseForTurn({
      context: context([leasedAcct("a", { primaryUsedPercent: 99 }), leasedAcct("b")]),
      leasingEnabled: true,
      sessionId: "manual-near-full",
      sessionPinSource: "manual",
      sessionPinnedCredentialId: "a",
      sessionLastCredentialId: "a",
      now: NOW,
    });
    expect(selected).toMatchObject({
      credentialId: "a",
      decision: { kind: "active", credentialId: "a", moved: false },
    });
  });

  test("a capped stale policy pin leaves a non-sharded strategy free to select healthy capacity", () => {
    const selected = selectCodexCredentialLeaseForTurn({
      context: context([
        leasedAcct("a", {
          primaryUsedPercent: 100,
          primaryResetAt: new Date(NOW.getTime() + HOUR),
        }),
        leasedAcct("b"),
      ]),
      leasingEnabled: true,
      sessionId: "session-test",
      sessionPinSource: "policy",
      sessionPinnedCredentialId: "a",
      sessionLastCredentialId: "a",
      now: NOW,
    });
    expect(selected.credentialId).toBe("b");
  });

  test("a capped manual pin never silently fails over", () => {
    const selected = selectCodexCredentialLeaseForTurn({
      context: context([
        leasedAcct("a", {
          primaryUsedPercent: 100,
          primaryResetAt: new Date(NOW.getTime() + HOUR),
        }),
        leasedAcct("b"),
      ]),
      leasingEnabled: true,
      sessionId: "manual-session",
      sessionPinSource: "manual",
      sessionPinnedCredentialId: "a",
      sessionLastCredentialId: "a",
      now: NOW,
    });
    expect(selected.credentialId).toBeNull();
    expect(selected.advanceActivePointer).toBe(false);
    expect(selected.decision.kind).toBe("allCapped");
  });

  test("sharded policy ranks only the supplied scope and never moves the workspace pointer", () => {
    const selected = selectCodexCredentialLeaseForTurn({
      context: {
        ...context([leasedAcct("pool-b-1"), leasedAcct("pool-b-2")]),
        activeCredentialId: "outside-scope",
        rotationStrategy: "sharded",
      },
      leasingEnabled: true,
      sessionId: "sharded-session",
      sessionPinSource: "policy",
      sessionPinnedCredentialId: "outside-scope",
      sessionLastCredentialId: "outside-scope",
      now: NOW,
    });
    expect(["pool-b-1", "pool-b-2"]).toContain(selected.credentialId);
    expect(selected.advanceActivePointer).toBe(false);
  });

  test("a still-live same-turn lease is reused idempotently", () => {
    const selected = selectCodexCredentialLeaseForTurn({
      context: context([leasedAcct("a"), leasedAcct("b")], "b"),
      leasingEnabled: true,
      sessionId: "session-test",
      sessionPinSource: null,
      sessionPinnedCredentialId: null,
      sessionLastCredentialId: null,
      now: NOW,
    });
    expect(selected.credentialId).toBe("b");
  });

  test("cutover flag off preserves the old worker's enabled rotation policy", () => {
    const selected = selectCodexCredentialLeaseForTurn({
      context: context([
        leasedAcct("a", { primaryUsedPercent: 60 }),
        leasedAcct("b", { primaryUsedPercent: 0 }),
      ]),
      leasingEnabled: false,
      sessionId: "session-test",
      sessionPinSource: null,
      sessionPinnedCredentialId: null,
      sessionLastCredentialId: "a",
      now: NOW,
    });
    // Pre-0053 most_remaining keeps a still-eligible active pointer sticky.
    expect(selected.credentialId).toBe("a");
  });

  test("workspace cutover false keeps leases inert while preserving legacy rotation", () => {
    const selected = selectCodexCredentialLeaseForTurn({
      context: {
        ...context([
          leasedAcct("a", { primaryUsedPercent: 60 }),
          leasedAcct("b", { primaryUsedPercent: 0 }),
        ]),
        leaseRotationEnabled: false,
      },
      leasingEnabled: true,
      sessionId: "session-test",
      sessionPinSource: null,
      sessionPinnedCredentialId: null,
      sessionLastCredentialId: "a",
      now: NOW,
    });
    expect(selected.credentialId).toBe("a");
  });

  test("legacy rollback ignores stale lease and fairness metadata", () => {
    const selected = selectCodexCredentialLeaseForTurn({
      context: {
        ...context([
          leasedAcct("a", {
            primaryUsedPercent: 100,
            primaryResetAt: new Date(NOW.getTime() + HOUR),
          }),
          leasedAcct("b", {
            primaryUsedPercent: 10,
            activeLeaseCount: 20,
            selectionCount: 500,
            lastSelectedAt: new Date(NOW.getTime() + HOUR),
          }),
          leasedAcct("c", {
            primaryUsedPercent: 20,
            activeLeaseCount: 0,
            selectionCount: 0,
            lastSelectedAt: null,
          }),
        ]),
        leaseRotationEnabled: false,
      },
      leasingEnabled: true,
      sessionId: "session-test",
      sessionPinSource: null,
      sessionPinnedCredentialId: null,
      sessionLastCredentialId: "a",
      now: NOW,
    });
    // The old selector knows only capacity and picks b (90% remaining), not c.
    expect(selected.credentialId).toBe("b");
  });

  test("legacy rotation false remains sticky even when the deployment flag is on", () => {
    const selected = selectCodexCredentialLeaseForTurn({
      context: {
        ...context([leasedAcct("a"), leasedAcct("b")]),
        rotationEnabled: false,
        leaseRotationEnabled: false,
      },
      leasingEnabled: true,
      sessionId: "session-test",
      sessionPinSource: null,
      sessionPinnedCredentialId: null,
      sessionLastCredentialId: "b",
      now: NOW,
    });
    expect(selected.credentialId).toBe("a");
  });

  test("OPE-36: stored round_robin behaves EXACTLY as sharded in the lease selector (sticky, never advancing)", () => {
    const args = (rotationStrategy: string) => ({
      context: {
        accounts: [acct("a"), acct("b"), acct("c")].map((candidate) => ({
          ...candidate,
          activeLeaseCount: 0,
          selectionCount: 0,
          lastSelectedAt: null,
        })),
        activeCredentialId: "a",
        rotationEnabled: true,
        leaseRotationEnabled: true,
        rotationStrategy,
        existingCredentialId: null,
        policyScope: null,
        unavailableDiagnostics: [],
      },
      leasingEnabled: true,
      sessionId: "session-test",
      sessionPinSource: null,
      sessionPinnedCredentialId: null,
      sessionLastCredentialId: "b",
      now: NOW,
    });
    // Old round_robin advanced past session-last "b" to "c". Normalized: the
    // stored legacy value is byte-equivalent to sharded (deterministic sticky
    // home for the session), and repeated selection never advances.
    const legacy = selectCodexCredentialLeaseForTurn(args("round_robin"));
    const sharded = selectCodexCredentialLeaseForTurn(args("sharded"));
    expect(legacy).toEqual(sharded);
    expect(selectCodexCredentialLeaseForTurn(args("round_robin"))).toEqual(legacy);
  });

  test("same-turn frozen continuation keeps a healthy disabled credential without admitting new work", () => {
    const accounts = [leasedAcct("frozen", { allocatorEnabled: false }), leasedAcct("eligible")];
    const frozenContext = {
      accounts,
      activeCredentialId: "frozen",
      rotationEnabled: true,
      leaseRotationEnabled: true,
      rotationStrategy: "most_remaining",
      existingCredentialId: null,
      policyScope: null,
      unavailableDiagnostics: [],
    };
    expect(
      selectCodexCredentialLeaseForTurn({
        context: frozenContext,
        leasingEnabled: true,
        sessionId: "session-test",
        sessionPinSource: null,
        sessionPinnedCredentialId: null,
        sessionLastCredentialId: "frozen",
        continuationCredentialId: "frozen",
        now: NOW,
      }).credentialId,
    ).toBe("frozen");
    expect(
      selectCodexCredentialLeaseForTurn({
        context: frozenContext,
        leasingEnabled: true,
        sessionId: "session-test",
        sessionPinSource: null,
        sessionPinnedCredentialId: null,
        sessionLastCredentialId: "frozen",
        now: NOW,
      }).credentialId,
    ).toBe("eligible");
  });
});
