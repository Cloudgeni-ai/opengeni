/** TEST ONLY: historical Codex regression fixture, snapshot 8c43a921512078d302f671ae590d43645669f88d. Never import from production. */
import { subscriptionAccountShardIndex } from "@opengeni/config";

import type {
  CodexAccountStatus,
  CodexCredentialLeaseSelectionContext,
  CodexLeaseAccountStatus,
  CodexPinSource,
} from "@opengeni/db";

import { codexPlanExcludesModel, connectionModelAllowed } from "@opengeni/db";

export type CodexRotationAccount = CodexAccountStatus | CodexLeaseAccountStatus;

export function codexAccountServesModel(
  account: Pick<CodexRotationAccount, "allowedModelIds" | "planType" | "planEntitlementExclusion">,
  modelId: string,
  now: Date,
): boolean {
  return (
    connectionModelAllowed(account.allowedModelIds, modelId) &&
    !codexPlanExcludesModel(account, modelId, now)
  );
}

export function codexAccountNeedsLiveCapacityRefresh(
  account: Pick<
    CodexAccountStatus,
    "primaryUsedPercent" | "secondaryUsedPercent" | "exhaustedUntil" | "exhaustedKind"
  >,
  _now: Date,
): boolean {
  return (
    (account.primaryUsedPercent ?? 0) >= CODEX_USAGE_EXHAUSTED_PCT ||
    (account.secondaryUsedPercent ?? 0) >= CODEX_USAGE_EXHAUSTED_PCT ||
    (account.exhaustedKind === "quota" && account.exhaustedUntil !== null)
  );
}

export type CodexRotationStrategy =
  | "most_remaining"
  | "round_robin"
  | "drain_then_next"
  | "sharded";

export function effectiveRotationStrategy(_stored: string): CodexRotationStrategy {
  return "sharded";
}

export type CodexPinDisposition = "manual" | "sharded" | "clearStale" | "unpinned";

export function classifyCodexPin(args: {
  pinnedCredentialId: string | null;
  pinSource: CodexPinSource | null;
  strategy: CodexRotationStrategy;
  rotationEnabled: boolean;
}): CodexPinDisposition {
  const { pinnedCredentialId, pinSource, strategy, rotationEnabled } = args;
  const pinned = pinnedCredentialId != null;
  // A manual pin is sacrosanct under every strategy — checked FIRST so sharded never
  // touches it. DEFENSE-IN-DEPTH (fail-safe toward sacredness): a pin whose source is
  // anything OTHER than the explicit 'policy' — including a NULL source (a pre-backfill
  // row, or any pin an unforeseen path wrote without labeling it) — is treated as
  // MANUAL. An unlabeled pin must NEVER be policy-moved; only an explicitly-'policy' pin
  // is re-shardable.
  if (pinned && pinSource !== "policy") {
    return "manual";
  }
  const shardedActive = rotationEnabled && effectiveRotationStrategy(strategy) === "sharded";
  if (shardedActive) {
    return "sharded";
  }
  // A policy pin outside the sharded regime is stale → clear it.
  if (pinned && pinSource === "policy") {
    return "clearStale";
  }
  return "unpinned";
}

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

export type CodexTurnLeaseDecision =
  | RotationDecision
  // The user's manual pin or rotation-off active pointer names a connected row
  // that is disabled for NEW allocations. This is policy-constrained capacity,
  // not a disconnected-account relogin failure: the accepted turn must wait
  // until the row is re-enabled or the governing policy changes.
  | { kind: "allocatorDisabled"; credentialId: string };

export type CodexTurnLeaseSelection = {
  credentialId: string | null;
  decision: CodexTurnLeaseDecision;
  /** Policy/manual homes never move the workspace-global legacy pointer. */
  advanceActivePointer?: boolean;
};

export const MIN_IDLE_MS = 60_000;

export const DEFAULT_RESET_COOLDOWN_MS = 60_000;

export const CODEX_USAGE_EXHAUSTED_PCT = 100;

function effectiveWindowUsed(usedPercent: number | null, resetAt: Date | null, now: Date): number {
  // A completed provider window is eligible immediately even if its last cache
  // sample still says 100%. This is the five-hour reset boundary—not a TTL
  // heuristic—and avoids stranding a reset subscription while another remains
  // healthy. A future/unknown reset keeps the cached percentage authoritative.
  return resetAt && resetAt.getTime() <= now.getTime() ? 0 : (usedPercent ?? 0);
}

