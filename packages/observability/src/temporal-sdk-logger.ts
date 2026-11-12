import type { Attributes, Observability } from "./index";

/**
 * Temporal SDK log levels. Declared structurally so this package does not
 * depend on `@temporalio/*`; the shape matches `@temporalio/common` `Logger`.
 */
export type TemporalSdkLogLevel = "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR";

export type TemporalSdkLogger = {
  log(level: TemporalSdkLogLevel, message: string, meta?: Record<string | symbol, unknown>): void;
  trace(message: string, meta?: Record<string | symbol, unknown>): void;
  debug(message: string, meta?: Record<string | symbol, unknown>): void;
  info(message: string, meta?: Record<string | symbol, unknown>): void;
  warn(message: string, meta?: Record<string | symbol, unknown>): void;
  error(message: string, meta?: Record<string | symbol, unknown>): void;
};

const LEVEL_SEVERITY: Record<TemporalSdkLogLevel, number> = {
  TRACE: 0,
  DEBUG: 1,
  INFO: 2,
  WARN: 3,
  ERROR: 4,
};

/**
 * Constant messages the Temporal TypeScript SDK emits. SDK records whose
 * message is not in this reviewed set (core messages, and SDK messages that
 * interpolate an exception's text) are published under a fixed message, so
 * exception text never reaches public logs through the message field.
 */
const REVIEWED_TEMPORAL_SDK_MESSAGES = new Set([
  "Activity completed",
  "Activity completed as cancelled",
  "Activity failed",
  "Activity failed, waiting for heartbeats to be flushed",
  "Activity paused",
  "Activity reset",
  "Activity resolved",
  "Activity started",
  "Activity will complete asynchronously",
  "Activity Worker terminated",
  "Cancelling activity",
  "Core reported failure in completeWorkflowActivation(). Initiating Worker shutdown.",
  "Error closing previous connection after replacement of worker connection",
  "External sink function threw an error",
  "Failed to encode heartbeat details, cancelling Activity",
  "Failed to initiate shutdown",
  "Heartbeats complete",
  "No activities registered, not polling for activity tasks",
  "No Nexus services registered, not polling for Nexus tasks",
  "No workflows registered, not polling for workflow tasks",
  "Nexus Worker terminated",
  "Shutdown force time expired, terminating worker",
  "Tried to cancel a non-existing activity",
  "Tried to cancel a non-existing Nexus handler",
  "Worker failed",
  "Worker state changed",
  "Workflow completed",
  "Workflow completed as cancelled",
  "Workflow continued as new",
  "Workflow failed",
  "Workflow Poller changed state to FAILED",
  "Workflow Poller changed state to SHUTDOWN",
  "Workflow referenced an unregistered external sink",
  "Workflow started",
  "Workflow Worker terminated",
]);

export const TEMPORAL_SDK_FALLBACK_LOG_MESSAGE = "Temporal SDK log record";

/** The SDK's closed `SdkComponent` enum. */
export const TEMPORAL_SDK_COMPONENT_PATTERN = /^(?:workflow|activity|nexus|worker|core)$/;
/** A code-registered workflow or activity type name. */
export const TEMPORAL_TYPE_NAME_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/;
const MAX_MESSAGE_LENGTH = 256;

/**
 * Error classes whose names carry no data, so a failed activity says what
 * failed instead of only that something did. Anything else is omitted.
 */
const REVIEWED_FAILURE_NAMES: ReadonlySet<string> = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "AggregateError",
  "AbortError",
  "TimeoutError",
  "ApplicationFailure",
  "CancelledFailure",
  "PostgresError",
  "DrizzleQueryError",
  "DatabaseTransactionError",
  "SessionEventPersistenceError",
  "SessionControlInvariantError",
]);
const FAILURE_SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;
/** A constant reason our own PL/pgSQL raises (`SESSION_ARCHIVED_READ_ONLY`);
 * PostgreSQL's own prose messages, which can quote row data, never match. */
const FAILURE_DATABASE_REASON_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;
/** `function_name:line` frames of our own database functions, comma-joined. */
const FAILURE_DATABASE_FUNCTIONS_PATTERN =
  /^[a-z_][a-z0-9_]{0,62}:\d{1,7}(?:,[a-z_][a-z0-9_]{0,62}:\d{1,7}){0,3}$/;
/** A code-owned persistence stage such as `session_attempts.mark_quiesced`. */
const FAILURE_PERSISTENCE_STAGE_PATTERN = /^[a-z][a-z0-9_]{0,47}(?:\.[a-z][a-z0-9_]{0,47}){0,3}$/;
const FAILURE_NESTED_KEYS = ["cause", "original", "driverError", "error", "errors"] as const;

