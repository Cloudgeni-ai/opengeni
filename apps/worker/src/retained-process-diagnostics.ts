import {
  databaseFailureCode,
  nestedPostgresSqlState,
  safeDatabaseErrorFacts,
  SandboxWorkspaceMutationFencedError,
  type SandboxRetainedProcess,
} from "@opengeni/db";
import type { Observability } from "@opengeni/observability";

/** Observation failures are not proof failures. Keep the cause chain in the
 * protected diagnostic sink, with only its opaque key and bounded stage in logs. */
export function warnRetainedProcessObservationFailure(
  observability: Pick<Observability, "recordFailureDiagnostic" | "warn">,
  failure: {
    stage: "binding" | "client" | "deserialize" | "resume" | "observation";
    error: unknown;
  },
  process: Pick<
    SandboxRetainedProcess,
    "id" | "sessionId" | "ownerAttemptId" | "ownerTurnId" | "reconcileAttempts"
  >,
): void {
  let correlationId: string | undefined;
  try {
    correlationId = observability.recordFailureDiagnostic({
      code: "retained_process_observation_failed",
      stage: "sandbox_retained_processes.observation",
      error: failure.error,
      processId: process.id,
      sessionId: process.sessionId,
      ...(process.ownerAttemptId ? { attemptId: process.ownerAttemptId } : {}),
      ...(process.ownerTurnId ? { turnId: process.ownerTurnId } : {}),
      attempts: process.reconcileAttempts,
    });
  } catch {
    /* Diagnostics cannot settle or fence a process. */
  }
  try {
    observability.warn("sandbox reaper: retained-process observation failed", {
      surface: "retained_process_observation",
      reason: failure.stage,
      ...(correlationId ? { correlationId } : {}),
    });
  } catch {
    /* The original deferral remains authoritative. */
  }
}

/** Protected cause locations and schema facts; public logs receive only the diagnostic key. */
export function warnRetainedProcessProofFailure(
  observability: Pick<Observability, "recordFailureDiagnostic" | "warn">,
  error: unknown,
  process: Pick<
    SandboxRetainedProcess,
    "id" | "sessionId" | "ownerAttemptId" | "ownerTurnId" | "reconcileAttempts"
  >,
): void {
  let correlationId: string | undefined;
  try {
    const sqlState = nestedPostgresSqlState(error);
    const constraint = safeDatabaseErrorFacts(error).constraint;
    correlationId = observability.recordFailureDiagnostic({
      code:
        error instanceof SandboxWorkspaceMutationFencedError
          ? "retained_process_fenced"
          : sqlState
            ? databaseFailureCode(sqlState)
            : "retained_process_proof_failed",
      stage: "sandbox_retained_processes.proof",
      error,
      processId: process.id,
      sessionId: process.sessionId,
      ...(process.ownerAttemptId ? { attemptId: process.ownerAttemptId } : {}),
      ...(process.ownerTurnId ? { turnId: process.ownerTurnId } : {}),
      attempts: process.reconcileAttempts,
      sqlState,
      ...(constraint ? { constraint } : {}),
    });
  } catch {
    // A diagnostic/export failure must not change reconciliation or release its fence.
  }
  try {
    observability.warn("sandbox reaper: retained-process proof checkpoint failed", {
      ...(correlationId ? { correlationId } : {}),
    });
  } catch {
    // Keep the original failure behavior even when the public sink fails.
  }
}
