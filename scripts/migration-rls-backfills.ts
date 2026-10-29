/**
 * Static analysis for migration-time backfills that silently no-op
 * under Opengeni's production migration principal.
 *
 * `FORCE ROW LEVEL SECURITY` binds the TABLE OWNER, not merely ordinary roles;
 * only a genuine `SUPERUSER` (or `BYPASSRLS`) escapes it. Opengeni's documented
 * deployment posture (`docs/deployment.md`) runs migrations as a NON-superuser
 * owner without `BYPASSRLS`. During a migration no `opengeni.account_id` /
 * `opengeni.workspace_id` GUC is set, so a GUC-gated `workspace_isolation`
 * policy evaluates false for every row and a top-level `UPDATE` / `DELETE` /
 * `INSERT ... SELECT` / `DO $$ ... $$` backfill loop touches ZERO rows and
 * reports success.
 *
 * One mitigation is the owner-only posture window:
 *
 *   ALTER TABLE "t" NO FORCE ROW LEVEL SECURITY;
 *   -- ... the backfill ...
 *   ALTER TABLE "t" FORCE ROW LEVEL SECURITY;
 *
 * `NO FORCE` relaxes only the owner; the application role stays policy-bound,
 * and the migration runner executes each file in one implicit transaction so a
 * failure rolls back the posture change with the data repair.
 *
 * Alternatives this analyzer also accepts: setting the tenant GUC around the
 * statement, disabling RLS on the table for the window, or activating a policy
 * that is pinned to the exact table owner and a transaction-local capability.
 * The latter may be set inside the statement or by the exact governed batched-
 * migration runner contract before the statement executes.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { splitStatements, stripComments } from "../packages/db/src/migration-sql";
export { splitStatements, stripComments } from "../packages/db/src/migration-sql";

export const MIGRATIONS_DIR = "packages/db/drizzle";

// Each complete statement here (including comments) only reads catalog source
// and replaces a routine definition. The writes it names run in that routine,
// not during migration. Bind this classification to reviewed bytes: changed
// statements keep conservative analysis. DO NOT add a statement that runs a
// migration-time backfill.
const REVIEWED_ROUTINE_SOURCE_PATCH_SHA256 = new Set([
  // 0995 statement 3: patch organization_membership_command_0263's role change.
  "1b890ad9397f53351e98d62dc8e9973732a3a28596c7fd6ff627632705ee6cf8",
  // 1032 statement 17: patch knowledge_entry_read to use kept collection activity.
  "1a71acab125baec541ce1c3dd514cda222d8c761b90adec97b0797e582ebea01",
]);

export type BackfillFinding = {
  /** Migration file name, e.g. `0296_...sql`. */
  file: string;
  /** 1-based index of the offending top-level statement within the file. */
  statement: number;
  /**
   * `write` - a backfill that matches zero rows and reports success.
   * `vacuous-guard` - a `RAISE EXCEPTION` preflight that can never fire.
   */
  kind: "write" | "vacuous-guard";
  /** FORCE-RLS tables the statement touches. */
  tables: string[];
  /** Leading text of the statement, whitespace-collapsed. */
  snippet: string;
};

/** Literal-unaware stripping: removes every `--`/`/* *\/` run, even in
 * literals. Suppressing tokens must survive this too, so comment text can
 * never suppress a finding. */
const stripAllCommentText = (text: string) =>
  text.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");

const TABLE_REF = (table: string) => `(?:"${table}"|${table})`;
const NOT_IDENT = String.raw`(?![A-Za-z0-9_"])`;

/** Does `statement` write rows of `table` at the top level? */
export function writesTable(statement: string, table: string): boolean {
  const ref = TABLE_REF(table);
  return (
    new RegExp(String.raw`\b(?:UPDATE|MERGE\s+INTO)\s+(?:ONLY\s+)?${ref}${NOT_IDENT}`, "i").test(
      statement,
    ) ||
    new RegExp(String.raw`\bINSERT\s+INTO\s+${ref}${NOT_IDENT}`, "i").test(statement) ||
    new RegExp(String.raw`\bDELETE\s+FROM\s+(?:ONLY\s+)?${ref}${NOT_IDENT}`, "i").test(statement)
  );
}

