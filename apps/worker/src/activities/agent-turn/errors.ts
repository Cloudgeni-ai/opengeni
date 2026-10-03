import { ClaudeSubscriptionReconnectRequired } from "@opengeni/db";
import { DrizzleQueryError } from "drizzle-orm";
import { SandboxCapabilitiesChangedError } from "./provider-dispatch-barrier";
import { ClaudeSubscriptionConnectionUnavailable } from "./claude-usage-observer";
import {
  ActiveSessionHistoryLimitExceededError,
  ApprovalRunStateLimitExceededError,
  nestedPostgresSqlState,
  databaseFailureCode,
  isRetryablePersistenceSqlState,
  safeDatabaseErrorFacts,
  isRetryableDatabaseTransportFailure,
  isSessionEventPersistenceError,
  SandboxLeaseTransitionError,
} from "@opengeni/db";
import {
  ActiveBackendUnresolvableError,
  AnthropicProviderRejection,
  CompactionProviderResponseError,
  EmptyCompactionSummaryError,
  compactionProviderRejection,
  describeCompactionProviderRejection,
  type CompactionProviderRejection,
  isMcpRequestTimeoutError,
  isMcpTransportConnectivityError,
  isModalTaskExecStartPreDispatchUnavailableError,
  isModalCommandStartOutcomeUnknownError,
  isProviderCommandObservationUnavailableError,
  isRoutingMutationOutcomeUnknownError,
  RoutingWorkspaceRootChangedError,
  ResponsesStreamingTerminalError,
  SandboxMaterializationVerificationError,
  materializationVerificationDiagnostic,
  type MaterializationVerificationDiagnostic,
  PROVIDER_QUOTA_EXHAUSTED_CODE,
  type ProviderQuotaExhaustion,
  type ProviderQuotaScope,
  classifyProviderQuotaError,
  providerQuotaExhaustedMessage,
  SelfhostedWorkspaceRootChangedError,
  UNKNOWN_MODEL_FINISH_REASON_CODE,
  AnthropicRequestError,
} from "@opengeni/runtime";
import {
  mcpTransportRequestFailureDiagnostic,
  type McpTransportRequestFailureDiagnostic,
} from "@opengeni/runtime/mcp-network";
import { ApplicationFailure, CancelledFailure } from "@temporalio/activity";
import { CODEX_USAGE_EXHAUSTED_PCT } from "../codex-rotation";
import { RetainedAttachmentTransportLimitError } from "../run-input";
import type { CodexAccountStatus } from "@opengeni/db";
import {
  CODEX_USAGE_LIMIT_ERROR_TYPE,
  CodexReloginRequired,
  classifyCodexEncryptedArtifactRejection,
  classifyCodexEntitlementRejection,
  classifyCodexResponseTimeoutError,
  classifyCodexUsageLimitError,
  isCodexTransportError,
} from "@opengeni/codex";
import {
  CodexPlanEntitlementError,
  codexPlanEntitlementFailurePayload,
  codexRequestRejectedFailurePayload,
} from "./codex-plan-entitlement";
import {
  classifyXaiSubscriptionStreamingTerminalError,
  classifyXaiSubscriptionStreamIdleTimeoutError,
  isXaiSubscriptionHostedToolContinuationError,
  isXaiSubscriptionRateLimitDiagnostic,
  isXaiSubscriptionTransportError,
  XaiSubscriptionReloginRequired,
} from "@opengeni/xai-subscription";
import type {
  EscapedMcpTimeoutRecoveryDetail,
  PostClaimDatabaseRecoveryDetail,
  PreClaimFailureDetail,
} from "../types";
import {
  ESCAPED_MCP_TIMEOUT_RECOVERY_FAILURE_MESSAGE,
  ESCAPED_MCP_TIMEOUT_RECOVERY_FAILURE_TYPE,
  POST_CLAIM_DATABASE_RECOVERY_FAILURE_MESSAGE,
  POST_CLAIM_DATABASE_RECOVERY_FAILURE_TYPE,
  PRE_CLAIM_FAILURE_MESSAGE,
  PRE_CLAIM_FAILURE_TYPE,
} from "../types";
import {
  MandatoryHistoryPersistenceError,
  type MandatoryHistoryPersistenceStage,
} from "./quiescence";

// Retryable provider connectivity/5xx failures start quickly and back off to
// this ceiling. Explicit rate limits retain the minute-granular fallback.
export const PROVIDER_BACKPRESSURE_DELAY_MS = 60_000;
export const PROVIDER_CONNECTIVITY_BACKOFF_MS = [2_000, 5_000, 15_000, 30_000, 60_000] as const;
export const MAX_AUTOMATIC_PROVIDER_RECOVERIES = PROVIDER_CONNECTIVITY_BACKOFF_MS.length;
/**
 * Minimum wait per rate-limited recovery. Providers such as Azure OpenAI often
 * answer a per-minute token limit with a `retry-after` of about a second, which
 * alone would spend every automatic recovery before the window resets.
 */
export const PROVIDER_RATE_LIMIT_BACKOFF_MS = [10_000, 20_000, 40_000, 60_000, 120_000] as const;
export const POST_COMPACTION_CONTINUATION_EMPTY_CODE = "post_compaction_continuation_empty";

export class PostCompactionContinuationEmptyError extends Error {
  readonly code = POST_COMPACTION_CONTINUATION_EMPTY_CODE;

  constructor() {
    super("Post-compaction continuation stream ended before a terminal model response");
    this.name = "PostCompactionContinuationEmptyError";
  }
}

export type ProviderRecoveryResult =
  | {
      status: "recovering";
      continueDelayMs: number;
    }
  | {
      status: "exhausted";
      providerRecoveryCount: number;
      maxProviderRecoveryCount: number;
    };

export function providerRecoveryResult(input: {
  failureCode: string | undefined;
  attemptNumber: number;
  retryAfterMs?: number | null;
}): ProviderRecoveryResult {
  if (input.attemptNumber > MAX_AUTOMATIC_PROVIDER_RECOVERIES) {
    return {
      status: "exhausted",
      providerRecoveryCount: MAX_AUTOMATIC_PROVIDER_RECOVERIES,
      maxProviderRecoveryCount: MAX_AUTOMATIC_PROVIDER_RECOVERIES,
    };
  }
  const providerDelay =
    input.retryAfterMs !== null &&
    input.retryAfterMs !== undefined &&
    Number.isFinite(input.retryAfterMs) &&
    input.retryAfterMs > 0
      ? Math.ceil(input.retryAfterMs)
      : null;
  const continueDelayMs =
    input.failureCode === "provider_rate_limited"
      ? Math.max(
          providerDelay ?? PROVIDER_BACKPRESSURE_DELAY_MS,
          PROVIDER_RATE_LIMIT_BACKOFF_MS[
            Math.min(
              Math.max(Math.trunc(input.attemptNumber) - 1, 0),
              PROVIDER_RATE_LIMIT_BACKOFF_MS.length - 1,
            )
          ]!,
        )
      : input.failureCode === "provider_unavailable" ||
          input.failureCode === "upstream_connectivity_unavailable" ||
          input.failureCode === "sandbox_command_start_unavailable" ||
          input.failureCode === "mcp_transport_timeout" ||
          input.failureCode === "mcp_transport_unavailable" ||
          input.failureCode === "turn_execution_policy_definition_mismatch" ||
          input.failureCode === POST_COMPACTION_CONTINUATION_EMPTY_CODE
        ? Math.max(
            providerDelay ?? 0,
            PROVIDER_CONNECTIVITY_BACKOFF_MS[
              Math.min(
                Math.max(Math.trunc(input.attemptNumber) - 1, 0),
                PROVIDER_CONNECTIVITY_BACKOFF_MS.length - 1,
              )
            ]!,
          )
        : PROVIDER_BACKPRESSURE_DELAY_MS;
  return {
    status: "recovering",
    continueDelayMs,
  };
}

export function providerRecoveryExhaustedFailure<
  T extends Record<string, unknown> & { error: string },
>(
  failure: T,
  recovery: Extract<ProviderRecoveryResult, { status: "exhausted" }>,
): T & {
  retryable: false;
  recoveryExhausted: true;
  providerRecoveryCount: number;
  maxProviderRecoveryCount: number;
  lastRetryableError: string;
} {
  return {
    ...failure,
    error: `Automatic same-turn recovery stopped after ${recovery.providerRecoveryCount} retries because the upstream dependency remained unavailable. Send a new message to retry after the dependency recovers.`,
    retryable: false,
    recoveryExhausted: true,
    providerRecoveryCount: recovery.providerRecoveryCount,
    maxProviderRecoveryCount: recovery.maxProviderRecoveryCount,
    lastRetryableError: failure.error,
  };
}