export type TemporalFailureFacts = {
  failureName?: string;
  failureType?: string;
  nonRetryable?: boolean;
  sqlState?: string;
  dbReason?: string;
  dbFunctions?: string;
  persistenceStage?: string;
};

function ownField(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function reviewedFailureName(value: object): string | undefined {
  // Temporal's failure classes keep `name` as a data property on their
  // prototype; read data properties only, never a getter.
  let current: unknown = value;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth += 1) {
    const name = ownField(current, "name");
    if (typeof name === "string") return REVIEWED_FAILURE_NAMES.has(name) ? name : undefined;
    try {
      current = Object.getPrototypeOf(current);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Reviewed, closed facts about a failure the SDK logged: the thrown class,
 * an ApplicationFailure's type and retryability, and for a database refusal
 * its SQLSTATE, the constant reason our own function raised, the raising
 * functions and the persistence stage. Never messages, SQL text, parameters,
 * stacks or identifiers.
 */
export function temporalFailureFacts(error: unknown): TemporalFailureFacts {
  const facts: TemporalFailureFacts = {};
  if (!error || typeof error !== "object") return facts;
  const failureName = reviewedFailureName(error);
  if (failureName) facts.failureName = failureName;
  if (failureName === "ApplicationFailure") {
    const type = ownField(error, "type");
    if (typeof type === "string" && TEMPORAL_TYPE_NAME_PATTERN.test(type)) facts.failureType = type;
    const nonRetryable = ownField(error, "nonRetryable");
    if (typeof nonRetryable === "boolean") facts.nonRetryable = nonRetryable;
  }
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  while (queue.length > 0 && seen.size < 16) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const details = ownField(current, "details");
    const stage = ownField(details, "stage");
    if (
      facts.persistenceStage === undefined &&
      reviewedFailureName(current) === "SessionEventPersistenceError" &&
      typeof stage === "string" &&
      FAILURE_PERSISTENCE_STAGE_PATTERN.test(stage)
    )
      facts.persistenceStage = stage;
    // A PostgreSQL server error carries a severity next to its SQLSTATE;
    // Node transport codes such as EPIPE do not.
    const code = ownField(current, "code");
    if (
      facts.sqlState === undefined &&
      typeof ownField(current, "severity") === "string" &&
      typeof code === "string" &&
      FAILURE_SQLSTATE_PATTERN.test(code)
    ) {
      facts.sqlState = code;
      const message = ownField(current, "message");
      if (typeof message === "string" && FAILURE_DATABASE_REASON_PATTERN.test(message))
        facts.dbReason = message;
      const where = ownField(current, "where");
      if (typeof where === "string") {
        const frames = where
          .slice(0, 8_192)
          .split("\n")
          .flatMap((line) => {
            const match =
              /^PL\/pgSQL function (?:[a-z_][a-z0-9_]*\.)?([a-z_][a-z0-9_]{0,62})\([^\n]*\) line (\d{1,7}) at /.exec(
                line,
              );
            return match ? [`${match[1]}:${match[2]}`] : [];
          })
          .slice(0, 4);
        if (frames.length > 0) facts.dbFunctions = frames.join(",");
      }
    }
    for (const key of FAILURE_NESTED_KEYS) {
      const nested = ownField(current, key);
      if (Array.isArray(nested)) queue.push(...nested.slice(0, 8));
      else if (nested !== undefined) queue.push(nested);
    }
  }
  return facts;
}

/** Re-validate failure facts at the log boundary; callers may pass anything. */
export function projectTemporalFailureFacts(
  attributes: Record<string, unknown>,
): TemporalFailureFacts {
  const { failureName, failureType, nonRetryable, sqlState, dbReason, dbFunctions } = attributes;
  const { persistenceStage } = attributes;
  return {
    ...(typeof failureName === "string" && REVIEWED_FAILURE_NAMES.has(failureName)
      ? { failureName }
      : {}),
    ...(typeof failureType === "string" && TEMPORAL_TYPE_NAME_PATTERN.test(failureType)
      ? { failureType }
      : {}),
    ...(typeof nonRetryable === "boolean" ? { nonRetryable } : {}),
    ...(typeof sqlState === "string" && FAILURE_SQLSTATE_PATTERN.test(sqlState)
      ? { sqlState }
      : {}),
    ...(typeof dbReason === "string" && FAILURE_DATABASE_REASON_PATTERN.test(dbReason)
      ? { dbReason }
      : {}),
    ...(typeof dbFunctions === "string" && FAILURE_DATABASE_FUNCTIONS_PATTERN.test(dbFunctions)
      ? { dbFunctions }
      : {}),
    ...(typeof persistenceStage === "string" &&
    FAILURE_PERSISTENCE_STAGE_PATTERN.test(persistenceStage)
      ? { persistenceStage }
      : {}),
  };
}

export type TemporalSdkLoggerOptions = {
  /** Records below this level are dropped. Defaults to INFO, the SDK default. */
  minimumLevel?: TemporalSdkLogLevel;
};

/**
 * Route Temporal SDK log records (worker lifecycle, activity and workflow
 * task events, `workflow.log`, and forwarded Rust core records) through the
 * structured Opengeni logger. Every record becomes exactly one public log
 * line: the SDK's free-form metadata (task tokens, workflow/run identifiers,
 * raw errors, stacks, core fields) is reduced to a reviewed set of bounded
 * fields before the ordinary public-attribute projection applies.
 */
export function createTemporalSdkLogger(
  observability: Pick<Observability, "log">,
  options: TemporalSdkLoggerOptions = {},
): TemporalSdkLogger {
  const threshold = LEVEL_SEVERITY[options.minimumLevel ?? "INFO"];
  const emit = (
    level: TemporalSdkLogLevel,
    message: string,
    meta?: Record<string | symbol, unknown>,
  ): void => {
    const severity = LEVEL_SEVERITY[level];
    if (severity === undefined || severity < threshold) return;
    try {
      const record = projectTemporalSdkLogRecord(message, meta);
      observability.log(
        level === "ERROR"
          ? "error"
          : level === "WARN"
            ? "warn"
            : level === "INFO"
              ? "info"
              : "debug",
        record.message,
        record.attributes,
      );
    } catch {
      // A logging failure must never fail a workflow activation or activity.
    }
  };
  return {
    log: emit,
    trace: (message, meta) => emit("TRACE", message, meta),
    debug: (message, meta) => emit("DEBUG", message, meta),
    info: (message, meta) => emit("INFO", message, meta),
    warn: (message, meta) => emit("WARN", message, meta),
    error: (message, meta) => emit("ERROR", message, meta),
  };
}

export function projectTemporalSdkLogRecord(
  message: string,
  meta: Record<string | symbol, unknown> = {},
): { message: string; attributes: Attributes } {
  const sdkComponent =
    typeof meta.sdkComponent === "string" && TEMPORAL_SDK_COMPONENT_PATTERN.test(meta.sdkComponent)
      ? meta.sdkComponent
      : undefined;
  const attributes: Attributes = {
    ...(sdkComponent ? { sdkComponent } : {}),
    ...typeName("activity", meta.activityType),
    ...typeName("workflowType", meta.workflowType),
    ...(typeof meta.attempt === "number" && Number.isInteger(meta.attempt) && meta.attempt > 0
      ? { attempt: meta.attempt }
      : {}),
    ...(typeof meta.durationMs === "number" &&
    Number.isFinite(meta.durationMs) &&
    meta.durationMs >= 0
      ? { durationMs: meta.durationMs }
      : {}),
  };
  if (meta.error !== undefined || meta.failure !== undefined) {
    // The cause is reduced to one reviewed class and code plus the reviewed
    // closed facts above (so a failure that repeats on every retry says
    // why); its free-form message and stack stay out of public logs.
    attributes.errorClass = "TemporalSdkOperationError";
    attributes.errorCode = "temporal_sdk_failure_logged";
    attributes.origin = "worker";
    Object.assign(attributes, temporalFailureFacts(meta.error ?? meta.failure));
  }
  return { message: publicMessage(message, sdkComponent), attributes };
}

function publicMessage(message: string, sdkComponent: string | undefined): string {
  if (REVIEWED_TEMPORAL_SDK_MESSAGES.has(message)) return message;
  // `workflow.log` is Opengeni workflow code; those call sites pass constant
  // messages under the same rule as every other Observability caller.
  if (
    sdkComponent === "workflow" &&
    message.length <= MAX_MESSAGE_LENGTH &&
    !/[\r\n]/.test(message)
  ) {
    return message;
  }
  return TEMPORAL_SDK_FALLBACK_LOG_MESSAGE;
}

function typeName(key: string, value: unknown): Attributes {
  return typeof value === "string" && TEMPORAL_TYPE_NAME_PATTERN.test(value)
    ? { [key]: value }
    : {};
}
