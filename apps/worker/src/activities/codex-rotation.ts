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

const EPOCH0 = new Date(0);

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
 */
function availableAt(acct: CodexAccountStatus, nearExhaustionPct: number): Date {
  const candidates: Date[] = [acct.exhaustedUntil ?? EPOCH0];
  if ((acct.primaryUsedPercent ?? 0) >= nearExhaustionPct) {
    candidates.push(acct.primaryResetAt ?? EPOCH0);
  }
  if ((acct.secondaryUsedPercent ?? 0) >= nearExhaustionPct) {
    candidates.push(acct.secondaryResetAt ?? EPOCH0);
  }
  return candidates.reduce((a, b) => (b.getTime() > a.getTime() ? b : a), EPOCH0);
}

/** earliestResetAt across ALL connected accounts (min of each account's availableAt). */
function earliestReset(accounts: CodexAccountStatus[], nearExhaustionPct: number): Date {
  return accounts
    .map((acct) => availableAt(acct, nearExhaustionPct))
    .reduce((a, b) => (b.getTime() < a.getTime() ? b : a));
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
      return { kind: "allCapped", earliestResetAt: earliestReset(accounts, nearExhaustionPct) };
    }
    return { kind: "active", credentialId: chosen.id, moved: chosen.id !== activeCredentialId };
  };

  if (rotationStrategy === "round_robin") {
    // Next eligible AFTER the prior account in list order (wrap around). When the
    // prior account isn't found, start from the head.
    if (eligibles.length === 0) {
      return { kind: "allCapped", earliestResetAt: earliestReset(accounts, nearExhaustionPct) };
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
