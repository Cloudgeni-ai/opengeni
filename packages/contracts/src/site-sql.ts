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
 *   schema changes, PRAGMA, EXPLAIN or recursive CTEs (no RECURSIVE keyword,
 *   no CTE that refers to itself and no UNION/INTERSECT/EXCEPT inside a CTE).
 * - `agent`: one read or write statement an owner's agent runs (query,
 *   execute), plus read-only PRAGMA and EXPLAIN. Schema changes go through
 *   migrations so the database can always be rebuilt from Postgres.
 * - `script`: migrations and SQL imports. Many statements, run together,
 *   schema changes included.
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
    kinds: ["read", "write"],
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
 * (`_cf_`) and names kept for Opengeni (`_og_`). Quoted identifiers count,
 * and so do string literals that start with one (SQLite accepts any string
 * as a table name, as in `FROM '_cf_KV'`), so such a value must be passed as
 * a parameter.
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
  /** Uppercase word, or the unquoted content of quoted identifiers and strings. */
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
      const end = readQuoted(sql, index, "'");
      push("string", end, unquote(sql.slice(index, end)));
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
    } else if (
      char === "?" ||
      char === ":" ||
      char === "@" ||
      char === "$" ||
      // SQLite reads `#name` as a parameter too.
      (char === "#" && WORD_START.test(next ?? ""))
    ) {
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

/**
 * Split on top-level semicolons; a CREATE TRIGGER body (BEGIN ... END) keeps
 * its own. Only the first BEGIN outside a CASE opens the body; inside it CASE
 * and END nest, an unquoted BEGIN is refused (quote a column named begin),
 * and the END that closes the body must be followed by `;` or the end of
 * the SQL. That way a statement boundary is never in doubt: anything SQLite
 * could read differently is refused rather than guessed.
 */
function splitStatements(tokens: Token[]): Token[][] {
  const statements: Token[][] = [];
  let current: Token[] = [];
  let words: string[] = [];
  let phase: "head" | "body" | "after" = "head";
  let caseDepth = 0;
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
    if (token.kind === "semi" && phase !== "body") {
      statements.push(current);
      current = [];
      words = [];
      phase = "head";
      caseDepth = 0;
      depth = 0;
      continue;
    }
    if (phase === "after" && token.kind !== "space")
      throw new SiteSqlSyntaxError(
        "A trigger's END must end the statement; quote identifiers named begin or end",
      );
    current.push(token);
    if (token.kind !== "word") continue;
    if (words.length < 3) words.push(token.value);
    if (!isTrigger()) continue;
    if (phase === "head") {
      if (token.value === "CASE") caseDepth += 1;
      else if (token.value === "END" && caseDepth > 0) caseDepth -= 1;
      else if (token.value === "BEGIN" && caseDepth === 0) {
        phase = "body";
        depth = 1;
      }
    } else if (phase === "body") {
      if (token.value === "BEGIN")
        throw new SiteSqlSyntaxError(
          "A trigger body cannot contain BEGIN; quote identifiers named begin or end",
        );
      if (token.value === "CASE") depth += 1;
      else if (token.value === "END") {
        depth -= 1;
        if (depth === 0) phase = "after";
      }
    }
  }
  if (phase === "body") throw new SiteSqlSyntaxError("A trigger body is missing its END");
  statements.push(current);
  return statements.filter((statement) => significant(statement).length > 0);
}

const DML = new Set(["INSERT", "UPDATE", "DELETE", "REPLACE"]);
const COMPOUND = new Set(["UNION", "INTERSECT", "EXCEPT"]);

type Refusal = { problem: SiteSqlProblem; message: string };

type Cte = { name: string; body: Token[] };

function isName(token: Token | undefined): token is Token {
  return token?.kind === "word" || token?.kind === "quoted" || token?.kind === "string";
}

/** A name as SQLite compares it (ASCII case-insensitive; Unicode folding only refuses more). */
function nameKey(token: Token): string {
  return (token.kind === "word" ? token.text : token.value).toUpperCase();
}