/** Does `statement` read rows of `table`? */
export function readsTable(statement: string, table: string): boolean {
  const ref = TABLE_REF(table);
  return new RegExp(String.raw`\b(?:FROM|JOIN|USING)\s+(?:ONLY\s+)?${ref}${NOT_IDENT}`, "i").test(
    statement,
  );
}

const ROUTINE_START = /\bCREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|PROCEDURE)\b/gi;
const ROUTINE_AS_DOLLAR = /\bAS\s+(\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$)/i;

/**
 * Drop CREATE FUNCTION/PROCEDURE bodies so a DO block that *defines* a
 * later-running trigger/lifecycle routine is not treated as a migration-time
 * backfill. `EXECUTE format($ddl$ UPDATE ... $ddl$)` still looks like a write.
 */
export function stripRoutineBodies(statement: string): string {
  statement = stripCatalogRoutinePatchLiterals(statement);
  let out = "";
  let index = 0;
  while (index < statement.length) {
    ROUTINE_START.lastIndex = index;
    const match = ROUTINE_START.exec(statement);
    if (!match || match.index === undefined) {
      out += statement.slice(index);
      break;
    }
    out += statement.slice(index, match.index);
    const asTag = ROUTINE_AS_DOLLAR.exec(statement.slice(match.index));
    if (!asTag || asTag.index === undefined || asTag[1] === undefined) {
      out += statement.slice(match.index, match.index + match[0].length);
      index = match.index + match[0].length;
      continue;
    }
    const tag = asTag[1];
    const bodyStart = match.index + asTag.index + asTag[0].length;
    const close = statement.indexOf(tag, bodyStart);
    if (close === -1) {
      out += statement.slice(match.index);
      break;
    }
    out += `${statement.slice(match.index, bodyStart)} /* routine body omitted */ `;
    index = close + tag.length;
  }
  return out;
}

/** A quoted replacement used only to patch pg_get_functiondef is routine
 * source, not an executed migration query. Keep arbitrary EXECUTE strings and
 * every actual query outside the replacement visible to the guard. */
