/**
 * Rolling (expand/contract) migrations are the default. A maintenance migration
 * stops every API, control worker and turn worker for the whole release, so a
 * new one must say why no expand → migrate → contract sequence works. A rolling
 * migration that removes or narrows something old binaries still use breaks
 * them mid-rollout, so contract-phase DDL must name the release that stopped
 * using it.
 *
 * Shipped migrations are frozen by the release schema-contract hash ladder and
 * are exempt: only ordinals at or above `GOVERNED_FROM_ORDINAL` are checked.
 *
 * Guide: docs/migrations-expand-contract.md
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { splitStatements, stripComments, stripRoutineBodies } from "./migration-rls-backfills";

export { MIGRATIONS_DIR } from "./migration-rls-backfills";

export const GUIDE_PATH = "docs/migrations-expand-contract.md";

/**
 * First migration ordinal this guard governs: one above the newest migration on
 * `main` when the guard landed. Never raise it to exempt a new migration.
 */
export const GOVERNED_FROM_ORDINAL = 786;

export const ROLLING_HEADER = "-- deployment-mode: rolling";
export const MAINTENANCE_HEADER = "-- deployment-mode: maintenance";
export const JUSTIFICATION_KEY = "maintenance-justification";
export const CONTRACT_STEP_KEY = "contract-step";

/** Minimum length of a justification, whitespace-collapsed. */
export const MIN_JUSTIFICATION_CHARS = 40;
export const MIN_JUSTIFICATION_WORDS = 6;
/** Minimum length of a contract-step annotation, whitespace-collapsed. */
export const MIN_CONTRACT_STEP_CHARS = 15;

export type DeploymentModeFindingKind =
  | "missing-header"
  | "misplaced-directive"
  | "maintenance-concurrent-index"
  | "missing-justification"
  | "weak-justification"
  | "unannotated-contract"
  | "weak-contract-step";

export type DeploymentModeFinding = {
  file: string;
  kind: DeploymentModeFindingKind;
  detail: string;
};

const MIGRATION_FILE = /^(\d{4})_[^/]*\.sql$/;

/** The 4-digit ordinal of a migration file name, or null. */
export function migrationOrdinal(file: string): number | null {
  const match = MIGRATION_FILE.exec(file);
  return match ? Number(match[1]) : null;
}

function normalizeNewlines(sql: string): string {
  return sql.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
}

/**
 * The lines at the top of the file, trimmed, up to the first line that is
 * neither blank nor a `--` comment. Blank lines are kept as "" so a header
 * value can end at them.
 */
export function leadingCommentBlock(sql: string): string[] {
  const lines: string[] = [];
  for (const raw of normalizeNewlines(sql).split("\n")) {
    const line = raw.trim();
    if (line !== "" && !line.startsWith("--")) break;
    lines.push(line);
  }
  return lines;
}

/** Headers this guard and the migration runner understand. */
const KNOWN_HEADER = new RegExp(
  `^--\\s*(?:deployment-mode|opengeni|${JUSTIFICATION_KEY}|${CONTRACT_STEP_KEY})\\s*:`,
  "i",
);
/** A continuation line: `--` followed by at least two spaces (or a tab) of indent. */
const CONTINUATION = /^--(?: {2,}|\t)\s*\S/;
const DIRECTIVE = /^--\s*opengeni:/i;
const CONCURRENT_INDEX_DIRECTIVE = /^--\s*opengeni:concurrent-index\b/i;

/**
 * The value of a `-- <key>: value` header in the leading comment block, joined
 * with the indented continuation lines (`--   more text`) directly below it.
 * The value ends at a blank line, an unindented comment or another known
 * header. Null when the header is absent.
 */
export function headerValue(sql: string, key: string): { first: string; full: string } | null {
  const lines = leadingCommentBlock(sql);
  const header = new RegExp(`^--\\s*${key}\\s*:(.*)$`, "i");
  for (const [index, line] of lines.entries()) {
    const match = header.exec(line);
    if (!match) continue;
    const first = (match[1] ?? "").trim();
    const parts = [first];
    for (const next of lines.slice(index + 1)) {
      if (!CONTINUATION.test(next) || KNOWN_HEADER.test(next)) break;
      parts.push(next.replace(/^--+/, "").trim());
    }
    return { first, full: parts.join(" ").replace(/\s+/g, " ").trim() };
  }
  return null;
}