function bindingUsedPct(acct: CodexRotationAccount, now: Date): number {
  return Math.max(
    effectiveWindowUsed(acct.primaryUsedPercent, acct.primaryResetAt, now),
    effectiveWindowUsed(acct.secondaryUsedPercent, acct.secondaryResetAt, now),
  );
}

function bindingRemaining(acct: CodexRotationAccount, now: Date): number {
  const primaryRemaining =
    100 - effectiveWindowUsed(acct.primaryUsedPercent, acct.primaryResetAt, now);
  const secondaryRemaining =
    100 - effectiveWindowUsed(acct.secondaryUsedPercent, acct.secondaryResetAt, now);
  return Math.min(primaryRemaining, secondaryRemaining);
}

function cooling(acct: CodexRotationAccount, now: Date): boolean {
  return acct.exhaustedUntil != null && acct.exhaustedUntil.getTime() > now.getTime();
}

export function codexHasIncludedUsage(acct: CodexRotationAccount, now: Date): boolean {
  return (
    !(acct.includedUsageUnavailableUntil && acct.includedUsageUnavailableUntil > now) &&
    bindingUsedPct(acct, now) < CODEX_USAGE_EXHAUSTED_PCT
  );
}

function preferredCreditTier(accounts: CodexRotationAccount[], now: Date) {
  const included = accounts.filter((account) => codexHasIncludedUsage(account, now));
  return included.length ? included : accounts;
}

export function isCodexCredentialHealthy(acct: CodexRotationAccount, now: Date): boolean {
  return (
    acct.status === "active" &&
    !cooling(acct, now) &&
    (codexHasIncludedUsage(acct, now) || acct.extraCreditsEnabled === true)
  );
}

export function isCodexCredentialEligible(acct: CodexRotationAccount, now: Date): boolean {
  return acct.allocatorEnabled && isCodexCredentialHealthy(acct, now);
}

export function isCodexAccountEligible(acct: CodexRotationAccount, now: Date): boolean {
  return isCodexCredentialEligible(acct, now);
}

export function shardCredentialForSession(args: {
  sessionId: string;
  accounts: CodexRotationAccount[];
  now: Date;
}): string | null {
  const { sessionId, accounts, now } = args;
  const eligibles = preferredCreditTier(
    accounts.filter((acct) => isCodexCredentialEligible(acct, now)),
    now,
  );
  if (eligibles.length === 0) {
    return null;
  }
  const index = subscriptionAccountShardIndex(sessionId, eligibles.length);
  return eligibles[index]!.id;
}

export function earliestCodexReset(accounts: CodexRotationAccount[], now: Date): Date {
  return earliestReset(accounts, now);
}

export function chooseShardedHome(args: {
  sessionId: string;
  currentPolicyPin: string | null;
  accounts: CodexRotationAccount[];
  now: Date;
}):
  | { kind: "home"; credentialId: string; rewritePin: boolean }
  | { kind: "allCapped"; earliestResetAt: Date } {
  const { sessionId, currentPolicyPin, accounts, now } = args;
  const pinRow = currentPolicyPin
    ? (accounts.find((acct) => acct.id === currentPolicyPin) ?? null)
    : null;
  if (
    pinRow &&
    isCodexCredentialEligible(pinRow, now) &&
    (codexHasIncludedUsage(pinRow, now) ||
      !accounts.some(
        (account) => isCodexCredentialEligible(account, now) && codexHasIncludedUsage(account, now),
      ))
  ) {
    return { kind: "home", credentialId: currentPolicyPin!, rewritePin: false };
  }
  const home = shardCredentialForSession({ sessionId, accounts, now });
  if (home == null) {
    return { kind: "allCapped", earliestResetAt: earliestReset(accounts, now) };
  }
  return { kind: "home", credentialId: home, rewritePin: true };
}

