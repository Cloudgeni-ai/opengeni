import { defineSchema } from "./define-schema";
import { z } from "zod";

/**
 * Site SQL: optional per-Site SQLite storage on Cloudflare (one SQLite-backed
 * Durable Object per Site, `idFromName(siteId)`), offered next to Site Data.
 * Postgres keeps the definitions (settings, migrations and named queries) so
 * the database can always be rebuilt; the Durable Object holds the data.
 * Shared by the API, the Site gateway Worker (which runs the Durable Object)
 * and the SDK. See docs/design/published-sites-2026-10-14.md (PR B).
 *
 * Sites never send SQL: they call named, parameterized queries an owner
 * defined (`site.sql.run(name, params)`). Every statement, whoever wrote it,
 * passes `compileSiteSql` on the API and again in the Durable Object.
 */

// ---------------------------------------------------------------------------
// Statement checking
// ---------------------------------------------------------------------------

/** A value a statement parameter may take. Booleans bind as 1 and 0. */
export type SiteSqlValue = string | number | boolean | null;

export type SiteSqlStatementKind = "read" | "write" | "schema";

/**
 * Who wrote the SQL, which decides what it may do:
 * - `named`: a named query Site pages call. One read or write statement; no
 *   schema changes, PRAGMA, EXPLAIN or recursive CTEs.
 * - `agent`: one statement an owner's agent runs (query, execute). Schema
 *   changes and read-only PRAGMA/EXPLAIN allowed.
 * - `script`: migrations and SQL imports. Many statements, run together.
 */
export type SiteSqlProfile = "named" | "agent" | "script";

export type SiteSqlProblem =
  | "empty"
  | "too_long"
  | "syntax"
  | "multiple_statements"
  | "too_many_statements"
  | "statement_not_allowed"
  | "attach"
  | "vacuum"
  | "transaction"
  | "pragma"
  | "load_extension"
  | "reserved_name"
  | "parameter_style"
  | "parameter_name"
  | "too_many_parameters"
  | "recursive";

export type SiteSqlStatement = {
  /** The statement with every `:name` replaced by `?`, comments removed, no trailing semicolon. */
  sql: string;
  kind: SiteSqlStatementKind;
  /** Parameter names in bind order (a name used twice appears twice). */
  params: string[];
};

export type SiteSqlCompileResult =
  | {
      ok: true;
      statements: SiteSqlStatement[];
      /** Distinct parameter names in first-use order. */
      paramNames: string[];
    }
  | { ok: false; problem: SiteSqlProblem; message: string };

type ProfileRules = {
  maxLength: number;
  maxStatements: number;
  kinds: readonly SiteSqlStatementKind[];
  pragma: boolean;
  explain: boolean;
  recursive: boolean;
};

/** Longest SQL text per profile, in UTF-16 code units. */
export const SITE_SQL_MAX_NAMED_LENGTH = 16 * 1024;
export const SITE_SQL_MAX_AGENT_LENGTH = 64 * 1024;
export const SITE_SQL_MAX_SCRIPT_LENGTH = 2 * 1024 * 1024;
export const SITE_SQL_MAX_SCRIPT_STATEMENTS = 2_000;
export const SITE_SQL_MAX_PARAMETERS = 100;

const PROFILE_RULES: Readonly<Record<SiteSqlProfile, ProfileRules>> = Object.freeze({
  named: {
    maxLength: SITE_SQL_MAX_NAMED_LENGTH,
    maxStatements: 1,
    kinds: ["read", "write"],
    pragma: false,
    explain: false,
    recursive: false,
  },
  agent: {
    maxLength: SITE_SQL_MAX_AGENT_LENGTH,
    maxStatements: 1,
    kinds: ["read", "write", "schema"],
    pragma: true,
    explain: true,
    recursive: true,
  },
  script: {
    maxLength: SITE_SQL_MAX_SCRIPT_LENGTH,
    maxStatements: SITE_SQL_MAX_SCRIPT_STATEMENTS,
    kinds: ["read", "write", "schema"],
    pragma: false,
    explain: false,
    recursive: true,
  },
});

/** PRAGMAs that only read the schema. Anything else (and any `=` form) is refused. */
export const SITE_SQL_READ_PRAGMAS: readonly string[] = Object.freeze([
  "table_info",
  "table_xinfo",
  "table_list",
  "index_list",
  "index_info",
  "index_xinfo",
  "foreign_key_list",
]);