/**
 * The runner reads `-- opengeni:` directives only from line 2; anywhere else
 * they are silently ignored and, for a batched backfill, the statement runs
 * once as an ordinary migration.
 */
export function misplacedDirectiveLines(sql: string): number[] {
  return leadingCommentBlock(sql)
    .map((line, index) => (index !== 1 && DIRECTIVE.test(line) ? index + 1 : 0))
    .filter((lineNumber) => lineNumber > 0);
}

const LEADING_PLACEHOLDER = /^(?:(?:todo|tbd|tbc|fixme|xxx)\b|<)/i;
const WHOLE_PLACEHOLDER =
  /^(?:todo|tbd|tbc|fixme|xxx|n\/?a|none|null|nil|placeholder|later|see below|see above|justification|reason|why|-+|\.+|\?+|<[^>]*>)$/i;

/** Why an annotation value is a placeholder, or null when it reads as real. */
export function placeholderReason(value: string): string | null {
  const text = value.trim().replace(/[\s.:;,!-]+$/, "");
  if (text === "") return "is empty";
  if (LEADING_PLACEHOLDER.test(text) || WHOLE_PLACEHOLDER.test(text)) {
    return `is a placeholder (${JSON.stringify(value.trim())})`;
  }
  return null;
}

function justificationProblem(value: { first: string; full: string }): string | null {
  const placeholder = placeholderReason(value.full);
  if (placeholder) return `the ${JUSTIFICATION_KEY} ${placeholder}`;
  const words = value.full.split(" ").filter((word) => /[a-z0-9]/i.test(word));
  if (value.full.length < MIN_JUSTIFICATION_CHARS || words.length < MIN_JUSTIFICATION_WORDS) {
    return `the ${JUSTIFICATION_KEY} is too short (${value.full.length} characters, ${words.length} words; need at least ${MIN_JUSTIFICATION_CHARS} characters and ${MIN_JUSTIFICATION_WORDS} words) to say why no expand/contract sequence works; wrap long text onto indented \`--   \` continuation lines`;
  }
  return null;
}

function contractStepProblem(value: { first: string; full: string }): string | null {
  const placeholder = placeholderReason(value.full);
  if (placeholder) return `the ${CONTRACT_STEP_KEY} annotation ${placeholder}`;
  if (value.full.length < MIN_CONTRACT_STEP_CHARS) {
    return `the ${CONTRACT_STEP_KEY} annotation is too short (${value.full.length} characters, need at least ${MIN_CONTRACT_STEP_CHARS}); name the earlier release or migration after which nothing uses the old shape, or say why the previous release is unaffected`;
  }
  return null;
}

/** Blank single-quoted literals: SQL text inside a string is not DDL here. */
function stripStringLiterals(text: string): string {
  return text.replace(/'(?:[^']|'')*'/g, "''");
}

/** Statement text that executes at migration time, comments and literals removed. */
export function executableText(statement: string): string {
  return stripStringLiterals(stripComments(stripRoutineBodies(statement)))
    .replace(/\s+/g, " ")
    .trim();
}

const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const QUALIFIED = String.raw`${IDENT}(?:\s*\.\s*${IDENT})?`;

function normalizeName(name: string): string {
  const parts = name.split(".").map((part) => {
    const trimmed = part.trim();
    return trimmed.startsWith('"')
      ? trimmed.slice(1, -1).replaceAll('""', '"')
      : trimmed.toLowerCase();
  });
  // `public.widgets` and `widgets` name the same table for this purpose, and a
  // `pg_temp.` prefix names the session's temporary table.
  return parts.length === 2 && (parts[0] === "public" || parts[0] === "pg_temp")
    ? parts[1]!
    : parts.join(".");
}

