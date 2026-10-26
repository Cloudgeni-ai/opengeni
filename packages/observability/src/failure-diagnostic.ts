import { createHash, randomUUID } from "node:crypto";
import { SessionEventType } from "@opengeni/contracts";

const CODES = [
  "operational_failure",
  "api_startup_failed",
  "api_unhandled_rejection",
  "api_uncaught_exception",
  "http_request_failed",
  "db_deadlock",
  "db_serialization_failure",
  "db_failure",
  "retained_process_fenced",
  "retained_process_proof_failed",
  "retained_process_observation_failed",
  "mcp_orchestration_failed",
] as const;
const STAGES = [
  "observability.error",
  "startup",
  "running",
  "http.request",
  "session_events.append_generic",
  "session_events.append_for_turn_attempt",
  "preclaim",
  "session_attempts.claim",
  "failure_settlement",
  "sandbox_retained_processes.proof",
  "sandbox_retained_processes.observation",
  "mcp.session_create",
  "mcp.session_send_message",
  "mcp.session_steer",
] as const;
const RETRIES = ["not_retryable", "exhausted", "unknown"] as const;
// Reviewed schema names, never a syntactic allowlist for arbitrary driver strings.
const CONSTRAINTS = new Set([
  "session_events_workspace_account_fk",
  "session_events_turn_association_check",
  "session_events_payload_bytes_check",
  "session_events_type_bytes_check",
  "session_events_duplicate_classification_check",
  "sandbox_retained_processes_reconcile_proof_check",
  "sandbox_retained_processes_reconcile_claim_check",
  "sandbox_retained_processes_settlement_check",
]);
const ERROR_NAMES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "AggregateError",
  "PostgresError",
  "DrizzleQueryError",
  "SessionEventPersistenceError",
  "SandboxWorkspaceMutationFencedError",
  "ProviderCommandObservationUnavailableError",
  "ClientError",
]);

// Human-reviewed code locations, not a regex permission to publish any path.
export const DIAGNOSTIC_SOURCE_FILES = [
  "apps/api/src/index.ts",
  "apps/api/src/app.ts",
  "apps/api/src/fatal-process-boundary.ts",
  "apps/api/src/mcp/server.ts",
  "apps/api/src/mcp/orchestration-failure-diagnostic.ts",
  "apps/api/dist/process/index.js",
  "apps/worker/src/activities/agent-turn/run.ts",
  "apps/worker/src/activities/agent-turn/claim.ts",
  "apps/worker/src/activities/agent-turn/failure-settlement.ts",
  "apps/worker/src/activities/parent-wake.ts",
  "apps/worker/src/activities/session-state.ts",
  "apps/worker/src/activities/sandbox-lease.ts",
  "apps/worker/dist/process/index.js",
  "packages/db/src/index.ts",
  "packages/db/src/persistence-errors.ts",
  "packages/storage/src/index.ts",
  "packages/observability/src/index.ts",
] as const;

export const DIAGNOSTIC_POSTGRES_FUNCTIONS = [
  "admit_session_attempt_personal_resources",
  "admit_session_attempt_personal_resources_v1",
  "admit_session_attempt_personal_machine",
  "admit_session_attempt_personal_machine_v1",
  "admit_session_attempt_personal_documents",
  "bind_session_attempt_machine_consent",
  "carry_session_attempt_machine_authorization",
  "guard_session_admission_block",
  "workspace_instruction_policy_get_or_create_snapshot",
  "preference_registry_get_or_create_snapshot",
] as const;

const DIAGNOSTIC_RELATIONS = new Set([
  "sessions",
  "session_turns",
  "session_turn_attempts",
  "session_events",
  "session_history_items",
  "workspace_inference_controls",
  "preference_registry_snapshots",
]);