/**
 * Identifier prefixes Site SQL may not name: Cloudflare's own tables
 * (`_cf_`) and the Durable Object's bookkeeping (`_og_`).
 */
export const SITE_SQL_RESERVED_PREFIXES: readonly string[] = Object.freeze(["_cf_", "_og_"]);

/**
 * Parameters the API binds from the verified viewer; a Site may never supply
 * them. `:viewer` is the viewer's stable per-Site principal (`user:<id>`,
 * `guest:<visitor>`, ...), `:viewer_kind` its kind, `:viewer_signed_in` 1 or 0.
 */
export const SITE_SQL_PRINCIPAL_PARAMS: readonly string[] = Object.freeze([
  "viewer",
  "viewer_kind",
  "viewer_signed_in",
]);

/** `viewer` and every `viewer_*` name are reserved for the API. */
export function isSiteSqlPrincipalParam(name: string): boolean {
  return name === "viewer" || name.startsWith("viewer_");
}

const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;

type Token = {
  kind:
    | "word"
    | "quoted"
    | "string"
    | "blob"
    | "number"
    | "param"
    | "semi"
    | "lparen"
    | "rparen"
    | "op"
    | "space";
  text: string;
  /** Uppercase word, or the unquoted identifier for quoted tokens. */
  value: string;
};

class SiteSqlSyntaxError extends Error {}

const WORD_START = /[A-Za-z_\u0080-\uffff]/u;
const WORD_PART = /[A-Za-z0-9_$\u0080-\uffff]/u;
const NUMBER = /^(?:0[xX][0-9A-Fa-f]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/u;

function readQuoted(sql: string, start: number, close: string): number {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] === close) {
      if (close !== "]" && sql[index + 1] === close) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  throw new SiteSqlSyntaxError("Unterminated quote");
}

function unquote(text: string): string {
  const open = text[0]!;
  const inner = text.slice(1, -1);
  if (open === "[") return inner;
  return inner.split(`${open}${open}`).join(open);
}

/** SQLite-aware tokenizer: strings, quoted identifiers, blobs, comments and parameters. */
function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const push = (kind: Token["kind"], end: number, value = "") => {
    tokens.push({ kind, text: sql.slice(index, end), value });
    index = end;
  };
  while (index < sql.length) {
    const char = sql[index]!;
    const next = sql[index + 1];
    if (/\s/u.test(char)) {
      let end = index + 1;
      while (end < sql.length && /\s/u.test(sql[end]!)) end += 1;
      push("space", end);
    } else if (char === "-" && next === "-") {
      const newline = sql.indexOf("\n", index);
      // Comments become whitespace in the compiled statement.
      tokens.push({ kind: "space", text: " ", value: "" });
      index = newline < 0 ? sql.length : newline + 1;
    } else if (char === "/" && next === "*") {
      const close = sql.indexOf("*/", index + 2);
      if (close < 0) throw new SiteSqlSyntaxError("Unterminated comment");
      tokens.push({ kind: "space", text: " ", value: "" });
      index = close + 2;
    } else if (char === "'") {
      push("string", readQuoted(sql, index, "'"));
    } else if (char === '"' || char === "`") {
      const end = readQuoted(sql, index, char);
      push("quoted", end, unquote(sql.slice(index, end)));
    } else if (char === "[") {
      const end = readQuoted(sql, index, "]");
      push("quoted", end, unquote(sql.slice(index, end)));
    } else if ((char === "x" || char === "X") && next === "'") {
      push("blob", readQuoted(sql, index + 1, "'"));
    } else if (/\d/u.test(char) || (char === "." && /\d/u.test(next ?? ""))) {
      const match = NUMBER.exec(sql.slice(index, index + 512));
      push("number", index + (match ? match[0].length : 1));
    } else if (WORD_START.test(char)) {
      let end = index + 1;
      while (end < sql.length && WORD_PART.test(sql[end]!)) end += 1;
      push("word", end, sql.slice(index, end).toUpperCase());
    } else if (char === "?" || char === ":" || char === "@" || char === "$") {
      let end = index + 1;
      if (char === "?") while (end < sql.length && /\d/u.test(sql[end]!)) end += 1;
      else while (end < sql.length && WORD_PART.test(sql[end]!)) end += 1;
      if (char === ":" && end === index + 1) push("op", end);
      else push("param", end, sql.slice(index, end));
    } else if (char === ";") {
      push("semi", index + 1);
    } else if (char === "(") {
      push("lparen", index + 1);
    } else if (char === ")") {
      push("rparen", index + 1);
    } else {
      push("op", index + 1);
    }
  }
  return tokens;
}

