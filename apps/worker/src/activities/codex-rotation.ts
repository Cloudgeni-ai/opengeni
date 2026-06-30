// Multi-account P3 — the PURE rotation ranker. Zero I/O: no provider calls, no
// decrypts, no db. It consumes the already-loaded, metadata-only account list
// (cached usage columns + the exhausted_until cooldown column) and returns the
// account a turn should run on. The two call sites (turn-start pre-emption and
// the reactive 429 catch in agent-turn.ts) feed its result into the unchanged
// `selectCodexCredentialForTurn` precedence gate (pin > active). Keeping the
// decision pure makes the whole rotation correctness story unit-testable in
// isolation (see codex-rotation.test.ts).
import type { CodexAccountStatus } from "@opengeni/db";

export type CodexRotationStrategy = "most_remaining" | "round_robin" | "drain_then_next";

export type RotationDecision =
  // The chosen account. `moved` ⇒ it differs from the current active pointer, so
  // the caller must persist the pointer move (and the switch is a "rotation").
  | { kind: "active"; credentialId: string; moved: boolean }
  // Every eligible account is capped/cooling: idle until the soonest instant ANY
  // account clears every blocking condition (the multi-account generalization of
  // the single-account idle-until-reset).
  | { kind: "allCapped"; earliestResetAt: Date }
  // No connected accounts at all (preserves today's relogin-fail path).
  | { kind: "none" };

// Invariant 4 (NO THRASH / BOUNDED) safety floors. An all-capped idle MUST be a
// positive, bounded wait — a null / elapsed / unknown reset can NEVER collapse it
// into a 0 or a past instant (which the caller would turn into a 0 continueDelayMs
// and a tight re-dispatch loop that hammers CPU/DB and never runs the model, so the
// stale usage cache never self-heals).
/** The minimum all-capped idle: continueDelayMs is clamped to at least this (never 0). */
export const MIN_IDLE_MS = 60_000; // 60s
/**
 * Cooldown applied to an over-threshold account whose cached reset is null / unknown
 * / already-elapsed (the turn hot path never refreshes usage, so a capped window's
 * reset reads stale). Treating it as "available after a default cooldown" keeps
 * availableAt — and therefore earliestReset — ALWAYS in the future.
 */
export const DEFAULT_RESET_COOLDOWN_MS = 60_000; // 60s

/** The worse-window used percent: weekly binds as hard as 5h, so take the max. null ⇒ 0. */
function bindingUsedPct(acct: CodexAccountStatus): number {
  return Math.max(acct.primaryUsedPercent ?? 0, acct.secondaryUsedPercent ?? 0);
}

/**
 * Remaining quota across the binding window — the P3 rotation key. Mirrors
 * buildCodexUsageWindowFromCache's `remaining = 100 - percent`, taking the MIN
 * across both windows (the scarcer of 5h/weekly). null percent ⇒ 100 remaining.
 */
function bindingRemaining(acct: CodexAccountStatus): number {
  const primaryRemaining = 100 - (acct.primaryUsedPercent ?? 0);
  const secondaryRemaining = 100 - (acct.secondaryUsedPercent ?? 0);
  return Math.min(primaryRemaining, secondaryRemaining);
}

function cooling(acct: CodexAccountStatus, now: Date): boolean {
  return acct.exhaustedUntil != null && acct.exhaustedUntil.getTime() > now.getTime();
}

/**
 * Eligible = connected/usable (status "active", excludes needs_relogin/error) AND
 * not cooling AND under the near-exhaustion threshold on BOTH windows.
 */
function eligible(acct: CodexAccountStatus, nearExhaustionPct: number, now: Date): boolean {
  return acct.status === "active" && !cooling(acct, now) && bindingUsedPct(acct) < nearExhaustionPct;
}

/**
 * The soonest instant `acct` clears EVERY blocking condition: its cooldown end,
 * and each window's reset (only when that window is at/over the threshold). The
 * literal multi-account generalization of #143's single-account resetsInSeconds.
 *
 * GUARANTEE (invariant 4): the result is ALWAYS in the future. A blocking window
 * whose cached reset is null / unknown / already-elapsed does NOT contribute a past
 * instant (the old EPOCH0 seed bug that made earliestReset land in 1970 → a 0
 * continueDelayMs → a tight idle loop). Such a window is treated as clearing after a
 * default cooldown (now + DEFAULT_RESET_COOLDOWN_MS), so the caller always idles a
 * bounded positive time and re-checks (which refreshes usage and self-heals).
 */
