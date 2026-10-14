export type DatabaseFailureCode = "db_deadlock" | "db_serialization_failure" | "db_failure";

export type PersistenceRetryOutcome = "not_retryable" | "exhausted";

export type SafeDatabaseErrorFacts = {
  severity?: string;
  schema?: string;
  table?: string;
  column?: string;
  dataType?: string;
  constraint?: string;
  routine?: string;
};

export type PersistenceFailureDetails = {
  code: DatabaseFailureCode;
  sqlState: string | null;
  stage: string;
  eventTypes: string[];
  correlationId: string;
  attempts: number;
  retryOutcome: PersistenceRetryOutcome;
  database: SafeDatabaseErrorFacts;
};

const SQLSTATE_KEYS = ["sqlState", "sqlstate", "code"] as const;
const NESTED_ERROR_KEYS = ["cause", "original", "driverError", "error", "errors"] as const;
const RETRYABLE_DATABASE_TRANSPORT_CODES = new Set([
  // postgres.js connection lifecycle failures.
  "CONNECTION_CLOSED",
  "CONNECTION_DESTROYED",
  "CONNECTION_ENDED",
  "CONNECT_TIMEOUT",
  // Node socket/DNS failures surfaced unchanged by postgres.js.
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTDOWN",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
]);
const DATABASE_ERROR_NAMES = new Set(["DatabaseError", "DrizzleQueryError", "PostgresError"]);
const DATABASE_DIAGNOSTIC_KEYS = [
  "severity",
  "schema_name",
  "table_name",
  "column_name",
  "data_type_name",
  "constraint_name",
  "routine",
] as const;
const SAFE_FACT_KEYS = [
  ["severity", "severity"],
  ["schema_name", "schema"],
  ["schema", "schema"],
  ["table_name", "table"],
  ["table", "table"],
  ["column_name", "column"],
  ["column", "column"],
  ["data_type_name", "dataType"],
  ["dataType", "dataType"],
  ["constraint_name", "constraint"],
  ["constraint", "constraint"],
  ["routine", "routine"],
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function safeFact(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value;
}

/** Find the driver SQLSTATE even when Drizzle wrapped it under nested causes. */
export function nestedPostgresSqlState(error: unknown): string | null {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  let fallback: string | null = null;
  while (queue.length > 0 && seen.size < 64) {
    const current = queue.shift();
    if (!isRecord(current) || seen.has(current)) continue;
    seen.add(current);
    for (const key of SQLSTATE_KEYS) {
      const value = current[key];
      if (typeof value !== "string" || !/^[0-9A-Z]{5}$/i.test(value)) continue;
      const normalized = value.toUpperCase();
      // Node transport codes such as EPIPE happen to be five characters but
      // are not PostgreSQL SQLSTATEs.
      if (RETRYABLE_DATABASE_TRANSPORT_CODES.has(normalized)) continue;
      if (normalized === "40P01" || normalized === "40001") return normalized;
      fallback ??= normalized;
    }
    for (const key of NESTED_ERROR_KEYS) {
      const nested = current[key];
      if (Array.isArray(nested)) queue.push(...nested);
      else if (nested !== undefined) queue.push(nested);
    }
  }
  return fallback;
}

export function databaseFailureCode(sqlState: string | null): DatabaseFailureCode {
  if (sqlState === "40P01") return "db_deadlock";
  if (sqlState === "40001") return "db_serialization_failure";
  return "db_failure";
}

export function isRetryablePersistenceSqlState(sqlState: string | null): boolean {
  return sqlState === "40P01" || sqlState === "40001";
}

/**
 * Recognize only explicit postgres.js/Node transport codes, including nested
 * driver causes. These failures can arrive as plain Errors with no SQLSTATE or
 * database diagnostic fields when the connection dies before PostgreSQL can
 * answer. Messages are intentionally ignored: they are unstable and may
 * contain connection detail.
 */
export function isRetryableDatabaseTransportFailure(error: unknown): boolean {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  while (queue.length > 0 && seen.size < 64) {
    const current = queue.shift();
    if (!isRecord(current) || seen.has(current)) continue;
    seen.add(current);

    for (const key of ["code", "errno"] as const) {
      const value = current[key];
      if (
        typeof value === "string" &&
        RETRYABLE_DATABASE_TRANSPORT_CODES.has(value.toUpperCase())
      ) {
        return true;
      }
    }

    for (const key of NESTED_ERROR_KEYS) {
      const nested = current[key];
      if (Array.isArray(nested)) queue.push(...nested);
      else if (nested !== undefined) queue.push(nested);
    }
  }
  return false;
}

/**
 * SQLSTATEs PostgreSQL sends when it ends or refuses the session itself:
 * operator intervention (`pg_terminate_backend`, shutdown, crash recovery,
 * "the database system is starting up") and the connection-exception class.
 */
const DATABASE_CONNECTION_LOSS_SQLSTATES = new Set([
  "57P01", // admin_shutdown (pg_terminate_backend, smart/fast shutdown)
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
  "08000", // connection_exception
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "08003", // connection_does_not_exist
  "08004", // sqlserver_rejected_establishment_of_sqlconnection
  "08006", // connection_failure
]);

/**
 * node-postgres (Better Auth's pool) reports a lost socket as a plain Error with
 * no code. Only these exact library sentences are recognized.
 */
const NODE_POSTGRES_CONNECTION_LOSS_MESSAGES = new Set([
  "Connection terminated unexpectedly",
  "Connection terminated",
  "Connection terminated due to connection timeout",
  "Client has encountered a connection error and is not queryable",
  "Client was closed and is not queryable",
]);

/**
 * Explicit marker for a dependency that hid its driver error behind its own
 * generic failure but is known to have failed reading the database.
 */
export class DatabaseUnavailableError extends Error {
  readonly code = "DATABASE_UNAVAILABLE";

  constructor(message = "database unavailable", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DatabaseUnavailableError";
  }
}

/**
 * True when a failure means the database connection itself went away (an
 * operator drain, failover, restart, or socket loss), not that a statement was
 * rejected. Such a failure is transient: a fresh pooled connection succeeds once
 * the server accepts connections again. It says nothing about whether a write
 * in flight committed.
 *
 * Socket and postgres.js transport codes (`ECONNRESET`, `CONNECTION_CLOSED`,
 * ...) count only when the same failure proves it came from the database: a
 * query-bearing driver or ORM error, a PostgresError, or postgres.js's own
 * connection error. The same codes from NATS, a provider fetch, or a browser
 * transport are not database loss.
 */
export function isDatabaseConnectionLoss(error: unknown): boolean {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  let transportFailure = false;
  let databaseOrigin = false;
  while (queue.length > 0 && seen.size < 64) {
    const current = queue.shift();
    if (!isRecord(current) || seen.has(current)) continue;
    seen.add(current);
    if (current instanceof DatabaseUnavailableError) return true;
    for (const key of SQLSTATE_KEYS) {
      const value = current[key];
      if (
        typeof value === "string" &&
        DATABASE_CONNECTION_LOSS_SQLSTATES.has(value.toUpperCase())
      ) {
        return true;
      }
    }
    if (
      typeof current.message === "string" &&
      NODE_POSTGRES_CONNECTION_LOSS_MESSAGES.has(current.message)
    ) {
      return true;
    }
    if (hasTransportCode(current)) transportFailure = true;
    if (isDatabaseOrigin(current)) databaseOrigin = true;
    if (transportFailure && databaseOrigin) return true;
    for (const key of NESTED_ERROR_KEYS) {
      const nested = current[key];
      if (Array.isArray(nested)) queue.push(...nested);
      else if (nested !== undefined) queue.push(nested);
    }
  }
  return false;
}

function hasTransportCode(current: Record<string, unknown>): boolean {
  return (["code", "errno"] as const).some((key) => {
    const value = current[key];
    return typeof value === "string" && RETRYABLE_DATABASE_TRANSPORT_CODES.has(value.toUpperCase());
  });
}

function isDatabaseOrigin(current: Record<string, unknown>): boolean {
  if (typeof current.name === "string" && DATABASE_ERROR_NAMES.has(current.name)) return true;
  // postgres.js stamps the failed query onto its error; Drizzle wraps it as
  // DrizzleQueryError with `query` + `params`.
  if (typeof current.query === "string") return true;
  // postgres.js connection errors: `write <CODE> <host:port>` with errno === code.
  return (
    typeof current.code === "string" &&
    current.errno === current.code &&
    "address" in current &&
    typeof current.message === "string" &&
    current.message.startsWith(`write ${current.code} `)
  );
}

/**
 * Distinguish database/ORM failures from expected domain exceptions when a
 * driver omitted SQLSTATE. This checks shape only; callers retain the original
 * failure independently as canonical error evidence.
 */
export function isDatabasePersistenceFailure(error: unknown): boolean {
  if (isRetryableDatabaseTransportFailure(error) || nestedPostgresSqlState(error) !== null) {
    return true;
  }

  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  while (queue.length > 0 && seen.size < 64) {
    const current = queue.shift();
    if (!isRecord(current) || seen.has(current)) continue;
    seen.add(current);

    if (typeof current.name === "string" && DATABASE_ERROR_NAMES.has(current.name)) {
      return true;
    }
    if (
      typeof current.query === "string" &&
      (Object.hasOwn(current, "params") || Object.hasOwn(current, "parameters"))
    ) {
      return true;
    }
    if (DATABASE_DIAGNOSTIC_KEYS.some((key) => Object.hasOwn(current, key))) {
      return true;
    }

    for (const key of NESTED_ERROR_KEYS) {
      const nested = current[key];
      if (Array.isArray(nested)) queue.push(...nested);
      else if (nested !== undefined) queue.push(nested);
    }
  }
  return false;
}

/** Extract only PostgreSQL diagnostic identifiers; never query text/parameters. */
export function safeDatabaseErrorFacts(error: unknown): SafeDatabaseErrorFacts {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  const facts: SafeDatabaseErrorFacts = {};
  while (queue.length > 0 && seen.size < 64) {
    const current = queue.shift();
    if (!isRecord(current) || seen.has(current)) continue;
    seen.add(current);
    for (const [source, destination] of SAFE_FACT_KEYS) {
      if (facts[destination] !== undefined) continue;
      const value = safeFact(current[source]);
      if (value !== undefined) facts[destination] = value;
    }
    for (const key of NESTED_ERROR_KEYS) {
      const nested = current[key];
      if (Array.isArray(nested)) queue.push(...nested);
      else if (nested !== undefined) queue.push(nested);
    }
  }
  return facts;
}

/** Own-driver transaction boundary; callback errors never establish provenance. */
export class DatabaseTransactionError extends Error {
  readonly name = "DatabaseTransactionError";

  constructor(
    readonly stage: "admission" | "settlement",
    cause: unknown,
    // A rollback failure must not erase a callback's no-replay/permanent
    // evidence. The recovery classifier inspects both branches for vetoes.
    readonly original?: unknown,
  ) {
    super(`Database transaction ${stage} failed`, { cause });
  }
}

/** Typed persistence classification retaining the original cause internally.
 * Its ordinary message is stable and contains no SQL or driver parameters. */
export class SessionEventPersistenceError extends Error {
  readonly name = "SessionEventPersistenceError";

  constructor(
    readonly details: PersistenceFailureDetails,
    cause?: unknown,
  ) {
    const label =
      details.code === "db_deadlock"
        ? "Database deadlock"
        : details.code === "db_serialization_failure"
          ? "Database serialization failure"
          : "Database failure";
    const operation = `${label} while persisting ${details.eventTypes.join(", ") || "session events"}`;
    super(operation, cause === undefined ? undefined : { cause });
  }

  get code(): DatabaseFailureCode {
    return this.details.code;
  }
}

export function isSessionEventPersistenceError(
  error: unknown,
): error is SessionEventPersistenceError {
  return error instanceof SessionEventPersistenceError;
}

export type IdempotentPersistenceTransactionOptions = {
  stage: string;
  eventTypes?: string[];
  maxAttempts?: number;
  correlationId?: string;
  onRetry?: (input: { attempt: number; sqlState: "40P01" | "40001" }) => void | Promise<void>;
};

/**
 * Retry only the supplied idempotent database transaction/savepoint. Provider
 * inference, tools, NATS, and all other external effects must remain outside
 * this function. A single correlation ID follows every persistence attempt.
 */
export async function runIdempotentPersistenceTransaction<T>(
  options: IdempotentPersistenceTransactionOptions,
  transaction: (attempt: number) => Promise<T>,
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("Persistence maxAttempts must be a positive integer");
  }
  const correlationId = options.correlationId ?? crypto.randomUUID();
  const eventTypes = [...new Set(options.eventTypes ?? [])].sort();
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await transaction(attempt);
    } catch (error) {
      const sqlState = nestedPostgresSqlState(error);
      const retryable = isRetryablePersistenceSqlState(sqlState);
      if (retryable && attempt < maxAttempts) {
        await options.onRetry?.({
          attempt,
          sqlState: sqlState as "40P01" | "40001",
        });
        continue;
      }
      if (!isDatabasePersistenceFailure(error)) throw error;
      throw new SessionEventPersistenceError(
        {
          code: databaseFailureCode(sqlState),
          sqlState,
          stage: options.stage,
          eventTypes,
          correlationId,
          attempts: attempt,
          retryOutcome: retryable ? "exhausted" : "not_retryable",
          database: safeDatabaseErrorFacts(error),
        },
        error,
      );
    }
  }
  throw new Error("Unreachable persistence retry state");
}