/** A statement identity, never its SQL text, identifiers outside this list, or parameters. */
function databaseStatement(error: unknown): { operation: string; relation: string } | undefined {
  const query = own(error, "query");
  if (typeof query !== "string") return undefined;
  const match = /^\s*(insert into|update|delete from)\s+"?([a-z_]+)"?(?=\s|\()/i.exec(
    query.slice(0, 256),
  );
  if (!match || !DIAGNOSTIC_RELATIONS.has(match[2]!)) return undefined;
  return { operation: match[1]!.toLowerCase().split(" ")[0]!, relation: match[2]! };
}

function reviewedSource(location: string): string | undefined {
  // Match an exact reviewed suffix; discard the host/deployment path entirely.
  return DIAGNOSTIC_SOURCE_FILES.find((file) => location === file || location.endsWith(`/${file}`));
}

function postgresContext(error: unknown): Array<{ functionName: string; line: number }> {
  if (errorKind(error) !== "PostgresError") return [];
  const where = own(error, "where");
  if (typeof where !== "string") return [];
  return where
    .slice(0, 8_192)
    .split("\n")
    .slice(0, 16)
    .flatMap((value) => {
      const match = /^PL\/pgSQL function (?:public\.)?([a-z_]+)\([^\n]*\) line (\d{1,7}) at /.exec(
        value,
      );
      if (!match || !DIAGNOSTIC_POSTGRES_FUNCTIONS.some((name) => name === match[1])) return [];
      return [{ functionName: match[1]!, line: Number(match[2]) }];
    })
    .slice(0, 8);
}

export type FailureDiagnosticInput = {
  code: (typeof CODES)[number];
  stage: (typeof STAGES)[number];
  retryDecision?: (typeof RETRIES)[number];
  error: unknown;
  diagnosticId?: string;
  attemptId?: string;
  sessionId?: string;
  parentSessionId?: string;
  processId?: string;
  turnId?: string;
  executionGeneration?: number;
  attempts?: number;
  sqlState?: string | null;
  constraint?: string;
  eventTypes?: readonly string[];
};

function own(value: unknown, key: string): unknown {
  try {
    if (!value || typeof value !== "object") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function errorKind(error: unknown): string {
  const name = own(error, "name");
  if (typeof name === "string" && ERROR_NAMES.has(name)) return name;
  try {
    const prototype = Object.getPrototypeOf(error);
    if (prototype === TypeError.prototype) return "TypeError";
    if (prototype === RangeError.prototype) return "RangeError";
    if (prototype === AggregateError.prototype) return "AggregateError";
  } catch {
    /* Untrusted proxies do not contribute type information. */
  }
  return "Error";
}

/** No arbitrary property reads, Error.toJSON, messages, SQL, parameters or function names. */
export function failureDiagnostic(input: FailureDiagnosticInput, revision?: string) {
  const causes: Array<{
    kind: string;
    providerStatus?: number;
    frames: Array<{ locationHash: string; source?: string; line: number; column: number }>;
  }> = [];
  const pgContext: Array<{ functionName: string; line: number }> = [];
  const seen = new Set<unknown>();
  let causeSqlState: string | undefined;
  let statement: ReturnType<typeof databaseStatement>;
  let rejectionReason: "personal_machine_owner_required" | undefined;
  let error = input.error;
  while (error && typeof error === "object" && !seen.has(error) && causes.length < 4) {
    seen.add(error);
    const kind = errorKind(error);
    const numericCode = own(error, "code");
    // Only numeric gRPC status codes; no provider details, URLs or command text.
    const providerStatus =
      typeof numericCode === "number" &&
      Number.isInteger(numericCode) &&
      numericCode >= 0 &&
      numericCode <= 16
        ? numericCode
        : undefined;
    const driverCode = kind === "PostgresError" ? own(error, "code") : undefined;
    if (!causeSqlState && typeof driverCode === "string" && /^[0-9A-Z]{5}$/.test(driverCode)) {
      causeSqlState = driverCode;
    }
    pgContext.push(...postgresContext(error).slice(0, 8 - pgContext.length));
    if (
      kind === "PostgresError" &&
      driverCode === "42501" &&
      own(error, "message") === "only the personal machine owner may attach it" &&
      postgresContext(error).some(
        ({ functionName }) => functionName === "admit_session_attempt_personal_machine",
      )
    ) {
      rejectionReason = "personal_machine_owner_required";
    }
    statement ??= databaseStatement(error);
    const stack = own(error, "stack");
    const frames =
      typeof stack === "string"
        ? stack
            .slice(0, 16_384)
            .split("\n")
            .slice(1, 33)
            .flatMap((frame) => {
              const match = /(?:\(|\s)([^\s()]+):(\d{1,7}):(\d{1,7})\)?$/.exec(frame);
              if (!match) return [];
              // Even a path/function can contain a credential. Keep source-location
              // fingerprints plus line/column, not untrusted textual stack bytes.
              return [
                {
                  locationHash: createHash("sha256").update(match[1]!).digest("hex"),
                  ...(reviewedSource(match[1]!) ? { source: reviewedSource(match[1]!)! } : {}),
                  line: Number(match[2]),
                  column: Number(match[3]),
                },
              ];
            })
        : [];
    causes.push({
      kind,
      ...(providerStatus === undefined ? {} : { providerStatus }),
      frames,
    });
    error = own(error, "cause");
  }
  const uuid = (value: unknown) =>
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
      ? value
      : undefined;
  return {
    schema: "opengeni.failure-diagnostic.v1",
    diagnosticId: uuid(input.diagnosticId) ?? randomUUID(),
    code: CODES.includes(input.code) ? input.code : "db_failure",
    stage: STAGES.includes(input.stage) ? input.stage : "failure_settlement",
    retryDecision:
      input.retryDecision && RETRIES.includes(input.retryDecision)
        ? input.retryDecision
        : "unknown",
    attemptId: uuid(input.attemptId),
    sessionId: uuid(input.sessionId),
    parentSessionId: uuid(input.parentSessionId),
    processId: uuid(input.processId),
    turnId: uuid(input.turnId),
    executionGeneration:
      Number.isSafeInteger(input.executionGeneration) &&
      input.executionGeneration! >= 1 &&
      input.executionGeneration! <= 2_147_483_647
        ? input.executionGeneration
        : undefined,
    attempts:
      Number.isSafeInteger(input.attempts) && input.attempts! >= 0 && input.attempts! <= 1_000_000
        ? input.attempts
        : undefined,
    sqlState:
      typeof input.sqlState === "string" && /^[0-9A-Z]{5}$/.test(input.sqlState)
        ? input.sqlState
        : causeSqlState,
    constraint:
      input.constraint && CONSTRAINTS.has(input.constraint) ? input.constraint : undefined,
    deploymentRevision: revision && /^[0-9a-f]{40}$/.test(revision) ? revision : undefined,
    causes,
    postgresContext: pgContext,
    databaseStatement: statement,
    rejectionReason,
    eventTypes: (input.eventTypes ?? [])
      .slice(0, 32)
      .filter((type) => SessionEventType.safeParse(type).success),
  };
}