function significant(tokens: Token[]): Token[] {
  return tokens.filter((token) => token.kind !== "space");
}

/** Split on top-level semicolons; a CREATE TRIGGER body (BEGIN ... END) keeps its own. */
function splitStatements(tokens: Token[]): Token[][] {
  const statements: Token[][] = [];
  let current: Token[] = [];
  let words: string[] = [];
  let depth = 0;
  const isTrigger = () => {
    const [first, second, third] = words;
    return (
      first === "CREATE" &&
      (second === "TRIGGER" ||
        ((second === "TEMP" || second === "TEMPORARY") && third === "TRIGGER"))
    );
  };
  for (const token of tokens) {
    if (token.kind === "semi" && !(depth > 0 && isTrigger())) {
      statements.push(current);
      current = [];
      words = [];
      depth = 0;
      continue;
    }
    current.push(token);
    if (token.kind === "word") {
      if (words.length < 3) words.push(token.value);
      if (isTrigger()) {
        if (token.value === "BEGIN" || token.value === "CASE") depth += 1;
        else if (token.value === "END" && depth > 0) depth -= 1;
      }
    }
  }
  statements.push(current);
  return statements.filter((statement) => significant(statement).length > 0);
}

const DML = new Set(["INSERT", "UPDATE", "DELETE", "REPLACE"]);

type Refusal = { problem: SiteSqlProblem; message: string };

/** The statement kind, or why it is refused. `at` indexes the first significant token. */
function classify(
  sig: Token[],
  rules: ProfileRules,
  at = 0,
): { kind: SiteSqlStatementKind } | Refusal {
  const first = sig[at];
  if (!first || first.kind !== "word")
    return { problem: "statement_not_allowed", message: "A statement must start with a keyword" };
  switch (first.value) {
    case "SELECT":
    case "VALUES":
      return { kind: "read" };
    case "INSERT":
    case "REPLACE":
    case "UPDATE":
    case "DELETE":
      return { kind: "write" };
    case "WITH": {
      let depth = 0;
      for (let index = at + 1; index < sig.length; index += 1) {
        const token = sig[index]!;
        if (token.kind === "lparen") depth += 1;
        else if (token.kind === "rparen") depth -= 1;
        else if (depth === 0 && token.kind === "word") {
          if (token.value === "SELECT" || token.value === "VALUES") return { kind: "read" };
          if (DML.has(token.value) && sig[index + 1]?.kind !== "lparen") return { kind: "write" };
        }
      }
      return { problem: "syntax", message: "A WITH clause must end in a statement" };
    }
    case "CREATE":
    case "DROP":
    case "ALTER":
    case "ANALYZE":
    case "REINDEX":
      return { kind: "schema" };
    case "EXPLAIN": {
      if (!rules.explain)
        return { problem: "statement_not_allowed", message: "EXPLAIN is not allowed here" };
      let inner = at + 1;
      if (sig[inner]?.value === "QUERY" && sig[inner + 1]?.value === "PLAN") inner += 2;
      const explained = classify(sig, rules, inner);
      return "problem" in explained ? explained : { kind: "read" };
    }
    case "PRAGMA": {
      if (!rules.pragma) return { problem: "pragma", message: "PRAGMA is not allowed here" };
      const name = sig[at + 1];
      const pragma = name?.kind === "word" || name?.kind === "quoted" ? name.value : "";
      if (
        !SITE_SQL_READ_PRAGMAS.includes(pragma.toLowerCase()) ||
        sig.some((token) => token.kind === "op" && (token.text === "=" || token.text === "."))
      )
        return {
          problem: "pragma",
          message: `Only these read-only PRAGMAs are allowed: ${SITE_SQL_READ_PRAGMAS.join(", ")}`,
        };
      return { kind: "read" };
    }
    case "ATTACH":
    case "DETACH":
      return { problem: "attach", message: "ATTACH and DETACH are not allowed" };
    case "VACUUM":
      return { problem: "vacuum", message: "VACUUM is not allowed" };
    case "BEGIN":
    case "COMMIT":
    case "END":
    case "ROLLBACK":
    case "SAVEPOINT":
    case "RELEASE":
      return {
        problem: "transaction",
        message: "Transaction statements are not allowed; each call already runs atomically",
      };
    default:
      return {
        problem: "statement_not_allowed",
        message: `${first.value} statements are not allowed`,
      };
  }
}

