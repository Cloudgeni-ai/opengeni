// Multi-account P3 — the PURE rotation ranker. Zero I/O: no provider calls, no
// decrypts, no db. It consumes the already-loaded, metadata-only account list
// (cached usage columns + the exhausted_until cooldown column) and returns the
// account a turn should run on. The two call sites (turn-start pre-emption and
// the reactive 429 catch in agent-turn.ts) feed its result into the unchanged
// `selectCodexCredentialForTurn` precedence gate (pin > active). Keeping the
// decision pure makes the whole rotation correctness story unit-testable in
// isolation (see codex-rotation.test.ts).
import type {
  CodexAccountStatus,
  CodexCredentialLeaseSelectionContext,
  CodexLeaseAccountStatus,
  CodexPinSource,
} from "@opengeni/db";

export type CodexRotationAccount = CodexAccountStatus | CodexLeaseAccountStatus;

export type CodexRotationStrategy =
  | "most_remaining"
  | "round_robin"
  | "drain_then_next"
  | "sharded";

/**
 * The ONE strategy rotation-enabled workspaces run: sticky-sharded. The legacy
 * strategies are all strictly dominated post-cache-affinity — session
 * stickiness is worth ~half the prompt-cache hit rate, and round_robin /
 * most_remaining churn accounts per turn while drain_then_next concentrates
 * every concurrent session on ONE account (the measured concurrency-eviction
 * failure sharding replaced). Stored `rotation_strategy` values are therefore
 * NORMALIZED here at every read site: legacy values (and any future unknown
 * string) behave as "sharded". The column and the legacy branch code are kept
 * intact for old-binary rollback safety — they are simply unreachable through
 * this normalization. The API accepts-but-ignores strategy writes for the same
 * reason (no SDK caller breaks). User-facing choice is intentionally gone: the
 * remaining real intents are rotation on/off, per-account allocator
 * include/exclude, and manual pins — not algorithm selection.
 */
export function effectiveRotationStrategy(_stored: string): CodexRotationStrategy {
  return "sharded";
}

/**
 * How a session's codex pin governs THIS turn's account selection (pure). Encodes the
 * policy-pin LIFECYCLE rule: a 'policy' pin is meaningful ONLY while the sharded policy
 * is active.
 *   • "manual"     — a manual pin: honored under EVERY strategy; never moved or cleared.
 *   • "sharded"    — the sharded policy is active and the pin is non-manual: assign / keep
 *                    / re-shard the deterministic home (covers an unpinned first turn AND
 *                    an existing policy pin).
 *   • "clearStale" — a 'policy' pin while the sharded policy is NOT active: IGNORE it
 *                    (never honor it as a sticky pin — that is the no-escape trap) and
 *                    clear it lazily so the session converges to the active strategy.
 *   • "unpinned"   — no pin (or none that applies): follow the active strategy / workspace
 *                    active pointer, unchanged.
 */
export type CodexPinDisposition = "manual" | "sharded" | "clearStale" | "unpinned";

/** Classify a session's codex pin against the active rotation regime (see {@link CodexPinDisposition}). */
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
  // `droppedConnectors` (P4 Part B): the leaving session's used connectors that the
  // chosen account does NOT cover — populated ONLY on a Tier-2/unknown pick that
  // can't cover (prefer-not-require: failover still happens, but the pill warns).
  | { kind: "active"; credentialId: string; moved: boolean; droppedConnectors?: string[] }
  // Every eligible account is capped/cooling: idle until the soonest instant ANY
  // account clears every blocking condition (the multi-account generalization of
  // the single-account idle-until-reset).
  | { kind: "allCapped"; earliestResetAt: Date }
  // No connected accounts at all (preserves today's relogin-fail path).
  | { kind: "none" };

export type CodexTurnLeaseSelection = {
  credentialId: string | null;
  decision: RotationDecision;
  /** Policy/manual homes never move the workspace-global legacy pointer. */
  advanceActivePointer?: boolean;
};

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

function effectiveWindowUsed(usedPercent: number | null, resetAt: Date | null, now: Date): number {
  // A completed provider window is eligible immediately even if its last cache
  // sample still says 100%. This is the five-hour reset boundary—not a TTL
  // heuristic—and avoids stranding a reset subscription while another remains
  // healthy. A future/unknown reset keeps the cached percentage authoritative.
  return resetAt && resetAt.getTime() <= now.getTime() ? 0 : (usedPercent ?? 0);
}