export function availableAt(acct: CodexAccountStatus, nearExhaustionPct: number, now: Date): Date {
  const nowMs = now.getTime();
  // An unknown/elapsed block clears after a default cooldown, never in the past.
  const defaultClear = new Date(nowMs + DEFAULT_RESET_COOLDOWN_MS);
  const candidates: Date[] = [];
  // An active cooldown only blocks while it is still in the future; a past cooldown
  // self-clears (matches `cooling()`), so it must not pin availableAt to the past.
  if (acct.exhaustedUntil != null && acct.exhaustedUntil.getTime() > nowMs) {
    candidates.push(acct.exhaustedUntil);
  }
  const windowClear = (over: boolean, resetAt: Date | null | undefined) => {
    if (!over) return;
    // Over-threshold window: wait for its KNOWN future reset; a null/elapsed cached
    // reset is unknown → default cooldown (never a past instant).
    candidates.push(resetAt != null && resetAt.getTime() > nowMs ? resetAt : defaultClear);
  };
  windowClear((acct.primaryUsedPercent ?? 0) >= nearExhaustionPct, acct.primaryResetAt);
  windowClear((acct.secondaryUsedPercent ?? 0) >= nearExhaustionPct, acct.secondaryResetAt);
  // Ineligible for a non-quota reason (needs_relogin / error) with no known block, or
  // a cleared cooldown: still idle a bounded cooldown before re-check — never the past.
  if (candidates.length === 0) {
    return defaultClear;
  }
  // Clears EVERY blocking condition ⇒ the MAX of the per-condition clear instants.
  return candidates.reduce((a, b) => (b.getTime() > a.getTime() ? b : a));
}

/** earliestResetAt across ALL connected accounts (min of each account's availableAt). */
function earliestReset(accounts: CodexAccountStatus[], nearExhaustionPct: number, now: Date): Date {
  return accounts
    .map((acct) => availableAt(acct, nearExhaustionPct, now))
    .reduce((a, b) => (b.getTime() < a.getTime() ? b : a));
}

/**
 * The bounded all-capped idle delay: clamp(earliestResetAt − now) into
 * [MIN_IDLE_MS, maxMs]. NEVER 0 and NEVER negative, so a null / elapsed / unknown
 * reset cannot collapse the hold into a tight re-dispatch loop (invariant 4). The two
 * agent-turn call sites (proactive turn-start + reactive 429) feed allCapped's
 * earliestResetAt through this before returning continueDelayMs.
 */
export function computeIdleDelayMs(earliestResetAt: Date, now: Date, maxMs: number): number {
  const delta = earliestResetAt.getTime() - now.getTime();
  return Math.min(Math.max(delta, MIN_IDLE_MS), maxMs);
}

/**
 * THE pure rotation ranker. `accounts` arrives in stable created_at order
 * (listCodexAccountStatuses), which deterministically breaks ranking ties.
 */
export function chooseRotationActive(args: {
  rotationStrategy: CodexRotationStrategy;
  activeCredentialId: string | null;
  priorCredentialId: string | null;
  accounts: CodexAccountStatus[];
  nearExhaustionPct: number;
  now: Date;
}): RotationDecision {
  const { rotationStrategy, activeCredentialId, priorCredentialId, accounts, nearExhaustionPct, now } = args;

  if (accounts.length === 0) {
    return { kind: "none" };
  }

  const eligibles = accounts.filter((acct) => eligible(acct, nearExhaustionPct, now));

  // Healthy-active fast path (minimal churn, all strategies): a rotation-enabled
  // session whose active account is still eligible does NOT rotate — no pointer
  // move, no switch event. Steady-state stays as cheap as a non-rotation turn
  // save the in-memory ranking. (Skipped for round_robin/drain which anchor on
  // the prior account, but most_remaining is the default + correctness path.)
  const activeRow = activeCredentialId ? accounts.find((acct) => acct.id === activeCredentialId) ?? null : null;

  const decide = (chosen: CodexAccountStatus | undefined): RotationDecision => {
    if (!chosen) {
      return { kind: "allCapped", earliestResetAt: earliestReset(accounts, nearExhaustionPct, now) };
    }
    return { kind: "active", credentialId: chosen.id, moved: chosen.id !== activeCredentialId };
  };

  if (rotationStrategy === "round_robin") {
    // Next eligible AFTER the prior account in list order (wrap around). When the
    // prior account isn't found, start from the head.
    if (eligibles.length === 0) {
      return { kind: "allCapped", earliestResetAt: earliestReset(accounts, nearExhaustionPct, now) };
    }
    const priorIdx = priorCredentialId ? accounts.findIndex((acct) => acct.id === priorCredentialId) : -1;
    const ordered = priorIdx >= 0
      ? [...accounts.slice(priorIdx + 1), ...accounts.slice(0, priorIdx + 1)]
      : accounts;
    const chosen = ordered.find((acct) => eligible(acct, nearExhaustionPct, now));
    return decide(chosen);
  }

  if (rotationStrategy === "drain_then_next") {
    // Stay on the prior account while it is eligible (drain it), else first eligible.
    const priorRow = priorCredentialId ? accounts.find((acct) => acct.id === priorCredentialId) : undefined;
    if (priorRow && eligible(priorRow, nearExhaustionPct, now)) {
      return decide(priorRow);
    }
    return decide(eligibles[0]);
  }

  // most_remaining (default + the correctness path).
  if (activeRow && eligible(activeRow, nearExhaustionPct, now)) {
    return { kind: "active", credentialId: activeRow.id, moved: false };
  }
  // Active is capped/near-cap/cooling/missing → pick max remaining, ties broken by
  // list (created_at) order via a stable reduce.
  const chosen = eligibles.reduce<CodexAccountStatus | undefined>((best, acct) => {
    if (!best) {
      return acct;
    }
    return bindingRemaining(acct) > bindingRemaining(best) ? acct : best;
  }, undefined);
  return decide(chosen);
}