export function availableAt(acct: CodexRotationAccount, now: Date): Date {
  const nowMs = now.getTime();
  // An unknown/elapsed block clears after a default cooldown, never in the past.
  const defaultClear = new Date(nowMs + DEFAULT_RESET_COOLDOWN_MS);
  const candidates: Date[] = [];
  if (
    !acct.extraCreditsEnabled &&
    acct.includedUsageUnavailableUntil &&
    acct.includedUsageUnavailableUntil > now
  )
    candidates.push(acct.includedUsageUnavailableUntil);
  // An active cooldown only blocks while it is still in the future; a past cooldown
  // self-clears (matches `cooling()`), so it must not pin availableAt to the past.
  if (acct.exhaustedUntil != null && acct.exhaustedUntil.getTime() > nowMs) {
    candidates.push(acct.exhaustedUntil);
  }
  const windowClear = (over: boolean, resetAt: Date | null | undefined) => {
    if (!over || acct.extraCreditsEnabled === true) return;
    // Over-threshold window: wait for its KNOWN future reset; a null/elapsed cached
    // reset is unknown → default cooldown (never a past instant).
    candidates.push(resetAt != null && resetAt.getTime() > nowMs ? resetAt : defaultClear);
  };
  windowClear(
    effectiveWindowUsed(acct.primaryUsedPercent, acct.primaryResetAt, now) >=
      CODEX_USAGE_EXHAUSTED_PCT,
    acct.primaryResetAt,
  );
  windowClear(
    effectiveWindowUsed(acct.secondaryUsedPercent, acct.secondaryResetAt, now) >=
      CODEX_USAGE_EXHAUSTED_PCT,
    acct.secondaryResetAt,
  );
  // Ineligible for a non-quota reason (needs_relogin / error) with no known block, or
  // a cleared cooldown: still idle a bounded cooldown before re-check — never the past.
  if (candidates.length === 0) {
    return defaultClear;
  }
  // Clears EVERY blocking condition ⇒ the MAX of the per-condition clear instants.
  return candidates.reduce((a, b) => (b.getTime() > a.getTime() ? b : a));
}

function earliestReset(accounts: CodexRotationAccount[], now: Date): Date {
  return accounts
    .map((acct) => availableAt(acct, now))
    .reduce((a, b) => (b.getTime() < a.getTime() ? b : a));
}

export function authoritativeCodexCapacityResetAt(
  accounts: CodexRotationAccount[],
  now: Date,
): Date | null {
  const future: Date[] = [];
  for (const account of accounts) {
    if (!account.allocatorEnabled || account.status !== "active") continue;
    if (account.exhaustedUntil && account.exhaustedUntil.getTime() > now.getTime()) {
      future.push(account.exhaustedUntil);
    }
    if (
      (account.primaryUsedPercent ?? 0) >= CODEX_USAGE_EXHAUSTED_PCT &&
      account.primaryResetAt &&
      account.primaryResetAt.getTime() > now.getTime()
    ) {
      future.push(account.primaryResetAt);
    }
    if (
      (account.secondaryUsedPercent ?? 0) >= CODEX_USAGE_EXHAUSTED_PCT &&
      account.secondaryResetAt &&
      account.secondaryResetAt.getTime() > now.getTime()
    ) {
      future.push(account.secondaryResetAt);
    }
  }
  if (future.length === 0) return null;
  return future.reduce((earliest, candidate) =>
    candidate.getTime() < earliest.getTime() ? candidate : earliest,
  );
}

export function computeIdleDelayMs(earliestResetAt: Date, now: Date, maxMs: number): number {
  const delta = earliestResetAt.getTime() - now.getTime();
  return Math.min(Math.max(delta, MIN_IDLE_MS), maxMs);
}