const KIND_LABEL: Record<SiteSqlStatementKind, string> = {
  read: "read",
  write: "write",
  schema: "schema change",
};

/**
 * Check and compile Site SQL. Refuses ATTACH/DETACH, VACUUM, transaction
 * control, PRAGMA writes, load_extension, reserved table names, positional or
 * `@`/`$` parameters and, per profile, more than one statement, schema
 * changes and recursive CTEs. Parameters are `:name` only and are rewritten
 * to `?` with their bind order, so values are always bound, never spliced.
 */
export function compileSiteSql(sql: string, profile: SiteSqlProfile): SiteSqlCompileResult {
  const rules = PROFILE_RULES[profile];
  const refuse = (problem: SiteSqlProblem, message: string): SiteSqlCompileResult => ({
    ok: false,
    problem,
    message,
  });
  if (typeof sql !== "string") return refuse("empty", "Give a SQL statement");
  if (sql.length > rules.maxLength)
    return refuse("too_long", `SQL is limited to ${rules.maxLength} characters here`);
  let tokens: Token[];
  try {
    tokens = tokenize(sql);
  } catch (error) {
    return refuse("syntax", error instanceof Error ? error.message : "Invalid SQL");
  }
  const statements = splitStatements(tokens);
  if (statements.length === 0) return refuse("empty", "Give a SQL statement");
  if (statements.length > rules.maxStatements)
    return rules.maxStatements === 1
      ? refuse("multiple_statements", "Give exactly one statement")
      : refuse("too_many_statements", `At most ${rules.maxStatements} statements`);
  const compiled: SiteSqlStatement[] = [];
  const paramNames: string[] = [];
  for (const statement of statements) {
    const sig = significant(statement);
    for (const token of sig) {
      if (token.kind !== "word" && token.kind !== "quoted") continue;
      const name = (token.kind === "word" ? token.text : token.value).toLowerCase();
      if (name === "load_extension")
        return refuse("load_extension", "load_extension is not allowed");
      if (SITE_SQL_RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix)))
        return refuse(
          "reserved_name",
          `Names starting with ${SITE_SQL_RESERVED_PREFIXES.join(" or ")} are reserved`,
        );
    }
    const classified = classify(sig, rules);
    if ("problem" in classified) return refuse(classified.problem, classified.message);
    if (!rules.kinds.includes(classified.kind))
      return refuse(
        "statement_not_allowed",
        `A ${profile === "named" ? "named query" : "statement"} cannot be a ${KIND_LABEL[classified.kind]}`,
      );
    if (
      !rules.recursive &&
      sig.some((token) => token.kind === "word" && token.value === "RECURSIVE")
    )
      return refuse("recursive", "Recursive queries are not allowed in named queries");
    const params: string[] = [];
    let text = "";
    for (const token of statement) {
      if (token.kind !== "param") {
        text += token.text;
        continue;
      }
      if (token.text[0] !== ":")
        return refuse("parameter_style", "Use named parameters like :name (not ?, @name or $name)");
      const name = token.text.slice(1);
      if (!PARAM_NAME.test(name))
        return refuse(
          "parameter_name",
          "Parameter names are a letter or _, then letters, digits or _ (up to 64)",
        );
      params.push(name);
      if (!paramNames.includes(name)) paramNames.push(name);
      text += "?";
    }
    if (params.length > SITE_SQL_MAX_PARAMETERS)
      return refuse("too_many_parameters", `At most ${SITE_SQL_MAX_PARAMETERS} parameters`);
    compiled.push({ sql: text.trim(), kind: classified.kind, params });
  }
  if (paramNames.length > SITE_SQL_MAX_PARAMETERS)
    return refuse("too_many_parameters", `At most ${SITE_SQL_MAX_PARAMETERS} parameters`);
  return { ok: true, statements: compiled, paramNames };
}