/** The worse live window: weekly binds as hard as 5h. */
function bindingUsedPct(acct: CodexRotationAccount, now: Date): number {
  return Math.max(
    effectiveWindowUsed(acct.primaryUsedPercent, acct.primaryResetAt, now),
    effectiveWindowUsed(acct.secondaryUsedPercent, acct.secondaryResetAt, now),
  );
}

/**
 * Remaining quota across the binding window — the P3 rotation key. Mirrors
 * buildCodexUsageWindowFromCache's `remaining = 100 - percent`, taking the MIN
 * across both windows (the scarcer of 5h/weekly). null percent ⇒ 100 remaining.
 */
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

/**
 * P4 connector coverage (prefer-not-require). `acct` COVERS `usedConnectors` iff its
 * cached connector set is a SUPERSET of the session's used set. An empty used set is
 * trivially covered by everyone (→ Tier 1 == all eligibles == byte-identical to P3).
 * A null (never-probed) set is UNKNOWN: never credited as covering (Tier 2 only),
 * but — critically — never excluded, so failover is fully preserved.
 */
function covers(acct: CodexRotationAccount, usedConnectors: string[]): boolean {
  if (usedConnectors.length === 0) {
    return true;
  }
  const owned = acct.connectorNamespaces;
  if (owned === null) {
    return false; // unprobed ⇒ unknown ⇒ never Tier 1 (but still a Tier-2 candidate)
  }
  const ownedSet = new Set(owned);
  return usedConnectors.every((connector) => ownedSet.has(connector));
}

/**
 * The used connectors the chosen account does NOT cover (the "switch dropped a
 * connector" note). Empty when the account covers (superset) or nothing was used.
 * A null (unknown) set surfaces ALL used connectors — we can't prove it covers them.
 */
function droppedConnectorsFor(acct: CodexRotationAccount, usedConnectors: string[]): string[] {
  if (usedConnectors.length === 0) {
    return [];
  }
  const owned = acct.connectorNamespaces;
  if (owned === null) {
    return [...usedConnectors];
  }
  const ownedSet = new Set(owned);
  return usedConnectors.filter((connector) => !ownedSet.has(connector));
}

/**
 * Healthy for an already-frozen/in-flight turn = connected/usable (status
 * "active", excludes needs_relogin/error), not cooling, and under the
 * near-exhaustion threshold on BOTH windows. Allocator eligibility is
 * deliberately separate so disabling NEW work cannot break refresh/resume.
 */
export function isCodexCredentialHealthy(
  acct: CodexRotationAccount,
  nearExhaustionPct: number,
  now: Date,
): boolean {
  return (
    acct.status === "active" && !cooling(acct, now) && bindingUsedPct(acct, now) < nearExhaustionPct
  );
}

/** New automatic allocation requires both health and explicit allocator eligibility. */
export function isCodexCredentialEligible(
  acct: CodexRotationAccount,
  nearExhaustionPct: number,
  now: Date,
): boolean {
  return acct.allocatorEnabled && isCodexCredentialHealthy(acct, nearExhaustionPct, now);
}

/**
 * Public eligibility predicate (same definition as the private `eligible`): an
 * account is usable this turn iff it is connected/active, not cooling, and under
 * the near-exhaustion threshold on BOTH windows. The worker's sharded home
 * health-check uses this to decide whether a session's existing policy pin is still
 * a valid home or must be re-sharded.
 */
export function isCodexAccountEligible(
  acct: CodexRotationAccount,
  nearExhaustionPct: number,
  now: Date,
): boolean {
  return isCodexCredentialEligible(acct, nearExhaustionPct, now);
}

