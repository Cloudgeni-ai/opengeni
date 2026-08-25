/**
 * Shared helpers for the release-schema contract registration guard.
 *
 * `scripts/release-schema-contract.test.ts` pins the migration ledger in three
 * places that a new migration moves, and all three must be updated in the same
 * change:
 *
 * 1. `appendedMigrationPaths` - the forward-migration list. Migrations named
 *    here are excluded from the governed host-export checkpoint input, so the
 *    pinned aggregate SHA-256 never moves.
 * 2. A presence probe over the COMPLETE ledger
 *    (`completeSourceContract.migrations.some((migration) => migration.path === ...)`),
 *    whose indicator feeds the pinned `fileCount`.
 * 3. A `latestMigration` branch in the same `expect(completeSourceContract)`
 *    assertion, which names the newest migration on the tree.
 *
 * Sites 2 and 3 pin the UNFILTERED contract, so forward-listing alone does not
 * satisfy them: a migration registered only at site 1 still fails the contract
 * test on `fileCount` and `latestMigration`.
 *
 * What makes these three the right registration, rather than a fresh
 * `releaseSchemaContractHash` ladder value, is that each is base-invariant. An
 * added list entry, an added indicator term, and an added ternary branch all
 * stay correct however many other migrations merge first. A fresh aggregate
 * hash does not: it covers the whole filtered ledger, so it is computed against
 * your branch and stale the moment someone else's migration lands, which is how
 * migrations 0331, 0332, 0333 and 0334 each reached protected main green and
 * turned it red.
 *
 * The rule is deliberately base-relative and never reads the hash ladder.
 * Reading it would let the very edit that causes the breakage (a fresh pin for
 * the new migration) also define the boundary the guard checks against, which
 * is exactly how commits 4d833689a and ca8aad33d reached main.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { MIGRATIONS_DIR, RELEASE_CONTRACT_TEST } from "./migration-ordinals";

export { MIGRATIONS_DIR, RELEASE_CONTRACT_TEST };

/**
 * The two pre-existing Company Brain entries live in a separate literal in the
 * contract for historical reasons but are the same kind of forward exclusion,
 * so both lists are read.
 */
const FORWARD_LIST_NAMES = ["companyBrainMigrationPaths", "appendedMigrationPaths"] as const;

/** The list a newly added migration belongs in, named in guidance and error output. */
export const CANONICAL_FORWARD_LIST = "appendedMigrationPaths";

const LADDER_NAME = "releaseSchemaContractHash";
const COMPLETE_CONTRACT = "completeSourceContract";
const COMPLETE_ASSERTION = `expect(${COMPLETE_CONTRACT}).toMatchObject({`;

const MIGRATION_FILE = /^\d{4}_[A-Za-z0-9_]+\.sql$/;
const MIGRATION_LITERAL = /"(\d{4}_[A-Za-z0-9_]+\.sql)"/g;
const LINE_COMMENT = /^[^\S\n]*\/\/.*$/gm;
/**
 * A `fileCount` presence probe. The callback parameter is captured and then
 * backreferenced rather than hard-coded, so renaming it (or annotating its
 * type) stays recognised: the guard must not reject a probe that the contract
 * itself accepts.
 */
const PRESENCE_PROBE = new RegExp(
  `${COMPLETE_CONTRACT}\\.migrations\\.some\\(\\s*\\(\\s*([A-Za-z_$][\\w$]*)[^)]*\\)\\s*=>\\s*\\1\\.path === "(\\d{4}_[A-Za-z0-9_]+\\.sql)"`,
  "g",
);

export class ContractParseError extends Error {}

export type BaseLedger = { ref: string; files: string[] };

/** The three places the contract pins the ledger. */
export type RegistrationSite = "forward-list" | "file-count-probe" | "latest-migration-pin";

export const REGISTRATION_SITES: readonly RegistrationSite[] = [
  "forward-list",
  "file-count-probe",
  "latest-migration-pin",
];

export type ContractRegistration = {
  /** Migrations excluded from the governed checkpoint input. */
  forward: string[];
  /** Migrations probed against the complete ledger, feeding the pinned `fileCount`. */
  fileCountProbes: string[];
  /** Migrations named inside the complete-contract assertion, i.e. the `latestMigration` chain. */
  latestMigrationPins: string[];
};

export type RegistrationViolation = {
  /** The migration this head adds. */
  file: string;
  /** Registration sites that do not name it. Never empty. */
  missing: RegistrationSite[];
  /** The base that does not carry it, so it is genuinely new rather than inherited. */
  absentFrom: string;
};

/** Strips `//` line comments so a commented-out entry never counts as registered. */
function withoutLineComments(source: string): string {
  return source.replace(LINE_COMMENT, "");
}

/**
 * Reads a balanced bracketed region starting at `open`, skipping over string
 * literals.
 *
 * String awareness is load-bearing rather than pedantic: a bare depth counter
 * desyncs on a `{` inside a quoted string and over-runs past the end of the
 * region, which would silently widen what the guard treats as registered. It is
 * the one failure direction that must not be possible here.
 */
