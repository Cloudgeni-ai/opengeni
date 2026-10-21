/** Deterministic migration-time SQL heuristics, not a PostgreSQL cost estimator. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MIN_CONTRACT_STEP_CHARS,
  MIN_JUSTIFICATION_WORDS,
  headerValue,
  leadingCommentBlock,
  migrationOrdinal,
  placeholderReason,
} from "./migration-deployment-mode";
import { splitStatements, stripComments, stripRoutineBodies } from "./migration-rls-backfills";

export { MIGRATIONS_DIR } from "./migration-rls-backfills";

// 0887 was the last existing migration when this guard was introduced. Its
// predecessors are hash-frozen history, including real online-safety violations.
// Never raise this boundary to admit a new unsafe migration.
export const ONLINE_SAFETY_FROM_ORDINAL = 888;
export const EXCEPTION_KEY = "online-safety-exception";

export const RULES = {
  "nonconcurrent-index":
    "Build the index in a separate rolling file with CREATE INDEX CONCURRENTLY and the line-2 -- opengeni:concurrent-index directive.",
  "constraint-validation":
    "Add FOREIGN KEY/CHECK constraints NOT VALID, then VALIDATE CONSTRAINT in a separate migration.",
  "table-rewrite":
    "Use expand/dual-write/batched-backfill/contract across releases; for UNIQUE, attach an earlier concurrent unique index with USING INDEX. For SET NOT NULL or PRIMARY KEY, establish NOT NULL without a scan in an earlier migration and explain that proof in an exception.",
  "unbatched-data":
    "Move large-table data work to a rolling (or post-release) -- opengeni:batched-backfill migration. A literal equality on every column of a known unique key is accepted for single-row config changes.",
  "unannotated-contract":
    "Add -- contract-step: naming the earlier release that stopped using the removed/renamed shape (or why the previous release is unaffected), after deploying the compatible code.",
  "explicit-lock":
    "Remove LOCK TABLE; use short online DDL or a narrowly justified maintenance step instead.",
  "maintenance-concurrent-index":
    "Move concurrent index construction to a separate rolling migration before parking or after release; keep the maintenance window short.",
  "maintenance-batched-backfill":
    "Move the batched backfill to a rolling or post-release migration, outside the parked maintenance window.",
  "maintenance-unbatched-data":
    "Split large-table UPDATE/DELETE/INSERT SELECT into a rolling or post-release batched backfill; keep only the short cutover in maintenance.",
} as const;
export type OnlineSafetyRule = keyof typeof RULES;
export type OnlineSafetyFinding = {
  file: string;
  statement: number;
  rule: OnlineSafetyRule;
  detail: string;
};

type Token = { value: string; kind: "word" | "identifier" | "literal" | "symbol" };
type Relation = { name: string; end: number; qualified: boolean };
type Schema = {
  keys: Map<string, string[][]>;
  indexes: Map<string, { table: string; columns: string[]; concurrent: boolean }>;
};
const schemaState = (): Schema => ({ keys: new Map(), indexes: new Map() });
const word = (t: Token | undefined, value: string): boolean =>
  t?.kind === "word" && t.value.toUpperCase() === value;
const isName = (t: Token | undefined): t is Token => t?.kind === "word" || t?.kind === "identifier";
const name = (t: Token): string => (t.kind === "word" ? t.value.toLowerCase() : t.value);
const at = (ts: Token[], i: number, ...words: string[]): boolean =>
  words.every((w, j) => word(ts[i + j], w));

/** Shield quoted identifiers/literals before reusing the shared comment stripper.
 * Nested comments are flattened first; comment markers inside quotes stay data.
 * Keep dollar bodies intact for the shared statement splitter and routine stripper.
 */