function stripCatalogRoutinePatchLiterals(statement: string): string {
  // Chained replacements of a pg_get_functiondef result are also routine
  // source, provided the resulting definition is the block's sole dynamic
  // execution. Keep every other statement visible to the backfill analyzer.
  // The built-ins may be schema-qualified with pg_catalog; no other schema.
  const source =
    /\b([a-z_]\w*)\s*:=\s*(?:pg_catalog\s*\.\s*)?pg_get_functiondef\s*\([\s\S]*?\)\s*;/gi;
  const sources = [...statement.matchAll(source)];
  if (sources.length === 1) {
    const variable = sources[0]![1]!;
    const execution = new RegExp(`\\bEXECUTE\\s+${variable}\\s*;`, "gi");
    const executions = [...statement.matchAll(execution)];
    const otherExecutions = [...statement.matchAll(/\bEXECUTE\b/gi)].length;
    const assignments = [...statement.matchAll(new RegExp(`\\b${variable}\\s*:=`, "gi"))];
    if (executions.length === 1 && otherExecutions === 1) {
      const replacements: Array<{ start: number; end: number }> = [];
      let cursor = sources[0]!.index! + sources[0]![0].length;
      const assignment = new RegExp(
        `\\b${variable}\\s*:=\\s*(?:pg_catalog\\s*\\.\\s*)?replace\\s*\\(\\s*${variable}\\s*,`,
        "gi",
      );
      let match: RegExpExecArray | null;
      while ((match = assignment.exec(statement))) {
        if (match.index < cursor) continue;
        let depth = 1;
        let quoted = false;
        let end = match.index + match[0].length;
        for (; end < statement.length; end += 1) {
          const char = statement[end]!;
          if (!quoted && char === "$") {
            // A dollar-quoted literal is opaque text: its parentheses, quotes
            // and semicolons are routine source, not this call's syntax.
            const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(statement.slice(end))?.[0];
            if (tag) {
              const close = statement.indexOf(tag, end + tag.length);
              if (close === -1) break;
              end = close + tag.length - 1;
              continue;
            }
          }
          if (char === "'") {
            if (quoted && statement[end + 1] === "'") {
              end += 1;
              continue;
            }
            quoted = !quoted;
          } else if (!quoted && char === "(") depth += 1;
          else if (!quoted && char === ")") depth -= 1;
          else if (!quoted && char === ";" && depth === 0) break;
        }
        if (depth !== 0 || quoted || statement[end] !== ";") break;
        replacements.push({ start: match.index, end: end + 1 });
        cursor = end + 1;
        assignment.lastIndex = cursor;
      }
      if (replacements.length > 0 && assignments.length === replacements.length + 1) {
        const ranges = [
          ...replacements,
          { start: executions[0]!.index!, end: executions[0]!.index! + executions[0]![0].length },
        ].sort((left, right) => right.start - left.start);
        let stripped = statement;
        for (const range of ranges) {
          stripped = `${stripped.slice(0, range.start)}${stripped.slice(range.end)}`;
        }
        return stripped;
      }
    }
  }

  // The literal may be assigned in the body or initialised in DECLARE
  // (`replacement text := $new$...$new$;`); both bind the same variable.
  const assignments = /\b([a-z_]\w*)(?:\s+text)?\s*:=\s*(\$[a-z_]\w*\$|\$\$)([\s\S]*?)\2\s*;/gi;
  return statement.replace(assignments, (whole, variable: string, _tag: string) => {
    const outside = statement.replace(whole, `${variable} := NULL;`);
    const use = new RegExp(
      `\\bEXECUTE\\s+replace\\(\\s*([a-z_]\\w*)\\s*,\\s*[a-z_]\\w*\\s*,\\s*${variable}\\s*\\)\\s*;`,
      "i",
    ).exec(outside);
    if (!use) return whole;
    const definition = use[1]!;
    const writes = [...outside.matchAll(new RegExp(`\\b${definition}\\s*:=\\s*([^;]+);`, "gi"))];
    if (!writes.some((match) => /^pg_get_functiondef\s*\(/i.test(match[1]!.trim()))) return whole;
    if (
      writes.some(
        (match) =>
          !new RegExp(`^(?:pg_get_functiondef\\s*\\(|replace\\(\\s*${definition}\\s*,)`, "i").test(
            match[1]!.trim(),
          ),
      )
    )
      return whole;
    // Declaration and the one assignment/use are the only permitted references
    // to the replacement variable. Additional execution or data flow is opaque.
    const remainder = outside
      .replace(use[0], "")
      .replace(new RegExp(`\\b${variable}\\s*:=\\s*NULL\\s*;`, "i"), "")
      .replace(new RegExp(`\\b${variable}\\s+text\\s*;`, "i"), "");
    if (new RegExp(`\\b${variable}\\b`, "i").test(remainder)) return whole;
    return `${variable} := NULL; /* catalog routine replacement omitted */`;
  });
}

const DDL_ONLY =
  /^CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|PROCEDURE|VIEW|MATERIALIZED|TRIGGER|INDEX|UNIQUE|POLICY|SCHEMA|TYPE|EXTENSION|SEQUENCE|ROLE|TABLE)/i;
const NON_DML =
  /^(DROP|ALTER|GRANT|REVOKE|COMMENT|SET|RESET|LOCK|ANALYZE|VACUUM|REASSIGN|SECURITY)\b/i;

type OwnerCapabilityPolicy = { guc: string; table: string };

function parenthesizedPolicyClause(statement: string, marker: RegExp): string | null {
  const match = marker.exec(statement);
  if (!match || match.index === undefined) return null;
  const open = statement.indexOf("(", match.index);
  if (open === -1) return null;

  let depth = 0;
  for (let index = open; index < statement.length; index += 1) {
    const char = statement[index]!;
    if (char === "'" || char === '"') {
      const quote = char;
      index += 1;
      while (index < statement.length) {
        if (statement[index] === quote && statement[index + 1] === quote) {
          index += 2;
          continue;
        }
        if (statement[index] === quote) break;
        index += 1;
      }
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return statement.slice(open + 1, index);
    }
  }
  return null;
}