export function providerRecoveryCountFromMetadata(metadata: Record<string, unknown>): number {
  const value = metadata.providerRecoveryCount;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function providerRecoveryCountAfterModelRequestPhase(
  currentCount: number,
  phase: string,
): number {
  return phase === "completed" ? 0 : currentCount;
}

export function headerValue(headers: unknown, name: string): string | null {
  if (!headers || typeof headers !== "object") return null;
  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === "function") {
    const value = getter.call(headers, name);
    return typeof value === "string" ? value : null;
  }
  const target = name.toLowerCase();
  const entry = Object.entries(headers as Record<string, unknown>).find(
    ([key, value]) => key.toLowerCase() === target && typeof value === "string",
  );
  return typeof entry?.[1] === "string" ? entry[1] : null;
}

/** Read a provider Retry-After hint without retaining response headers/body. */
export function providerRetryAfterMs(error: unknown, nowMs = Date.now()): number | null {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth += 1) {
    const value = current as Record<string, unknown>;
    const body =
      value.error && typeof value.error === "object"
        ? (value.error as Record<string, unknown>)
        : null;
    const milliseconds = Number(
      headerValue(value.headers, "retry-after-ms") ??
        headerValue(value.responseHeaders, "retry-after-ms") ??
        headerValue(body?.headers, "retry-after-ms") ??
        undefined,
    );
    if (Number.isFinite(milliseconds) && milliseconds > 0) return Math.ceil(milliseconds);
    const directSeconds = Number(
      value.retry_after_seconds ?? body?.retry_after_seconds ?? value.retryAfterSeconds,
    );
    const header =
      headerValue(value.headers, "retry-after") ??
      headerValue(value.responseHeaders, "retry-after") ??
      headerValue(body?.headers, "retry-after");
    const headerSeconds = header === null ? Number.NaN : Number(header);
    const headerDate =
      header !== null && !Number.isFinite(headerSeconds) ? Date.parse(header) : Number.NaN;
    const seconds = Number.isFinite(directSeconds)
      ? directSeconds
      : Number.isFinite(headerSeconds)
        ? headerSeconds
        : Number.isFinite(headerDate)
          ? Math.max(0, (headerDate - nowMs) / 1_000)
          : Number.NaN;
    if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1_000);
    current = value.cause;
  }
  return null;
}

/**
 * Tell the model when durable MCP policy references are unavailable for this
 * exact turn. The policy projection already bounds and validates these ids;
 * this notice prevents a graceful runtime drop from becoming a silent source-
 * of-truth substitution or a false claim that the disconnected system was read.
 */
export function unavailableMcpOperationalContext(input: {
  droppedIds: readonly string[];
  droppedCount: number;
}): string | undefined {
  if (input.droppedCount <= 0) {
    return undefined;
  }
  const omittedCount = Math.max(0, input.droppedCount - input.droppedIds.length);
  const listed = input.droppedIds.map((id) => `"${id}"`).join(", ");
  const inventory = listed
    ? `${listed}${omittedCount > 0 ? `, plus ${omittedCount} additional unavailable server(s)` : ""}`
    : `${input.droppedCount} unavailable server(s)`;
  return `MCP capability availability for this turn: the following session-selected server(s) are disconnected or no longer registered and were skipped: ${inventory}. Do not claim to have read or updated those systems. If the task depends on one as a source of truth, explain the limitation and ask the user to reconnect it or select another authoritative source; continue with unaffected work only when safe.`;
}

/**
 * Preserve one precise recovery obligation across Temporal's activity boundary.
 * This is intentionally narrower than the ordinary retryable-provider path:
 * only a recovered turn (generation > 1) whose MCP timeout happened before a
 * model request may ask the workflow's DB-only control activity to finish the
 * same-turn checkpoint. The original transport/recovery errors are excluded
 * from details so raw MCP response data can never enter workflow history.
 */
export function escapedMcpTimeoutRecoveryFailure(input: {
  failureCode: string | undefined;
  modelRequestStarted: boolean;
  detail: EscapedMcpTimeoutRecoveryDetail;
}): ApplicationFailure | null {
  if (
    input.failureCode !== "mcp_transport_timeout" ||
    input.modelRequestStarted ||
    !Number.isSafeInteger(input.detail.executionGeneration) ||
    input.detail.executionGeneration <= 1 ||
    !Number.isSafeInteger(input.detail.providerRecoveryCount) ||
    input.detail.providerRecoveryCount <= 0 ||
    input.detail.providerRecoveryCount > MAX_AUTOMATIC_PROVIDER_RECOVERIES ||
    !Number.isSafeInteger(input.detail.continueDelayMs) ||
    input.detail.continueDelayMs <= 0
  ) {
    return null;
  }
  return ApplicationFailure.create({
    message: ESCAPED_MCP_TIMEOUT_RECOVERY_FAILURE_MESSAGE,
    type: ESCAPED_MCP_TIMEOUT_RECOVERY_FAILURE_TYPE,
    nonRetryable: true,
    details: [input.detail],
  });
}

/**
 * Convert the atomic claim transaction's failure into a small, stable
 * Temporal wire contract. The original error remains in activity diagnostics,
 * but SQL text, parameters, and arbitrary invariant messages never enter
 * workflow history. Operational failures retry; other persistence rejections
 * retain accepted work behind a durable explicit-recheck fence. Repeating the
 * same rejected transaction without changed conditions is not recovery.
 */
export function preClaimAdmissionFailure(error: unknown): ApplicationFailure {
  const persistenceFailure = isSessionEventPersistenceError(error) ? error : null;
  const retryableCode = retryableDatabaseFailureCode(error);
  const rejectedClaim =
    persistenceFailure?.details.stage === "session_attempts.claim" &&
    persistenceFailure.details.retryOutcome === "not_retryable" &&
    !retryableCode;
  const detail: PreClaimFailureDetail = {
    disposition: rejectedClaim
      ? "blocked"
      : persistenceFailure || retryableCode
        ? "retryable"
        : "permanent",
    code: retryableCode ?? persistenceFailure?.details.code ?? "claim_invariant",
    ...(persistenceFailure && rejectedClaim
      ? {
          sqlState: persistenceFailure.details.sqlState,
          reason:
            persistenceFailure.details.stage === "session_attempts.claim" &&
            persistenceFailure.details.sqlState === "OG001"
              ? ("initiator_membership_required" as const)
              : persistenceFailure.details.stage === "session_attempts.claim" &&
                  persistenceFailure.details.sqlState === "OG002"
                ? ("personal_resource_grant_required" as const)
                : ("database_claim_rejected" as const),
          retryPolicy: "explicit_recheck" as const,
        }
      : {}),
  };
  return ApplicationFailure.create({
    message: PRE_CLAIM_FAILURE_MESSAGE,
    type: PRE_CLAIM_FAILURE_TYPE,
    nonRetryable: true,
    details: [detail],
  });
}

/** Complete structured-cause graph or no recovery authority. Budget distinct
 * objects (including array containers), not queue positions/duplicate refs.
 * The separate link ceiling bounds huge duplicate arrays without truncating
 * them into permission. Cycles are harmless; overflow/unreadable edges hold. */
function databaseRecoveryCauseGraph(error: unknown): Map<object, Set<object>> | null {
  const graph = new Map<object, Set<object>>();
  const queue: object[] = [];
  let links = 0;
  const add = (value: unknown): boolean => {
    if (!value || typeof value !== "object" || graph.has(value)) return true;
    if (graph.size >= 64) return false;
    graph.set(value, new Set());
    queue.push(value);
    return true;
  };
  if (!add(error)) return null;
  try {
    for (const current of queue) {
      const record = current as Record<string, unknown>;
      const children = Array.isArray(current)
        ? current
        : ["cause", "original", "driverError", "error", "errors"].map((key) => record[key]);
      for (const child of children) {
        if (++links > 4096 || !add(child)) return null;
        if (child && typeof child === "object") graph.get(current)!.add(child);
      }
    }
  } catch {
    return null;
  }
  return graph;
}