/** Bind values for one compiled statement; a missing name binds null. Booleans become 1 or 0. */
export function siteSqlBindings(
  statement: SiteSqlStatement,
  params: Readonly<Record<string, SiteSqlValue | undefined>>,
): Array<string | number | null> {
  return statement.params.map((name) => {
    const value = Object.hasOwn(params, name) ? params[name] : null;
    if (typeof value === "boolean") return value ? 1 : 0;
    return value ?? null;
  });
}

/** A SQLite identifier quoted for splicing (table and column names only, never values). */
export function quoteSiteSqlIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Table and column names Site SQL tools accept as arguments. */
export const SITE_SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;

export function isSiteSqlTableName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    SITE_SQL_IDENTIFIER.test(name) &&
    !lower.startsWith("sqlite_") &&
    !SITE_SQL_RESERVED_PREFIXES.some((prefix) => lower.startsWith(prefix))
  );
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Hard ceilings that hold whatever the profile or settings say. */
export const SITE_SQL_HARD_LIMITS = Object.freeze({
  maxRowsPerCall: 5_000,
  maxResponseBytes: 4 * 1024 * 1024,
  storageBytesPerSite: 5 * 1024 * 1024 * 1024,
  exportBytesPerCall: 4 * 1024 * 1024,
  importRowsPerCall: 5_000,
  /** UTF-8 bytes of SQL all of a Site's migrations hold together, so a rebuild fits in bounded calls. */
  migrationBytesPerSite: 6 * 1024 * 1024,
  /** Bytes one export call returns at most; follow nextCursor for the rest. */
  exportBytesPerResponse: 16 * 1024 * 1024,
});

/** Response header of the HTTP export: the cursor of the next piece, when there is one. */
export const SITE_SQL_EXPORT_NEXT_CURSOR_HEADER = "X-OpenGeni-Export-Next-Cursor";

/**
 * Effective Site SQL limits for one Site. Null means no Opengeni cap (the
 * hard limits still hold).
 */
export type SiteSqlLimits = {
  storageBytesPerSite: number;
  rowsReadPerSitePerMonth: number | null;
  rowsWrittenPerSitePerMonth: number | null;
  callsPerMinutePerViewer: number | null;
  callsPerMinutePerSite: number | null;
  maxRowsPerCall: number;
  maxResponseBytes: number;
};

// ---------------------------------------------------------------------------
// Definitions and requests
// ---------------------------------------------------------------------------

export const SITE_SQL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;

const SqlName = z
  .string()
  .regex(SITE_SQL_NAME)
  .describe("A letter, then letters, digits, - or _ (up to 64).");

export const SiteSqlValueSchema = /* @__PURE__ */ defineSchema(() =>
  z.union([z.string().max(64 * 1024), z.number(), z.boolean(), z.null()]),
);

export const SiteSqlParams = /* @__PURE__ */ defineSchema(() =>
  z
    .record(z.string().regex(PARAM_NAME), SiteSqlValueSchema)
    .refine((value) => Object.keys(value).length <= SITE_SQL_MAX_PARAMETERS, {
      message: `At most ${SITE_SQL_MAX_PARAMETERS} parameters`,
    })
    .describe("Parameter values by name (without the colon): strings, numbers, booleans or null."),
);
export type SiteSqlParams = z.infer<typeof SiteSqlParams>;

/**
 * Who may run a named query from a Site page:
 * - everyone: every viewer, including anonymous guests of public Sites;
 * - signed_in: viewers signed in as a person (workspace members, invited
 *   people and, on public Sites, any signed-in user). Callers with no person
 *   behind them (service keys, agents and schedules acting on their own) are
 *   refused unless they manage the Site;
 * - managers: only the Site's managers, through agent tools and the console's
 *   Data view; Site pages cannot run it.
 */
export const SiteSqlQueryAudience = /* @__PURE__ */ defineSchema(() =>
  z.enum(["everyone", "signed_in", "managers"]),
);
export type SiteSqlQueryAudience = z.infer<typeof SiteSqlQueryAudience>;

