import {
  childSpanRecordingActive,
  startChildSpan,
  withTraceContext,
  type ChildSpanAttributes,
} from "@opengeni/observability";
import type postgres from "postgres";

/**
 * Database spans for scopes that record child spans (API requests; see
 * startChildSpan). One client span per statement and one span per transaction
 * or savepoint, so a slow request shows which statements it waited on and how
 * long it waited for a connection (the gap before a transaction's first
 * statement). Attributes come from the statement's shape only: its leading
 * keyword and first table or routine name. SQL text, bound parameters, rows
 * and error messages are never recorded.
 */

const OPERATIONS = new Set([
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "MERGE",
  "WITH",
  "VALUES",
  "CALL",
  "DO",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "SAVEPOINT",
  "RELEASE",
  "SET",
  "RESET",
  "SHOW",
  "LOCK",
  "LISTEN",
  "UNLISTEN",
  "NOTIFY",
  "COPY",
  "TRUNCATE",
  "CREATE",
  "ALTER",
  "DROP",
  "GRANT",
  "REVOKE",
  "ANALYZE",
  "VACUUM",
  "EXPLAIN",
  "PREPARE",
  "EXECUTE",
  "DEALLOCATE",
  "DISCARD",
]);

// A whole identifier only: quoted names must close, bare names must end. A
// name that is not a plain identifier (spaces, dashes) yields no target at all.
const NAME = "[A-Za-z_][A-Za-z0-9_]{0,62}";
const IDENTIFIER = String.raw`(?:"(${NAME})"|(${NAME})(?![A-Za-z0-9_$".]))`;
const QUALIFIED = String.raw`(?:(?:"${NAME}"|${NAME})\.)?${IDENTIFIER}`;
const TARGET_AFTER: Record<string, RegExp> = {
  SELECT: new RegExp(String.raw`\bfrom\s+(?:only\s+)?${QUALIFIED}`, "i"),
  DELETE: new RegExp(String.raw`^delete\s+from\s+(?:only\s+)?${QUALIFIED}`, "i"),
  INSERT: new RegExp(String.raw`^insert\s+into\s+${QUALIFIED}`, "i"),
  UPDATE: new RegExp(String.raw`^update\s+(?:only\s+)?${QUALIFIED}`, "i"),
  MERGE: new RegExp(String.raw`^merge\s+into\s+${QUALIFIED}`, "i"),
  WITH: new RegExp(String.raw`\b(?:from|into|update)\s+(?:only\s+)?${QUALIFIED}`, "i"),
  CALL: new RegExp(String.raw`^call\s+${QUALIFIED}\s*\(`, "i"),
};
/** `select some_routine(...)` with no FROM: the routine is the target. */
const SELECTED_ROUTINE = new RegExp(String.raw`^select\s+${QUALIFIED}\s*\(`, "i");

export type StatementSummary = { name: string; attributes: ChildSpanAttributes };

// Statement texts repeat (Drizzle binds values as parameters), so summaries
// are kept for a bounded set of recent texts instead of re-parsed per query.
const SUMMARY_CACHE_MAX = 256;
const summaryCache = new Map<string, StatementSummary>();

function cachedSummary(text: string): StatementSummary {
  const cached = summaryCache.get(text);
  if (cached) return cached;
  const summary = summarizeStatement(text);
  if (summaryCache.size >= SUMMARY_CACHE_MAX) summaryCache.clear();
  summaryCache.set(text, summary);
  return summary;
}

/** Span name and attributes for one SQL statement, from its shape only. */
export function summarizeStatement(text: string): StatementSummary {
  // Literals and quoted bodies never name the target, so they are blanked first.
  const statement = text
    .slice(0, 8192)
    .replace(/^(?:\s+|--[^\n]*\n?|\/\*[\s\S]*?\*\/)+/, "")
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, "''")
    .replace(/'(?:[^']|'')*'/g, "''");
  const keyword = /^[A-Za-z]+/.exec(statement)?.[0]?.toUpperCase();
  const operation = keyword && OPERATIONS.has(keyword) ? keyword : "OTHER";
  let target: string | undefined;
  const pattern = TARGET_AFTER[operation];
  const named = (match: RegExpExecArray | null | undefined) => match?.[1] ?? match?.[2];
  if (pattern) target = named(pattern.exec(statement));
  if (operation === "SELECT" && !/\bfrom\b/i.test(statement)) {
    target = named(SELECTED_ROUTINE.exec(statement));
  }
  const collection = target?.toLowerCase();
  return {
    name: collection ? `${operation} ${collection}` : operation,
    attributes: {
      "db.system.name": "postgresql",
      "db.operation.name": operation,
      ...(collection ? { "db.collection.name": collection } : {}),
    },
  };
}

function sqlState(error: unknown): ChildSpanAttributes {
  try {
    const code =
      typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
    return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)
      ? { "db.response.status_code": code }
      : {};
  } catch {
    return {};
  }
}

function returnedRows(value: unknown): ChildSpanAttributes {
  return Array.isArray(value) ? { "db.response.returned_rows": value.length } : {};
}

/**
 * Record a client span from the query's first `then` (when postgres-js sends
 * it) to its settlement. Leaves `then` reconfigurable for later wrappers.
 */
export function traceQuery<T extends postgres.Row[]>(
  query: postgres.PendingQuery<T>,
  text: string,
): postgres.PendingQuery<T> {
  if (!childSpanRecordingActive()) return query;
  const summary = cachedSummary(text);
  const observe = query.then.bind(query);
  let result: Promise<unknown> | undefined;
  Object.defineProperty(query, "then", {
    configurable: true,
    writable: true,
    value: (...args: Parameters<Promise<unknown>["then"]>) => {
      result ??= (() => {
        const span = startChildSpan(summary.name, summary.attributes, "client");
        const settled = new Promise<unknown>((resolve, reject) => observe(resolve, reject));
        return span
          ? settled.then(
              (value) => {
                span.end({ attributes: returnedRows(value) });
                return value;
              },
              (error: unknown) => {
                span.end({ error, attributes: sqlState(error) });
                throw error;
              },
            )
          : settled;
      })();
      return result.then(...args);
    },
  });
  return query;
}

/**
 * Run a transaction or savepoint under its own span, so its statements nest
 * beneath it and connection admission shows as the gap before the first one.
 */
export function traceTransaction<T>(
  kind: "transaction" | "savepoint",
  run: () => Promise<T>,
): Promise<T> {
  if (!childSpanRecordingActive()) return run();
  const span = startChildSpan(`db ${kind}`, { "db.system.name": "postgresql" }, "internal");
  if (!span) return run();
  let pending: Promise<T>;
  try {
    pending = withTraceContext(span, run);
  } catch (error) {
    span.end({ error });
    throw error;
  }
  return Promise.resolve(pending).then(
    (value) => {
      span.end();
      return value;
    },
    (error: unknown) => {
      span.end({ error, attributes: sqlState(error) });
      throw error;
    },
  );
}