function retryableDatabaseFailureCode(
  error: unknown,
  requireDatabaseProvenance = false,
): PostClaimDatabaseRecoveryDetail["code"] | null {
  try {
    const graph = databaseRecoveryCauseGraph(error);
    if (!graph) return null;
    const transports = new Set<object>();
    const boundaries = new Set<object>();
    const codes = new Set<PostClaimDatabaseRecoveryDetail["code"]>();
    // Ask the canonical transport predicate about ONLY this node's facts. Its
    // recursive search must not pair a DB sibling with an unrelated provider.
    for (const node of graph.keys()) {
      if (isRoutingMutationOutcomeUnknownError(node)) return null;
      const record = node as Record<string, unknown>;
      if (isRetryableDatabaseTransportFailure({ code: record.code, errno: record.errno }))
        transports.add(node);
      const sqlState = isSessionEventPersistenceError(node)
        ? node.details.sqlState
        : record.name === "PostgresError" && typeof record.code === "string"
          ? record.code
          : null;
      if (isDatabaseConnectionSqlState(sqlState)) transports.add(node);
    }
    const hasOwnTransport = (boundary: object): boolean => {
      const seen = new Set<object>();
      const queue = [boundary];
      for (const node of queue) {
        if (seen.has(node)) continue;
        seen.add(node);
        if (transports.has(node)) return true;
        queue.push(...graph.get(node)!);
      }
      return false;
    };
    // Inspect ALL trusted DB evidence before returning a permit. A permanent,
    // auth or uncertain SQLSTATE vetoes every sibling regardless of traversal
    // order; a deeper transport/reset cannot override it either.
    for (const node of graph.keys()) {
      const record = node as Record<string, unknown>;
      if (node instanceof DrizzleQueryError) {
        boundaries.add(node);
        if (hasOwnTransport(node)) codes.add("db_failure");
      }
      const typed = isSessionEventPersistenceError(node);
      if (!typed && record.name !== "PostgresError") continue;
      boundaries.add(node);
      const sqlState = typed
        ? node.details.sqlState
        : typeof record.code === "string"
          ? record.code
          : null;
      const connectionOutage = isDatabaseConnectionSqlState(sqlState);
      const code = typed
        ? retryablePersistenceFailureCode(sqlState)
        : connectionOutage || isRetryablePersistenceSqlState(sqlState)
          ? databaseFailureCode(sqlState)
          : null;
      if (
        !code ||
        (requireDatabaseProvenance &&
          !connectionOutage &&
          !(sqlState === null && hasOwnTransport(node)))
      )
        return null;
      codes.add(code);
    }
    // Preserve the legacy pre-execution transport-only allowance, but never
    // borrow it across an explicit DB boundary with no eligible own evidence.
    if (!requireDatabaseProvenance && boundaries.size === 0 && transports.size > 0)
      codes.add("db_failure");
    // Stable classification for multiple positive DB siblings too.
    for (const code of ["db_failure", "db_deadlock", "db_serialization_failure"] as const)
      if (codes.has(code)) return code;
    return null;
  } catch {
    // Unreadable structured facts are no more authority than unreadable edges.
    return null;
  }
}

function isDatabaseConnectionSqlState(sqlState: string | null): boolean {
  return (
    sqlState !== null &&
    (sqlState.startsWith("08") || ["57P01", "57P02", "57P03"].includes(sqlState))
  );
}

function retryablePersistenceFailureCode(
  sqlState: string | null,
): PostClaimDatabaseRecoveryDetail["code"] | null {
  if (
    !(
      sqlState === null ||
      sqlState.startsWith("08") ||
      isRetryablePersistenceSqlState(sqlState) ||
      sqlState.startsWith("53") ||
      sqlState === "55P03" ||
      sqlState === "57014" ||
      sqlState === "57P01" ||
      sqlState === "57P02" ||
      sqlState === "57P03" ||
      sqlState.startsWith("58")
    )
  ) {
    return null;
  }
  return databaseFailureCode(sqlState);
}

/**
 * Carry one exact claimed attempt into the workflow's DB-only
 * recovery lane. Permanent database/state failures remain terminal; only the
 * same operational outage classes that are safe before claim are admitted.
 */
export function postClaimDatabaseRecoveryFailure(input: {
  error: unknown;
  turnId: string;
  triggerEventId: string;
  executionGeneration: number;
  /** After execution starts, a provider socket failure is not DB provenance. */
  requireDatabaseProvenance?: boolean;
  sandboxSetupOutcomeUnknown?: true;
  sandboxSetupRecoveryExhausted?: true;
  providerRecovery?: {
    failureCode: string;
    providerRecoveryCount: number;
  };
}): ApplicationFailure | null {
  const code = retryableDatabaseFailureCode(input.error, input.requireDatabaseProvenance);
  if (
    !code ||
    input.executionGeneration < 1 ||
    (input.requireDatabaseProvenance && code !== "db_failure")
  )
    return null;
  if (
    (input.sandboxSetupOutcomeUnknown && input.sandboxSetupRecoveryExhausted) ||
    ((input.sandboxSetupOutcomeUnknown || input.sandboxSetupRecoveryExhausted) &&
      input.providerRecovery)
  ) {
    return null;
  }
  if (
    input.providerRecovery &&
    (!Number.isSafeInteger(input.providerRecovery.providerRecoveryCount) ||
      input.providerRecovery.providerRecoveryCount <= 0 ||
      input.providerRecovery.providerRecoveryCount > MAX_AUTOMATIC_PROVIDER_RECOVERIES ||
      !/^[a-z][a-z0-9_]{0,63}$/.test(input.providerRecovery.failureCode))
  ) {
    return null;
  }
  const detail: PostClaimDatabaseRecoveryDetail = {
    turnId: input.turnId,
    triggerEventId: input.triggerEventId,
    executionGeneration: input.executionGeneration,
    code,
    ...(input.sandboxSetupOutcomeUnknown ? { sandboxSetupOutcomeUnknown: true } : {}),
    ...(input.sandboxSetupRecoveryExhausted ? { sandboxSetupRecoveryExhausted: true } : {}),
    ...(input.providerRecovery
      ? {
          providerFailureCode: input.providerRecovery.failureCode,
          providerRecoveryCount: input.providerRecovery.providerRecoveryCount,
        }
      : {}),
  };
  return ApplicationFailure.create({
    message: POST_CLAIM_DATABASE_RECOVERY_FAILURE_MESSAGE,
    type: POST_CLAIM_DATABASE_RECOVERY_FAILURE_TYPE,
    nonRetryable: true,
    details: [detail],
  });
}

/**
 * Resolve which Codex account a turn runs on (multi-account P1): session-pin >
 * workspace-active. No rotation in P1. The selected id must still be in the
 * connected set — a disconnected pin was FK-nulled, so a stale id can't appear,
 * but we guard anyway. Returns null when there is no usable account (the turn
 * then fails with the existing relogin error path).
 */
export function isWorkerShutdownCancellation(error: unknown): boolean {
  return error instanceof CancelledFailure && error.message === "WORKER_SHUTDOWN";
}

export type SandboxLifecycleTransitionDiagnostic = {
  sandboxGroupId: string;
  leaseEpoch: number;
  reason: "capture_in_progress" | "rotation_in_progress" | "provider_recovery_in_progress";
};

/**
 * Recover a typed sandbox lifecycle transition through the structural wrappers
 * used by parallel Agents SDK function-tool execution. Never infer transition
 * truth from message text: only the original class or an exact, fully-shaped
 * cross-package error object is accepted.
 */
export function sandboxLifecycleTransitionDiagnostic(
  error: unknown,
): SandboxLifecycleTransitionDiagnostic | null {
  const pending: unknown[] = [error];
  const seen = new WeakSet<object>();
  let inspected = 0;

  while (pending.length > 0 && inspected < 64) {
    const current = pending.shift();
    inspected += 1;
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);

    try {
      const record = current as Record<string, unknown>;
      const reason = record.reason;
      if (
        (current instanceof SandboxLeaseTransitionError ||
          record.name === "SandboxLeaseTransitionError") &&
        typeof record.sandboxGroupId === "string" &&
        record.sandboxGroupId.length > 0 &&
        typeof record.leaseEpoch === "number" &&
        Number.isSafeInteger(record.leaseEpoch) &&
        record.leaseEpoch >= 0 &&
        (reason === "capture_in_progress" ||
          reason === "rotation_in_progress" ||
          reason === "provider_recovery_in_progress")
      ) {
        return {
          sandboxGroupId: record.sandboxGroupId,
          leaseEpoch: record.leaseEpoch,
          reason,
        };
      }

      for (const key of ["cause", "error"] as const) {
        const nested = record[key];
        if (nested && typeof nested === "object") pending.push(nested);
      }
      if (Array.isArray(record.errors)) pending.push(...record.errors.slice(0, 32));
    } catch {
      // A hostile proxy or getter is not durable lifecycle evidence.
    }
  }

  return null;
}

export function modelPreparationFailureEventPayload(error: unknown, durationMs: number) {
  const transition = sandboxLifecycleTransitionDiagnostic(error);
  return {
    phase: "model_preparation",
    durationMs: Math.max(0, Math.round(durationMs)),
    expectedTransition: transition !== null,
    ...(transition
      ? {
          failureCategory: "drain_capture_wait",
          failureStage: "lifecycle_wait",
          failureCode: transition.reason,
          retryable: true,
        }
      : {}),
  };
}

/**
 * Recognize active-route transitions that cannot finish inside their
 * originating attempt. A Modal-home session may start on a Connected Machine
 * without creating or leasing its managed home box. When an explicit attach
 * clears the active pointer back to home, the pointer commit is authoritative,
 * but this attempt has no home session to serve the next sandbox operation.
 *
 * The Agents SDK may retain the typed routing error directly, through `cause`,
 * or inside an AggregateError from a parallel function-tool batch. Traverse
 * only those structural error links with a strict bound; never classify from
 * message text, which could originate in model or tool content.
 */
