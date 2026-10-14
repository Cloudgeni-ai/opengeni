import type { SessionEvent, SessionStatus } from "@opengeni/sdk";

/**
 * Finite same-turn provider recovery, projected for people. Presentation only:
 * the worker owns retry authority, pacing and the recovery budget. The worker
 * (`apps/worker/src/activities/agent-turn/provider-recovery-copy.ts`) writes
 * the same exhausted sentence into `turn.failed.error`; keep the two in step.
 */
export type ProviderRecoveryCondition =
  | "overloaded"
  | "unavailable"
  | "unresponsive"
  | "rate_limited";

export type ProviderRecoveryFacts = {
  /** Recorded worker failure code (`provider_unavailable`, `mcp_transport_timeout`, ...). */
  code: string;
  condition: ProviderRecoveryCondition | null;
  /** Display label of the affected model, when the route was recorded. */
  modelLabel: string | null;
  /** Display label of the serving provider, when the route was recorded. */
  providerLabel: string | null;
  /** Automatic retries scheduled (live) or spent (exhausted). */
  attempt: number | null;
  /** Finite automatic retry budget. */
  maxAttempts: number | null;
  /** True when the model route itself is affected, so another model may help. */
  modelRoute: boolean;
  /** True while the turn waits for its sandbox to be saved and replaced. It
   * has no retry budget: it resumes as soon as the successor box is ready. */
  sandboxWait?: boolean;
  /** Recorded lifecycle fence of a sandbox wait (`capture_in_progress`,
   * `rotation_in_progress`, `provider_recovery_in_progress`), when known. */
  sandboxTransition?: string | null;
};

const MODEL_CODES: ReadonlySet<string> = new Set([
  "provider_unavailable",
  "provider_rate_limited",
  "provider_unknown_finish_reason",
  "post_compaction_continuation_empty",
]);

/** A recovering turn parked behind a sandbox lifecycle transition (worker
 * `failure-settlement.ts`). Before, this showed only "Recovering" with no
 * reason. A superseded lease
 * counts only when the worker recorded the pending transition it waits for. */
const SANDBOX_WAIT_CODES: ReadonlySet<string> = new Set([
  "sandbox_deadline_rotation",
  "sandbox_lifecycle_transition",
  "sandbox_lease_superseded",
]);

const RECOVERY_CODES: ReadonlySet<string> = new Set([
  ...MODEL_CODES,
  ...SANDBOX_WAIT_CODES,
  "upstream_connectivity_unavailable",
  "mcp_transport_timeout",
  "mcp_transport_unavailable",
  "sandbox_command_start_unavailable",
  "turn_execution_policy_definition_mismatch",
]);

/** Matches the worker's default budget for legacy events that omit it. */
const DEFAULT_MAX_ATTEMPTS = 5;

function text(value: unknown, max = 120): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, max) : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function condition(
  payload: Record<string, unknown>,
  code: string,
): ProviderRecoveryCondition | null {
  const recorded = payload.providerCondition;
  if (
    recorded === "overloaded" ||
    recorded === "unavailable" ||
    recorded === "unresponsive" ||
    recorded === "rate_limited"
  )
    return recorded;
  if (code === "provider_rate_limited") return "rate_limited";
  if (code !== "provider_unavailable") return null;
  // Older events predate the typed condition; their provider text still says so.
  return [payload.lastRetryableError, payload.detail, payload.error].some(
    (value) => typeof value === "string" && /\boverload(?:ed)?(?:_error)?\b/i.test(value),
  )
    ? "overloaded"
    : null;
}

/**
 * Read a retryable `turn.recovery.requested` payload or an exhausted
 * `turn.failed` payload. Returns null for every other recovery reason (human
 * Retry, worker shutdown, credential rotation, capacity waits, ...).
 */
export function parseProviderRecovery(payload: unknown): ProviderRecoveryFacts | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const code = text(record.code) ?? text(record.reason);
  if (!code || !RECOVERY_CODES.has(code)) return null;
  const rotation = text(record.rotationReason);
  const transition = text(record.transitionReason);
  if (code === "sandbox_lease_superseded" && !rotation && !transition) return null;
  // A live recovery request is retryable; a spent budget is explicitly marked.
  if (record.recoveryExhausted !== true && record.retryable === false) return null;
  const attempt = count(record.providerRecoveryCount);
  return {
    code,
    condition: condition(record, code),
    modelLabel: text(record.modelLabel),
    providerLabel: text(record.providerLabel),
    attempt,
    maxAttempts: count(record.maxProviderRecoveryCount) ?? DEFAULT_MAX_ATTEMPTS,
    modelRoute: MODEL_CODES.has(code),
    ...(SANDBOX_WAIT_CODES.has(code)
      ? {
          sandboxWait: true,
          sandboxTransition: transition ?? (rotation ? "rotation_in_progress" : null),
        }
      : {}),
  };
}