/** site_sql_define_query and PUT .../sql/queries/:name. */
export const SiteSqlQueryDefinitionRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({
    sql: z
      .string()
      .min(1)
      .max(SITE_SQL_MAX_NAMED_LENGTH)
      .describe(
        "Exactly one SELECT, INSERT, UPDATE, DELETE or REPLACE statement (WITH allowed, not recursive). Use :name parameters; :viewer, :viewer_kind and :viewer_signed_in are bound by Opengeni from the signed-in viewer.",
      ),
    audience: SiteSqlQueryAudience.optional().describe(
      "everyone (including anonymous guests of public Sites), signed_in (default: viewers signed in as a person) or managers.",
    ),
    description: z.string().max(2000).optional().describe("What the query is for."),
    maxRows: z
      .number()
      .int()
      .min(1)
      .max(SITE_SQL_HARD_LIMITS.maxRowsPerCall)
      .optional()
      .describe("Most rows one call returns (capped by the Site's limits)."),
  }),
);
export type SiteSqlQueryDefinitionRequest = z.infer<typeof SiteSqlQueryDefinitionRequest>;

/** POST .../published-artifacts/current/sql/queries/:name (Site pages, `site.sql.run`). */
export const SiteSqlRunRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({ params: SiteSqlParams.optional() }),
);
export type SiteSqlRunRequest = z.infer<typeof SiteSqlRunRequest>;

/** POST .../sql/query and .../sql/execute: one ad hoc statement from a manager. */
export const SiteSqlStatementRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({
    sql: z
      .string()
      .min(1)
      .max(SITE_SQL_MAX_AGENT_LENGTH)
      .describe("Exactly one SQLite statement; use :name parameters for values."),
    params: SiteSqlParams.optional(),
    maxRows: z
      .number()
      .int()
      .min(1)
      .max(SITE_SQL_HARD_LIMITS.maxRowsPerCall)
      .optional()
      .describe("Most rows to return (capped by the Site's limits)."),
  }),
);
export type SiteSqlStatementRequest = z.infer<typeof SiteSqlStatementRequest>;

/** POST .../sql/reset. */
export const SiteSqlResetRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({
    confirm: z.literal(true).describe("Must be true."),
    schema: z
      .enum(["keep", "drop"])
      .optional()
      .describe(
        "keep (default): delete every row and rebuild the tables from the migrations. drop: delete the database and forget every migration and named query.",
      ),
  }),
);
export type SiteSqlResetRequest = z.infer<typeof SiteSqlResetRequest>;

export const SiteSqlMigrationRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({
    name: SqlName.describe("A unique migration name, such as create_votes."),
    sql: z
      .string()
      .min(1)
      .max(SITE_SQL_MAX_SCRIPT_LENGTH)
      .describe("One or more statements (CREATE TABLE, CREATE INDEX, ALTER TABLE, INSERT ...)."),
  }),
);
export type SiteSqlMigrationRequest = z.infer<typeof SiteSqlMigrationRequest>;

export const SiteSqlExportFormat = /* @__PURE__ */ defineSchema(() =>
  z
    .enum(["sql", "csv", "json"])
    .describe("sql: schema and INSERT statements. csv: one table. json: rows per table."),
);
export type SiteSqlExportFormat = z.infer<typeof SiteSqlExportFormat>;

export const SiteSqlImportRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      format: SiteSqlExportFormat,
      sql: z
        .string()
        .max(SITE_SQL_MAX_SCRIPT_LENGTH)
        .optional()
        .describe("sql format: statements to run together (schema and data)."),
      table: z
        .string()
        .regex(SITE_SQL_IDENTIFIER)
        .optional()
        .describe("csv and json formats: the existing table to insert into."),
      csv: z
        .string()
        .max(SITE_SQL_MAX_SCRIPT_LENGTH)
        .optional()
        .describe("csv format: a header row of column names, then one row per line."),
      rows: z
        .array(z.record(z.string(), SiteSqlValueSchema))
        .max(SITE_SQL_HARD_LIMITS.importRowsPerCall)
        .optional()
        .describe("json format: objects keyed by column name."),
      onConflict: z
        .enum(["fail", "replace", "ignore"])
        .optional()
        .describe("csv and json formats: what to do with a row that hits a unique key."),
    })
    .refine(
      (value) =>
        value.format === "sql"
          ? value.sql !== undefined
          : value.table !== undefined &&
            (value.format === "csv" ? value.csv !== undefined : value.rows !== undefined),
      { message: "Give sql for sql, or table plus csv or rows" },
    ),
);
export type SiteSqlImportRequest = z.infer<typeof SiteSqlImportRequest>;

