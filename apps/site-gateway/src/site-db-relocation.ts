/**
 * Copying a Site database from its legacy Durable Object into its EU object
 * (`site-db-location.ts`), exactly: the same schema objects, every row with
 * its rowid and storage class (64-bit integers and blobs included), the
 * AUTOINCREMENT counters, and the bookkeeping kept beside the data
 * (migrations applied, recent request ids).
 *
 * Both objects compute the same `RelocationState` over their own storage: the
 * schema, and per copied table its row count and a SHA-256 chained over its
 * rows in order. The EU object accepts the copy only when its state equals
 * the legacy object's, taken while the legacy object refused every other
 * caller. Anything this module cannot copy faithfully (for example an FTS5
 * table without its own content) is refused, so the database stays where it
 * is instead of moving with a loss.
 */
import { quoteSiteSqlIdentifier, siteSqlBlobValue } from "@opengeni/contracts";
import { sha256Hex } from "@opengeni/contracts/values";
import type { SqlStorage, SqlStorageValue, SyncKvStorage } from "./site-database";

/** Raised when a database cannot be copied as it is; the database stays where it was. */
export class RelocationError extends Error {
  constructor(
    message: string,
    /** The HTTP status of the legacy object's refusal, when it refused a step. */
    readonly status?: number,
  ) {
    super(message);
    this.name = "RelocationError";
  }
}

/**
 * A value with its SQLite storage class: integers and reals as exact text,
 * text and blobs as base64 of their stored bytes (so text that is not valid
 * UTF-8 is copied and compared byte for byte).
 */
export type EncodedValue = null | { i: string } | { r: string } | { t: string } | { b: string };

export type SchemaEntry = {
  type: "table" | "index" | "view" | "trigger";
  name: string;
  tbl: string;
  sql: string | null;
};

/** A table whose rows are copied: an ordinary table or a virtual table (not its shadow tables). */
export type CopiedTable = {
  name: string;
  virtual: boolean;
  /** The rowid name the rows are read and written with, or null (WITHOUT ROWID, or every alias is a column). */
  alias: string | null;
  /** Stored columns in order; generated and hidden columns are left to SQLite. */
  columns: string[];
};

export type RelocationState = {
  /** User schema objects in creation order (Cloudflare, Opengeni and SQLite internals excluded). */
  schema: SchemaEntry[];
  tables: Array<CopiedTable & { rows: number; digest: string }>;
  /** FTS5 settings (`<table>_config` rows other than `version`), by table then key. */
  ftsConfig: Array<{ table: string; key: string; value: EncodedValue }>;
  /** AUTOINCREMENT counters (`sqlite_sequence`), by table name. */
  sequences: Array<{ name: string; seq: string }>;
  /** Migration records (`mig:` keys), by key. */
  migrations: Array<[string, unknown]>;
  /** Recent request ids (`rq:` keys): copied, not compared (they expire on their own). */
  requests: Array<[string, unknown]>;
};

export type PageCursor = { t: number; r?: string; o?: number };

export type RelocationPage = {
  table: string;
  /** The table's position among the copied tables. */
  index: number;
  /** Each row: the rowid (when the table has an alias) then one value per column. */
  rows: EncodedValue[][];
  next: PageCursor | null;
};

/**
 * Staging in the EU object before the copy is built (excluded from user
 * schema reads): one table per copied table (`_og_relocation_<index>`, one
 * untyped column per value, so every value keeps its storage class and no
 * staged value is larger than it was in the source) and a list of them.
 */
export const STAGING_TABLE = "_og_relocation";

const PAGE_MAX_ROWS = 2_000;
/** UTF-8 bytes of the rows in one page (a page always holds at least one row). */
const PAGE_MAX_BYTES = 1024 * 1024;
const DIGEST_CHUNK_ROWS = 500;
const INTERNAL_NAME = /^(?:sqlite_|_cf_|_og_)/iu;

// --- reading ----------------------------------------------------------------

/** User schema objects in creation order. */
export function schemaEntries(sql: SqlStorage): SchemaEntry[] {
  return sql
    .exec(
      "SELECT type, name, tbl_name AS tbl, sql FROM sqlite_master WHERE type IN ('table', 'index', 'view', 'trigger') ORDER BY rowid",
    )
    .toArray()
    .filter((entry) => !INTERNAL_NAME.test(String(entry.name)))
    .map((entry) => ({
      type: entry.type as SchemaEntry["type"],
      name: String(entry.name),
      tbl: String(entry.tbl),
      sql: typeof entry.sql === "string" ? entry.sql : null,
    }));
}

