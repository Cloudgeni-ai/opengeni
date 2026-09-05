import {
  ActiveSessionHistoryLimitExceededError,
  ApprovalRunStateLimitExceededError,
  isRetryableDatabaseTransportFailure,
  isSessionEventPersistenceError,
  SandboxLeaseTransitionError,
} from "@opengeni/db";
import {
  ActiveBackendUnresolvableError,
  CompactionProviderResponseError,
  EmptyCompactionSummaryError,
  isMcpRequestTimeoutError,
  isMcpTransportConnectivityError,
  isModalTaskExecStartDnsResolutionError,
  RoutingWorkspaceRootChangedError,
  SelfhostedWorkspaceRootChangedError,
  UNKNOWN_MODEL_FINISH_REASON_CODE,
} from "@opengeni/runtime";
import {
  mcpTransportRequestFailureDiagnostic,
  type McpTransportRequestFailureDiagnostic,
} from "@opengeni/runtime/mcp-network";
import { ApplicationFailure, CancelledFailure } from "@temporalio/activity";
import { CODEX_USAGE_EXHAUSTED_PCT } from "../codex-rotation";
import type { CodexAccountStatus } from "@opengeni/db";
import {
  CodexReloginRequired,
  classifyCodexResponseTimeoutError,
  classifyCodexUsageLimitError,
  isCodexTransportError,
} from "@opengeni/codex";
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
      ? (providerDelay ?? PROVIDER_BACKPRESSURE_DELAY_MS)
      : input.failureCode === "provider_unavailable" ||
          input.failureCode === "upstream_connectivity_unavailable" ||
          input.failureCode === "sandbox_command_start_unavailable" ||
          input.failureCode === "mcp_transport_timeout" ||
          input.failureCode === "mcp_transport_unavailable" ||
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
 * workflow history. Contention and operational database unavailability are
 * safe to re-read after backoff because the claim transaction contains no
 * model/tool effects; permanent database and state failures require terminal
 * settlement.
 */
export function preClaimAdmissionFailure(error: unknown): ApplicationFailure {
  const persistenceFailure = isSessionEventPersistenceError(error) ? error : null;
  const retryableCode = retryableDatabaseFailureCode(error);
  // The database transaction itself retries only the two contention failures
  // proven safe for immediate replay. Once the activity has failed, the
  // workflow may also retry operational outages after a durable re-read and
  // bounded delay. Unknown driver/database failures stay recoverable because
  // they commonly represent a lost connection; known constraint, auth, and
  // application SQLSTATEs are permanent and must not create an infinite loop.
  const detail: PreClaimFailureDetail = {
    disposition: retryableCode ? "retryable" : "permanent",
    code: retryableCode ?? persistenceFailure?.details.code ?? "claim_invariant",
  };
  return ApplicationFailure.create({
    message: PRE_CLAIM_FAILURE_MESSAGE,
    type: PRE_CLAIM_FAILURE_TYPE,
    nonRetryable: true,
    details: [detail],
  });
}

function retryableDatabaseFailureCode(
  error: unknown,
): PostClaimDatabaseRecoveryDetail["code"] | null {
  const persistenceFailure = isSessionEventPersistenceError(error) ? error : null;
  const sqlState = persistenceFailure?.details.sqlState ?? null;
  if (sqlState === null && isRetryableDatabaseTransportFailure(error)) {
    return "db_failure";
  }
  if (
    !persistenceFailure ||
    !(
      sqlState === null ||
      sqlState.startsWith("08") ||
      sqlState.startsWith("40") ||
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
  return persistenceFailure.details.code;
}

/**
 * Carry one exact claimed-but-not-started attempt into the workflow's DB-only
 * recovery lane. Permanent database/state failures remain terminal; only the
 * same operational outage classes that are safe before claim are admitted.
 */
export function postClaimDatabaseRecoveryFailure(input: {
  error: unknown;
  turnId: string;
  triggerEventId: string;
  executionGeneration: number;
  providerRecovery?: {
    failureCode: string;
    providerRecoveryCount: number;
  };
}): ApplicationFailure | null {
  const code = retryableDatabaseFailureCode(input.error);
  if (!code || input.executionGeneration < 1) return null;
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

/**
 * Recognize the one active-route transition that cannot finish inside its
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
): "home_unavailable_this_turn" | "workspace_root_changed_this_turn" | null {
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

export function compactionFailureReasonFromError(error: unknown): string {
  if (
    error instanceof CompactionProviderResponseError ||
    error instanceof EmptyCompactionSummaryError
  ) {
    return compactionFailureReason(error.message);
  }
  const errorName = error instanceof Error && error.name ? error.name : "unknown error";
  return compactionFailureReason(`unexpected ${errorName}`);
}

export function isCompactionSummaryFailure(error: unknown): boolean {
  return (
    error instanceof CompactionProviderResponseError || error instanceof EmptyCompactionSummaryError
  );
}

export function shouldRecoverCompactionProviderFailure(error: unknown): boolean {
  if (!(error instanceof CompactionProviderResponseError)) return false;
  if (isCodexTransportError(error) && classifyCodexUsageLimitError(error)) return true;
  return agentRunFailurePayload(error).retryable === true;
}

export function classifyContextWindowOverflowError(
  error: unknown,
): { message: string; code?: string; detail?: string } | null {
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

function isProviderSafetyRefusal(error: unknown): boolean {
  return collectErrorStrings(error).some(
    (value) =>
      /^(?:content_policy_violation|content_filter|safety_violation|bio_policy|cyber_policy)$/.test(
        value,
      ) || /\bthis request was blocked by our safety systems\b/i.test(value),
  );
}

export function isTransientProviderError(error: unknown): boolean {
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

export function agentRunFailurePayload(
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
} {
  if (error instanceof MandatoryHistoryPersistenceError) {
    const underlying = isSessionEventPersistenceError(error.cause)
      ? agentRunFailurePayload(error.cause, options)
      : {
          error: error.cause instanceof Error ? error.cause.message : String(error.cause),
        };
    return {
      ...underlying,
      historyPersistenceStage: error.stage,
    };
  }
  if (isProviderSafetyRefusal(error)) {
    return {
      error:
        "The model provider blocked this request through its safety systems. Automatic retries stopped.",
      code: "provider_safety_refusal",
      retryable: false,
      detail: error instanceof Error ? error.message : collectErrorStrings(error).join(": "),
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
  if (isModalTaskExecStartDnsResolutionError(error)) {
    return {
      error:
        "The managed sandbox command transport was temporarily unreachable before the command started. The same turn will retry after a short delay.",
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
  const usageLimit = classifyCodexUsageLimitError(error);
  if (usageLimit) {
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
  if (
    status === 429 ||
    code === "rate_limit_exceeded" ||
    /(?:too many requests|rate.?limit|\b429\b)/i.test(message)
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
  kind: "auth" | "forbidden" | "rate_limit" | "quota";
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
  if (failure.kind === "auth" || failure.kind === "forbidden") {
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