function withoutComments(sql: string): string {
  const pieces: string[] = [];
  let out = "";
  for (let i = 0; i < sql.length;) {
    const rest = sql.slice(i);
    const tag = /^\$\w*\$/.exec(rest)?.[0];
    if (tag) {
      const end = sql.indexOf(tag, i + tag.length);
      if (end >= 0) {
        if (/(?:^|;)\s*DO\s+(?:LANGUAGE\s+\w+\s+)?$/i.test(out)) {
          out += `__online_safety_quote_${pieces.length}__`;
          pieces.push(tag + withoutComments(sql.slice(i + tag.length, end)) + tag);
        } else {
          out += `__online_safety_quote_${pieces.length}__`;
          pieces.push(sql.slice(i, end + tag.length));
        }
        i = end + tag.length;
        continue;
      }
    }
    const quoted = /^(?:[eE]'(?:\\.|''|[^'])*'|'(?:''|[^'])*'|"(?:""|[^"])*")/.exec(rest)?.[0];
    if (quoted) {
      const marker = `__online_safety_quote_${pieces.length}__`;
      pieces.push(quoted);
      out += marker;
      i += quoted.length;
    } else if (rest.startsWith("--")) {
      const end = sql.indexOf("\n", i);
      out += "\n";
      i = end < 0 ? sql.length : end + 1;
    } else if (rest.startsWith("/*")) {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (sql.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else {
          if (sql[i] === "\n") out += "\n";
          i++;
        }
      }
      out += " ";
    } else {
      out += sql[i++];
    }
  }
  return stripComments(out).replace(
    /__online_safety_quote_(\d+)__/g,
    (_, index) => pieces[Number(index)]!,
  );
}

function tokens(statement: string): Token[] {
  // A quoted function definition is not executed by the migration.
  if (/^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\b/i.test(statement)) return [];
  let text = stripRoutineBodies(statement);
  const block =
    /^\s*DO\s+(?:LANGUAGE\s+\w+\s+)?(\$\w*\$)([\s\S]*)\1\s*(?:LANGUAGE\s+\w+\s*)?;?\s*$/i.exec(
      text,
    );
  if (block) text = block[2]!;
  const result: Token[] = [];
  const lex =
    /[eE]'(?:\\.|''|[^'])*'|'(?:''|[^'])*'|"(?:""|[^"])*"|\$\w*\$|[A-Za-z_][A-Za-z0-9_$]*|\d+(?:\.\d+)?|\S/g;
  for (const match of text.matchAll(lex)) {
    const value = match[0];
    if (/^\$\w*\$$/.test(value)) {
      // Nested dollar strings (e.g. dynamic EXECUTE) are data, not static SQL.
      const end = text.indexOf(value, match.index! + value.length);
      if (end >= 0) {
        // matchAll clones the regexp, so consume dollar strings before lexing.
        return tokens(text.slice(0, match.index) + " '' " + text.slice(end + value.length));
      }
    }
    result.push(
      value.startsWith('"')
        ? { kind: "identifier", value: value.slice(1, -1).replaceAll('""', '"') }
        : /^([eE])?'/.test(value) || /^\d/.test(value)
          ? { kind: "literal", value }
          : /^[A-Za-z_]/.test(value)
            ? { kind: "word", value }
            : { kind: "symbol", value },
    );
  }
  return result;
}

function relation(ts: Token[], start: number): Relation | null {
  let i = start;
  if (at(ts, i, "IF", "NOT", "EXISTS")) i += 3;
  else if (at(ts, i, "IF", "EXISTS")) i += 2;
  if (word(ts[i], "ONLY")) i++;
  if (!isName(ts[i])) return null;
  const parts = [name(ts[i++]!)];
  while (ts[i]?.value === "." && isName(ts[i + 1])) {
    parts.push(name(ts[i + 1]!));
    i += 2;
  }
  const qualified = parts.length > 1;
  if (!qualified) parts.unshift("public");
  return { name: JSON.stringify(parts), end: i, qualified };
}

function indexName(index: Relation, table: string): string {
  if (index.qualified) return index.name;
  return JSON.stringify([
    (JSON.parse(table) as string[])[0],
    (JSON.parse(index.name) as string[])[1],
  ]);
}

/** Split ALTER actions / table columns at commas, never inside CHECK/default expressions. */
function clauses(ts: Token[]): Token[][] {
  const out: Token[][] = [[]];
  let depth = 0;
  for (const t of ts) {
    if (t.value === "(") depth++;
    if (t.value === ")") depth--;
    if (t.value === "," && depth === 0) out.push([]);
    else out[out.length - 1]!.push(t);
  }
  return out;
}
function has(ts: Token[], ...words: string[]): boolean {
  return ts.some((_, i) => at(ts, i, ...words));
}

