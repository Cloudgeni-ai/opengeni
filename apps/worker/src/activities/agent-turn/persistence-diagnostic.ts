import type { SessionEventPersistenceError } from "@opengeni/db";
import { failureDiagnostic } from "@opengeni/observability";
import type { TurnActivityServices } from "../types";

/** Local diagnostics must remain available without the optional protected exporter. */
export function reportSessionPersistenceFailure(
  observability: Pick<TurnActivityServices["observability"], "recordFailureDiagnostic" | "error">,
  error: SessionEventPersistenceError,
  identity: { sessionId: string; attemptId: string; turnId?: string },
): void {
  const input = {
    ...identity,
    diagnosticId: error.details.correlationId,
    code: error.details.code,
    stage:
      error.details.stage === "session_events.append_generic"
        ? ("session_events.append_generic" as const)
        : error.details.stage === "session_events.append_for_turn_attempt"
          ? ("session_events.append_for_turn_attempt" as const)
          : error.details.stage === "session_attempts.claim"
            ? ("session_attempts.claim" as const)
            : ("failure_settlement" as const),
    retryDecision: error.details.retryOutcome,
    error,
    attempts: error.details.attempts,
    eventTypes: error.details.eventTypes,
    sqlState: error.details.sqlState,
    ...(error.details.database.constraint ? { constraint: error.details.database.constraint } : {}),
  };
  const diagnostic = failureDiagnostic(input);
  try {
    observability.recordFailureDiagnostic({ ...input, diagnosticId: diagnostic.diagnosticId });
  } catch {
    // Export failure must not hide the local diagnostic or alter settlement.
  }
  const statement = diagnostic.databaseStatement;
  const functions = diagnostic.postgresContext
    .map(({ functionName, line }) => `${functionName}:${line}`)
    .join(",");
  try {
    observability.error(
      `Session persistence failed: stage=${diagnostic.stage} sqlState=${diagnostic.sqlState ?? "unknown"}` +
        (diagnostic.rejectionReason ? ` reason=${diagnostic.rejectionReason}` : "") +
        (statement ? ` statement=${statement.operation}:${statement.relation}` : "") +
        (functions ? ` functions=${functions}` : ""),
      {
        correlationId: diagnostic.diagnosticId,
        sessionId: identity.sessionId,
        attemptId: identity.attemptId,
      },
    );
  } catch {
    // Logging is not a prerequisite for preserving accepted work.
  }
}