export function sandboxRouteTransitionCode(
  error: unknown,
):
  | "home_unavailable_this_turn"
  | "workspace_root_changed_this_turn"
  | "native_capabilities_changed_this_attempt"
  | null {
  const pending: unknown[] = [error];
  const seen = new WeakSet<object>();
  let inspected = 0;

  while (pending.length > 0 && inspected < 64) {
    const current = pending.shift();
    inspected += 1;
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);

    try {
      const record = current as Record<string, unknown>;
      if (
        (current instanceof SandboxCapabilitiesChangedError ||
          record.name === "SandboxCapabilitiesChangedError") &&
        record.code === "native_capabilities_changed_this_attempt"
      ) {
        return "native_capabilities_changed_this_attempt";
      }
      if (
        (current instanceof ActiveBackendUnresolvableError ||
          record.name === "ActiveBackendUnresolvableError") &&
        record.code === "home_unavailable_this_turn"
      ) {
        return "home_unavailable_this_turn";
      }
      if (
        current instanceof RoutingWorkspaceRootChangedError ||
        current instanceof SelfhostedWorkspaceRootChangedError ||
        record.name === "RoutingWorkspaceRootChangedError" ||
        record.name === "SelfhostedWorkspaceRootChangedError"
      ) {
        return "workspace_root_changed_this_turn";
      }

      for (const key of ["cause", "error"] as const) {
        const nested = record[key];
        if (nested && typeof nested === "object") pending.push(nested);
      }
      if (Array.isArray(record.errors)) {
        pending.push(...record.errors.slice(0, 32));
      }
    } catch {
      // A hostile proxy or getter is not a route-transition proof.
    }
  }

  return null;
}

export function isSandboxRouteTransitionError(error: unknown): boolean {
  return sandboxRouteTransitionCode(error) !== null;
}

/** Backward-compatible name for callers/tests that only exercised the original
 * machine-to-home transition. */
export function isHomeSandboxTurnTransitionError(error: unknown): boolean {
  return sandboxRouteTransitionCode(error) === "home_unavailable_this_turn";
}

/**
 * Review captures and protective snapshots are cache/persistence housekeeping,
 * never part of cancellation correctness. A control-fenced or Temporal-cancelled
 * attempt must release its physical activity promptly so Steer/Pause can advance.
 */
export function compactionFailureReason(reason: string): string {
  return reason.startsWith("compaction summarization failed:")
    ? reason
    : `compaction summarization failed: ${reason}`;
}

export type SafeErrorDiagnostic = {
  errorClass: "WorkerOperationError";
  errorCode: "worker_operation_failed";
  status?: number;
  origin: "worker";
  historyPersistenceStage?: MandatoryHistoryPersistenceStage;
};

/**
 * Produce the only exception shape allowed in worker logs. It deliberately
 * excludes the arbitrary source message, stack, cause, response/request
 * bodies, and enumerable properties. Exact failure content belongs in the
 * permission-controlled session event, not stdout or telemetry.
 */
export function safeErrorDiagnostic(error: unknown): SafeErrorDiagnostic {
  const diagnostic: SafeErrorDiagnostic = {
    errorClass: "WorkerOperationError",
    errorCode: "worker_operation_failed",
    origin: "worker",
  };
  try {
    let statusSource = error;
    if (error instanceof MandatoryHistoryPersistenceError) {
      diagnostic.historyPersistenceStage = error.stage;
      statusSource = error.cause;
    }
    if (statusSource && typeof statusSource === "object") {
      const status = Number(
        (statusSource as { status?: unknown; statusCode?: unknown }).status ??
          (statusSource as { statusCode?: unknown }).statusCode,
      );
      if (Number.isInteger(status) && status >= 100 && status <= 599) {
        diagnostic.status = status;
      }
    }
  } catch {
    // Public diagnostics are best-effort and must never replace the exact
    // internal worker failure.
  }
  return diagnostic;
}

export function safeErrorForTelemetry(error: unknown): Error {
  const diagnostic = safeErrorDiagnostic(error);
  const safe = new Error("worker operation failed") as Error & {
    code?: string;
    status?: number;
    origin?: string;
  };
  safe.name = "WorkerOperationError";
  safe.code = diagnostic.errorCode;
  if (diagnostic.status !== undefined) safe.status = diagnostic.status;
  safe.origin = diagnostic.origin;
  return safe;
}

/**
 * Guidance appended to a definitive provider rejection. Repeating the exact
 * request cannot succeed, so the generic "send another message to retry"
 * advice is wrong here: a new prompt re-sends the same rejected history.
 */
export const COMPACTION_PROVIDER_REJECTION_GUIDANCE =
  "The provider refused this exact request, so repeating it fails the same way until the conversation changes. If a new message fails again, start a new session.";

export function compactionFailureReasonFromError(error: unknown): string {
  const rejection = compactionProviderRejection(error);
  if (rejection) {
    return compactionFailureReason(
      `the model provider rejected the compaction request (${describeCompactionProviderRejection(rejection)}). Active history was preserved. ${COMPACTION_PROVIDER_REJECTION_GUIDANCE}`,
    );
  }
  // An exhausted provider quota is not retried (see agentRunFailurePayload),
  // so name the refusal plainly instead of the raw diagnostic envelope.
  const quota = classifyProviderQuotaExhaustionError(error);
  if (quota) {
    return compactionFailureReason(
      `${providerQuotaExhaustedMessage(quota.scope)} Active history was preserved.`,
    );
  }
  if (
    error instanceof CompactionProviderResponseError ||
    error instanceof EmptyCompactionSummaryError
  ) {
    return compactionFailureReason(error.message);
  }
  const errorName = error instanceof Error && error.name ? error.name : "unknown error";
  return compactionFailureReason(`unexpected ${errorName}`);
}

/**
 * Exact `turn.failed` payload for a terminal compaction failure. A definitive
 * provider rejection additionally carries its closed identifier record so the
 * timeline, API consumers, and operators can name the rejected field without
 * parsing the message.
 */
export function compactionFailureTurnEventPayload(
  error: unknown,
  overrides: { error?: string } = {},
): {
  error: string;
  code: "context_compaction_failed";
  retryable: false;
  recovery: "user_message";
  compacted: false;
  providerRejection?: CompactionProviderRejection;
  quotaScope?: ProviderQuotaScope;
} {
  const rejection = compactionProviderRejection(error);
  // The same closed marker as a `provider_quota_exhausted` turn failure, so
  // clients can name the exhausted limit and offer another model here too.
  const quota = rejection ? null : classifyProviderQuotaExhaustionError(error);
  return {
    error: overrides.error ?? compactionFailureReasonFromError(error),
    code: "context_compaction_failed",
    retryable: false,
    recovery: "user_message",
    compacted: false,
    ...(rejection ? { providerRejection: rejection } : {}),
    ...(quota ? { quotaScope: quota.scope } : {}),
  };
}

export function isCompactionSummaryFailure(error: unknown): boolean {
  return (
    error instanceof CompactionProviderResponseError || error instanceof EmptyCompactionSummaryError
  );
}

export function shouldRecoverCompactionProviderFailure(error: unknown): boolean {
  if (!(error instanceof CompactionProviderResponseError)) return false;
  if (isCodexTransportError(error) && classifyCodexUsageLimitError(error)) return true;
  // Codex may reject an opaque artifact it minted itself on the compaction
  // request exactly as it can on an ordinary request. Failure settlement
  // invalidates only the exact participating artifacts and recovers the same
  // logical turn; when nothing can be invalidated it fails closed there.
  if (classifyCodexEncryptedArtifactRejection(error)) return true;
  // A ChatGPT plan that no longer includes the model refuses the compaction
  // request exactly as it refuses an ordinary one (often with an empty 400).
  // Failure settlement re-checks the plan and, when it proves the loss,
  // excludes that account for the model and fails the same turn over; an
  // unexplained rejection still fails there with typed copy.
  if (classifyCodexEntitlementRejection(error)) return true;
  return agentRunFailurePayload(error).retryable === true;
}

export function classifyContextWindowOverflowError(
  error: unknown,
): { message: string; code?: string; detail?: string } | null {
  if (isProviderSafetyRefusal(error)) return null;
  const fields = collectErrorStrings(error);
  const matched = fields.find(
    (value) =>
      /context[_\s-]*length[_\s-]*exceeded/i.test(value) ||
      /exceeds?\s+(?:the\s+)?context\s+window/i.test(value) ||
      /maximum\s+context\s+length/i.test(value) ||
      /context\s+window[^.]*exceed/i.test(value),
  );
  if (!matched) {
    return null;
  }
  const message = error instanceof Error ? error.message : String(error);
  const code = fields.find((value) => /context[_\s-]*length[_\s-]*exceeded/i.test(value));
  return {
    message,
    ...(code ? { code } : {}),
    ...(matched && matched !== message ? { detail: matched } : {}),
  };
}

/**
 * Recognize an MCP transport/request timeout that escaped the SDK's per-tool
 * `mcpConfig.errorFunction` boundary. A thrown tool invocation is normally
 * converted to an `{isError:true}` tool output; however, connect/tools-list or
 * next-loop transport work can reject the stream iterator after a prior tool
 * output was already published. That is transient external backpressure, not a
 * terminal session error. Match MCP-qualified timeout text only: an unrelated
 * sandbox/model timeout and MCP's application-defined Authentication required signal must
 * retain their existing semantics.
 */