/** PUT .../sql/settings: the owner turns Site SQL on or off for one Site. */
export const SiteSqlSettingsRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({ enabled: z.boolean() }),
);
export type SiteSqlSettingsRequest = z.infer<typeof SiteSqlSettingsRequest>;

export const SiteSqlErrorCode = /* @__PURE__ */ defineSchema(() =>
  z.enum([
    "validation",
    "not_found",
    "forbidden",
    "conflict",
    "quota_exceeded",
    "rate_limited",
    "sql_error",
    "unavailable",
    "disabled",
  ]),
);
export type SiteSqlErrorCode = z.infer<typeof SiteSqlErrorCode>;

export const SITE_SQL_ERROR_STATUS: Readonly<Record<SiteSqlErrorCode, number>> = Object.freeze({
  validation: 422,
  not_found: 404,
  forbidden: 403,
  conflict: 409,
  quota_exceeded: 413,
  rate_limited: 429,
  sql_error: 422,
  unavailable: 503,
  disabled: 409,
});

/** A row as a Site sees it. Blobs come back as `{ "$base64": "..." }`. */
export type SiteSqlRow = Record<string, unknown>;

export type SiteSqlRunResponse = {
  columns: string[];
  rows: SiteSqlRow[];
  /** True when maxRows or the response size cut the result short. */
  truncated: boolean;
  rowsRead: number;
  rowsWritten: number;
};

export type SiteSqlQueryResponse = {
  name: string;
  sql: string;
  mode: "read" | "write";
  params: string[];
  audience: SiteSqlQueryAudience;
  description: string | null;
  maxRows: number | null;
  createdAt: string;
  updatedAt: string;
};

export type SiteSqlMigrationResponse = {
  ordinal: number;
  name: string;
  sql: string;
  checksum: string;
  createdAt: string;
};

export type SiteSqlUsageResponse = {
  storageBytes: number;
  rowsReadThisMonth: number;
  rowsWrittenThisMonth: number;
};

export type SiteSqlDescribeResponse = {
  siteId: string;
  /** Site SQL is configured on this deployment. */
  available: boolean;
  /** The owner turned Site SQL on for this Site. */
  enabled: boolean;
  migrations: SiteSqlMigrationResponse[];
  queries: SiteSqlQueryResponse[];
  usage: SiteSqlUsageResponse;
  limits: SiteSqlLimits;
};

export type SiteSqlMigrateResponse = {
  migration: SiteSqlMigrationResponse;
  /** Migrations the database applied now (earlier ones it was missing, then this one). */
  applied: string[];
};

export type SiteSqlImportResponse = {
  /** Rows inserted (csv, json) or data statements run (sql). */
  imported: number;
  /** The migration a sql import recorded for its schema statements (before the data), if any. */
  migration: string | null;
  /**
   * Every migration a sql import recorded, in order: its schema statements
   * before the data, then its triggers after the data (so they do not fire
   * on imported rows).
   */
  migrations: string[];
  rowsWritten: number;
};

export type SiteSqlResetResponse = { applied: string[]; droppedSchema: boolean };

// ---------------------------------------------------------------------------
// API -> gateway internal protocol
// ---------------------------------------------------------------------------

/**
 * The gateway route the API calls for a Site's Durable Object:
 * `POST <gateway internal origin>/_og/internal/site-db/<siteId>/<operation>`,
 * signed like gateway -> API requests (`siteGatewayCanonicalString` over the
 * internal path and the gateway's host, empty session, visitor, IP and human
 * fields, the shared gateway secret, 30 s skew). The path prefix keeps these
 * signatures distinct from any site-runtime request.
 */
export const SITE_DB_INTERNAL_PREFIX = "/_og/internal/site-db";

export const SITE_DB_OPERATIONS = Object.freeze([
  "run",
  "script",
  "migrate",
  "insert",
  "export",
  "inspect",
  "reset",
] as const);
export type SiteDbOperation = (typeof SITE_DB_OPERATIONS)[number];