export function chooseRotationActive(args: {
  rotationStrategy: CodexRotationStrategy;
  activeCredentialId: string | null;
  priorCredentialId: string | null;
  accounts: CodexRotationAccount[];
  now: Date;
}): RotationDecision {
  const { activeCredentialId, priorCredentialId, accounts, now } = args;
  // Normalize at the entry point: rotation-enabled ALWAYS behaves as sharded
  // (see effectiveRotationStrategy). args keeps the field so call sites and
  // tests can still express stored legacy values.
  const rotationStrategy = effectiveRotationStrategy(args.rotationStrategy);
  const allocatableAccounts = accounts.filter((account) => account.allocatorEnabled);

  if (allocatableAccounts.length === 0) {
    return { kind: "none" };
  }

  const eligibles = preferredCreditTier(
    allocatableAccounts.filter((acct) => isCodexCredentialEligible(acct, now)),
    now,
  );

  // The active pointer is a cursor/manual preference, NOT a sticky lease. In
  // particular, most_remaining must rank the whole eligible pool every turn;
  // keeping a healthy active account sticky was the production monopolization
  // defect fixed by credential allocator. drain_then_next remains the one explicitly sticky
  // strategy, and a manual pin is handled by the caller as explicit policy.
  const decide = (chosen: CodexRotationAccount | undefined): RotationDecision => {
    if (!chosen) {
      return {
        kind: "allCapped",
        earliestResetAt: earliestReset(allocatableAccounts, now),
      };
    }
    return {
      kind: "active",
      credentialId: chosen.id,
      moved: chosen.id !== activeCredentialId,
    };
  };

  if (rotationStrategy === "round_robin") {
    // Next eligible AFTER the prior account in list order (wrap around). When the
    // prior account isn't found, start from the head.
    if (eligibles.length === 0) {
      return {
        kind: "allCapped",
        earliestResetAt: earliestReset(allocatableAccounts, now),
      };
    }
    const priorIdx = priorCredentialId
      ? allocatableAccounts.findIndex((acct) => acct.id === priorCredentialId)
      : -1;
    const ordered =
      priorIdx >= 0
        ? [
            ...allocatableAccounts.slice(priorIdx + 1),
            ...allocatableAccounts.slice(0, priorIdx + 1),
          ]
        : allocatableAccounts;
    const chosen = ordered.find((acct) => isCodexCredentialEligible(acct, now));
    return decide(chosen);
  }

  if (rotationStrategy === "drain_then_next") {
    // Stay on the prior account while it is eligible (drain it), else first eligible.
    const priorRow = priorCredentialId
      ? accounts.find((acct) => acct.id === priorCredentialId)
      : undefined;
    if (priorRow && isCodexCredentialEligible(priorRow, now)) {
      return decide(priorRow);
    }
    return decide(eligibles[0]);
  }

  // most_remaining (default + the correctness path). Across the eligible set:
  //   1. least active leases (concurrent turns spread before quota metadata moves),
  //   2. most remaining binding quota,
  //   3. fewest historical selections,
  //   4. least-recently selected, then stable created_at/id input order.
  // Base CodexAccountStatus values (pure legacy tests/reactive rank) default the
  // lease/cursor metadata to zero/null, preserving deterministic stable ties.
  const activeLeases = (acct: CodexRotationAccount): number =>
    "activeLeaseCount" in acct ? acct.activeLeaseCount : 0;
  const selections = (acct: CodexRotationAccount): number =>
    "selectionCount" in acct ? acct.selectionCount : 0;
  const lastSelected = (acct: CodexRotationAccount): number =>
    "lastSelectedAt" in acct && acct.lastSelectedAt ? acct.lastSelectedAt.getTime() : 0;
  const chosen = eligibles.reduce<CodexRotationAccount | undefined>((best, acct) => {
    if (!best) {
      return acct;
    }
    if (activeLeases(acct) !== activeLeases(best)) {
      return activeLeases(acct) < activeLeases(best) ? acct : best;
    }
    if (bindingRemaining(acct, now) !== bindingRemaining(best, now)) {
      return bindingRemaining(acct, now) > bindingRemaining(best, now) ? acct : best;
    }
    if (selections(acct) !== selections(best)) {
      return selections(acct) < selections(best) ? acct : best;
    }
    return lastSelected(acct) < lastSelected(best) ? acct : best;
  }, undefined);
  return decide(chosen);
}

export function selectCodexCredentialLeaseForTurn<
  TPolicyScope = never,
  TUnavailableDiagnostic = never,