function balanced(source: string, open: number, opener: "[" | "{", closer: "]" | "}"): string {
  if (open < 0 || source[open] !== opener) {
    throw new ContractParseError(`expected \`${opener}\` in ${RELEASE_CONTRACT_TEST}`);
  }
  let depth = 0;
  let quote: string | null = null;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote !== null) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === opener) depth += 1;
    else if (character === closer) {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  throw new ContractParseError(`unterminated region in ${RELEASE_CONTRACT_TEST}`);
}

/**
 * Reads the body of a `const <name> = [ ... ]` array literal.
 *
 * Deliberately strict: a rename or refactor of the contract must fail this
 * guard loudly rather than silently reduce it to a no-op, which is the one
 * failure mode that would put main back where it started.
 */
function arrayLiteralBody(source: string, name: string): string {
  const start = source.indexOf(`const ${name} = [`);
  if (start < 0) {
    throw new ContractParseError(
      `${RELEASE_CONTRACT_TEST} no longer declares \`const ${name} = [\`. ` +
        "The registration guard cannot locate the forward-migration list; update " +
        "scripts/migration-schema-contract.ts to match the contract.",
    );
  }
  return balanced(source, source.indexOf("[", start), "[", "]");
}

/** Every migration the contract excludes from the governed checkpoint input. */
export function parseForwardMigrations(source: string): string[] {
  const clean = withoutLineComments(source);
  const forward: string[] = [];
  for (const name of FORWARD_LIST_NAMES) {
    for (const match of arrayLiteralBody(clean, name).matchAll(MIGRATION_LITERAL)) {
      if (!forward.includes(match[1]!)) forward.push(match[1]!);
    }
  }
  if (forward.length === 0) {
    throw new ContractParseError(
      `no migration names found in ${FORWARD_LIST_NAMES.join(" / ")} in ${RELEASE_CONTRACT_TEST}`,
    );
  }
  return forward;
}

/** Every registration site the contract declares, parsed from its source. */
export function parseContractRegistration(source: string): ContractRegistration {
  const clean = withoutLineComments(source);
  const fileCountProbes: string[] = [];
  for (const match of clean.matchAll(PRESENCE_PROBE)) {
    if (!fileCountProbes.includes(match[2]!)) fileCountProbes.push(match[2]!);
  }
  if (fileCountProbes.length === 0) {
    throw new ContractParseError(
      `${RELEASE_CONTRACT_TEST} no longer probes \`${COMPLETE_CONTRACT}.migrations.some(...)\` for ` +
        "any migration. The registration guard cannot locate the `fileCount` indicators; update " +
        "scripts/migration-schema-contract.ts to match the contract.",
    );
  }
  const assertion = clean.indexOf(COMPLETE_ASSERTION);
  if (assertion < 0) {
    throw new ContractParseError(
      `${RELEASE_CONTRACT_TEST} no longer contains \`${COMPLETE_ASSERTION}\`. ` +
        "The registration guard cannot locate the `latestMigration` pin; update " +
        "scripts/migration-schema-contract.ts to match the contract.",
    );
  }
  const body = balanced(clean, assertion + COMPLETE_ASSERTION.length - 1, "{", "}");
  const latestMigrationPins: string[] = [];
  for (const match of body.matchAll(MIGRATION_LITERAL)) {
    if (!latestMigrationPins.includes(match[1]!)) latestMigrationPins.push(match[1]!);
  }
  if (latestMigrationPins.length === 0) {
    throw new ContractParseError(
      `\`${COMPLETE_ASSERTION}\` in ${RELEASE_CONTRACT_TEST} names no migration. ` +
        "The registration guard cannot locate the `latestMigration` pin.",
    );
  }
  return { forward: parseForwardMigrations(source), fileCountProbes, latestMigrationPins };
}

/**
 * Migrations this head adds on top of the protected base without registering
 * them at every site the contract pins.
 *
 * A migration already on the base is inherited rather than added here, so it is
 * never reported: only what this head introduces has to be registered by it.
 * The base is the single ref this head targets, deliberately not "any protected
 * branch": a migration that exists only on `origin/production` genuinely is a
 * new addition to `main` when it is forward-ported, and has to be registered
 * for main's contract exactly like any other.
 */
export function unregisteredMigrations(
  head: readonly string[],
  base: BaseLedger,
  registration: ContractRegistration,
): RegistrationViolation[] {
  const carried = new Set(base.files);
  const sites: Record<RegistrationSite, Set<string>> = {
    "forward-list": new Set(registration.forward),
    "file-count-probe": new Set(registration.fileCountProbes),
    "latest-migration-pin": new Set(registration.latestMigrationPins),
  };
  const violations: RegistrationViolation[] = [];
  for (const file of [...head].sort()) {
    if (carried.has(file)) continue;
    const missing = REGISTRATION_SITES.filter((site) => !sites[site].has(file));
    if (missing.length > 0) violations.push({ file, missing, absentFrom: base.ref });
  }
  return violations;
}

/**
 * Every top-level `*.sql` under the migrations directory, sorted by file name.
 *
 * Matches what the contract generator hashes rather than the stricter
 * `NNNN_slug.sql` shape, so an off-convention file cannot slip past this guard
 * while still moving the pins.
 */
