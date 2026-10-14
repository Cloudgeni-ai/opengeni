import {
  quoteSiteSqlIdentifier,
  type SiteDbSchemaEntry,
  type SiteSqlValue,
} from "@opengeni/contracts";
import { siteDataCsvCell } from "../site-data/operations";

/**
 * Site SQL export and import formats, so a Site's data can always leave
 * Cloudflare: a SQL dump (schema, then INSERT statements), CSV for one table,
 * and JSON rows per table. Blobs travel as `{ "$base64": "..." }` in JSON,
 * X'..' literals in SQL and base64 text in CSV.
 */

export type SiteSqlExportTable = { name: string; columns: string[]; rows: unknown[][] };

function isBlob(value: unknown): value is { $base64: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { $base64?: unknown }).$base64 === "string"
  );
}

/** One value as a SQLite literal. */
export function siteSqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value ? "1" : "0";
  if (isBlob(value)) return `X'${Buffer.from(value.$base64, "base64").toString("hex")}'`;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return `'${text.replaceAll("'", "''")}'`;
}

/** The schema statements of a dump, tables first, each ending with a semicolon. */
export function siteSqlSchemaStatements(schema: readonly SiteDbSchemaEntry[]): string[] {
  const order = { table: 0, view: 1, index: 2, trigger: 3 } as const;
  return [...schema]
    .filter((entry) => entry.sql)
    .sort((a, b) => order[a.type] - order[b.type])
    .map((entry) => `${entry.sql!.trim().replace(/;+$/u, "")};`);
}

/** INSERT statements for one exported page of a table. */
export function siteSqlInsertStatements(table: SiteSqlExportTable): string[] {
  if (table.rows.length === 0) return [];
  const columns = table.columns.map(quoteSiteSqlIdentifier).join(", ");
  return table.rows.map(
    (row) =>
      `INSERT INTO ${quoteSiteSqlIdentifier(table.name)} (${columns}) VALUES (${row
        .map(siteSqlLiteral)
        .join(", ")});`,
  );
}

/** A CSV cell for an exported value (formula-safe, like Site Data exports). */
export function siteSqlCsvCell(value: unknown): string {
  if (isBlob(value)) return siteDataCsvCell(value.$base64);
  return siteDataCsvCell(value);
}

export function siteSqlCsvLine(values: readonly unknown[]): string {
  return values.map(siteSqlCsvCell).join(",");
}

/** Rows as objects keyed by column, for JSON exports. */
export function siteSqlRowObjects(table: SiteSqlExportTable): Array<Record<string, unknown>> {
  return table.rows.map((row) =>
    Object.fromEntries(table.columns.map((column, index) => [column, row[index] ?? null])),
  );
}

/**
 * Rows of a JSON import as column lists and value rows: the columns are every
 * key any row uses, in first-seen order; a missing key is NULL.
 */
export function siteSqlImportRows(rows: ReadonlyArray<Record<string, SiteSqlValue>>): {
  columns: string[];
  values: SiteSqlValue[][];
} {
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of rows)
    for (const key of Object.keys(row))
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
  return {
    columns,
    values: rows.map((row) =>
      columns.map((column) => (Object.hasOwn(row, column) ? (row[column] ?? null) : null)),
    ),
  };
}