export function classifyMcpTransportTimeoutError(
  error: unknown,
): { message: string; detail?: string } | null {
  const fields = collectErrorStrings(error);
  const matchedText = fields.find(
    (value) =>
      /\bmcp\b/i.test(value) &&
      /(?:request\s+timed\s+out|request\s+timeout|\btimed\s+out\b|\btimeout\b|ETIMEDOUT)/i.test(
        value,
      ) &&
      !/authentication\s+required/i.test(value),
  );
  const sanitizedSdkTimeout = isMcpRequestTimeoutError(error);
  if (!matchedText && !sanitizedSdkTimeout) {
    return null;
  }
  const message = error instanceof Error ? error.message : String(error);
  const matched = matchedText ?? fields.find((value) => /\bmcp\b/i.test(value));
  return {
    message,
    ...(matched && matched !== message ? { detail: matched } : {}),
  };
}

export function collectErrorStrings(value: unknown, seen = new WeakSet<object>()): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  if (seen.has(value)) {
    return [];
  }
  seen.add(value);
  const out: string[] = [];
  // This diagnostic is already provider-owned and byte-bounded. Do not widen
  // generic detail traversal to arbitrary application payloads.
  if (value instanceof ResponsesStreamingTerminalError) out.push(value.detail);
  const record = value as Record<string, unknown>;
  for (const key of ["message", "code", "type", "name", "param"]) {
    const field = record[key];
    if (typeof field === "string" && field.length > 0) {
      out.push(field);
    }
  }
  for (const key of ["error", "cause", "response", "data"]) {
    out.push(...collectErrorStrings(record[key], seen));
  }
  return out;
}

/**
 * Compute the conversation-truth rows a reconcile pass should append, given the
 * SDK's current `state.history` and the count already persisted.
 *
 * `state.history` is a computed getter that runs the SDK's orphan-tool-call
 * pruning on every access, so it is non-monotonic: a `function_call` with no
 * settling result yet is transiently absent and a later access yields a
 * different, possibly shorter/reordered list. The old code sliced this list by
 * a blind length watermark and appended at fixed positions with
 * onConflictDoNothing, which could freeze a position with one shape and later
 * persist a `function_call_result` whose `function_call` had been pruned away in
 * an earlier slice — the orphaned tool output that 400s the Responses API and
 * bricks the session on every replay.
 *
 * Defending: structurally repair the full current history into an API-valid sequence (the
 * same pure rules the read path uses), then append only the new tail beyond the
 * watermark. A trailing dangling call is dropped here and re-evaluated next
 * pass once its result lands, so a call and its result are written together at
 * consecutive positions and a result is never persisted without its call. The
 * watermark advances to the repaired length — never past anything unwritten —
 * so a non-monotonic history can never desync it. When previously-persisted
 * rows already exceed the repaired length (e.g. legacy orphans written before
 * this fix), nothing new is appended and the watermark holds steady.
 */
/**
 * Stable+unique usage source key for one model call, used to build the per-call
 * idempotency key (`usage:model.tokens:${turnId}:${sourceKey}`). The turnId is
 * shared across a new attempt of the SAME turn (recovery, approval
 * rerun, activity retry), so the sourceKey alone must distinguish calls.
 *
 * - A provider responseId is globally stable+unique, so reuse it verbatim: a
 *   true activity retry that re-emits the same responseId correctly DEDUPES
 *   (one charge), while two distinct calls get distinct ids.
 * - Without a responseId the old synthesized key was only POSITIONAL ("response-1",
 *   "aggregate"), which collides across a re-dispatch — dispatch B's first
 *   call reuses dispatch A's "response-1" key and its charge is silently
 *   dropped (undercharge). Qualifying the synthesized key with the
 *   per-execution dispatch id (the Temporal activityId, unique per scheduled
 *   execution) makes re-dispatched calls distinct while still deduping a
 *   same-execution retry.
 */
export const STATUSLESS_UPSTREAM_CONNECTIVITY_MESSAGE =
  "unable to connect. is the computer able to access the url?";

export function isExactStatuslessUpstreamConnectivityMessage(message: string): boolean {
  return message.trim().toLowerCase() === STATUSLESS_UPSTREAM_CONNECTIVITY_MESSAGE;
}

function providerSafetyRefusalDiagnostic(error: unknown): string | undefined {
  if (error instanceof ResponsesStreamingTerminalError) {
    return error.category === "safety" ? error.detail : undefined;
  }
  return collectErrorStrings(error).find(
    (value) =>
      /^(?:content_policy_violation|content_filter|safety_violation|bio_policy|cyber_policy|misalignment_policy_violation)$/.test(
        value,
      ) || /\bthis request was blocked by our safety systems\b/i.test(value),
  );
}

function isProviderSafetyRefusal(error: unknown): boolean {
  return providerSafetyRefusalDiagnostic(error) !== undefined;
}

export function isTransientProviderError(error: unknown): boolean {
  if (error instanceof ResponsesStreamingTerminalError) {
    return error.category === "unavailable";
  }
  // A semantic refusal can arrive inside a 5xx transport envelope.
  if (isProviderSafetyRefusal(error)) return false;
  const status =
    typeof error === "object" && error !== null
      ? Number(
          (error as { status?: unknown; statusCode?: unknown }).status ??
            (error as { statusCode?: unknown }).statusCode,
        )
      : undefined;
  // A real HTTP status is AUTHORITATIVE: a 5xx is transient, and ANY other status
  // (4xx validation/auth/404, plus the 429 the earlier branches already handled) is
  // a request fault that must NOT auto-retry — even if its body happens to read like
  // "connection error" or "overloaded". The code/message heuristics below apply ONLY
  // when no status survived: a network fault or an SDK-rethrown bare Error.
  if (status !== undefined && Number.isFinite(status)) {
    return status >= 500 && status < 600;
  }
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : undefined;
  if (code && /^(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|EPIPE)$/i.test(code)) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (isExactStatuslessUpstreamConnectivityMessage(message)) {
    return true;
  }
  return /overloaded|an error occurred while processing your request|connection error|service unavailable|bad gateway|gateway timeout/i.test(
    message,
  );
}

/** An explicit `usage_limit_reached` type or code string anywhere on the error chain. */
function hasCodexUsageLimitType(error: unknown): boolean {
  return collectErrorStrings(error).some((value) => value.includes(CODEX_USAGE_LIMIT_ERROR_TYPE));
}

/**
 * Recognize an exhausted API-key provider quota (a daily or monthly allowance,
 * a free-tier day cap, or an account out of credits) as distinct from an
 * ordinary per-minute rate limit. Retrying within the bounded same-turn budget
 * cannot succeed, so the turn fails promptly instead. Subscription transports
 * own their quota semantics through credential rotation and durable capacity
 * waits, so a Codex or SuperGrok transport error never classifies here.
 */
export function classifyProviderQuotaExhaustionError(
  error: unknown,
): ProviderQuotaExhaustion | null {
  if (isCodexTransportError(error) || isXaiSubscriptionTransportError(error)) return null;
  // The same reader the OpenAI SDK retry veto uses, so the two never disagree.
  return classifyProviderQuotaError(error);
}

export type XaiCredentialFailure = {
  kind: "auth" | "forbidden" | "rate_limit";
  cooldownMs: number | null;
};

/**
 * Only definitive SuperGrok account refusals may move the same logical turn to
 * another credential. A marked HTTP 401/403/429, or an HTTP 200 SSE terminal
 * that is a rate-limit/capacity diagnostic, proves inference was refused
 * without an accepted model response; refresh relogin is equally definitive.
 */
export function classifyXaiCredentialFailure(error: unknown): XaiCredentialFailure | null {
  if (isProviderSafetyRefusal(error)) return null;
  let relogin: unknown = error;
  for (let depth = 0; depth < 6 && relogin && typeof relogin === "object"; depth += 1) {
    if (relogin instanceof XaiSubscriptionReloginRequired) {
      return { kind: "auth", cooldownMs: null };
    }
    relogin = (relogin as Record<string, unknown>).cause;
  }
  if (!isXaiSubscriptionTransportError(error)) return null;
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth += 1) {
    const value = current as Record<string, unknown>;
    const body =
      value.error && typeof value.error === "object"
        ? (value.error as Record<string, unknown>)
        : null;
    const status = Number(value.status ?? value.statusCode ?? body?.status ?? body?.statusCode);
    const code = String(value.code ?? body?.code ?? "").toLowerCase();
    if (status === 401 || code === "unauthorized" || code === "invalid_token") {
      return { kind: "auth", cooldownMs: null };
    }
    if (status === 403) {
      return { kind: "forbidden", cooldownMs: null };
    }
    const message = String(value.message ?? body?.message ?? "");
    if (
      isXaiSubscriptionRateLimitDiagnostic({
        code,
        message,
        status: Number.isInteger(status) ? status : null,
      })
    ) {
      return {
        kind: "rate_limit",
        cooldownMs: providerRetryAfterMs(error) ?? PROVIDER_BACKPRESSURE_DELAY_MS,
      };
    }
    current = value.cause;
  }
  return null;
}