const CREATE_TABLE = new RegExp(
  String.raw`\bCREATE\s+(?:(?:GLOBAL|LOCAL)\s+)?(TEMP(?:ORARY)?\s+|UNLOGGED\s+)?TABLE\s+(IF\s+NOT\s+EXISTS\s+)?(${QUALIFIED})`,
  "gi",
);
const ALTER_TABLE = new RegExp(
  String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${QUALIFIED})`,
  "gi",
);
const DROP_TABLE = new RegExp(
  String.raw`\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?((?:${QUALIFIED})(?:\s*,\s*${QUALIFIED})*)`,
  "gi",
);

/**
 * Contract-phase operations: each removes or narrows a shape that a binary from
 * the previous release may still read or write while a rolling deploy runs.
 * Deliberately narrow: DROP INDEX/TRIGGER/POLICY/FUNCTION/CONSTRAINT, ADD
 * COLUMN and RENAME CONSTRAINT are not listed.
 */
// `ALTER COLUMN <name>` or `ALTER <name>`, so a column named `type` is not
// mistaken for the TYPE keyword.
const ALTER_COLUMN = String.raw`\bALTER\s+(?:COLUMN\s+${IDENT}|(?!COLUMN\b)${IDENT})`;
const CONTRACT_PATTERNS: readonly { label: string; pattern: RegExp }[] = [
  { label: "DROP COLUMN", pattern: /\bDROP\s+COLUMN\b/i },
  {
    label: "RENAME COLUMN",
    pattern: new RegExp(
      String.raw`\bRENAME\s+(?:COLUMN\s+)?(?!CONSTRAINT\b|TO\b)${IDENT}\s+TO\b`,
      "i",
    ),
  },
  { label: "RENAME TABLE", pattern: /\bRENAME\s+TO\b/i },
  {
    label: "ALTER COLUMN ... TYPE",
    pattern: new RegExp(String.raw`${ALTER_COLUMN}\s+(?:SET\s+DATA\s+)?TYPE\b`, "i"),
  },
  {
    label: "SET NOT NULL",
    pattern: new RegExp(String.raw`${ALTER_COLUMN}\s+SET\s+NOT\s+NULL\b`, "i"),
  },
];

/**
 * Tables a statement certainly creates. `CREATE TABLE IF NOT EXISTS` may be a
 * no-op on an existing table, so only temporary tables count with it.
 */
function tablesCreatedBy(text: string): string[] {
  return [...text.matchAll(CREATE_TABLE)]
    .filter((match) => match[2] === undefined || /^TEMP/i.test(match[1] ?? ""))
    .map((match) => normalizeName(match[3]!));
}

/**
 * Contract-phase operations in one statement, ignoring operations on tables
 * the same migration creates (no earlier binary can use those).
 */
export function contractOperationsIn(
  statement: string,
  createdHere: ReadonlySet<string>,
): string[] {
  const text = executableText(statement);
  const found: string[] = [];
  if (/^(?:ALTER\s+TABLE|DO)\b/i.test(text)) {
    // Judge each ALTER TABLE clause list against its own target. Inside a DO
    // block it ends at the next `;`, so a later ALTER INDEX ... RENAME TO is
    // not read as a table rename.
    const starts = [...text.matchAll(ALTER_TABLE)];
    for (const [index, start] of starts.entries()) {
      const target = normalizeName(start[1]!);
      if (createdHere.has(target)) continue;
      const from = start.index! + start[0].length;
      const nextStart = starts[index + 1]?.index ?? text.length;
      const semicolon = text.indexOf(";", from);
      const end = semicolon === -1 ? nextStart : Math.min(semicolon, nextStart);
      const clauses = text.slice(from, end);
      for (const { label, pattern } of CONTRACT_PATTERNS) {
        if (pattern.test(clauses) && !found.includes(label)) found.push(label);
      }
    }
  }
  for (const match of text.matchAll(DROP_TABLE)) {
    const targets = match[1]!.split(",").map(normalizeName);
    if (targets.some((target) => !createdHere.has(target)) && !found.includes("DROP TABLE")) {
      found.push("DROP TABLE");
    }
  }
  return found;
}

/**
 * Every contract-phase operation a migration performs, in first-seen order.
 * A table counts as created here only from the statement after its CREATE, so
 * dropping or renaming an existing table and then recreating it is flagged.
 */
export function contractOperations(sql: string): string[] {
  const createdHere = new Set<string>();
  const found: string[] = [];
  for (const statement of splitStatements(normalizeNewlines(sql))) {
    for (const label of contractOperationsIn(statement, createdHere)) {
      if (!found.includes(label)) found.push(label);
    }
    for (const table of tablesCreatedBy(executableText(statement))) createdHere.add(table);
  }
  return found;
}

/** Check one migration's text. Returns no findings for ungoverned ordinals. */
export function analyzeMigrationDeploymentMode(
  file: string,
  sql: string,
  governedFrom = GOVERNED_FROM_ORDINAL,
): DeploymentModeFinding[] {
  const ordinal = migrationOrdinal(file);
  if (ordinal === null || ordinal < governedFrom) return [];
  const text = normalizeNewlines(sql);
  const firstLine = text.split("\n", 1)[0]?.trim() ?? "";
  if (firstLine !== ROLLING_HEADER && firstLine !== MAINTENANCE_HEADER) {
    return [
      {
        file,
        kind: "missing-header",
        detail: `line 1 must be exactly \`${ROLLING_HEADER}\` (the default) or \`${MAINTENANCE_HEADER}\`; found ${JSON.stringify(firstLine.slice(0, 80))}`,
      },
    ];
  }
  const findings: DeploymentModeFinding[] = [];
  const misplaced = misplacedDirectiveLines(text);
  if (misplaced.length > 0) {
    findings.push({
      file,
      kind: "misplaced-directive",
      detail: `\`-- opengeni:\` directives are read only from line 2, directly below the deployment-mode header; line ${misplaced.join(", ")} would be ignored and the file would run as an ordinary migration`,
    });
  }
  const lineTwo = leadingCommentBlock(text)[1] ?? "";
  if (firstLine === MAINTENANCE_HEADER) {
    if (CONCURRENT_INDEX_DIRECTIVE.test(lineTwo)) {
      findings.push({
        file,
        kind: "maintenance-concurrent-index",
        detail:
          "a `-- opengeni:concurrent-index` migration builds its index online and cannot carry a justification; declare it `-- deployment-mode: rolling`",
      });
      return findings;
    }
    const justification = headerValue(text, JUSTIFICATION_KEY);
    if (!justification) {
      findings.push({
        file,
        kind: "missing-justification",
        detail: `maintenance migrations need \`-- ${JUSTIFICATION_KEY}: <why no expand/contract sequence works>\` in the leading comment block`,
      });
      return findings;
    }
    const problem = justificationProblem(justification);
    if (problem) findings.push({ file, kind: "weak-justification", detail: problem });
    return findings;
  }
  const operations = contractOperations(text);
  if (operations.length === 0) return findings;
  const contractStep = headerValue(text, CONTRACT_STEP_KEY);
  if (!contractStep) {
    findings.push({
      file,
      kind: "unannotated-contract",
      detail: `rolling migration performs ${operations.join(", ")} on an existing table without \`-- ${CONTRACT_STEP_KEY}: <which earlier release stopped using it, or why the previous release is unaffected>\` in the leading comment block`,
    });
    return findings;
  }
  const problem = contractStepProblem(contractStep);
  if (problem) findings.push({ file, kind: "weak-contract-step", detail: problem });
  return findings;
}

export function analyzeMigrationDeploymentModes(
  migrationsDir: string,
  governedFrom = GOVERNED_FROM_ORDINAL,
): DeploymentModeFinding[] {
  const findings: DeploymentModeFinding[] = [];
  for (const file of readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    findings.push(
      ...analyzeMigrationDeploymentMode(
        file,
        readFileSync(join(migrationsDir, file), "utf8"),
        governedFrom,
      ),
    );
  }
  return findings;
}