export function listLedger(root: string): string[] {
  return readdirSync(join(root, MIGRATIONS_DIR), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
}

/** Parses `git ls-tree --name-only <ref> -- packages/db/drizzle/` output. */
export function parseLedgerPaths(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim().split("/").pop() ?? "")
    .filter((file) => file.endsWith(".sql"))
    .sort();
}

export function readContractSource(root: string): string {
  return readFileSync(join(root, RELEASE_CONTRACT_TEST), "utf8");
}

/**
 * Identifiers the suggested probe name must not collide with. A one-word slug
 * such as `0003_new.sql` would otherwise be printed as `const new = ...`, which
 * does not parse, and the whole point of this text is that it can be pasted.
 */
const RESERVED_IDENTIFIERS = new Set([
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
  // Not reserved words, but `const eval` / `const arguments` are strict-mode errors.
  "eval",
  "arguments",
]);

/** `0342_slack_routing_probe.sql` -> `slackRoutingProbe`, for the suggested const name. */
export function probeName(file: string): string {
  const slug = MIGRATION_FILE.test(file) ? file.slice(5, -4) : file.replace(/\.sql$/, "");
  const parts = slug.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (parts.length === 0) return "addedMigration";
  const camel = parts
    .map((part, index) =>
      index === 0
        ? part.toLowerCase()
        : `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`,
    )
    .join("");
  const safe = /^[A-Za-z_$]/.test(camel) ? camel : `migration${camel}`;
  return RESERVED_IDENTIFIERS.has(safe) ? `${safe}Migration` : safe;
}

/** `const foo`, `let bar` and friends already declared by the contract source. */
export function declaredIdentifiers(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(/\b(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(match[1]!);
  }
  return names;
}

/**
 * A probe name that is safe to paste: not a reserved word, and not already
 * declared in the contract. A colliding suggestion produces a duplicate `const`,
 * which is the same unusable-suggestion failure as a reserved word.
 */
export function availableProbeName(file: string, taken: ReadonlySet<string> = new Set()): string {
  const base = probeName(file);
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${base}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}Probe`;
}

/**
 * The exact edits that fix a violation, so the failure is actionable without
 * reading the contract first. Only the missing sites are shown.
 */
export function registrationFixLines(
  violations: readonly RegistrationViolation[],
  taken: ReadonlySet<string> = new Set(),
): string[] {
  const lines: string[] = [];
  const names = new Map(
    violations.map((violation) => [violation.file, availableProbeName(violation.file, taken)]),
  );
  const nameOf = (file: string) => names.get(file) ?? probeName(file);
  const missingAt = (site: RegistrationSite) =>
    violations.filter((violation) => violation.missing.includes(site));

  const forward = missingAt("forward-list");
  if (forward.length > 0) {
    lines.push(
      `1. Add to \`${CANONICAL_FORWARD_LIST}\`, at the end of that array, keeping the`,
      "   existing one-name-per-line shape:",
      "",
      ...forward.map((violation) => `      "${violation.file}",`),
      "",
      "   That keeps the migration out of the governed checkpoint input, so the",
      "   pinned aggregate SHA-256 stays exactly as it is.",
      "",
    );
  }

  const probes = missingAt("file-count-probe");
  if (probes.length > 0) {
    lines.push(
      "2. Add a presence probe beside the existing ones, so the pinned `fileCount`",
      "   counts it:",
      "",
      ...probes.flatMap((violation) => [
        `    const ${nameOf(violation.file)} = ${COMPLETE_CONTRACT}.migrations.some(`,
        `      (migration) => migration.path === "${violation.file}",`,
        "    );",
      ]),
      "",
      ...probes.map(
        (violation) =>
          `   then add \`+ (${nameOf(violation.file)} ? 1 : 0)\` to the \`fileCount\` sum.`,
      ),
      "",
    );
  }

  const pins = missingAt("latest-migration-pin");
  if (pins.length > 0) {
    const newest = pins[pins.length - 1]!;
    lines.push(
      "3. Prepend a `latestMigration` branch in that same assertion, OUTERMOST, because",
      "   the newest migration has to win the ternary:",
      "",
      `      latestMigration: ${nameOf(newest.file)}`,
      `        ? "${newest.file}"`,
      "        : <the existing chain>,",
      "",
      "   Prepending a level re-indents the whole chain, so run `bun run format`",
      "   afterwards: `format` is a CI guard too.",
      "",
    );
  }

  lines.push(
    `Sites 2 and 3 live in \`${COMPLETE_ASSERTION}\` in ${RELEASE_CONTRACT_TEST},`,
    "which pins the UNFILTERED ledger, so the forward-list entry alone does not",
    "satisfy them.",
    "",
    `Do NOT instead pin a fresh hash in the \`${LADDER_NAME}\` ladder. That aggregate`,
    "covers the whole filtered ledger, so a hash computed on your branch is stale the",
    "moment another migration merges first: your pull request stays green and",
    "protected main lands red. If you genuinely mean to advance the governed",
    "checkpoint, do that as its own change against current main.",
  );
  return lines;
}