/** Command positions, not words in FK actions, privileges, triggers or columns.
 * DML can also start a CTE body, or follow the last CTE's closing parenthesis.
 */
function commandStart(ts: Token[], i: number, procedural: boolean): boolean {
  if (i === 0) return true;
  const previous = ts[i - 1];
  if (previous?.value === ";") return true;
  if (procedural && ["BEGIN", "THEN", "ELSE", "LOOP"].some((w) => word(previous, w))) return true;
  if (!["UPDATE", "DELETE", "INSERT"].some((w) => word(ts[i], w))) return false;
  if (previous?.value === "(" && (word(ts[i - 2], "AS") || word(ts[i - 2], "MATERIALIZED")))
    return true;
  if (previous?.value !== ")") return false;
  let start = i - 1;
  while (start > 0 && ts[start - 1]?.value !== ";") start--;
  return has(ts.slice(start, i), "WITH");
}

function topLevel(ts: Token[]): Token[] {
  let depth = 0;
  return ts.filter((t) => {
    if (t.value === "(") {
      depth++;
      return false;
    }
    if (t.value === ")") {
      depth--;
      return false;
    }
    return depth === 0;
  });
}
function cteNames(ts: Token[]): Set<string> {
  const names = new Set<string>();
  if (!word(ts[0], "WITH")) return names;
  let i = word(ts[1], "RECURSIVE") ? 2 : 1;
  while (i < ts.length) {
    const cte = relation(ts, i);
    if (!cte) break;
    i = cte.end;
    if (ts[i]?.value === "(") {
      while (i < ts.length && ts[i]?.value !== ")") i++;
      i++;
    }
    if (!word(ts[i++], "AS")) break;
    if (word(ts[i], "NOT")) i++;
    if (word(ts[i], "MATERIALIZED")) i++;
    if (ts[i++]?.value !== "(") break;
    names.add(cte.name);
    let depth = 1;
    while (i < ts.length && depth) {
      if (ts[i]?.value === "(") depth++;
      if (ts[i]?.value === ")") depth--;
      i++;
    }
    if (ts[i++]?.value !== ",") break;
  }
  return names;
}
function columns(ts: Token[], start: number): string[] {
  if (ts[start]?.value !== "(") return [];
  const end = ts.findIndex((t, i) => i > start && t.value === ")");
  if (end < 0) return [];
  const parts = clauses(ts.slice(start + 1, end));
  return parts.every((p) => p.length === 1 && isName(p[0])) ? parts.map((p) => name(p[0]!)) : [];
}

/** Only simple literal equalities on a known unique key prove a bounded write.
 * OR, subqueries, USING/FROM joins, range predicates and arbitrary LIMITs do not.
 */
function bounded(ts: Token[], table: string, schema: Schema): boolean {
  const where = ts.findIndex((t) => word(t, "WHERE"));
  if (where < 0 || has(ts, "OR") || has(ts, "SELECT") || has(ts, "FROM") || has(ts, "USING"))
    return false;
  const stop = ts.findIndex((t, i) => i > where && (word(t, "RETURNING") || t.value === ";"));
  const predicate = ts
    .slice(where + 1, stop < 0 ? undefined : stop)
    .filter((t) => t.value !== "(" && t.value !== ")");
  const tableName = (JSON.parse(table) as string[]).at(-1)!;
  const alias = word(ts[0], "AS")
    ? ts[1]
    : !word(ts[0], "SET") && !word(ts[0], "WHERE")
      ? ts[0]
      : undefined;
  const equality = new Set<string>();
  for (let i = 0; i < predicate.length;) {
    let column = predicate[i++];
    if (!isName(column)) return false;
    if (predicate[i]?.value === ".") {
      if (name(column) !== tableName && (!isName(alias) || name(column) !== name(alias)))
        return false;
      column = predicate[++i];
      i++;
    }
    if (!isName(column) || predicate[i++]?.value !== "=") return false;
    const literal = predicate[i++];
    if (literal?.kind !== "literal" && !word(literal, "TRUE") && !word(literal, "FALSE"))
      return false;
    if (predicate[i]?.value === ":" && predicate[i + 1]?.value === ":") {
      const cast = relation(predicate, i + 2);
      if (!cast) return false;
      i = cast.end;
    }
    equality.add(name(column));
    if (i < predicate.length && !word(predicate[i++], "AND")) return false;
  }
  return (schema.keys.get(table) ?? []).some(
    (key) => key.length > 0 && key.every((col) => equality.has(col)),
  );
}

