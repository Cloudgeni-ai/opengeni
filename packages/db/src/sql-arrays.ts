import { Param, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

type ArrayElementType = "uuid" | "text";

const ARRAY_ELEMENT_TYPES = new Set<string>(["uuid", "text"]);

/**
 * `column = any($n::type[])` with the whole list bound as one array parameter.
 *
 * Drizzle's `inArray` binds one parameter per value, so every list length is a
 * different statement text. Each text is a separate prepared statement that a
 * backend must plan from scratch (five custom plans before a generic one), so
 * list queries over a varying number of ids were planned on almost every
 * execution. One array parameter keeps one statement and one reusable plan for
 * any list length. An empty list matches nothing, like `inArray`.
 *
 * A single value binds as `column = $n` instead. The generic plan of an array
 * comparison is costed for an unknown, several-element list, so for a
 * one-element list PostgreSQL's plan cache judges the custom plan cheaper and
 * re-plans every execution; a lock-ordered single-row read under row-level
 * security then spends more time planning than executing. The scalar form
 * gets an exact one-row generic plan that is reused. Lists therefore produce
 * at most two statement texts: one value, and any other length.
 *
 * A raw SQL expression (for example an alias column) must name its element type.
 */
export function anyOf(column: PgColumn, values: readonly string[]): SQL;
export function anyOf(
  expression: SQL,
  values: readonly string[],
  elementType: ArrayElementType,
): SQL;
export function anyOf(
  column: PgColumn | SQL,
  values: readonly string[],
  explicitType?: ArrayElementType,
): SQL {
  const elementType = explicitType ?? (column as PgColumn).getSQLType();
  if (!ARRAY_ELEMENT_TYPES.has(elementType)) {
    throw new Error(`anyOf does not support ${elementType} columns`);
  }
  if (values.length === 1) {
    return sql`${column} = ${new Param(values[0])}::${sql.raw(elementType)}`;
  }
  return sql`${column} = any(${new Param([...values])}::${sql.raw(elementType)}[])`;
}
