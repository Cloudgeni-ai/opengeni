import {
  databaseFailureCode,
  nestedPostgresSqlState,
  safeDatabaseErrorFacts,
  SandboxWorkspaceMutationFencedError,
  type SandboxRetainedProcess,
} from "@opengeni/db";
import {
  errorCauseAttributes,
  messageFingerprint,
  sandboxLeaseTelemetryKey,
  type Observability,
} from "@opengeni/observability";

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

/** Public, reviewed facts about a reaper failure: the cause's class, fence
 * code and SQLSTATE, and a one-way fingerprint of its message that
 * `scripts/resolve-rejection-fingerprint.ts` maps back to a source literal.
 * Never message text, identifiers or provider payloads. */
function sandboxReaperFailureFacts(error: unknown): {
  causeName?: string;
  causeFenceCode?: string;
  causeSqlState?: string;
  causeFingerprint?: string;
} {
  const facts: ReturnType<typeof sandboxReaperFailureFacts> = {};
  try {
    Object.assign(facts, errorCauseAttributes(error));
    const sqlState = nestedPostgresSqlState(error);
    if (sqlState && !facts.causeSqlState) facts.causeSqlState = sqlState;
    const descriptor =
      error && typeof error === "object"
        ? Object.getOwnPropertyDescriptor(error, "message")
        : undefined;
    const message = descriptor && "value" in descriptor ? descriptor.value : undefined;
    if (typeof message === "string" && message.length > 0) {
      facts.causeFingerprint = messageFingerprint(message.slice(0, 16_384));
    }
  } catch {
    // Diagnostics never replace the original failure.
  }
  return facts;
}

/** A proved retained process that could not be settled keeps holding its box.
 * The protected diagnostic keeps the throw site and process correlation; the
 * public warning names the lease (hashed) and the reviewed cause facts. */
export function warnRetainedProcessSettlementFailure(
  observability: Pick<Observability, "recordFailureDiagnostic" | "warn">,
  error: unknown,
  process: Pick<
    SandboxRetainedProcess,
    | "id"
    | "workspaceId"
    | "sessionId"
    | "sandboxGroupId"
    | "leaseEpoch"
    | "providerBackend"
    | "ownerAttemptId"
    | "ownerTurnId"
    | "reconcileAttempts"
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
            : "retained_process_settlement_failed",
      stage: "sandbox_retained_processes.settlement",
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
    // A diagnostic/export failure must not change settlement or its deferral.
  }
  try {
    observability.warn("sandbox reaper: retained-process settlement failed", {
      errorClass: "SandboxReaperOperationError",
      errorCode: "sandbox_reaper_settlement_failed",
      origin: "worker",
      sandboxLeaseKey: sandboxLeaseTelemetryKey(process.workspaceId, process.sandboxGroupId),
      leaseEpoch: process.leaseEpoch,
      backend: process.providerBackend,
      ...sandboxReaperFailureFacts(error),
      ...(correlationId ? { correlationId } : {}),
    });
  } catch {
    // Keep the original failure behavior even when the public sink fails.
  }
}

/** A per-sandbox drain that threw. Same split as settlement: the protected
 * diagnostic keeps the throw site, the public warning the reviewed facts. */
export function warnSandboxDrainFailure(
  observability: Pick<Observability, "recordFailureDiagnostic" | "warn">,
  error: unknown,
  lease: { workspaceId: string; sandboxGroupId: string; leaseEpoch: number; backend: string },
): void {
  let correlationId: string | undefined;
  try {
    const sqlState = nestedPostgresSqlState(error);
    correlationId = observability.recordFailureDiagnostic({
      code: sqlState ? databaseFailureCode(sqlState) : "sandbox_drain_failed",
      stage: "sandbox_leases.drain",
      error,
      sqlState,
    });
  } catch {
    // A diagnostic/export failure must not change the drain outcome.
  }
  try {
    observability.warn("sandbox reaper: per-sandbox drain failed", {
      errorClass: "SandboxReaperOperationError",
      errorCode: "sandbox_reaper_drain_failed",
      origin: "worker",
      sandboxLeaseKey: sandboxLeaseTelemetryKey(lease.workspaceId, lease.sandboxGroupId),
      leaseEpoch: lease.leaseEpoch,
      backend: lease.backend,
      ...sandboxReaperFailureFacts(error),
      ...(correlationId ? { correlationId } : {}),
    });
  } catch {
    // Keep the original failure behavior even when the public sink fails.
  }
}