function ownerCapabilityClauseGuc(clause: string, table: string): string | null {
  const exactOwner = new RegExp(
    String.raw`current_user\s*=\s*\(\s*SELECT\s+pg_catalog\.pg_get_userbyid\s*\(\s*[a-z0-9_]+\.relowner\s*\)\s+FROM\s+pg_catalog\.pg_class\s+[a-z0-9_]+\s+WHERE\s+[a-z0-9_]+\.oid\s*=\s*'${table}'::regclass\s*\)`,
    "gi",
  );
  const capability =
    /(?:pg_catalog\.)?current_setting\s*\(\s*'opengeni\.([a-z0-9_]+)'\s*,\s*true\s*\)\s*=\s*'1'/gi;
  const ownerMatches = clause.match(exactOwner) ?? [];
  const capabilityMatches = [...clause.matchAll(capability)];
  if (ownerMatches.length !== 1 || capabilityMatches.length !== 1) return null;

  const normalized = clause
    .replace(exactOwner, "OWNER")
    .replace(capability, "CAPABILITY")
    .replace(/[()\s]/g, "")
    .toUpperCase();
  if (normalized !== "OWNERANDCAPABILITY" && normalized !== "CAPABILITYANDOWNER") return null;
  return capabilityMatches[0]![1]!;
}