/** Deterministic 32-bit FNV-1a over a UTF-16 code-unit stream. Pure, allocation-free. */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // 32-bit FNV prime multiply via Math.imul; `>>> 0` keeps it unsigned.
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Session-sharded HOME account (AM-6): the deterministic account a session runs on
 * under the "sharded" strategy — `stableAccountList[ hash(sessionId) % N ]` over the
 * ELIGIBLE (connected, not cooling, under-threshold) accounts in stable created_at
 * order (`listCodexAccountStatuses`).
 *
 * Why deterministic hash over "least-loaded by session count" (AM-6): it needs ZERO
 * coordination — every worker computes the same home for a given (sessionId,
 * eligible-set), so a burst of concurrent first-turns can't all read the same
 * "least-loaded" account and stampede it (read-then-write skew), and there is no
 * shared round-robin cursor to contend on. It is balanced in expectation.
 *
 * Re-shard (AM-5): pass the just-capped account as already-cooling (or simply let it
 * fall over its threshold) and this reshuffles the SURVIVORS deterministically — the
 * sessions that shared a capped account spread across the remaining pool by their own
 * hashes instead of all re-concentrating on one first-eligible failover.
 *
 * Returns null when NO account is eligible (the caller idles until reset).
 */
export function shardCredentialForSession(args: {
  sessionId: string;
  accounts: CodexRotationAccount[];
  nearExhaustionPct: number;
  now: Date;
}): string | null {
  const { sessionId, accounts, nearExhaustionPct, now } = args;
  const eligibles = accounts.filter((acct) =>
    isCodexCredentialEligible(acct, nearExhaustionPct, now),
  );
  if (eligibles.length === 0) {
    return null;
  }
  const index = fnv1a32(sessionId) % eligibles.length;
  return eligibles[index]!.id;
}

/** earliestResetAt across ALL connected accounts — exported for the sharded all-capped idle. */
export function earliestCodexReset(
  accounts: CodexRotationAccount[],
  nearExhaustionPct: number,
  now: Date,
): Date {
  return earliestReset(accounts, nearExhaustionPct, now);
}

/**
 * The proactive SHARDED home decision (pure — zero I/O, like {@link chooseRotationActive}).
 * Decides the account a session should run on THIS turn under the "sharded" strategy,
 * given its current POLICY pin (null on the first turn) and the accounts snapshot:
 *
 *  - keepPin: the current policy pin is still ELIGIBLE → run there, no rewrite. This
 *    is the steady-state cache-warm path (a session stays on its one home account).
 *  - reshard: no policy pin yet (first-turn lazy assignment, AM-7) OR the policy pin
 *    is capped/ineligible (proactive re-shard, AM-4) → deterministically shard over the
 *    ELIGIBLE set (AM-6) and durably (re)write the pin (`rewritePin:true`, AM-3/AM-5).
 *  - allCapped: no account is eligible → the caller idles until the earliest reset.
 *
 * A MANUAL pin is handled by the CALLER (it never reaches here); this function only
 * governs policy homes. Pure so the assignment/re-shard/keep logic is unit-testable
 * without a worker/db env; the caller wraps it with a self-heal usage refresh between
 * two evaluations exactly like chooseRotationActive's allCapped path.
 */
