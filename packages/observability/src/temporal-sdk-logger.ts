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
    // The cause is reduced to one reviewed class and code; its name, message
    // and stack stay out of public logs.
    attributes.errorClass = "TemporalSdkOperationError";
    attributes.errorCode = "temporal_sdk_failure_logged";
    attributes.origin = "worker";
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