function exceptions(sql: string): Set<string> {
  const accepted = new Set<string>();
  for (const line of leadingCommentBlock(sql)) {
    const match = /^--\s*online-safety-exception\s*:\s*([\w-]+)\s*:\s*(.*)$/i.exec(line);
    if (!match) continue;
    const reason = match[2]!.trim().replace(/\s+/g, " ");
    if (
      !placeholderReason(reason) &&
      reason.split(" ").filter((w) => /[a-z0-9]/i.test(w)).length >= MIN_JUSTIFICATION_WORDS
    )
      accepted.add(match[1]!.toLowerCase());
  }
  return accepted;
}

function batched(sql: string, statements: string[]): boolean {
  const line = sql.replaceAll("\r\n", "\n").split("\n")[1]?.trim() ?? "";
  const match =
    /^-- opengeni:batched-backfill batch-size=(\d+) lock-timeout=\d+(?:ms|s|min) statement-timeout=\d+(?:ms|s|min)$/.exec(
      line,
    );
  if (!match || statements.length !== 1 || Number(match[1]) < 1 || Number(match[1]) > 10000)
    return false;
  const ts = tokens(statements[0]!);
  return (
    word(ts[0], "WITH") &&
    has(ts, "UPDATE") &&
    has(ts, "RETURNING") &&
    ts.some((t, i) => word(t, "LIMIT") && ts[i + 1]?.value === match[1])
  );
}