// The generic turn-failure boundary also receives application/provider errors.
// A five-character code or generic severity alone does not establish a driver error.
function findPostgresDriverError(error: unknown): Record<string, unknown> | null {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  for (let index = 0; index < queue.length && index < 64; index += 1) {
    const current = queue[index];
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (record.name === "PostgresError") return record;
    for (const key of ["cause", "original", "driverError", "error", "errors"]) {
      const nested = record[key];
      if (Array.isArray(nested)) queue.push(...nested.slice(0, 64));
      else if (nested !== undefined) queue.push(nested);
    }
  }
  return null;
}

function isRawDatabaseQueryError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "query" in error &&
    typeof error.query === "string" &&
    "params" in error &&
    Array.isArray(error.params)
  );
}

function anthropicRequestDiagnostic(error: unknown): AnthropicRequestError | undefined {
  if (error instanceof AnthropicRequestError) return error;
  return error instanceof Error && error.cause instanceof AnthropicRequestError
    ? error.cause
    : undefined;
}

export function agentRunFailurePayload(
  error: unknown,
  options: { isCodexTurn?: boolean } = {},
): ReturnType<typeof baseAgentRunFailurePayload> {
  const failure = baseAgentRunFailurePayload(error, options);
  const diagnostic = materializationVerificationDiagnostic(error);
  const anthropic = anthropicRequestDiagnostic(error);
  if (anthropic) {
    const authenticationRejected =
      anthropic.status === 401 &&
      (error === anthropic ||
        (error instanceof Error && (error as Error & { status?: unknown }).status === 401));
    return {
      ...failure,
      code:
        failure.code ??
        (authenticationRejected ? "anthropic_authentication_error" : anthropic.code),
      retryable: failure.retryable ?? false,
      ...(anthropic.detail ? { detail: anthropic.detail } : {}),
      ...(anthropic.request_id ? { requestId: anthropic.request_id } : {}),
    };
  }
  return diagnostic ? { ...failure, materializationDiagnostic: diagnostic } : failure;
}

/** Keep Anthropic provider text on terminal failures, never recovery events. */
export function agentRunRecoveryFailurePayload(
  error: unknown,
  failure: ReturnType<typeof agentRunFailurePayload>,
): ReturnType<typeof agentRunFailurePayload> {
  if (!anthropicRequestDiagnostic(error)) return failure;
  // Project a copy: retry exhaustion still needs the terminal diagnostic.
  const recovery = { ...failure };
  delete recovery.detail;
  return recovery;
}