export function siteDbInternalPath(siteId: string, operation: SiteDbOperation): string {
  return `${SITE_DB_INTERNAL_PREFIX}/${encodeURIComponent(siteId)}/${operation}`;
}

/** Every internal request names a fresh id; the Durable Object refuses a replay within the skew window. */
type SiteDbBase = { requestId: string };

export type SiteDbRunRequest = SiteDbBase & {
  sql: string;
  profile: "named" | "agent";
  params: Record<string, SiteSqlValue>;
  /** The mode a named query was defined with; a read that writes is rolled back. */
  expect?: "read" | "write";
  maxRows: number;
  maxResponseBytes: number;
  maxDatabaseBytes: number;
};

export type SiteDbScriptRequest = SiteDbBase & { sql: string; maxDatabaseBytes: number };

export type SiteDbMigrateRequest = SiteDbBase & {
  /**
   * Migrations to apply in order; ones already applied (same checksum) are
   * skipped. `position` is the migration's ordinal in Postgres, so the
   * database keeps the order when the API sends only the missing ones.
   */
  migrations: Array<{ name: string; sql: string; checksum: string; position?: number }>;
  /**
   * Delete everything first, then apply these migrations (the first call of
   * a rebuild from Postgres; later calls send the rest without it).
   */
  rebuild?: boolean;
  maxDatabaseBytes: number;
};

/** Inspect; `migrationsOnly` skips the tables (and their row counts). */
export type SiteDbInspectRequest = SiteDbBase & { migrationsOnly?: boolean };

export type SiteDbInsertRequest = SiteDbBase & {
  table: string;
  columns: string[];
  rows: SiteSqlValue[][];
  onConflict: "fail" | "replace" | "ignore";
  maxDatabaseBytes: number;
};

export type SiteDbExportRequest = SiteDbBase & {
  /** Tables to export; all user tables when omitted. */
  tables?: string[];
  /** nextCursor from the previous page. */
  cursor?: string | null;
  maxRows: number;
  maxBytes: number;
};

export type SiteDbMeter = {
  rowsRead: number;
  rowsWritten: number;
  /** Database size after the operation. */
  databaseBytes: number;
};

export type SiteDbSchemaEntry = {
  type: "table" | "index" | "view" | "trigger";
  name: string;
  table: string;
  sql: string | null;
};

export type SiteDbRunResponse = SiteDbMeter & {
  columns: string[];
  rows: SiteSqlRow[];
  truncated: boolean;
};

export type SiteDbMigrateResponse = SiteDbMeter & { applied: string[] };

export type SiteDbExportResponse = SiteDbMeter & {
  /** The whole database schema, on every page. */
  schema: SiteDbSchemaEntry[];
  /** Row values in column order; blobs as `{ "$base64": "..." }`. */
  tables: Array<{ name: string; columns: string[]; rows: unknown[][] }>;
  nextCursor: string | null;
};

export type SiteDbInspectResponse = SiteDbMeter & {
  tables: Array<{
    name: string;
    type: "table" | "view";
    sql: string | null;
    columns: Array<{
      name: string;
      type: string;
      notNull: boolean;
      primaryKey: boolean;
      defaultValue: string | null;
    }>;
    /** Rows, counted up to 100,000 (rowCountCapped says the count stopped there). */
    rowCount: number;
    rowCountCapped: boolean;
  }>;
  indexes: SiteDbSchemaEntry[];
  migrations: Array<{ name: string; checksum: string; appliedAt: string }>;
};

/** GET .../sql/inspect: the database as the Durable Object sees it. */
export type SiteSqlInspectResponse = Omit<SiteDbInspectResponse, "rowsRead" | "rowsWritten"> & {
  /** Migrations Postgres has that the database has not applied (migrate or reset to apply). */
  pendingMigrations: string[];
};

export type SiteDbErrorCode =
  | "validation"
  | "sql_error"
  | "quota_exceeded"
  | "conflict"
  | "replayed"
  | "too_large"
  | "unauthorized"
  | "not_found";

export type SiteDbErrorBody = { error: { code: SiteDbErrorCode; message: string } };

/** Encode a SQLite blob for JSON. */
export function siteSqlBlobValue(bytes: Uint8Array): { $base64: string } {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return { $base64: btoa(binary) };
}