function analyze(
  file: string,
  sql: string,
  schema: Schema,
  governedFrom: number,
): OnlineSafetyFinding[] {
  const ordinal = migrationOrdinal(file);
  if (ordinal === null) return [];
  const normalized = sql.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
  const maintenance =
    headerValue(normalized, "deployment-mode")?.first.toLowerCase() === "maintenance";
  const contract = headerValue(normalized, "contract-step");
  const contracted =
    contract !== null &&
    !placeholderReason(contract.full) &&
    contract.full.length >= MIN_CONTRACT_STEP_CHARS;
  const suppressed = exceptions(normalized);
  const statements = splitStatements(withoutComments(normalized));
  const batch = batched(normalized, statements);
  const created = new Set<string>();
  const temporaryAliases = new Set<string>();
  const alteredHere = new Set<string>();
  const priorIndexes = new Map(schema.indexes);
  const findings: OnlineSafetyFinding[] = [];
  const add = (rule: OnlineSafetyRule, statement: number, operation: string) => {
    if (
      ordinal < governedFrom ||
      suppressed.has(rule) ||
      findings.some((f) => f.statement === statement && f.rule === rule)
    )
      return;
    findings.push({
      file,
      statement,
      rule,
      detail: `${operation}. ${RULES[rule]} Or add a header: -- ${EXCEPTION_KEY}: ${rule}: <specific reason of at least six words, not a placeholder>. See docs/migrations-expand-contract.md.`,
    });
  };
  if (
    maintenance &&
    /^--\s*opengeni:batched-backfill\b/i.test(leadingCommentBlock(normalized)[1] ?? "")
  )
    add("maintenance-batched-backfill", 1, "Batched backfill while parked");
  const existing = (table: Relation) =>
    !created.has(table.name) && (table.qualified || !temporaryAliases.has(table.name));
  const dataRule = maintenance ? "maintenance-unbatched-data" : "unbatched-data";
  for (const [statementIndex, statement] of statements.entries()) {
    const number = statementIndex + 1;
    const ts = tokens(statement);
    const procedural = /^\s*DO\b/i.test(statement);
    for (let i = 0; i < ts.length; i++) {
      if (!commandStart(ts, i, procedural)) continue;
      if (at(ts, i, "CREATE")) {
        let j = i + 1;
        if (word(ts[j], "GLOBAL") || word(ts[j], "LOCAL")) j++;
        const temporary = word(ts[j], "TEMP") || word(ts[j], "TEMPORARY");
        if (word(ts[j], "TEMP") || word(ts[j], "TEMPORARY") || word(ts[j], "UNLOGGED")) j++;
        if (word(ts[j], "TABLE")) {
          const table = relation(ts, j + 1);
          if (table && !procedural && (temporary || !at(ts, j + 1, "IF", "NOT", "EXISTS"))) {
            if (temporary) {
              temporaryAliases.add(table.name);
              created.add(JSON.stringify(["pg_temp", (JSON.parse(table.name) as string[])[1]]));
            } else created.add(table.name);
            const keys: string[][] = [];
            let end = table.end + 1;
            let depth = 1;
            while (end < ts.length && depth > 0) {
              if (ts[end]?.value === "(") depth++;
              if (ts[end]?.value === ")") depth--;
              end++;
            }
            for (const c of clauses(ts.slice(table.end + 1, end - 1))) {
              const primary = c.findIndex((t, k) => word(t, "PRIMARY") && word(c[k + 1], "KEY"));
              const unique = c.findIndex((t) => word(t, "UNIQUE"));
              const pos = primary >= 0 ? primary + 2 : unique >= 0 ? unique + 1 : -1;
              if (pos < 0) continue;
              const key = columns(c, pos);
              if (key.length) keys.push(key);
              else if (isName(c[0]) && !word(c[0], "CONSTRAINT")) keys.push([name(c[0])]);
            }
            if (!temporary) schema.keys.set(table.name, keys);
          }
        }
        const unique = word(ts[j], "UNIQUE");
        if (unique) j++;
        if (word(ts[j], "INDEX")) {
          j++;
          const concurrent = word(ts[j], "CONCURRENTLY");
          if (concurrent) j++;
          const index = word(ts[j], "ON") ? null : relation(ts, j);
          const on = index?.end ?? j;
          if (!word(ts[on], "ON")) continue;
          const table = relation(ts, on + 1);
          if (!table) continue;
          if (maintenance && concurrent)
            add("maintenance-concurrent-index", number, "Concurrent index build while parked");
          if (!maintenance && !concurrent && existing(table))
            add("nonconcurrent-index", number, "Non-concurrent index on an existing table");
          if (unique && index && !procedural) {
            const start = word(ts[table.end], "USING") ? table.end + 2 : table.end;
            const key = columns(ts, start);
            schema.indexes.set(indexName(index, table.name), {
              table: table.name,
              columns: key,
              concurrent: concurrent && !has(ts.slice(start), "WHERE") && key.length > 0,
            });
            if (key.length && !has(ts.slice(start), "WHERE"))
              schema.keys.set(table.name, [...(schema.keys.get(table.name) ?? []), key]);
          }
        }
      }
      if (at(ts, i, "ALTER", "TABLE")) {
        const table = relation(ts, i + 2);
        if (!table) continue;
        const end = ts.findIndex((t, k) => k >= table.end && t.value === ";");
        const actions = clauses(ts.slice(table.end, end < 0 ? undefined : end));
        // A multi-action ALTER acquires its strongest lock before any action.
        // Ordinary files are one transaction: prior ALTER locks also survive.
        if (actions.some((c) => !at(c, 0, "VALIDATE", "CONSTRAINT"))) alteredHere.add(table.name);
        for (const c of actions) {
          const surface = topLevel(c);
          if (existing(table) && !maintenance) {
            if (at(c, 0, "VALIDATE", "CONSTRAINT") && alteredHere.has(table.name))
              add(
                "constraint-validation",
                number,
                "VALIDATE retains an earlier ALTER lock until this file commits; use a separate migration",
              );
            if (word(c[0], "ADD")) {
              if (
                (has(c, "FOREIGN", "KEY") || has(c, "REFERENCES") || has(c, "CHECK")) &&
                !has(surface, "NOT", "VALID")
              )
                add("constraint-validation", number, "Validating constraint on an existing table");
              if (has(c, "PRIMARY", "KEY") || has(c, "UNIQUE")) {
                const using = c.findIndex((_, k) => at(c, k, "USING", "INDEX"));
                const index = using >= 0 ? relation(c, using + 2) : null;
                const prior = index && priorIndexes.get(indexName(index, table.name));
                if (
                  has(c, "PRIMARY", "KEY") ||
                  !prior ||
                  !prior.concurrent ||
                  prior.table !== table.name
                )
                  add(
                    "table-rewrite",
                    number,
                    "PRIMARY KEY (may scan for NOT NULL) or UNIQUE without an earlier concurrent unique index",
                  );
              }
              const defaultAt = c.findIndex((t) => word(t, "DEFAULT"));
              if (
                defaultAt >= 0 &&
                c
                  .slice(defaultAt + 1)
                  .some(
                    (t, k, tail) =>
                      isName(t) &&
                      /^(?:now|random|gen_random_uuid|uuid_generate_v(?:\d|1mc)|uuidv[47]|nextval|setval|clock_timestamp|timeofday)$/i.test(
                        name(t),
                      ) &&
                      tail[k + 1]?.value === "(",
                  )
              )
                add("table-rewrite", number, "ADD COLUMN with a per-row or policy-listed default");
              if (has(c, "GENERATED", "ALWAYS", "AS") && has(c, "STORED"))
                add("table-rewrite", number, "Stored generated column rewrites existing rows");
              let column = word(c[1], "COLUMN") ? 2 : 1;
              if (at(c, column, "IF", "NOT", "EXISTS")) column += 3;
              const columnDefinition = ![
                "CONSTRAINT",
                "CHECK",
                "FOREIGN",
                "PRIMARY",
                "UNIQUE",
                "EXCLUDE",
              ].some((w) => word(c[1], w));
              const type = columnDefinition ? relation(c, column + 1) : null;
              const typeName = type && (JSON.parse(type.name) as string[]).at(-1);
              if (
                (typeName && /^(?:smallserial|serial|bigserial|serial[248])$/.test(typeName)) ||
                has(surface, "AS", "IDENTITY")
              )
                add(
                  "table-rewrite",
                  number,
                  "Serial/identity columns fill every existing row from a sequence",
                );
            }
            const alteration = word(c[1], "COLUMN") ? 3 : 2;
            if (
              word(c[0], "ALTER") &&
              (at(c, alteration, "SET", "NOT", "NULL") ||
                at(c, alteration, "TYPE") ||
                at(c, alteration, "SET", "DATA", "TYPE"))
            )
              add("table-rewrite", number, "ALTER COLUMN TYPE/SET DATA TYPE/SET NOT NULL");
            if (at(c, 0, "SET", "TABLESPACE") || at(c, 0, "SET", "ACCESS", "METHOD"))
              add("table-rewrite", number, "ALTER TABLE SET TABLESPACE/ACCESS METHOD");
            if (at(c, 0, "SET", "LOGGED") || at(c, 0, "SET", "UNLOGGED"))
              add("table-rewrite", number, "Changing table logging rewrites existing rows");
            if (
              !contracted &&
              ((word(c[0], "DROP") && !word(c[1], "CONSTRAINT")) ||
                (word(c[0], "RENAME") && !word(c[1], "CONSTRAINT")))
            )
              add("unannotated-contract", number, "DROP/RENAME on an existing table");
          }
          // Losing a key invalidates any later bounded-write proof. Conservative
          // invalidation is preferable to guessing which constraint survived.
          if (word(c[0], "DROP") || word(c[0], "RENAME")) schema.keys.delete(table.name);
        }
      }
      if (at(ts, i, "DROP", "INDEX")) {
        const index = relation(ts, word(ts[i + 2], "CONCURRENTLY") ? i + 3 : i + 2);
        if (index) {
          schema.keys.delete(schema.indexes.get(index.name)?.table ?? "");
          schema.indexes.delete(index.name);
          priorIndexes.delete(index.name);
        }
      }
      if (at(ts, i, "DROP", "TABLE") || word(ts[i], "TRUNCATE")) {
        let j = word(ts[i], "DROP") || word(ts[i + 1], "TABLE") ? i + 2 : i + 1;
        do {
          const table = relation(ts, j);
          if (!table) break;
          if (!maintenance && existing(table) && !contracted)
            add("unannotated-contract", number, "DROP TABLE/TRUNCATE on an existing table");
          if (word(ts[i], "DROP")) {
            created.delete(table.name);
            if (!table.qualified) temporaryAliases.delete(table.name);
            schema.keys.delete(table.name);
            for (const [key, index] of schema.indexes)
              if (index.table === table.name) {
                schema.indexes.delete(key);
                priorIndexes.delete(key);
              }
          }
          j = table.end + 1;
        } while (ts[j - 1]?.value === ",");
      }
      if (!maintenance && word(ts[i], "LOCK")) add("explicit-lock", number, "Explicit table lock");
      if (!maintenance && (word(ts[i], "CLUSTER") || word(ts[i], "VACUUM"))) {
        if (word(ts[i], "CLUSTER") && word(ts[i + 1], "ON")) continue;
        const full = word(ts[i], "CLUSTER") || has(ts.slice(i), "FULL");
        let j = i + 1;
        if (ts[j]?.value === "(") {
          while (j < ts.length && ts[j]?.value !== ")") j++;
          j++;
        } else {
          while (["FULL", "VERBOSE", "ANALYZE", "FREEZE"].some((w) => word(ts[j], w))) j++;
        }
        const table = relation(ts, j);
        if (full && (!table || existing(table)))
          add("table-rewrite", number, "CLUSTER/VACUUM FULL rewrites tables");
      }
      const update = word(ts[i], "UPDATE") && !word(ts[i + 1], "SET");
      const deletion = at(ts, i, "DELETE", "FROM");
      if (update || deletion) {
        const table = relation(ts, i + (deletion ? 2 : 1));
        if (!table || word(ts[i - 1], "FOR")) continue;
        const end = ts.findIndex((t, k) => k >= table.end && t.value === ";");
        const tail = ts.slice(table.end, end < 0 ? undefined : end);
        if (update && !has(tail, "SET")) continue;
        if (existing(table) && !batch && !bounded(tail, table.name, schema))
          add(dataRule, number, "Unbounded UPDATE/DELETE on an existing table");
      }
      if (at(ts, i, "INSERT", "INTO")) {
        const end = ts.findIndex((t, k) => k > i && t.value === ";");
        const tail = ts.slice(i + 2, end < 0 ? undefined : end);
        if (!has(tail, "SELECT")) continue;
        const query = word(ts[0], "WITH") ? ts : tail;
        const ctes = cteNames(ts);
        for (let j = 0; j < query.length; j++) {
          if (!word(query[j], "FROM") && !word(query[j], "JOIN")) continue;
          const source = relation(query, j + 1);
          if (
            !source ||
            !existing(source) ||
            ctes.has(source.name) ||
            query[source.end]?.value === "("
          )
            continue;
          const parts = JSON.parse(source.name) as string[];
          if (parts[0] === "pg_catalog" || parts[0] === "information_schema") continue;
          if (!bounded(query.slice(source.end), source.name, schema))
            add(dataRule, number, "INSERT SELECT reads a potentially large existing table");
        }
      }
    }
  }
  return findings;
}

export function analyzeMigrationOnlineSafety(
  file: string,
  sql: string,
  governedFrom = ONLINE_SAFETY_FROM_ORDINAL,
): OnlineSafetyFinding[] {
  return analyze(file, sql, schemaState(), governedFrom);
}

/** Replay schema metadata from frozen history, but emit findings only in range. */
export function analyzeMigrationOnlineSafetyDirectory(
  directory: string,
  governedFrom = ONLINE_SAFETY_FROM_ORDINAL,
): OnlineSafetyFinding[] {
  const schema = schemaState();
  return readdirSync(directory)
    .filter((file) => migrationOrdinal(file) !== null)
    .sort()
    .flatMap((file) =>
      analyze(file, readFileSync(join(directory, file), "utf8"), schema, governedFrom),
    );
}