type TableKind = { type: string; withoutRowid: boolean };

function tableKinds(sql: SqlStorage): Map<string, TableKind> {
  return new Map(
    sql
      .exec("PRAGMA table_list")
      .toArray()
      .filter((row) => row.schema === "main")
      .map((row) => [
        String(row.name),
        { type: String(row.type), withoutRowid: Number(row.wr) === 1 },
      ]),
  );
}

/** Names of ordinary and virtual tables (not shadow tables), in creation order. */
export function userTables(sql: SqlStorage, schema = schemaEntries(sql)): string[] {
  const kinds = tableKinds(sql);
  return schema
    .filter((entry) => entry.type === "table" && kinds.get(entry.name)?.type !== "shadow")
    .map((entry) => entry.name);
}

/**
 * The tables whose rows are copied, in creation order: ordinary and virtual
 * tables; shadow tables are rebuilt by their virtual table.
 */
export function copiedTables(sql: SqlStorage, schema = schemaEntries(sql)): CopiedTable[] {
  const kinds = tableKinds(sql);
  const tables: CopiedTable[] = [];
  for (const entry of schema) {
    if (entry.type !== "table") continue;
    const kind = kinds.get(entry.name)?.type;
    if (kind === "shadow") continue;
    const virtual = kind === "virtual";
    if (
      virtual &&
      !/^\s*CREATE\s+VIRTUAL\s+TABLE\b[^(]*\bUSING\s+fts5\s*\(/iu.test(entry.sql ?? "")
    )
      throw new RelocationError(
        `Table ${entry.name} is a virtual table this copy does not support; only FTS5 tables are copied`,
      );
    if (virtual && /\b(?:content|contentless_delete)\s*=/iu.test(entry.sql ?? ""))
      throw new RelocationError(
        `Table ${entry.name} is an FTS5 table without its own content, which cannot be copied row by row`,
      );
    if (kind !== "table" && !virtual)
      throw new RelocationError(
        `Table ${entry.name} has an unexpected kind (${kind ?? "unknown"})`,
      );
    const info = sql.exec(`PRAGMA table_xinfo(${quoteSiteSqlIdentifier(entry.name)})`).toArray();
    const names = new Set(info.map((column) => String(column.name).toLowerCase()));
    const withoutRowid = !virtual && kinds.get(entry.name)!.withoutRowid;
    const alias = virtual
      ? "rowid"
      : withoutRowid
        ? null
        : (["rowid", "_rowid_", "oid"].find((name) => !names.has(name)) ?? null);
    if (!withoutRowid && alias === null)
      throw new RelocationError(
        `Table ${entry.name} has columns named rowid, _rowid_ and oid, so its rowids cannot be copied`,
      );
    tables.push({
      name: entry.name,
      virtual,
      alias,
      columns: info.filter((column) => Number(column.hidden) === 0).map((c) => String(c.name)),
    });
  }
  return tables;
}

function drainCursor(cursor: { raw(): Iterable<unknown> }): void {
  for (const _ of cursor.raw()) {
    // run to completion
  }
}

function toBase64(bytes: ArrayBuffer): string {
  return siteSqlBlobValue(new Uint8Array(bytes)).$base64;
}

function fromBase64(text: string): ArrayBuffer {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function encodeReal(value: number): string {
  return Object.is(value, -0) ? "-0" : String(value);
}

/** One stored value as `typeof(...)` and its exact form (integers as text). */
function encodeValue(type: SqlStorageValue, value: SqlStorageValue): EncodedValue {
  switch (type) {
    case "null":
      return null;
    case "integer":
      return { i: String(value) };
    case "real":
      return { r: encodeReal(Number(value)) };
    case "text":
      return { t: toBase64(value as ArrayBuffer) };
    case "blob":
      return { b: toBase64(value as ArrayBuffer) };
    default:
      throw new RelocationError(`Unexpected SQLite storage class ${String(type)}`);
  }
}

/** SELECT list that reads each column's storage class and exact value (integers as text). */
function selectList(table: CopiedTable): string {
  const parts = table.alias === null ? [] : [`CAST(${table.alias} AS TEXT)`];
  for (const column of table.columns) {
    const quoted = quoteSiteSqlIdentifier(column);
    parts.push(
      `typeof(${quoted})`,
      `CASE typeof(${quoted}) WHEN 'integer' THEN CAST(${quoted} AS TEXT) WHEN 'text' THEN CAST(${quoted} AS BLOB) ELSE ${quoted} END`,
    );
  }
  return parts.join(", ");
}

function decodeRow(table: CopiedTable, raw: SqlStorageValue[]): EncodedValue[] {
  const row: EncodedValue[] = [];
  let index = 0;
  if (table.alias !== null) {
    row.push({ i: String(raw[0]) });
    index = 1;
  }
  for (let column = 0; column < table.columns.length; column += 1, index += 2)
    row.push(encodeValue(raw[index] ?? "null", raw[index + 1] ?? null));
  return row;
}

/**
 * Up to `limit` rows of a table after a position, in rowid order (or the
 * table's natural order when it has no rowid alias).
 */
function readRows(
  sql: SqlStorage,
  table: CopiedTable,
  after: { r?: string; o?: number },
  limit: number,
): Array<{ row: EncodedValue[]; rowid: string | null }> {
  const quoted = quoteSiteSqlIdentifier(table.name);
  const select = selectList(table);
  const cursor =
    table.alias === null
      ? sql.exec(`SELECT ${select} FROM ${quoted} LIMIT ? OFFSET ?`, limit, after.o ?? 0)
      : after.r === undefined
        ? sql.exec(`SELECT ${select} FROM ${quoted} ORDER BY ${table.alias} LIMIT ?`, limit)
        : sql.exec(
            `SELECT ${select} FROM ${quoted} WHERE ${table.alias} > CAST(? AS INTEGER) ORDER BY ${table.alias} LIMIT ?`,
            after.r,
            limit,
          );
  return Array.from(cursor.raw(), (raw) => ({
    row: decodeRow(table, raw),
    rowid: table.alias === null ? null : String(raw[0]),
  }));
}

const utf8 = new TextEncoder();

/** One page of rows for the copy, bounded in rows and bytes. */
export function readPage(
  sql: SqlStorage,
  tables: CopiedTable[],
  cursor: PageCursor | null,
): RelocationPage | null {
  let position = cursor ?? { t: 0 };
  while (position.t < tables.length) {
    const table = tables[position.t]!;
    const chunk = readRows(sql, table, position, PAGE_MAX_ROWS);
    if (chunk.length === 0) {
      position = { t: position.t + 1 };
      continue;
    }
    const rows: EncodedValue[][] = [];
    let bytes = 0;
    let last = chunk[0]!;
    for (const entry of chunk) {
      const size = utf8.encode(JSON.stringify(entry.row)).byteLength + 1;
      if (rows.length > 0 && bytes + size > PAGE_MAX_BYTES) break;
      rows.push(entry.row);
      bytes += size;
      last = entry;
    }
    const next: PageCursor =
      table.alias === null
        ? { t: position.t, o: (position.o ?? 0) + rows.length }
        : { t: position.t, r: last.rowid! };
    return { table: table.name, index: position.t, rows, next };
  }
  return null;
}

/** Row count and SHA-256 chained over the table's rows in order. */
async function tableDigest(
  sql: SqlStorage,
  table: CopiedTable,
): Promise<{ rows: number; digest: string }> {
  let digest = await sha256Hex(JSON.stringify([table.name, table.alias, table.columns]));
  let rows = 0;
  let position: { r?: string; o?: number } = {};
  for (;;) {
    const chunk = readRows(sql, table, position, DIGEST_CHUNK_ROWS);
    if (chunk.length === 0) break;
    rows += chunk.length;
    digest = await sha256Hex(
      `${digest}\n${chunk.map((entry) => JSON.stringify(entry.row)).join("\n")}`,
    );
    position =
      table.alias === null ? { o: (position.o ?? 0) + chunk.length } : { r: chunk.at(-1)!.rowid! };
  }
  return { rows, digest };
}

/** The FTS5 settings of the virtual tables (`rank`, `automerge`, ...), read from `<table>_config`. */
function ftsConfig(
  sql: SqlStorage,
  tables: CopiedTable[],
): Array<{ table: string; key: string; value: EncodedValue }> {
  const settings: Array<{ table: string; key: string; value: EncodedValue }> = [];
  for (const table of tables) {
    if (!table.virtual) continue;
    const config = quoteSiteSqlIdentifier(`${table.name}_config`);
    for (const [key, type, value] of sql
      .exec(
        `SELECT k, typeof(v), CASE typeof(v) WHEN 'integer' THEN CAST(v AS TEXT) WHEN 'text' THEN CAST(v AS BLOB) ELSE v END FROM ${config} WHERE k <> 'version' ORDER BY k`,
      )
      .raw())
      settings.push({
        table: table.name,
        key: String(key),
        value: encodeValue(type ?? "null", value ?? null),
      });
  }
  return settings;
}

function kvEntries(kv: SyncKvStorage, prefix: string): Array<[string, unknown]> {
  return Array.from(kv.list({ prefix }), ([key, value]) => [key, value] as [string, unknown]);
}

/** The state compared between the two copies (see the module comment). */
export async function relocationState(
  sql: SqlStorage,
  kv: SyncKvStorage,
): Promise<RelocationState> {
  const schema = schemaEntries(sql);
  const tables = [];
  for (const table of copiedTables(sql, schema))
    tables.push({ ...table, ...(await tableDigest(sql, table)) });
  const hasSequences =
    sql
      .exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'")
      .toArray().length > 0;
  const sequences = hasSequences
    ? sql
        .exec("SELECT name, CAST(seq AS TEXT) AS seq FROM sqlite_sequence ORDER BY name")
        .toArray()
        .map((row) => ({ name: String(row.name), seq: String(row.seq) }))
    : [];
  return {
    schema,
    tables,
    ftsConfig: ftsConfig(sql, tables),
    sequences,
    migrations: kvEntries(kv, "mig:"),
    requests: kvEntries(kv, "rq:"),
  };
}

/** True when the object holds nothing worth copying (request ids alone are not). */
export function isEmptyDatabase(sql: SqlStorage, kv: SyncKvStorage): boolean {
  if (schemaEntries(sql).length > 0) return false;
  for (const [key] of kv.list({}))
    if (!key.startsWith("rq:") && !key.startsWith("loc:")) return false;
  return true;
}

const sortedSchema = (schema: SchemaEntry[]) =>
  JSON.stringify(
    [...schema].sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name)),
  );

/** The first difference between the source and its copy, or null when they match. */
export function compareStates(source: RelocationState, copy: RelocationState): string | null {
  if (sortedSchema(source.schema) !== sortedSchema(copy.schema))
    return "the schema of the copy differs";
  if (source.tables.length !== copy.tables.length) return "the copy has a different set of tables";
  for (const [index, table] of source.tables.entries()) {
    const other = copy.tables[index]!;
    if (
      table.name !== other.name ||
      JSON.stringify(table.columns) !== JSON.stringify(other.columns) ||
      table.alias !== other.alias
    )
      return `table ${table.name} has different columns in the copy`;
    if (table.rows !== other.rows)
      return `table ${table.name} has ${other.rows} rows in the copy, ${table.rows} in the source`;
    if (table.digest !== other.digest) return `the rows of table ${table.name} differ in the copy`;
  }
  if (JSON.stringify(source.ftsConfig) !== JSON.stringify(copy.ftsConfig))
    return "the FTS5 settings differ in the copy";
  if (JSON.stringify(source.sequences) !== JSON.stringify(copy.sequences))
    return "the AUTOINCREMENT counters differ in the copy";
  if (JSON.stringify(source.migrations) !== JSON.stringify(copy.migrations))
    return "the migration records differ in the copy";
  return null;
}

// --- writing (EU object) ----------------------------------------------------

function stagingTable(index: number): string {
  return quoteSiteSqlIdentifier(`${STAGING_TABLE}_${index}`);
}

function bindValue(value: EncodedValue): { expression: string; binding: unknown } {
  if (value === null) return { expression: "?", binding: null };
  if ("i" in value) return { expression: "CAST(? AS INTEGER)", binding: value.i };
  if ("r" in value) {
    const number = Number(value.r);
    // Text keeps infinities exact through the binding; SQLite reads 9e999 as Inf.
    const binding = Number.isFinite(number) ? number : number > 0 ? "9e999" : "-9e999";
    return { expression: "CAST(? AS REAL)", binding };
  }
  // The stored bytes, read back as text without decoding them.
  if ("t" in value) return { expression: "CAST(? AS TEXT)", binding: fromBase64(value.t) };
  return { expression: "?", binding: fromBase64(value.b) };
}

/** Keep one page of the source, each value with its storage class, until the copy is built. */
export function stagePage(sql: SqlStorage, page: RelocationPage): void {
  if (!Number.isSafeInteger(page.index) || page.index < 0)
    throw new RelocationError("A page arrived without its table position");
  const width = page.rows[0]?.length ?? 0;
  sql.exec(
    `CREATE TABLE IF NOT EXISTS ${STAGING_TABLE} (idx INTEGER PRIMARY KEY, tbl TEXT NOT NULL, width INTEGER NOT NULL)`,
  );
  const [known] = sql
    .exec(`SELECT tbl, width FROM ${STAGING_TABLE} WHERE idx = ?`, page.index)
    .toArray();
  if (!known) {
    if (width < 1) throw new RelocationError(`A page of table ${page.table} has no values`);
    sql.exec(
      `INSERT INTO ${STAGING_TABLE} (idx, tbl, width) VALUES (?, ?, ?)`,
      page.index,
      page.table,
      width,
    );
    const columns = Array.from({ length: width }, (_, column) => `c${column}`).join(", ");
    sql.exec(`CREATE TABLE ${stagingTable(page.index)} (${columns})`);
  } else if (known.tbl !== page.table || Number(known.width) !== width)
    throw new RelocationError(`Pages of table ${page.table} do not line up`);
  for (const row of page.rows) {
    if (row.length !== width)
      throw new RelocationError(`A row of table ${page.table} has the wrong width`);
    const bound = row.map(bindValue);
    sql.exec(
      `INSERT INTO ${stagingTable(page.index)} VALUES (${bound.map((value) => value.expression).join(", ")})`,
      ...bound.map((value) => value.binding),
    );
  }
}

/**
 * Inside one transaction: create the schema, insert the staged rows with
 * their rowids, then indexes, views and triggers (so triggers never fire on
 * the copy), set the AUTOINCREMENT counters and check foreign keys. The
 * caller wraps it in `transactionSync` with foreign keys deferred.
 */
export function buildCopy(sql: SqlStorage, kv: SyncKvStorage, source: RelocationState): void {
  const copied = new Map(source.tables.map((table) => [table.name, table]));
  for (const entry of source.schema)
    if (entry.type === "table" && copied.has(entry.name)) {
      if (!entry.sql) throw new RelocationError(`Table ${entry.name} has no definition`);
      sql.exec(entry.sql);
    }
  for (const setting of source.ftsConfig) {
    // FTS5 takes its settings as a command row: INSERT INTO t(t, rank) VALUES (key, value).
    const table = quoteSiteSqlIdentifier(setting.table);
    const value = bindValue(setting.value);
    sql.exec(
      `INSERT INTO ${table} (${table}, rank) VALUES (?, ${value.expression})`,
      setting.key,
      value.binding,
    );
  }
  const hasStaging =
    sql
      .exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", STAGING_TABLE)
      .toArray().length > 0;
  const staged = hasStaging
    ? sql.exec(`SELECT idx, tbl, width FROM ${STAGING_TABLE} ORDER BY idx`).toArray()
    : [];
  for (const entry of staged) {
    const table = copied.get(String(entry.tbl));
    if (!table) throw new RelocationError(`Rows arrived for an unknown table ${String(entry.tbl)}`);
    const names = [
      ...(table.alias === null ? [] : [table.alias]),
      ...table.columns.map(quoteSiteSqlIdentifier),
    ];
    if (Number(entry.width) !== names.length)
      throw new RelocationError(`The rows of table ${table.name} have the wrong width`);
    const columns = names.map((_, column) => `c${column}`).join(", ");
    drainCursor(
      sql.exec(
        `INSERT INTO ${quoteSiteSqlIdentifier(table.name)} (${names.join(", ")}) SELECT ${columns} FROM ${stagingTable(Number(entry.idx))} ORDER BY rowid`,
      ),
    );
    sql.exec(`DROP TABLE ${stagingTable(Number(entry.idx))}`);
  }
  for (const entry of source.schema)
    if (entry.type !== "table" && entry.sql !== null) sql.exec(entry.sql);
  for (const { name, seq: value } of source.sequences) {
    const updated = sql.exec(
      "UPDATE sqlite_sequence SET seq = CAST(? AS INTEGER) WHERE name = ?",
      value,
      name,
    );
    drainCursor(updated);
    if (updated.rowsWritten === 0)
      sql.exec(
        "INSERT INTO sqlite_sequence (name, seq) VALUES (?, CAST(? AS INTEGER))",
        name,
        value,
      );
  }
  const violations = sql.exec("PRAGMA foreign_key_check").toArray();
  if (violations.length > 0)
    throw new RelocationError(
      `The copy breaks ${violations.length} foreign key reference(s), first in table ${String(violations[0]!.table)}`,
    );
  if (hasStaging) sql.exec(`DROP TABLE ${STAGING_TABLE}`);
  for (const [key, value] of [...source.migrations, ...source.requests]) kv.put(key, value);
}