function ownerCapabilityPolicy(statement: string): OwnerCapabilityPolicy | null {
  const target =
    /^CREATE\s+POLICY\s+(?:"[^"]+"|[a-z0-9_]+)\s+ON\s+(?:(?:"[^"]+"|[a-z0-9_]+)\.)?"?([a-z0-9_]+)"?/i.exec(
      statement.trim(),
    );
  if (!target || !/\bFOR\s+ALL\b/i.test(statement)) {
    return null;
  }

  const table = target[1]!;
  const usingClause = parenthesizedPolicyClause(statement, /\bUSING\s*\(/i);
  const withCheckClause = parenthesizedPolicyClause(statement, /\bWITH\s+CHECK\s*\(/i);
  if (!usingClause || !withCheckClause) return null;

  // Each RLS arm must be exactly the owner proof AND the transaction-local
  // capability proof (in either order, with arbitrary grouping parentheses).
  // Counting tokens across the whole policy would accept owner OR capability,
  // allowing any application role to activate the custom GUC itself.
  const usingGuc = ownerCapabilityClauseGuc(usingClause, table);
  const withCheckGuc = ownerCapabilityClauseGuc(withCheckClause, table);
  if (!usingGuc || usingGuc !== withCheckGuc) return null;
  return { guc: usingGuc, table };
}

function activatedOwnerCapabilityTables(
  statement: string,
  policies: ReadonlyMap<string, OwnerCapabilityPolicy>,
): Set<string> {
  const activeGucs = new Set<string>();
  for (const match of statement.matchAll(
    /set_config\s*\(\s*'opengeni\.([a-z0-9_]+)'\s*,\s*'1'\s*,\s*true\s*\)/gi,
  )) {
    activeGucs.add(match[1]!);
  }
  return new Set(
    [...policies.values()]
      .filter((policy) => activeGucs.has(policy.guc))
      .map((policy) => policy.table),
  );
}

/** Recognize only the catalog-filtered, closed regclass window used by 0882.
 * Attribute visibility to its single backfill statement, never to subsequent
 * statements or files. Unrecognized/mutated windows retain ordinary analysis.
 */
function catalogOwnerWindows(statements: readonly string[]): Map<number, Set<string>> {
  const windows = new Map<number, Set<string>>();
  const normalized = statements.map((statement) =>
    stripComments(statement).trim().replace(/\s+/g, " "),
  );
  for (let index = 0; index + 3 < statements.length; index += 1) {
    const capture =
      /^CREATE TEMP TABLE ([a-z_][a-z0-9_]*) ON COMMIT DROP AS SELECT class\.oid::regclass AS relation FROM pg_class class WHERE class\.oid IN \(\s*((?:'[a-z_][a-z0-9_]*'::regclass\s*,\s*)*'[a-z_][a-z0-9_]*'::regclass)\s*\) AND class\.relforcerowsecurity;$/i.exec(
        normalized[index]!,
      );
    if (!capture) continue;
    const temporary = capture[1]!;
    const tables = new Set(
      [...capture[2]!.matchAll(/'([a-z_][a-z0-9_]*)'::regclass/gi)].map((match) =>
        match[1]!.toLowerCase(),
      ),
    );
    if (tables.has(temporary.toLowerCase())) continue;
    const loop = (operation: "NO FORCE" | "FORCE") =>
      new RegExp(
        String.raw`^DO (\$[a-z_][a-z0-9_]*\$) DECLARE forced regclass; BEGIN FOR forced IN SELECT relation FROM ${temporary} ORDER BY relation::text LOOP EXECUTE format\('ALTER TABLE %s ${operation} ROW LEVEL SECURITY', forced\); END LOOP; END \1;$`,
        "i",
      );
    if (
      !loop("NO FORCE").test(normalized[index + 1]!) ||
      !loop("FORCE").test(normalized[index + 3]!)
    )
      continue;
    const body = normalized[index + 2]!;
    // No intervening policy/DDL changes, temp-snapshot edits, or executable DO
    // blocks can inherit the exemption. Matching both comment views prevents
    // quoted/comment text from manufacturing a recognized posture window.
    if (
      !/^(WITH|INSERT|UPDATE|DELETE)\b/i.test(body) ||
      /\b(CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|CALL)\b/i.test(body) ||
      /\bDO\b(?!\s+(UPDATE|NOTHING)\b)/i.test(body) ||
      writesTable(body, temporary)
    )
      continue;
    if (
      statements
        .slice(index, index + 4)
        .some(
          (statement, offset) =>
            stripAllCommentText(statement).trim().replace(/\s+/g, " ") !==
            normalized[index + offset],
        )
    )
      continue;
    windows.set(index + 2, tables);
  }
  return windows;
}

/**
 * Walk the whole ordered migration ledger, tracking which tables have RLS
 * enabled + forced at each point, and report top-level writes that would match
 * zero rows for a non-superuser owner.
 */
export function analyzeMigrationRlsBackfills(migrationsDir: string): BackfillFinding[] {
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  const forced = new Set<string>();
  const enabled = new Set<string>();
  const ownerCapabilityPolicies = new Map<string, OwnerCapabilityPolicy>();
  const findings: BackfillFinding[] = [];

  for (const file of files) {
    const raw = readFileSync(join(migrationsDir, file), "utf8");
    // Owner-only posture window and tenant GUC state are per-file: the runner
    // executes one file as one implicit transaction.
    const unforced = new Set<string>();
    let tenantGuc = false;
    let statementNumber = 0;
    const statements = splitStatements(raw);
    const ownerWindows = catalogOwnerWindows(statements);

    for (const rawStatement of statements) {
      statementNumber += 1;
      if (
        REVIEWED_ROUTINE_SOURCE_PATCH_SHA256.has(
          createHash("sha256").update(rawStatement).digest("hex"),
        )
      )
        continue;
      const statement = stripComments(rawStatement);
      const commentFreeStatement = stripAllCommentText(rawStatement);
      const head = statement.trim().replace(/\s+/g, " ");

      const createdPolicy = ownerCapabilityPolicy(statement);
      if (createdPolicy) {
        const policyName =
          /^CREATE\s+POLICY\s+(?:"([^"]+)"|([a-z0-9_]+))/i.exec(head)?.slice(1).find(Boolean) ?? "";
        ownerCapabilityPolicies.set(policyName.toLowerCase(), createdPolicy);
      }
      const droppedPolicy =
        /^DROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?(?:"([^"]+)"|([a-z0-9_]+))\s+ON\b/i.exec(head);
      if (droppedPolicy) {
        ownerCapabilityPolicies.delete((droppedPolicy[1] ?? droppedPolicy[2]!).toLowerCase());
      }

      // A DDL statement that merely *defines* a routine whose body mentions
      // set_config must not latch this: the GUC is set when that routine is
      // called, not when it is created. Latching here silently suppressed
      // every later candidate in the file - and "CREATE FUNCTION ... then
      // backfill" is exactly the shape this repo's authority migrations take.
      if (
        !DDL_ONLY.test(head) &&
        /set_config\s*\(\s*'opengeni\.(account_id|workspace_id)'/i.test(statement) &&
        /set_config\s*\(\s*'opengeni\.(account_id|workspace_id)'/i.test(commentFreeStatement)
      ) {
        tenantGuc = true;
      }

      // ---- posture tracking -------------------------------------------------
      const dynamicPosture =
        /^DO\b/i.test(head) &&
        /EXECUTE\s+format\(\s*'ALTER TABLE %I (ENABLE|FORCE) ROW LEVEL SECURITY/i.test(statement);
      if (dynamicPosture) {
        const array = /FOREACH\s+\w+\s+IN\s+ARRAY\s+ARRAY\[([\s\S]*?)\]/i.exec(statement);
        for (const quoted of array?.[1]?.matchAll(/'([a-z0-9_]+)'/gi) ?? []) {
          if (/ENABLE ROW LEVEL SECURITY/i.test(statement)) enabled.add(quoted[1]!);
          if (/FORCE ROW LEVEL SECURITY/i.test(statement)) forced.add(quoted[1]!);
        }
        continue;
      }
      const posture =
        /^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:[a-z0-9_]+\.)?"?([a-z0-9_]+)"?\s+(NO\s+FORCE|FORCE|ENABLE|DISABLE)\s+ROW\s+LEVEL\s+SECURITY/i.exec(
          head,
        );
      if (posture) {
        const table = posture[1]!;
        const operation = posture[2]!.toUpperCase().replace(/\s+/g, " ");
        if (operation === "FORCE") {
          forced.add(table);
          unforced.delete(table);
        } else if (operation === "NO FORCE") {
          forced.delete(table);
          unforced.add(table);
        } else if (operation === "ENABLE") {
          enabled.add(table);
        } else if (operation === "DISABLE") {
          enabled.delete(table);
          unforced.add(table);
        }
        continue;
      }
      const rename =
        /^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?"?([a-z0-9_]+)"?\s+RENAME\s+TO\s+"?([a-z0-9_]+)"?/i.exec(
          head,
        );
      if (rename) {
        if (forced.delete(rename[1]!)) forced.add(rename[2]!);
        if (enabled.delete(rename[1]!)) enabled.add(rename[2]!);
        continue;
      }
      const dropped = /^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?"?([a-z0-9_]+)"?/i.exec(head);
      if (dropped) {
        forced.delete(dropped[1]!);
        enabled.delete(dropped[1]!);
        continue;
      }

      // ---- candidate statements --------------------------------------------
      if (DDL_ONLY.test(head) || NON_DML.test(head)) continue;
      const isBlock = /^DO\b/i.test(head);
      if (!isBlock && !/^(INSERT|UPDATE|DELETE|MERGE|WITH|SELECT|COPY|CALL)\b/i.test(head))
        continue;
      if (tenantGuc) continue;

      const executable = isBlock ? stripRoutineBodies(statement) : statement;
      const commentFreeExecutable = isBlock
        ? stripRoutineBodies(commentFreeStatement)
        : commentFreeStatement;
      const commentFreeOwnerVisible = activatedOwnerCapabilityTables(
        commentFreeExecutable,
        ownerCapabilityPolicies,
      );
      const ownerVisible = new Set(
        [...activatedOwnerCapabilityTables(executable, ownerCapabilityPolicies)].filter((table) =>
          commentFreeOwnerVisible.has(table),
        ),
      );
      const relaxesPosture = (table: string, text: string) =>
        new RegExp(
          String.raw`ALTER TABLE\s+${TABLE_REF(table)}\s+(NO FORCE|DISABLE) ROW LEVEL SECURITY`,
          "i",
        ).test(text);
      const opaque = [...forced].filter(
        (table) =>
          enabled.has(table) &&
          !unforced.has(table) &&
          !ownerWindows.get(statementNumber - 1)?.has(table) &&
          !ownerVisible.has(table) &&
          // A DO block that relaxes the posture itself is protected.
          !(relaxesPosture(table, executable) && relaxesPosture(table, commentFreeExecutable)),
      );

      const written = opaque.filter((table) => writesTable(executable, table)).sort();
      if (written.length > 0) {
        findings.push({
          file,
          statement: statementNumber,
          kind: "write",
          tables: written,
          snippet: head.slice(0, 160),
        });
        continue;
      }

      // A `DO $$ ... IF EXISTS (SELECT ... FROM <forced table>) ... RAISE
      // EXCEPTION` preflight sees zero rows for the same reason a backfill
      // writes zero rows, so it certifies success instead of guarding.
      if (!isBlock || !/RAISE\s+EXCEPTION/i.test(executable)) continue;
      const read = opaque.filter((table) => readsTable(executable, table)).sort();
      if (read.length === 0) continue;
      findings.push({
        file,
        statement: statementNumber,
        kind: "vacuous-guard",
        tables: read,
        snippet: head.slice(0, 160),
      });
    }
  }
  return findings;
}