/** One present-tense clause naming what is unavailable, without a trailing period. */
export function providerRecoverySubject(facts: ProviderRecoveryFacts): string {
  const model = facts.modelLabel ?? "The model";
  const at = facts.providerLabel ? ` at the provider (${facts.providerLabel})` : " at the provider";
  switch (facts.code) {
    case "provider_rate_limited":
      return `${model} is rate limited${at}`;
    case "provider_unavailable":
      return facts.condition === "overloaded"
        ? `${model} is overloaded${at}`
        : facts.condition === "unresponsive"
          ? `${model} stopped responding${at}`
          : `${model} is temporarily unavailable${at}`;
    case "provider_unknown_finish_reason":
      return `${model} ended its response unexpectedly`;
    case "post_compaction_continuation_empty":
      return `${model} stopped right after compacting the conversation`;
    case "upstream_connectivity_unavailable":
      return "Opengeni can't reach an upstream service";
    case "mcp_transport_timeout":
      return "A required MCP server isn't responding";
    case "mcp_transport_unavailable":
      return "A required MCP server is unreachable";
    case "sandbox_command_start_unavailable":
      return "The sandbox isn't ready yet";
    case "turn_execution_policy_definition_mismatch":
      return "Opengeni is applying a configuration update";
    case "sandbox_deadline_rotation":
      return "The sandbox reached its maximum lifetime, so Opengeni is moving the workspace to a fresh sandbox";
    case "sandbox_lifecycle_transition":
    case "sandbox_lease_superseded":
      return facts.sandboxTransition === "capture_in_progress"
        ? "Opengeni is saving the sandbox workspace"
        : facts.sandboxTransition === "provider_recovery_in_progress"
          ? "Opengeni is recovering the sandbox"
          : facts.sandboxTransition === "rotation_in_progress"
            ? "Opengeni is moving the workspace to a fresh sandbox"
            : "Opengeni is preparing the sandbox";
    default:
      return "A service this turn depends on is temporarily unavailable";
  }
}

/** Live status while the same turn waits for its next automatic retry. */
export function providerRecoveryRetryingText(facts: ProviderRecoveryFacts): string {
  if (facts.sandboxWait) return `${providerRecoverySubject(facts)}…`;
  const progress =
    facts.attempt !== null && facts.maxAttempts !== null
      ? ` (attempt ${Math.min(facts.attempt, facts.maxAttempts)} of ${facts.maxAttempts})`
      : " automatically";
  return `${providerRecoverySubject(facts)} — retrying${progress}…`;
}

/** Terminal sentence once the automatic budget is spent. */
export function providerRecoveryExhaustedText(facts: ProviderRecoveryFacts): string {
  const spent = facts.attempt ?? facts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retried = `Opengeni retried ${spent} ${spent === 1 ? "time" : "times"} without success.`;
  const remedy = facts.modelRoute
    ? "Try again in a few minutes, or switch to another model."
    : "Try again in a few minutes.";
  return `${providerRecoverySubject(facts)}. ${retried} ${remedy}`;
}

const BOUNDARY_TYPES: ReadonlySet<string> = new Set([
  "turn.recovery.requested",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "turn.superseded",
]);

/**
 * The active turn's current automatic provider retry, or null. Only a
 * `recovering`, unpaused session qualifies, and only the newest boundary of its
 * exact active turn counts, so merged or replayed pages never borrow another
 * turn's diagnosis.
 */
export function currentProviderRecovery(
  session: {
    id: string;
    status: SessionStatus | null | undefined;
    activeTurnId: string | null | undefined;
    effectiveControl?: { state: string } | null | undefined;
  },
  events: readonly SessionEvent[],
): ProviderRecoveryFacts | null {
  if (
    session.status !== "recovering" ||
    (session.effectiveControl && session.effectiveControl.state !== "active") ||
    !session.activeTurnId
  )
    return null;
  let latest: SessionEvent | undefined;
  for (const event of events) {
    if (
      event.sessionId !== session.id ||
      event.turnId !== session.activeTurnId ||
      event.duplicateOfEventId ||
      (event.turnAssociation && event.turnAssociation !== "current") ||
      !BOUNDARY_TYPES.has(event.type)
    )
      continue;
    if (!latest || event.sequence > latest.sequence) latest = event;
  }
  if (latest?.type !== "turn.recovery.requested") return null;
  const payload = latest.payload as Record<string, unknown> | null | undefined;
  return payload?.recoveryExhausted === true ? null : parseProviderRecovery(payload);
}
