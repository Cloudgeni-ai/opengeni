import { createHash, randomUUID } from "node:crypto";
import { SessionEventType } from "@opengeni/contracts";

const CODES = [
  "api_startup_failed",
  "api_unhandled_rejection",
  "api_uncaught_exception",
  "db_deadlock",
  "db_serialization_failure",
  "db_failure",
] as const;
const STAGES = [
  "startup",
  "running",
  "session_events.append_generic",
  "session_events.append_for_turn_attempt",
  "preclaim",
  "failure_settlement",
] as const;
const RETRIES = ["not_retryable", "exhausted", "unknown"] as const;
// Reviewed schema names, never a syntactic allowlist for arbitrary driver strings.
const CONSTRAINTS = new Set([
  "session_events_workspace_account_fk",
  "session_events_turn_association_check",
  "session_events_payload_bytes_check",
  "session_events_type_bytes_check",
  "session_events_duplicate_classification_check",
]);
const ERROR_NAMES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "AggregateError",
  "PostgresError",
  "DrizzleQueryError",
  "SessionEventPersistenceError",
]);

export type FailureDiagnosticInput = {
  code: (typeof CODES)[number];
  stage: (typeof STAGES)[number];
  retryDecision?: (typeof RETRIES)[number];
  error: unknown;
  attemptId?: string;
  sessionId?: string;
  turnId?: string;
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
    frames: Array<{ locationHash: string; line: number; column: number }>;
  }> = [];
  const seen = new Set<unknown>();
  let error = input.error;
  while (error && typeof error === "object" && !seen.has(error) && causes.length < 4) {
    seen.add(error);
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
                  line: Number(match[2]),
                  column: Number(match[3]),
                },
              ];
            })
        : [];
    causes.push({
      kind: errorKind(error),
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
    diagnosticId: randomUUID(),
    code: CODES.includes(input.code) ? input.code : "db_failure",
    stage: STAGES.includes(input.stage) ? input.stage : "failure_settlement",
    retryDecision:
      input.retryDecision && RETRIES.includes(input.retryDecision)
        ? input.retryDecision
        : "unknown",
    attemptId: uuid(input.attemptId),
    sessionId: uuid(input.sessionId),
    turnId: uuid(input.turnId),
    attempts:
      Number.isSafeInteger(input.attempts) && input.attempts! >= 0 && input.attempts! <= 1_000_000
        ? input.attempts
        : undefined,
    sqlState:
      typeof input.sqlState === "string" && /^[0-9A-Z]{5}$/.test(input.sqlState)
        ? input.sqlState
        : undefined,
    constraint:
      input.constraint && CONSTRAINTS.has(input.constraint) ? input.constraint : undefined,
    deploymentRevision: revision && /^[0-9a-f]{40}$/.test(revision) ? revision : undefined,
    causes,
    eventTypes: (input.eventTypes ?? [])
      .slice(0, 32)
      .filter((type) => SessionEventType.safeParse(type).success),
  };
}