function baseAgentRunFailurePayload(
  error: unknown,
  options: { isCodexTurn?: boolean } = {},
): {
  error: string;
  code?: string;
  retryable?: boolean;
  detail?: string;
  timeoutClass?: string;
  responseObserved?: boolean;
  requestId?: string;
  eventCount?: number;
  lastEventType?: string;
  silenceDurationMs?: number;
  correlationId?: string;
  stage?: string;
  sqlState?: string | null;
  attempts?: number;
  retryOutcome?: string;
  database?: Record<string, string>;
  historyPersistenceStage?: MandatoryHistoryPersistenceStage;
  mcpTransportDiagnostic?: McpTransportRequestFailureDiagnostic;
  materializationDiagnostic?: MaterializationVerificationDiagnostic;
  quotaScope?: ProviderQuotaScope;
  /** Closed Codex plan key on `codex_plan_entitlement` / `codex_request_rejected`. */
  planType?: string | null;
  /** Product model id a `codex_plan_entitlement` failure refers to. */
  model?: string | null;
} {
  if (error instanceof SandboxMaterializationVerificationError) {
    return {
      error: error.message,
      code: error.code,
      retryable: false,
      materializationDiagnostic: error.diagnostic,
    };
  }
  if (error instanceof RetainedAttachmentTransportLimitError) {
    return { error: error.message, code: "retained_attachment_transport_limit", retryable: false };
  }
  if (error instanceof MandatoryHistoryPersistenceError) {
    const databaseFailure =
      isSessionEventPersistenceError(error.cause) ||
      findPostgresDriverError(error.cause) !== null ||
      isRawDatabaseQueryError(error.cause);
    const underlying = databaseFailure
      ? agentRunFailurePayload(error.cause, options)
      : {
          error: error.cause instanceof Error ? error.cause.message : String(error.cause),
        };
    return {
      ...underlying,
      historyPersistenceStage: error.stage,
    };
  }
  // Raw ORM wrappers can contain the full SQL and its parameters. Classify a
  // real driver before provider message heuristics; the original cause stays
  // available to internal diagnostics. This payload grants no replay authority.
  const postgresDriverError = findPostgresDriverError(error);
  const rawOrmFailure = isRawDatabaseQueryError(error);
  if ((postgresDriverError || rawOrmFailure) && !isSessionEventPersistenceError(error)) {
    const database = safeDatabaseErrorFacts(postgresDriverError ?? error);
    const sqlState = postgresDriverError ? nestedPostgresSqlState(postgresDriverError) : null;
    return {
      error: "OpenGeni encountered a database error.",
      code: databaseFailureCode(sqlState),
      sqlState,
      ...(Object.keys(database).length > 0 ? { database } : {}),
    };
  }
  if (error instanceof ClaudeSubscriptionConnectionUnavailable) {
    return { error: error.message, code: error.code, retryable: false };
  }
  if (error instanceof AnthropicProviderRejection) {
    return {
      error: error.message,
      code: error.code === "content_policy_violation" ? "provider_safety_refusal" : error.code,
      retryable: false,
      ...(error.request_id ? { requestId: error.request_id } : {}),
    };
  }
  const safetyRefusalDiagnostic = providerSafetyRefusalDiagnostic(error);
  if (safetyRefusalDiagnostic !== undefined) {
    return {
      error:
        "The model provider blocked this request through its safety systems. Automatic retries stopped.",
      code: "provider_safety_refusal",
      retryable: false,
      detail: safetyRefusalDiagnostic,
    };
  }
  if (error instanceof ResponsesStreamingTerminalError) {
    const quota =
      error.category === "unknown" || error.category === "rate_limit"
        ? classifyProviderQuotaExhaustionError({
            code: error.code,
            error: { code: error.code, type: error.type, message: error.detail },
            retryAfterSeconds: error.retryAfterSeconds,
          })
        : null;
    if (quota) {
      return {
        error: providerQuotaExhaustedMessage(quota.scope),
        code: PROVIDER_QUOTA_EXHAUSTED_CODE,
        retryable: false,
        quotaScope: quota.scope,
        detail: error.detail,
      };
    }
    return {
      error:
        error.category === "rate_limit"
          ? "Model provider rate limit hit. Try again in a minute or lower the reasoning effort."
          : error.category === "unavailable"
            ? "The model provider is temporarily unavailable. The same turn will retry after a short delay."
            : "The model provider rejected the response. Automatic retries stopped.",
      code:
        error.category === "rate_limit"
          ? "provider_rate_limited"
          : error.category === "unavailable"
            ? "provider_unavailable"
            : "provider_request_rejected",
      retryable: error.category === "rate_limit" || error.category === "unavailable",
      detail: error.detail,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const status =
    typeof error === "object" && error !== null
      ? Number(
          (error as { status?: unknown; statusCode?: unknown }).status ??
            (error as { statusCode?: unknown }).statusCode,
        )
      : undefined;
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : undefined;
  if (error instanceof ActiveSessionHistoryLimitExceededError) {
    return {
      error:
        "The session's active conversation history exceeds the worker's safe materialization envelope. Clear the session context before retrying; an oversized history cannot be compacted safely in a serving worker.",
      code: error.code,
      retryable: false,
      detail: error.message,
    };
  }
  if (error instanceof ApprovalRunStateLimitExceededError) {
    return {
      error:
        "The saved approval state exceeds the worker's safe materialization envelope. Clear the pending approval context before retrying.",
      code: error.code,
      retryable: false,
      detail: error.message,
    };
  }
  if (error instanceof PostCompactionContinuationEmptyError) {
    return {
      error:
        "Context compaction completed, but the continuation ended before a new model response. The same turn will retry from the compacted checkpoint.",
      code: POST_COMPACTION_CONTINUATION_EMPTY_CODE,
      retryable: true,
    };
  }
  if (isProviderCommandObservationUnavailableError(error)) {
    return {
      error:
        "A managed sandbox command cannot be observed. Its exact invocation and writer remain retained; setup is blocked without replay until the incomplete operation can be reconciled.",
      code: "sandbox_command_observation_unavailable",
      retryable: false,
    };
  }
  if (isModalCommandStartOutcomeUnknownError(error)) {
    return {
      error:
        "A managed sandbox command has an unknown outcome. Its original invocation remains fenced; setup is blocked without replay until the incomplete operation can be reconciled.",
      code: "sandbox_command_start_outcome_unknown",
      retryable: false,
    };
  }
  if (
    !isRoutingMutationOutcomeUnknownError(error) &&
    isModalTaskExecStartPreDispatchUnavailableError(error)
  ) {
    return {
      error:
        "The managed sandbox command router was not ready before the command was sent. The same turn will retry after a short delay.",
      code: "sandbox_command_start_unavailable",
      retryable: true,
    };
  }
  // An accepted Codex stream with no terminal response is malformed/partial,
  // not provider backpressure. Replaying the same accepted turn could repeat
  // model or tool effects, so this marked transport failure must outrank the
  // generic 5xx retry classifier (CodexStreamingTerminalError uses status 502).
  if (isCodexTransportError(error) && code === "invalid_sse_terminal") {
    return {
      error: "The Codex response stream ended without a terminal response",
      code: "invalid_sse_terminal",
      retryable: false,
    };
  }
  if (isXaiSubscriptionHostedToolContinuationError(error)) {
    return {
      error:
        "SuperGrok stopped responding after its hosted search completed. Partial output was preserved; automatic replay is disabled because the accepted response may still have provider-side effects.",
      code: "xai_hosted_tool_continuation_stalled",
      retryable: false,
    };
  }
  const xaiStreamTerminal = classifyXaiSubscriptionStreamingTerminalError(error);
  if (xaiStreamTerminal) {
    return {
      error: xaiStreamTerminal.message,
      code: xaiStreamTerminal.code,
      retryable: xaiStreamTerminal.status === 429,
      lastEventType: xaiStreamTerminal.eventType,
      ...(xaiStreamTerminal.requestId ? { requestId: xaiStreamTerminal.requestId } : {}),
    };
  }
  const xaiStreamTimeout = classifyXaiSubscriptionStreamIdleTimeoutError(error);
  if (xaiStreamTimeout) {
    return {
      error:
        "SuperGrok stopped sending valid response events. Partial output was preserved; automatic replay is disabled because the accepted response may still have provider-side effects.",
      code: "xai_response_stream_idle_timeout",
      retryable: false,
      responseObserved: xaiStreamTimeout.responseObserved,
      eventCount: xaiStreamTimeout.eventCount,
      silenceDurationMs: xaiStreamTimeout.silenceDurationMs,
      ...(xaiStreamTimeout.requestId ? { requestId: xaiStreamTimeout.requestId } : {}),
      ...(xaiStreamTimeout.lastEventType ? { lastEventType: xaiStreamTimeout.lastEventType } : {}),
    };
  }
  if (isSessionEventPersistenceError(error)) {
    const { details } = error;
    return {
      error: error.message,
      code: details.code,
      detail:
        details.retryOutcome === "exhausted"
          ? `The idempotent persistence transaction failed after ${details.attempts} attempts.`
          : "The database rejected the idempotent persistence transaction.",
      correlationId: details.correlationId,
      stage: details.stage,
      sqlState: details.sqlState,
      attempts: details.attempts,
      retryOutcome: details.retryOutcome,
      ...(Object.keys(details.database).length > 0 ? { database: details.database } : {}),
    };
  }
  // Codex plan entitlement: the settlement path normally re-checks the plan
  // and records a precise payload. These branches keep any other path from
  // surfacing the SDK's raw "400 status code (no body)" text.
  if (error instanceof CodexPlanEntitlementError) {
    return error.payload;
  }
  const entitlementRejection = classifyCodexEntitlementRejection(error);
  if (entitlementRejection) {
    return entitlementRejection.evidence === "plan_entitlement"
      ? codexPlanEntitlementFailurePayload({
          accountLabel: null,
          planType: null,
          planChanged: false,
          modelId: null,
          rejection: entitlementRejection,
        })
      : codexRequestRejectedFailurePayload({
          accountLabel: null,
          planType: null,
          rejection: entitlementRejection,
          planChecked: false,
        });
  }
  // A ChatGPT/Codex usage cap is a HARD limit, not transient backpressure: it
  // must NOT be reported as a generic, retryable rate-limit (which would loop a
  // goal against a capped backend). Surface a precise, actionable message with
  // the humanized reset window and code, non-retryable. Checked BEFORE the
  // generic 429 branch below (a usage cap is also a 429).
  // This terminal payload classifier may receive a plain SDK-shaped error in
  // tests or after wrapper metadata was stripped. An explicit
  // `usage_limit_reached` shape must still outrank generic 429 retryability.
  // Credential quarantine/failover remains separately provenance-gated by
  // `isCodexTransportError`; this branch only chooses the truthful user payload.
  // The looser "429 ... usage limit" wording counts only on a Codex transport
  // error: an API-key provider's 429 that says "usage limit" is provider quota
  // evidence, not a ChatGPT/Codex subscription cap.
  const usageLimit = classifyCodexUsageLimitError(error);
  if (usageLimit && (isCodexTransportError(error) || hasCodexUsageLimitType(error))) {
    return codexUsageLimitFailurePayload(usageLimit, message);
  }
  const codexTimeout = classifyCodexResponseTimeoutError(error, {
    allowLegacyRequestTimeout: options.isCodexTurn === true,
  });
  if (codexTimeout) {
    return {
      error: codexTimeout.responseObserved
        ? "The Codex response timed out after streaming began. Observed output was checkpointed; automatic replay is disabled because the upstream operation may still be active."
        : "The Codex response timed out before any response was observed. Upstream acceptance is unknown, so automatic replay is disabled.",
      code: "codex_response_timeout",
      retryable: false,
      timeoutClass: codexTimeout.timeoutClass,
      responseObserved: codexTimeout.responseObserved,
      ...(codexTimeout.requestId ? { requestId: codexTimeout.requestId } : {}),
      ...(codexTimeout.message ? { detail: codexTimeout.message } : {}),
    };
  }
  const mcpTimeout = classifyMcpTransportTimeoutError(error);
  if (mcpTimeout) {
    const mcpTransportDiagnostic = mcpTransportRequestFailureDiagnostic(error);
    return {
      error:
        "An MCP server request timed out. Any completed tool output was checkpointed; the session can continue safely.",
      code: "mcp_transport_timeout",
      retryable: true,
      ...(mcpTimeout.detail || mcpTimeout.message
        ? { detail: mcpTimeout.detail ?? mcpTimeout.message }
        : {}),
      ...(mcpTransportDiagnostic ? { mcpTransportDiagnostic } : {}),
    };
  }
  if (isMcpTransportConnectivityError(error)) {
    const mcpTransportDiagnostic = mcpTransportRequestFailureDiagnostic(error);
    return {
      error:
        "A required MCP server was temporarily unreachable. The same turn will retry after a short delay.",
      code: "mcp_transport_unavailable",
      retryable: true,
      detail: message,
      ...(mcpTransportDiagnostic ? { mcpTransportDiagnostic } : {}),
    };
  }
  if (code === UNKNOWN_MODEL_FINISH_REASON_CODE) {
    return {
      error:
        "The model provider ended its response ambiguously. Partial output was not accepted as complete; the same turn will retry from durable history.",
      code: UNKNOWN_MODEL_FINISH_REASON_CODE,
      retryable: true,
    };
  }
  // An exhausted quota also arrives as HTTP 429 (or 402), but no retry within
  // the finite same-turn budget can succeed. Fail the turn promptly with a
  // distinct code so the client can offer another model; ordinary short rate
  // limits fall through to the retryable branch below.
  if (status === 402 && code === "anthropic_billing_error") {
    return {
      error: "Claude could not bill this request. Check the account's billing and payment details.",
      code: "provider_billing_error",
      retryable: false,
      ...(message ? { detail: message } : {}),
    };
  }
  const quota = classifyProviderQuotaExhaustionError(error);
  if (quota) {
    return {
      error: providerQuotaExhaustedMessage(quota.scope),
      code: PROVIDER_QUOTA_EXHAUSTED_CODE,
      retryable: false,
      quotaScope: quota.scope,
      ...(message ? { detail: message } : {}),
    };
  }
  if (
    status === 429 ||
    ((status === undefined || !Number.isFinite(status)) &&
      (code === "rate_limit_exceeded" ||
        /(?:too many requests|rate.?limit|\b429\b)/i.test(message)))
  ) {
    return {
      error: "Model provider rate limit hit. Try again in a minute or lower the reasoning effort.",
      code: "provider_rate_limited",
      retryable: true,
      ...(message && message !== "Too Many Requests" ? { detail: message } : {}),
    };
  }
  // Transient upstream backpressure (5xx / overloaded / dropped connection): keep
  // the provider's own message (it is already user-meaningful) but mark it
  // retryable so a goal-bearing session idles and auto-continues instead of going
  // terminal on a provider's bad minute. See isTransientProviderError.
  if (isTransientProviderError(error)) {
    if (isExactStatuslessUpstreamConnectivityMessage(message)) {
      return {
        error:
          "OpenGeni could not reach an upstream service. The same turn will retry after a short delay.",
        code: "upstream_connectivity_unavailable",
        retryable: true,
      };
    }
    return { error: message, code: "provider_unavailable", retryable: true };
  }
  return { error: message };
}

export type CodexCredentialFailure = {
  /**
   * `plan_entitlement` is produced only after a plan re-check proves the
   * serving account's current plan does not include the requested model.
   */
  kind: "auth" | "forbidden" | "rate_limit" | "quota" | "plan_entitlement";
  cooldownSeconds: number | null;
};

export const CODEX_ALLOWANCE_FALLBACK_MS = 5 * 60 * 60_000;

/**
 * Resolve a deterministic quarantine end. Generic request throttling honors
 * provider retry-after (or one minute); allowance/quota refusal waits for the
 * LAST of provider reset and every still-binding cached window (five-hour and
 * weekly both bind), falling back to one complete five-hour window when no reset
 * metadata exists.
 */
export function codexCredentialCooldownUntil(
  failure: CodexCredentialFailure,
  account: Pick<
    CodexAccountStatus,
    "primaryUsedPercent" | "primaryResetAt" | "secondaryUsedPercent" | "secondaryResetAt"
  > | null,
  now: Date,
): Date | null {
  if (
    failure.kind === "auth" ||
    failure.kind === "forbidden" ||
    failure.kind === "plan_entitlement"
  ) {
    return null;
  }
  const providerReset =
    failure.cooldownSeconds !== null &&
    Number.isFinite(failure.cooldownSeconds) &&
    failure.cooldownSeconds > 0
      ? new Date(now.getTime() + Math.ceil(failure.cooldownSeconds) * 1000)
      : null;
  if (failure.kind === "rate_limit") {
    return providerReset ?? new Date(now.getTime() + PROVIDER_BACKPRESSURE_DELAY_MS);
  }
  const blockingResets = account
    ? [
        { used: account.primaryUsedPercent, reset: account.primaryResetAt },
        { used: account.secondaryUsedPercent, reset: account.secondaryResetAt },
      ]
        .filter(
          (window): window is { used: number; reset: Date } =>
            (window.used ?? 0) >= CODEX_USAGE_EXHAUSTED_PCT &&
            window.reset instanceof Date &&
            window.reset.getTime() > now.getTime(),
        )
        .map((window) => window.reset)
    : [];
  const quotaResets = providerReset ? [...blockingResets, providerReset] : blockingResets;
  if (quotaResets.length === 0) {
    return new Date(now.getTime() + CODEX_ALLOWANCE_FALLBACK_MS);
  }
  return quotaResets.reduce((latest, reset) =>
    reset.getTime() > latest.getTime() ? reset : latest,
  );
}

/**
 * Only definitive credential/account refusals are safe rotation signals.
 * Ambiguous network failures, malformed/partial streams, invalid model content,
 * prompt 4xx, and provider 5xx may already have consumed tokens or persisted
 * progress and therefore MUST NOT walk the credential pool automatically.
 */
export function classifyCodexCredentialFailure(error: unknown): CodexCredentialFailure | null {
  // A request safety refusal is not evidence that another account should run it.
  if (isProviderSafetyRefusal(error)) return null;
  // A permanent OAuth refresh failure is definitive and the shared resolver has
  // already fenced/stamped the exact credential version. The OpenAI client can
  // wrap a rejection from its custom fetch in APIConnectionError, so recognize
  // the typed exception through the same bounded cause chain used below.
  let refreshError: unknown = error;
  for (let depth = 0; depth < 6 && refreshError && typeof refreshError === "object"; depth += 1) {
    if (refreshError instanceof CodexReloginRequired) {
      return { kind: "auth", cooldownSeconds: null };
    }
    refreshError = (refreshError as Record<string, unknown>).cause;
  }
  // The activity catch also receives sandbox, MCP, storage, and tool failures.
  // Their HTTP status codes are not Codex account state and must never walk the
  // subscription pool or replay a tool on another credential.
  if (!isCodexTransportError(error)) {
    return null;
  }
  // Plan/model entitlement evidence (an explicit plan refusal, or an empty
  // HTTP 400) is not account health or quota. The worker re-checks the plan
  // first; only a proven entitlement loss walks the pool, as `plan_entitlement`.
  if (classifyCodexEntitlementRejection(error)) {
    return null;
  }
  const usageLimit = classifyCodexUsageLimitError(error);
  if (usageLimit) {
    return { kind: "quota", cooldownSeconds: usageLimit.resetsInSeconds };
  }
  let cur: unknown = error;
  for (let depth = 0; depth < 6 && cur && typeof cur === "object"; depth++) {
    const value = cur as Record<string, unknown>;
    const body =
      value.error && typeof value.error === "object"
        ? (value.error as Record<string, unknown>)
        : null;
    const status = Number(value.status ?? value.statusCode ?? body?.status ?? body?.statusCode);
    const code = String(value.code ?? body?.code ?? "").toLowerCase();
    const directRetryAfter = Number(
      value.retry_after_seconds ?? body?.retry_after_seconds ?? value.retryAfterSeconds,
    );
    const retryAfterHeader =
      headerValue(value.headers, "retry-after") ??
      headerValue(value.responseHeaders, "retry-after") ??
      headerValue(body?.headers, "retry-after");
    const retryAfterNumber = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
    const retryAfterDate =
      retryAfterHeader !== null && !Number.isFinite(retryAfterNumber)
        ? Date.parse(retryAfterHeader)
        : Number.NaN;
    const retryAfter = Number.isFinite(directRetryAfter)
      ? directRetryAfter
      : Number.isFinite(retryAfterNumber)
        ? retryAfterNumber
        : Number.isFinite(retryAfterDate)
          ? Math.max(0, (retryAfterDate - Date.now()) / 1000)
          : Number.NaN;
    const cooldownSeconds =
      Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter) : null;
    // Provider quota codes are more specific than their HTTP transport status.
    // A permanent allowance refusal commonly arrives as HTTP 429; classify it
    // before generic backpressure so it receives the binding-window cooldown.
    if (
      code === "insufficient_quota" ||
      code === "quota_exceeded" ||
      code === "billing_hard_limit_reached"
    ) {
      return { kind: "quota", cooldownSeconds };
    }
    if (status === 401 || code === "unauthorized" || code === "invalid_api_key") {
      return { kind: "auth", cooldownSeconds };
    }
    if (status === 403) {
      return { kind: "forbidden", cooldownSeconds };
    }
    if (status === 429 || code === "rate_limit_exceeded" || code === "too_many_requests") {
      return { kind: "rate_limit", cooldownSeconds };
    }
    cur = value.cause;
  }
  return null;
}

/** Humanize a seconds duration into a short "2h 5m" / "9m" / "in under a minute" string. */
export function humanizeResetWindow(resetsInSeconds: number | null): string {
  if (resetsInSeconds === null || !Number.isFinite(resetsInSeconds) || resetsInSeconds <= 0) {
    return "shortly";
  }
  const total = Math.ceil(resetsInSeconds);
  if (total < 60) {
    return "in under a minute";
  }
  const hours = Math.floor(total / 3600);
  const minutes = Math.round((total % 3600) / 60);
  if (hours > 0) {
    return minutes > 0 ? `in about ${hours}h ${minutes}m` : `in about ${hours}h`;
  }
  return `in about ${minutes}m`;
}

/**
 * Build the turn.failed payload for a ChatGPT/Codex usage cap: a precise,
 * actionable message naming the reset window, the stable `codex_usage_limit_reached`
 * code, and retryable:false (an auto-retry would just re-hit the cap).
 */
export function codexUsageLimitFailurePayload(
  info: { resetsInSeconds: number | null },
  detail: string,
  opts?: { allAccounts?: boolean },
): { error: string; code: string; retryable: false; detail?: string } {
  // P3: when EVERY connected subscription is rate-limited the message names the
  // earliest reset across accounts; the single-account message is unchanged.
  const error = opts?.allAccounts
    ? `All connected ChatGPT/Codex subscriptions are rate-limited. Access returns ${humanizeResetWindow(info.resetsInSeconds)}. ` +
      `You can switch this session to a different model in the meantime, or wait for a subscription to reset.`
    : `Your ChatGPT/Codex subscription usage limit has been reached. Access resets ${humanizeResetWindow(info.resetsInSeconds)}. ` +
      `You can switch this session to a different model in the meantime, or wait for the limit to reset.`;
  return {
    error,
    code: "codex_usage_limit_reached",
    retryable: false,
    ...(detail ? { detail } : {}),
  };
}

// A usage cap that won't reset for a long time should not pin a Temporal timer
// open indefinitely for a goal-bearing session; cap the continuation hold so the
// goal re-evaluates at most this far out (it will re-pause if still capped).
export const CODEX_USAGE_LIMIT_MAX_RESUME_MS = 60 * 60_000; // 1h

/** Only typed provider backpressure or a verified reconnect requirement can rotate Claude. */
export function classifyClaudeCredentialFailure(
  error: unknown,
): (XaiCredentialFailure & { requestId?: string }) | null {
  if (isProviderSafetyRefusal(error)) return null;
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current instanceof Error; depth++) {
    if (current instanceof ClaudeSubscriptionReconnectRequired)
      return { kind: "auth", cooldownMs: null };
    if (current instanceof AnthropicRequestError && current.status === 401)
      return {
        kind: "auth",
        cooldownMs: null,
        ...(current.request_id ? { requestId: current.request_id } : {}),
      };
    if (current instanceof AnthropicRequestError && current.status === 429)
      return {
        kind: "rate_limit",
        cooldownMs: providerRetryAfterMs(current) ?? PROVIDER_BACKPRESSURE_DELAY_MS,
        ...(current.request_id ? { requestId: current.request_id } : {}),
      };
    current = current.cause;
  }
  return null;
}
