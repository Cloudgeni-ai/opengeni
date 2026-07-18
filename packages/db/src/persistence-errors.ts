import { sanitizeEventString } from "./event-payload-sanitizer";

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
  sqlState: string;
  stage: string;
  eventTypes: string[];
  correlationId: string;
  attempts: number;
  retryOutcome: PersistenceRetryOutcome;
  database: SafeDatabaseErrorFacts;
};

const SQLSTATE_KEYS = ["sqlState", "sqlstate", "code"] as const;
const NESTED_ERROR_KEYS = ["cause", "original", "driverError", "error", "errors"] as const;
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
  return sanitizeEventString(value).slice(0, 256);
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

export function databaseFailureCode(sqlState: string): DatabaseFailureCode {
  if (sqlState === "40P01") return "db_deadlock";
  if (sqlState === "40001") return "db_serialization_failure";
  return "db_failure";
}

export function isRetryablePersistenceSqlState(sqlState: string | null): boolean {
  return sqlState === "40P01" || sqlState === "40001";
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

/**
 * Public-safe replacement for a raw Drizzle/postgres-js failure. It deliberately
 * has no `cause`: driver causes can contain the full SQL statement and bound
 * parameters, which must never enter a session event or operator log payload.
 */
export class SessionEventPersistenceError extends Error {
  readonly name = "SessionEventPersistenceError";

  constructor(readonly details: PersistenceFailureDetails) {
    const label =
      details.code === "db_deadlock"
        ? "Database deadlock"
        : details.code === "db_serialization_failure"
          ? "Database serialization failure"
          : "Database failure";
    super(`${label} while persisting ${details.eventTypes.join(", ") || "session events"}`);
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
      if (!sqlState) throw error;
      const retryable = isRetryablePersistenceSqlState(sqlState);
      if (retryable && attempt < maxAttempts) {
        await options.onRetry?.({
          attempt,
          sqlState: sqlState as "40P01" | "40001",
        });
        continue;
      }
      throw new SessionEventPersistenceError({
        code: databaseFailureCode(sqlState),
        sqlState,
        stage: options.stage,
        eventTypes,
        correlationId,
        attempts: attempt,
        retryOutcome: retryable ? "exhausted" : "not_retryable",
        database: safeDatabaseErrorFacts(error),
      });
    }
  }
  throw new Error("Unreachable persistence retry state");
}