export function chooseShardedHome(args: {
  sessionId: string;
  currentPolicyPin: string | null;
  accounts: CodexRotationAccount[];
  nearExhaustionPct: number;
  now: Date;
}):
  | { kind: "home"; credentialId: string; rewritePin: boolean }
  | { kind: "allCapped"; earliestResetAt: Date } {
  const { sessionId, currentPolicyPin, accounts, nearExhaustionPct, now } = args;
  const pinRow = currentPolicyPin
    ? (accounts.find((acct) => acct.id === currentPolicyPin) ?? null)
    : null;
  if (pinRow && isCodexCredentialEligible(pinRow, nearExhaustionPct, now)) {
    return { kind: "home", credentialId: currentPolicyPin!, rewritePin: false };
  }
  const home = shardCredentialForSession({ sessionId, accounts, nearExhaustionPct, now });
  if (home == null) {
    return { kind: "allCapped", earliestResetAt: earliestReset(accounts, nearExhaustionPct, now) };
  }
  return { kind: "home", credentialId: home, rewritePin: true };
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
export function availableAt(
  acct: CodexRotationAccount,
  nearExhaustionPct: number,
  now: Date,
): Date {
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
  windowClear(
    effectiveWindowUsed(acct.primaryUsedPercent, acct.primaryResetAt, now) >= nearExhaustionPct,
    acct.primaryResetAt,
  );
  windowClear(
    effectiveWindowUsed(acct.secondaryUsedPercent, acct.secondaryResetAt, now) >= nearExhaustionPct,
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

/** earliestResetAt across ALL connected accounts (min of each account's availableAt). */
function earliestReset(
  accounts: CodexRotationAccount[],
  nearExhaustionPct: number,
  now: Date,
): Date {
  return accounts
    .map((acct) => availableAt(acct, nearExhaustionPct, now))
    .reduce((a, b) => (b.getTime() < a.getTime() ? b : a));
}

/**
 * Earliest provider/cooldown timestamp that is actually authoritative. The
 * ranker's `availableAt` deliberately synthesizes a positive default for
 * unknown/stale state; durable capacity waits must distinguish that bounded
 * refresh backoff from a real provider reset timer.
 */
export function authoritativeCodexCapacityResetAt(
  accounts: CodexRotationAccount[],
  nearExhaustionPct: number,
  now: Date,
): Date | null {
  const future: Date[] = [];
  for (const account of accounts) {
    if (!account.allocatorEnabled || account.status !== "active") continue;
    if (account.exhaustedUntil && account.exhaustedUntil.getTime() > now.getTime()) {
      future.push(account.exhaustedUntil);
    }
    if (
      (account.primaryUsedPercent ?? 0) >= nearExhaustionPct &&
      account.primaryResetAt &&
      account.primaryResetAt.getTime() > now.getTime()
    ) {
      future.push(account.primaryResetAt);
    }
    if (
      (account.secondaryUsedPercent ?? 0) >= nearExhaustionPct &&
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

// --- P3 reactive-rotation boundedness (Finding 1). The reactive 429 catch, on a
// LIVE failover candidate, normally returns continueDelayMs:0 (skip the hold and
// re-dispatch NOW — the just-served account is cooling so the next rank cannot
// re-pick it). Two independent second-order faults can break that "cannot
// re-pick it" premise and turn the 0-delay re-dispatch into a hot loop, so this
// pure decision applies two backstops before allowing the 0.

/**
 * Slow-retry floor (Finding 1a) for the double-fault where the just-served
 * account's cooldown write could NOT be confirmed persisted: the next proactive
 * rank might re-select the same capped account (stale-low cached usedPercent, not
 * cooling). A positive floor degrades that to a SLOW retry instead of a
 * model-paced hot loop. A few seconds — long enough to break the loop, short
 * enough to stay responsive once the transient write fault clears.
 */
export const REACTIVE_PERSISTENCE_FAULT_FLOOR_MS = 5_000; // 5s
/**
 * Circuit-breaker slack (Finding 1b) added to the connected-account count to bound
 * consecutive reactive failovers. Each legitimate failover cools one account, so
 * after at most N failovers every account is capped and the reactive path takes the
 * all-capped idle instead; the +margin absorbs benign re-ranks (a connector-covering
 * pick order) without tripping the breaker in normal use.
 */
export const REACTIVE_ROTATION_MARGIN = 2;
/**
 * The FIXED positive idle the reactive path falls to once consecutive reactive
 * failovers exceed the bound (a double-fault where cooldown writes are not sticking
 * AND the 429s carry no usage headers, so the same account keeps getting re-picked).
 * Mirrors the all-capped floor — a mandatory, bounded hold, never another 0-delay
 * re-dispatch — so the loop can never hammer the capped backend + DB (invariant 4).
 */
export const REACTIVE_CIRCUIT_BREAKER_IDLE_MS = MIN_IDLE_MS; // 60s

/** The reactive-resume shape returned to the goal-continuation caller. */
export type ReactiveRotationResume = { continueDelayMs: number; idleUntilReset: boolean };

/**
 * Decide the continueDelayMs for a reactive 429 failover onto a LIVE candidate,
 * bounding the (otherwise 0-delay) re-dispatch against two second-order faults:
 *
 *  1. Circuit breaker (1b): if the consecutive reactive-failover streak (prior
 *     rotated 429 failovers since the last successful turn, PLUS this one) exceeds
 *     `connectedAccountCount + REACTIVE_ROTATION_MARGIN`, fall to a FIXED positive,
 *     MANDATORY idle. Covers the double-fault (cooldown write not persisted + a
 *     header-less cap 429) where the same capped account is re-picked every turn.
 *  2. Persistence-fault floor (1a): if the just-served account's cooldown could NOT
 *     be confirmed persisted, use a positive floor (slow retry) instead of 0.
 *
 * Otherwise (a confirmed cooldown + an in-bounds streak) returns the unchanged
 * 0-delay fast re-dispatch — the happy single-rotation path is byte-identical.
 * Pure so the boundedness contract is unit-testable without a worker/db env.
 */
export function computeReactiveRotationResume(args: {
  cooldownPersisted: boolean;
  priorConsecutiveRotations: number; // reactive rotated failovers since last success (excludes this one)
  connectedAccountCount: number;
}): ReactiveRotationResume {
  const streak = args.priorConsecutiveRotations + 1; // include the failover about to be published
  const bound = args.connectedAccountCount + REACTIVE_ROTATION_MARGIN;
  if (streak > bound) {
    return { continueDelayMs: REACTIVE_CIRCUIT_BREAKER_IDLE_MS, idleUntilReset: true };
  }
  if (!args.cooldownPersisted) {
    return { continueDelayMs: REACTIVE_PERSISTENCE_FAULT_FLOOR_MS, idleUntilReset: false };
  }
  return { continueDelayMs: 0, idleUntilReset: false };
}

/**
 * THE pure rotation ranker. `accounts` arrives in stable created_at order
 * (listCodexAccountStatuses), which deterministically breaks ranking ties.
 */
export function chooseRotationActive(args: {
  rotationStrategy: CodexRotationStrategy;
  activeCredentialId: string | null;
  priorCredentialId: string | null;
  accounts: CodexRotationAccount[];
  nearExhaustionPct: number;
  now: Date;
  // P4 (Part B): the connectors the leaving session has access to (the leaving
  // account's cached connector set, used as the "session needs these" proxy).
  // Optional + defaults to [] ⇒ when absent/empty the ranker is BYTE-IDENTICAL to
  // P3 (every account trivially covers → Tier 1 == all eligibles). Self-gating.
  usedConnectors?: string[];
}): RotationDecision {
  const { activeCredentialId, priorCredentialId, accounts, nearExhaustionPct, now } = args;
  // Normalize at the entry point: rotation-enabled ALWAYS behaves as sharded
  // (see effectiveRotationStrategy). args keeps the field so call sites and
  // tests can still express stored legacy values.
  const rotationStrategy = effectiveRotationStrategy(args.rotationStrategy);
  const allocatableAccounts = accounts.filter((account) => account.allocatorEnabled);
  const usedConnectors = args.usedConnectors ?? [];

  if (allocatableAccounts.length === 0) {
    return { kind: "none" };
  }

  const eligibles = allocatableAccounts.filter((acct) =>
    isCodexCredentialEligible(acct, nearExhaustionPct, now),
  );

  // The active pointer is a cursor/manual preference, NOT a sticky lease. In
  // particular, most_remaining must rank the whole eligible pool every turn;
  // keeping a healthy active account until 90% was the production monopolization
  // defect fixed by OPE-21. drain_then_next remains the one explicitly sticky
  // strategy, and a manual pin is handled by the caller as explicit policy.
  const decide = (chosen: CodexRotationAccount | undefined): RotationDecision => {
    if (!chosen) {
      return {
        kind: "allCapped",
        earliestResetAt: earliestReset(allocatableAccounts, nearExhaustionPct, now),
      };
    }
    // P4: surface the dropped-connector note when the chosen account doesn't cover
    // the session's used connectors (a Tier-2/unknown failover pick). Empty ⇒ omit.
    const dropped = droppedConnectorsFor(chosen, usedConnectors);
    return {
      kind: "active",
      credentialId: chosen.id,
      moved: chosen.id !== activeCredentialId,
      ...(dropped.length > 0 ? { droppedConnectors: dropped } : {}),
    };
  };

  if (rotationStrategy === "round_robin") {
    // Next eligible AFTER the prior account in list order (wrap around). When the
    // prior account isn't found, start from the head.
    if (eligibles.length === 0) {
      return {
        kind: "allCapped",
        earliestResetAt: earliestReset(allocatableAccounts, nearExhaustionPct, now),
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
    const chosen = ordered.find((acct) => isCodexCredentialEligible(acct, nearExhaustionPct, now));
    return decide(chosen);
  }

  if (rotationStrategy === "drain_then_next") {
    // Stay on the prior account while it is eligible (drain it), else first eligible.
    const priorRow = priorCredentialId
      ? accounts.find((acct) => acct.id === priorCredentialId)
      : undefined;
    if (priorRow && isCodexCredentialEligible(priorRow, nearExhaustionPct, now)) {
      return decide(priorRow);
    }
    return decide(eligibles[0]);
  }

  // most_remaining (default + the correctness path). Two-tier coverage pick over
  // the SAME eligible set (prefer-not-require):
  //   Tier 1 — eligibles whose connector set COVERS the session's used set.
  //   Tier 2 — ALL eligibles, only if Tier 1 is empty (failover fully preserved).
  // Within the chosen tier:
  //   1. least active leases (concurrent turns spread before quota metadata moves),
  //   2. most remaining binding quota,
  //   3. fewest historical selections,
  //   4. least-recently selected, then stable created_at/id input order.
  // Base CodexAccountStatus values (pure legacy tests/reactive rank) default the
  // lease/cursor metadata to zero/null, preserving deterministic stable ties.
  const covering = eligibles.filter((acct) => covers(acct, usedConnectors));
  const pool = covering.length > 0 ? covering : eligibles;
  const activeLeases = (acct: CodexRotationAccount): number =>
    "activeLeaseCount" in acct ? acct.activeLeaseCount : 0;
  const selections = (acct: CodexRotationAccount): number =>
    "selectionCount" in acct ? acct.selectionCount : 0;
  const lastSelected = (acct: CodexRotationAccount): number =>
    "lastSelectedAt" in acct && acct.lastSelectedAt ? acct.lastSelectedAt.getTime() : 0;
  const chosen = pool.reduce<CodexRotationAccount | undefined>((best, acct) => {
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

/**
 * Exact pre-0053 selector used while the lease cutover is off.
 *
 * Old workers keep a healthy `most_remaining` active pointer sticky and know
 * nothing about lease counts or fairness cursors. A compatible worker must do
 * the same until BOTH the deployment flag and workspace cutover are enabled;
 * otherwise a rolling fleet would run two allocators at once. When the active
 * pointer is no longer eligible, zeroing the additive metadata delegates to the
 * same capacity/connector ranking that the old selector used.
 */
export function chooseLegacyRotationActive(
  args: Parameters<typeof chooseRotationActive>[0],
): RotationDecision {
  if (args.rotationStrategy === "most_remaining") {
    const active = args.activeCredentialId
      ? args.accounts.find((account) => account.id === args.activeCredentialId)
      : undefined;
    if (active && isCodexCredentialEligible(active, args.nearExhaustionPct, args.now)) {
      return { kind: "active", credentialId: active.id, moved: false };
    }
  }
  return chooseRotationActive({
    ...args,
    accounts: args.accounts.map((account) => ({
      ...account,
      activeLeaseCount: 0,
      selectionCount: 0,
      lastSelectedAt: null,
    })),
  });
}

/**
 * Full pure policy at the transaction boundary. A live same-turn lease is
 * idempotent; the rollout-off/manual path preserves pin>pointer behavior; a
 * healthy pin wins only while eligible, so quota/auth quarantine cannot trap a
 * session on one subscription.
 */
export function selectCodexCredentialLeaseForTurn(args: {
  context: CodexCredentialLeaseSelectionContext;
  leasingEnabled: boolean;
  sessionId: string;
  sessionPinnedCredentialId: string | null;
  sessionPinSource: CodexPinSource | null;
  sessionLastCredentialId: string | null;
  /** Same-turn checkpoint/frozen account; temporary disable cannot move it. */
  continuationCredentialId?: string | null;
  nearExhaustionPct: number;
  now: Date;
}): CodexTurnLeaseSelection {
  const {
    accounts,
    activeCredentialId,
    rotationEnabled,
    leaseRotationEnabled,
    rotationStrategy,
    existingCredentialId,
  } = args.context;
  const leasingEnabled = args.leasingEnabled && leaseRotationEnabled;
  // Normalized: rotation-enabled always behaves as sharded (see
  // effectiveRotationStrategy); the stored value is only ever legacy residue.
  const strategy = effectiveRotationStrategy(rotationStrategy);
  const existing = existingCredentialId
    ? accounts.find((account) => account.id === existingCredentialId)
    : undefined;
  if (existing && isCodexCredentialHealthy(existing, args.nearExhaustionPct, args.now)) {
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

  const continuation = args.continuationCredentialId
    ? accounts.find((account) => account.id === args.continuationCredentialId)
    : undefined;
  if (continuation && isCodexCredentialHealthy(continuation, args.nearExhaustionPct, args.now)) {
    return {
      credentialId: continuation.id,
      advanceActivePointer: false,
      decision: {
        kind: "active",
        credentialId: continuation.id,
        moved: continuation.id !== activeCredentialId,
      },
    };
  }

  const connectedIds = new Set(
    accounts.filter((account) => account.allocatorEnabled).map((account) => account.id),
  );

  const pinDisposition = classifyCodexPin({
    pinnedCredentialId: args.sessionPinnedCredentialId,
    pinSource: args.sessionPinSource,
    strategy,
    rotationEnabled,
  });

  // A manual pin is user intent, not a policy hint. Never silently fail it over.
  // We still reject allocator-disabled rows for a NEW turn; healthy live/frozen
  // same-turn continuity already returned above before this admission filter.
  if (pinDisposition === "manual" && args.sessionPinnedCredentialId) {
    const pinned = accounts.find((account) => account.id === args.sessionPinnedCredentialId);
    if (!pinned?.allocatorEnabled) {
      return { credentialId: null, decision: { kind: "none" }, advanceActivePointer: false };
    }
    if (isCodexCredentialHealthy(pinned, args.nearExhaustionPct, args.now)) {
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
        earliestResetAt: availableAt(pinned, args.nearExhaustionPct, args.now),
      },
      advanceActivePointer: false,
    };
  }

  // OPE-31 policy homes compose with OPE-21 by sharding only the candidate list
  // handed to this selector. A future OPE-32 filter may therefore choose one
  // primary/fallback pool before this ranker runs; accounts from different pools
  // are never union-ranked here.
  if (pinDisposition === "sharded") {
    if (accounts.length === 0) {
      return { credentialId: null, decision: { kind: "none" }, advanceActivePointer: false };
    }
    const shard = chooseShardedHome({
      sessionId: args.sessionId,
      currentPolicyPin: args.sessionPinSource === "policy" ? args.sessionPinnedCredentialId : null,
      accounts,
      nearExhaustionPct: args.nearExhaustionPct,
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
  // the pre-lease pin > active-pointer contract.
  if (!rotationEnabled) {
    const credentialId =
      activeCredentialId && connectedIds.has(activeCredentialId) ? activeCredentialId : null;
    return {
      credentialId,
      decision: credentialId ? { kind: "active", credentialId, moved: false } : { kind: "none" },
    };
  }

  // Before the workspace cutover bit is enabled (or after the deployment kill
  // switch is turned off), preserve the exact legacy policy used by old workers:
  // a pin stays sticky; otherwise an enabled workspace runs the pure legacy
  // rotation ranker without touching lease/cursor state.
  if (!leasingEnabled && pinDisposition !== "clearStale" && args.sessionPinnedCredentialId) {
    const credentialId = connectedIds.has(args.sessionPinnedCredentialId)
      ? args.sessionPinnedCredentialId
      : activeCredentialId && connectedIds.has(activeCredentialId)
        ? activeCredentialId
        : null;
    return {
      credentialId,
      decision: credentialId ? { kind: "active", credentialId, moved: false } : { kind: "none" },
    };
  }

  const priorId = args.sessionLastCredentialId ?? activeCredentialId;
  const choose = leasingEnabled ? chooseRotationActive : chooseLegacyRotationActive;
  const decision = choose({
    rotationStrategy: strategy,
    activeCredentialId,
    // Per-session continuity is the round-robin/drain cursor. Falling back to
    // the workspace pointer is only correct when this session has never run.
    priorCredentialId: priorId,
    accounts,
    nearExhaustionPct: args.nearExhaustionPct,
    now: args.now,
    usedConnectors: accounts.find((account) => account.id === priorId)?.connectorNamespaces ?? [],
  });
  return {
    credentialId: decision.kind === "active" ? decision.credentialId : null,
    decision,
  };
}