/** Index of the `)` matching the `(` at `open`, or -1. */
function closingParen(sig: Token[], open: number): number {
  let depth = 0;
  for (let index = open; index < sig.length; index += 1) {
    if (sig[index]!.kind === "lparen") depth += 1;
    else if (sig[index]!.kind === "rparen") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * The common table expressions after the WITH at `at`:
 * `WITH [RECURSIVE] name [(columns)] AS [NOT] [MATERIALIZED] (body), ...`,
 * and the index of the statement keyword that follows them.
 */
function parseCtes(sig: Token[], at: number): { ctes: Cte[]; main: number } | Refusal {
  const malformed: Refusal = { problem: "syntax", message: "Malformed WITH clause" };
  const ctes: Cte[] = [];
  let index = at + 1;
  if (sig[index]?.kind === "word" && sig[index]!.value === "RECURSIVE") index += 1;
  for (;;) {
    const name = sig[index];
    if (!isName(name)) return malformed;
    index += 1;
    if (sig[index]?.kind === "lparen") {
      const close = closingParen(sig, index);
      if (close < 0) return malformed;
      index = close + 1;
    }
    if (sig[index]?.value !== "AS" || sig[index]?.kind !== "word") return malformed;
    index += 1;
    if (sig[index]?.kind === "word" && sig[index]!.value === "NOT") index += 1;
    if (sig[index]?.kind === "word" && sig[index]!.value === "MATERIALIZED") index += 1;
    if (sig[index]?.kind !== "lparen") return malformed;
    const close = closingParen(sig, index);
    if (close < 0) return malformed;
    ctes.push({ name: nameKey(name), body: sig.slice(index + 1, close) });
    index = close + 1;
    if (sig[index]?.kind === "op" && sig[index]!.text === ",") {
      index += 1;
      continue;
    }
    return { ctes, main: index };
  }
}

/**
 * Named queries may not recurse: besides the RECURSIVE keyword, refuse any
 * CTE (at any nesting level) whose body names the CTE itself or combines
 * selects, since SQLite runs `name AS (... UNION ALL ... FROM name)`
 * recursively without the keyword.
 */
function refuseRecursion(sig: Token[]): Refusal | null {
  for (let index = 0; index < sig.length; index += 1) {
    if (sig[index]!.kind !== "word" || sig[index]!.value !== "WITH") continue;
    const parsed = parseCtes(sig, index);
    if ("problem" in parsed) return parsed;
    for (const cte of parsed.ctes)
      if (
        cte.body.some(
          (token) =>
            (token.kind === "word" && COMPOUND.has(token.value)) ||
            (isName(token) && nameKey(token) === cte.name),
        )
      )
        return {
          problem: "recursive",
          message:
            "Named queries cannot recurse: a WITH table may not refer to itself or use UNION, INTERSECT or EXCEPT",
        };
  }
  return null;
}

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
      // Skip the `name AS (...)` definitions, then classify the statement itself.
      const parsed = parseCtes(sig, at);
      if ("problem" in parsed) return parsed;
      const main = sig[parsed.main];
      if (main?.kind === "word") {
        if (main.value === "SELECT" || main.value === "VALUES") return { kind: "read" };
        if (DML.has(main.value)) return { kind: "write" };
      }
      return {
        problem: "syntax",
        message: "A WITH clause must end in SELECT, VALUES, INSERT, REPLACE, UPDATE or DELETE",
      };
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
 * control, PRAGMA writes, `pragma_*` functions outside the schema readers,
 * load_extension, reserved table names, positional or `@`/`$`/`#`
 * parameters and, per profile, more than one statement, schema changes and
 * recursive CTEs. Parameters are `:name` only and are rewritten to `?` with
 * their bind order, so values are always bound, never spliced.
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
  let statements: Token[][];
  try {
    statements = splitStatements(tokenize(sql));
  } catch (error) {
    return refuse("syntax", error instanceof Error ? error.message : "Invalid SQL");
  }
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
      if (token.kind === "string") {
        // SQLite can read any string literal as a table name.
        const value = token.value.toLowerCase();
        if (SITE_SQL_RESERVED_PREFIXES.some((prefix) => value.startsWith(prefix)))
          return refuse(
            "reserved_name",
            `Names starting with ${SITE_SQL_RESERVED_PREFIXES.join(" or ")} are reserved (pass such a value as a parameter)`,
          );
        continue;
      }
      if (token.kind !== "word" && token.kind !== "quoted") continue;
      const name = (token.kind === "word" ? token.text : token.value).toLowerCase();
      if (name === "load_extension")
        return refuse("load_extension", "load_extension is not allowed");
      if (SITE_SQL_RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix)))
        return refuse(
          "reserved_name",
          `Names starting with ${SITE_SQL_RESERVED_PREFIXES.join(" or ")} are reserved`,
        );
      // Table-valued PRAGMA functions: only the schema readers.
      if (name.startsWith("pragma_") && !SITE_SQL_READ_PRAGMAS.includes(name.slice(7)))
        return refuse(
          "pragma",
          `Only these pragma_ functions are allowed: ${SITE_SQL_READ_PRAGMAS.map((pragma) => `pragma_${pragma}`).join(", ")}`,
        );
    }
    const classified = classify(sig, rules);
    if ("problem" in classified) return refuse(classified.problem, classified.message);
    if (!rules.kinds.includes(classified.kind)) {
      if (profile === "agent" && classified.kind === "schema")
        return refuse(
          "statement_not_allowed",
          "Change the schema with a migration (site_sql_migrate) so the database can be rebuilt",
        );
      return refuse(
        "statement_not_allowed",
        `A ${profile === "named" ? "named query" : "statement"} cannot be a ${KIND_LABEL[classified.kind]}`,
      );
    }
    if (!rules.recursive) {
      if (sig.some((token) => token.kind === "word" && token.value === "RECURSIVE"))
        return refuse(
          "recursive",
          "Recursive queries are not allowed in named queries (quote an identifier named recursive)",
        );
      const recursion = refuseRecursion(sig);
      if (recursion) return refuse(recursion.problem, recursion.message);
    }
    const params: string[] = [];
    let text = "";
    for (const token of statement) {
      if (token.kind !== "param") {
        text += token.text;
        continue;
      }
      if (token.text[0] !== ":")
        return refuse(
          "parameter_style",
          "Use named parameters like :name (not ?, @name, $name or #name)",
        );
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
   * `checksum` is the lowercase hex SHA-256 of `sql` (UTF-8); the Durable
   * Object recomputes it and refuses a mismatch.
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
  | "not_found"
  /** SQLite or Durable Object failures that are not the caller's (busy, I/O, corruption); 500. */
  | "internal";

export type SiteDbErrorBody = { error: { code: SiteDbErrorCode; message: string } };

/** Encode a SQLite blob for JSON. */
export function siteSqlBlobValue(bytes: Uint8Array): { $base64: string } {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return { $base64: btoa(binary) };
}
