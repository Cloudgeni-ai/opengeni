import type { Observability } from "@opengeni/observability";

/**
 * Content-free diagnostics for per-task usage limits. Every label is
 * a closed set: where the decision was made and what it was. No workspace,
 * session, subject, model, prompt or amount ever becomes a label, so the
 * series count is bounded by these two lists.
 */
export type SessionUsageLimitMetricsSink = Pick<Observability, "incrementCounter">;

export const SESSION_USAGE_LIMIT_METRIC_BOUNDARIES = [
  "create",
  "child_create",
  "send",
  "steer",
  "goal",
  "claim",
  "between_calls",
  "single_call",
  "settlement",
  "write",
  "import",
] as const;
export type SessionUsageLimitMetricBoundary =
  (typeof SESSION_USAGE_LIMIT_METRIC_BOUNDARIES)[number];

export const SESSION_USAGE_LIMIT_METRIC_OUTCOMES = [
  /** Admission refused: observed settled usage reached the root limit. */
  "reached",
  /** The usage state could not be read or written; the request was blocked. */
  "unavailable",
  /** Settlement could not be recorded; the next dispatch waits for recovery. */
  "accounting_failure",
  /** A response had no known price: excluded from the total and disclosed. */
  "unpriced",
  /** A priced response was recorded once. */
  "recorded",
  /** An exact replay of an already recorded source. */
  "duplicate",
  /** A previously unpriced source gained its stored price. */
  "filled",
  /** A different amount was offered for an already recorded source. */
  "source_conflict",
  /** The session was deleted before its in-flight response settled. */
  "source_gone",
  /** A write lost its compare-and-set race. */
  "cas_conflict",
  /** A write targeted a root whose legacy history is still preparing. */
  "preparing",
  /** A write was refused for an agent, scoped bearer or other non-person actor. */
  "forbidden",
  /** A new non-null limit was refused because producers are disabled. */
  "disabled",
  /** A write was refused because the session is not the task root. */
  "not_root",
  /** An authorized write changed the limit. */
  "set",
  /** An authorized write removed the limit. */
  "cleared",
  /** An authorized write repeated an already applied request. */
  "replayed",
  /** Legacy import pages processed by maintenance. */
  "imported",
  /** Legacy import maintenance failed and will be retried. */
  "import_failed",
] as const;
export type SessionUsageLimitMetricOutcome = (typeof SESSION_USAGE_LIMIT_METRIC_OUTCOMES)[number];

export const SESSION_USAGE_LIMIT_EVENTS_METRIC = {
  name: "opengeni_session_usage_limit_events_total",
  help: "Per-task usage limit decisions by boundary and outcome; labels are closed sets.",
} as const;

/** Count one usage-limit decision. Never throws: telemetry cannot change the outcome. */
export function recordSessionUsageLimitEvent(
  sink: SessionUsageLimitMetricsSink | null | undefined,
  boundary: SessionUsageLimitMetricBoundary,
  outcome: SessionUsageLimitMetricOutcome,
  amount = 1,
): void {
  if (!sink || amount <= 0) return;
  try {
    sink.incrementCounter({
      ...SESSION_USAGE_LIMIT_EVENTS_METRIC,
      labels: { boundary, outcome },
      amount,
    });
  } catch {
    // Telemetry must never change an admission or settlement outcome.
  }
}