>(args: {
  context: CodexCredentialLeaseSelectionContext<TPolicyScope, TUnavailableDiagnostic>;
  sessionId: string;
  sessionPinnedCredentialId: string | null;
  sessionPinSource: CodexPinSource | null;
  sessionLastCredentialId: string | null;
  now: Date;
}): CodexTurnLeaseSelection {
  const { activeCredentialId, rotationEnabled, rotationStrategy, existingCredentialId } =
    args.context;
  if (args.context.failoverExhausted) {
    return { credentialId: null, decision: { kind: "none" }, advanceActivePointer: false };
  }
  // User model policy and proven plan entitlement both remove an account for
  // this model only. A plan exclusion is provider truth, never user policy; it
  // becomes inert when a different plan is observed or its TTL elapses.
  const accounts = args.context.modelId
    ? args.context.accounts.filter((account) =>
        codexAccountServesModel(account, args.context.modelId!, args.now),
      )
    : args.context.accounts;
  const failedCredentialIds = new Set(args.context.failedCredentialIds ?? []);
  // Normalized: rotation-enabled always behaves as sharded (see
  // effectiveRotationStrategy); the stored value is only ever legacy residue.
  const strategy = effectiveRotationStrategy(rotationStrategy);
  const existing = existingCredentialId
    ? accounts.find((account) => account.id === existingCredentialId)
    : undefined;
  if (
    existing &&
    !failedCredentialIds.has(existing.id) &&
    isCodexCredentialHealthy(existing, args.now)
  ) {
    return {
      credentialId: existing.id,
      advanceActivePointer: false,
      decision: {
        kind: "active",
        credentialId: existing.id,
        moved: existing.id !== activeCredentialId,
      },
    };
  }

  const pinDisposition = classifyCodexPin({
    pinnedCredentialId: args.sessionPinnedCredentialId,
    pinSource: args.sessionPinSource,
    strategy,
    rotationEnabled,
  });

  // A manual pin is user intent, not a policy hint. Never silently fail it over.
  // We still reject allocator-disabled rows for a NEW turn; a healthy live
  // same-turn lease already returned above before this admission filter.
  if (pinDisposition === "manual" && args.sessionPinnedCredentialId) {
    const pinned = accounts.find((account) => account.id === args.sessionPinnedCredentialId);
    if (!pinned) {
      return { credentialId: null, decision: { kind: "none" }, advanceActivePointer: false };
    }
    if (failedCredentialIds.has(pinned.id)) {
      return { credentialId: null, decision: { kind: "none" }, advanceActivePointer: false };
    }
    if (!pinned.allocatorEnabled) {
      return {
        credentialId: null,
        decision: { kind: "allocatorDisabled", credentialId: pinned.id },
        advanceActivePointer: false,
      };
    }
    if (isCodexCredentialHealthy(pinned, args.now)) {
      return {
        credentialId: pinned.id,
        decision: { kind: "active", credentialId: pinned.id, moved: false },
        advanceActivePointer: false,
      };
    }
    return {
      credentialId: null,
      decision: {
        kind: "allCapped",
        earliestResetAt: availableAt(pinned, args.now),
      },
      advanceActivePointer: false,
    };
  }

  // Pin-policy homes compose with the credential allocator by sharding only the candidate list
  // handed to this selector. A future policy filter may therefore choose one
  // primary/fallback pool before this ranker runs; accounts from different pools
  // are never union-ranked here.
  if (pinDisposition === "sharded") {
    const unattemptedAccounts = accounts.filter((account) => !failedCredentialIds.has(account.id));
    if (unattemptedAccounts.length === 0) {
      return { credentialId: null, decision: { kind: "none" }, advanceActivePointer: false };
    }
    const shard = chooseShardedHome({
      sessionId: args.sessionId,
      currentPolicyPin: args.sessionPinSource === "policy" ? args.sessionPinnedCredentialId : null,
      accounts: unattemptedAccounts,
      now: args.now,
    });
    if (shard.kind === "allCapped") {
      return {
        credentialId: null,
        decision: shard,
        advanceActivePointer: false,
      };
    }
    return {
      credentialId: shard.credentialId,
      decision: {
        kind: "active",
        credentialId: shard.credentialId,
        moved: shard.credentialId !== activeCredentialId,
      },
      advanceActivePointer: false,
    };
  }

  // A stale policy pin is intentionally ignored here and cleared by the caller
  // after the atomic selection. Rotation-off/unpinned behavior otherwise keeps
  // the pre-lease pin > active-pointer contract. The pointer is preference, not
  // proof of capacity: rotation-off must wait on a capped pointer rather than
  // falsely admitting it or silently failing over to another subscription.
  if (!rotationEnabled) {
    const active = activeCredentialId
      ? accounts.find((account) => account.id === activeCredentialId)
      : undefined;
    if (!active) {
      return { credentialId: null, decision: { kind: "none" }, advanceActivePointer: false };
    }
    if (failedCredentialIds.has(active.id)) {
      return { credentialId: null, decision: { kind: "none" }, advanceActivePointer: false };
    }
    if (!active.allocatorEnabled) {
      return {
        credentialId: null,
        decision: { kind: "allocatorDisabled", credentialId: active.id },
        advanceActivePointer: false,
      };
    }
    if (!isCodexCredentialHealthy(active, args.now)) {
      return {
        credentialId: null,
        decision: { kind: "allCapped", earliestResetAt: availableAt(active, args.now) },
        advanceActivePointer: false,
      };
    }
    return {
      credentialId: active.id,
      decision: { kind: "active", credentialId: active.id, moved: false },
      advanceActivePointer: false,
    };
  }

  const priorId = args.sessionLastCredentialId ?? activeCredentialId;
  const unattemptedAccounts = accounts.filter((account) => !failedCredentialIds.has(account.id));
  const decision = chooseRotationActive({
    rotationStrategy: strategy,
    activeCredentialId,
    // Per-session continuity is the round-robin/drain cursor. Falling back to
    // the workspace pointer is only correct when this session has never run.
    priorCredentialId: priorId,
    accounts: unattemptedAccounts,
    now: args.now,
  });
  return {
    credentialId: decision.kind === "active" ? decision.credentialId : null,
    decision,
  };
}
