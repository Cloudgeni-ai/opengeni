/**
 * Shared helpers for the release-schema contract registration guard.
 *
 * Forward registration excludes additions from the immutable governed
 * checkpoint. Complete-ledger metadata is checked independently against actual
 * SQL files, so new migrations need no count indicators or latest-name pins.
 * The legacy three-site mode remains supported for historical contracts:
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
import { parseSync } from "oxc-parser";

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
  /** True only after executable, source-derived metadata assertions are verified. */
  semanticLedger?: true;
};

export type RegistrationViolation = {
  /** The migration this head adds. */
  file: string;
  /** Registration sites that do not name it. Never empty. */
  missing: RegistrationSite[];
  /** The base that does not carry it, so it is genuinely new rather than inherited. */
  absentFrom: string;
};

/** Parse comments, rather than treating quoted text or commented code as executable. */
function withoutLineComments(source: string): string {
  const parsed = parseContract(source);
  let clean = source;
  for (const comment of [...parsed.comments].reverse()) {
    clean =
      clean.slice(0, comment.start) +
      " ".repeat(comment.end - comment.start) +
      clean.slice(comment.end);
  }
  return clean;
}

function parseContract(source: string) {
  const parsed = parseSync(RELEASE_CONTRACT_TEST, source);
  if (parsed.errors.length > 0) {
    throw new ContractParseError(
      `cannot parse ${RELEASE_CONTRACT_TEST}: ${parsed.errors[0]!.message}`,
    );
  }
  return parsed;
}

const SEMANTIC_LEDGER_TEST = "checks complete ledger metadata against migration files";

// An executable semantic contract, not a source-text/count/hash pin. Comparing
// parsed structure verifies independent directory provenance, SQL selection,
// ordering, exact path equality, uniqueness, and both metadata fields. Local
// bindings and import aliases are alpha-renamed; formatting, quotes, comments,
// callback names, and TypeScript annotations do not define the invariant.
const SEMANTIC_LEDGER_CALLBACK = `const check = async () => {
  const completeSourceContract = await buildCompleteSchemaContract();
  const sourceMigrationPaths = (
    await readdir(join(import.meta.dir, "../packages/db/drizzle"), { withFileTypes: true })
  )
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
  const contractMigrationPaths = completeSourceContract.migrations.map((migration) => migration.path);
  expect(completeSourceContract).toMatchObject({
    fileCount: sourceMigrationPaths.length,
    latestMigration: sourceMigrationPaths.at(-1) ?? null,
  });
  expect(contractMigrationPaths).toEqual(sourceMigrationPaths);
  expect(new Set(contractMigrationPaths).size).toBe(contractMigrationPaths.length);
};`;

type AstNode = { type: string; [key: string]: unknown };

function astNode(value: unknown): AstNode | undefined {
  return value !== null && typeof value === "object" && "type" in value
    ? (value as AstNode)
    : undefined;
}

/** Structural normalization with lexical binding scopes, never source replacement. */
function canonicalAst(
  value: unknown,
  bindings = new Map<string, string>(),
  counter = { next: 0 },
  propertyName = false,
): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalAst(entry, bindings, counter));
  const node = astNode(value);
  if (!node) return value;
  let scope = bindings;
  if (node.type === "BlockStatement" || node.type === "ArrowFunctionExpression") {
    scope = new Map(bindings);
  }
  const bind = (binding: unknown) => {
    const identifier = astNode(binding);
    if (identifier?.type === "Identifier") scope.set(String(identifier.name), `$${counter.next++}`);
  };
  if (node.type === "VariableDeclarator") bind(node.id);
  if (node.type === "ArrowFunctionExpression") {
    for (const parameter of node.params as unknown[]) bind(parameter);
  }
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(node)) {
    if (["start", "end", "raw", "typeAnnotation", "typeArguments", "decorators"].includes(key))
      continue;
    if (node.type === "Identifier" && key === "name") {
      result[key] = propertyName ? entry : (scope.get(String(entry)) ?? entry);
    } else {
      const isProperty =
        !node.computed &&
        ((node.type === "MemberExpression" && key === "property") ||
          (node.type === "Property" && key === "key"));
      result[key] = canonicalAst(entry, scope, counter, isProperty);
    }
  }
  return result;
}

function verifySemanticLedger(source: string): boolean {
  // A commented or string-embedded claim must fail closed, not select legacy
  // mode and accidentally use unrelated historical probes as its evidence.
  if (!source.includes(SEMANTIC_LEDGER_TEST)) return false;
  const program = parseContract(source).program;
  const bindings = new Map<string, string>();
  const imports: Record<string, readonly string[]> = {
    "bun:test": ["test", "describe", "expect"],
    "node:fs/promises": ["readdir"],
    "node:path": ["join"],
    "./release-schema-contract": ["buildSchemaContract"],
  };
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration") continue;
    if (statement.importKind === "type") continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type !== "ImportSpecifier") continue;
      if (specifier.importKind === "type") continue;
      const imported =
        specifier.imported.type === "Identifier"
          ? specifier.imported.name
          : String(specifier.imported.value);
      if (imports[statement.source.value]?.includes(imported)) {
        bindings.set(
          specifier.local.name,
          imported === "buildSchemaContract" ? "buildCompleteSchemaContract" : imported,
        );
      }
    }
  }
  if (
    ["test", "describe", "expect", "readdir", "join", "buildCompleteSchemaContract"].some(
      (name) => ![...bindings.values()].includes(name),
    )
  ) {
    throw new ContractParseError(
      "semantic ledger assertions must use the real test, filesystem, path, and complete-contract imports",
    );
  }
  const expected = parseContract(SEMANTIC_LEDGER_CALLBACK).program.body[0];
  if (expected?.type !== "VariableDeclaration")
    throw new ContractParseError("invalid semantic ledger guard template");
  const expectedCallback = expected.declarations[0]!.init;
  const candidates: { callback: unknown; bindings: Map<string, string> }[] = [];
  const visit = (statements: unknown[], parentBindings: Map<string, string>) => {
    const scope = new Map(parentBindings);
    for (const value of statements) {
      const statement = astNode(value);
      const shadow = (binding: unknown) => {
        visitAst(binding, (identifier) => {
          if (
            identifier.type === "Identifier" &&
            (scope.has(String(identifier.name)) || identifier.name === "Set")
          ) {
            scope.set(String(identifier.name), `shadowed:${identifier.name}`);
          }
        });
      };
      if (statement?.type === "VariableDeclaration") {
        for (const declaration of statement.declarations as unknown[])
          shadow(astNode(declaration)?.id);
      } else if (
        statement?.type === "FunctionDeclaration" ||
        statement?.type === "ClassDeclaration"
      )
        shadow(statement.id);
      // Ancestor control flow can prevent registration even when the callback
      // itself is correct. This mode recognizes unconditional test registration.
      if (
        statement &&
        [
          "ReturnStatement",
          "ThrowStatement",
          "IfStatement",
          "ForStatement",
          "ForOfStatement",
          "ForInStatement",
          "WhileStatement",
          "DoWhileStatement",
          "TryStatement",
          "SwitchStatement",
        ].includes(statement.type)
      )
        return;
    }
    for (const value of statements) {
      const statement = astNode(value);
      if (statement?.type !== "ExpressionStatement") continue;
      const call = astNode(statement.expression);
      const callee = astNode(call?.callee);
      if (call?.type !== "CallExpression" || callee?.type !== "Identifier") continue;
      const args = call.arguments as unknown[];
      const callback = astNode(args[1]);
      if (
        scope.get(String(callee.name)) === "test" &&
        astNode(args[0])?.value === SEMANTIC_LEDGER_TEST
      )
        candidates.push({ callback, bindings: scope });
      if (
        scope.get(String(callee.name)) === "describe" &&
        callback?.type === "ArrowFunctionExpression" &&
        (callback.params as unknown[]).length === 0
      ) {
        const body = astNode(callback.body);
        if (body?.type === "BlockStatement") visit(body.body as unknown[], scope);
      }
    }
  };
  visit(program.body, bindings);
  if (
    candidates.length !== 1 ||
    JSON.stringify(canonicalAst(candidates[0]?.callback, candidates[0]?.bindings)) !==
      JSON.stringify(canonicalAst(expectedCallback))
  ) {
    throw new ContractParseError(
      `${RELEASE_CONTRACT_TEST} must execute \`${SEMANTIC_LEDGER_TEST}\` with independent, ordered SQL-file paths, exact unique contract paths, and source-derived fileCount/latestMigration assertions; update the semantic guard for an intentional equivalent refactor.`,
    );
  }
  return true;
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

function visitAst(value: unknown, visitor: (node: AstNode) => void): void {
  const node = astNode(value);
  if (!node) return;
  visitor(node);
  for (const entry of Object.values(node)) {
    if (Array.isArray(entry)) {
      for (const child of entry) visitAst(child, visitor);
    } else visitAst(entry, visitor);
  }
}

/** Every migration the contract excludes from the governed checkpoint input. */
export function parseForwardMigrations(source: string): string[] {
  const program = parseContract(source).program;
  const forward: string[] = [];
  for (const name of FORWARD_LIST_NAMES) {
    const declarations: AstNode[] = [];
    visitAst(program, (node) => {
      if (node.type !== "VariableDeclaration" || node.kind !== "const") return;
      for (const declaration of node.declarations as unknown[]) {
        const declarator = astNode(declaration);
        if (astNode(declarator?.id)?.name === name && declarator) declarations.push(declarator);
      }
    });
    let array = astNode(declarations[0]?.init);
    if (array?.type === "CallExpression") {
      const callee = astNode(array.callee);
      array =
        callee?.type === "MemberExpression" && astNode(callee.property)?.name === "filter"
          ? astNode(callee.object)
          : undefined;
    }
    if (declarations.length !== 1 || array?.type !== "ArrayExpression") {
      throw new ContractParseError(
        `${RELEASE_CONTRACT_TEST} must declare one executable \`const ${name} = [\` forward list; update scripts/migration-schema-contract.ts for an intentional equivalent refactor.`,
      );
    }
    for (const value of array.elements as unknown[]) {
      const entry = astNode(value);
      if (
        entry?.type !== "Literal" ||
        typeof entry.value !== "string" ||
        !MIGRATION_FILE.test(entry.value)
      ) {
        throw new ContractParseError(`nonliteral migration in ${name} in ${RELEASE_CONTRACT_TEST}`);
      }
      if (!forward.includes(entry.value)) forward.push(entry.value);
    }
  }
  if (forward.length === 0) {
    throw new ContractParseError(
      `no migration names found in ${FORWARD_LIST_NAMES.join(" / ")} in ${RELEASE_CONTRACT_TEST}`,
    );
  }
  return forward;
}

/**
 * Every migration the contract tests for membership of the FILTERED set.
 *
 * Two shapes carry that test: a direct `migrations.has("<file>")`, and an array
 * of names resolved through `.find((path) => migrations.has(path))`. Both the
 * hash ladders and the `fileCount` / `latestMigration` pins are built from them,
 * so scanning the whole file rather than one ladder is what keeps the audit
 * total.
 */
export function parseFilteredMembershipTests(source: string): string[] {
  const clean = withoutLineComments(source);
  const found: string[] = [];
  for (const match of clean.matchAll(/migrations\.has\("(\d{4}_[A-Za-z0-9_]+\.sql)"\)/g)) {
    if (!found.includes(match[1]!)) found.push(match[1]!);
  }
  for (const match of clean.matchAll(
    // `.find` and `.filter` both resolve their entries through the same
    // membership test. The callback shape is matched loosely - annotated
    // parameter, extra arguments - for the same reason `PRESENCE_PROBE` is:
    // rejecting a construct the contract itself accepts would make the audit
    // wrong about a correct tree.
    /\[([^\]]*?)\]\s*\.(?:find|filter)\(\(\s*[A-Za-z_$][\w$]*[^)]*\)\s*=>\s*migrations\.has\(/g,
  )) {
    for (const entry of match[1]!.matchAll(MIGRATION_LITERAL)) {
      if (!found.includes(entry[1]!)) found.push(entry[1]!);
    }
  }
  if (found.length === 0) {
    throw new ContractParseError(
      `${RELEASE_CONTRACT_TEST} tests no migration against the filtered set. ` +
        "The registration guard cannot audit it; update " +
        "scripts/migration-schema-contract.ts to match the contract.",
    );
  }
  return found;
}

/** Every registration site the contract declares, parsed from its source. */
export function parseContractRegistration(source: string): ContractRegistration {
  if (verifySemanticLedger(source)) {
    return {
      forward: parseForwardMigrations(source),
      fileCountProbes: [],
      latestMigrationPins: [],
      semanticLedger: true,
    };
  }
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
 * Contract references that can never match.
 *
 * The hash ladders and the `fileCount` / `latestMigration` pins all ask
 * `migrations.has(...)` over the ALREADY-FILTERED set, so a reference to a
 * forward-listed migration present on this tree is unreachable: forward-listing
 * is what removes it from that map, and if the file were absent the check would
 * be false anyway.
 *
 * Such a reference is the residue of the wrong repair - pinning or counting your
 * own migration instead of registering it - and a dead hash rung is worse than
 * dead weight, because it reads as a live pin. It is not a fallback either: an
 * aggregate pinned while the migration was still framed is already wrong for the
 * only tree that could ever read it.
 *
 * A reference to a migration that is not on this tree is left alone. Those are
 * the ordinary compatibility branches that fire where fewer migrations exist.
 *
 * Known limit: a NEGATED test (`if (!migrations.has(X))`) is live exactly when X
 * is forward-listed, so flagging it would be wrong. No such test names a
 * forward-listed migration today, and the contract has exactly one negated test
 * at all, so this is left as a documented limit rather than special-cased on a
 * shape that does not yet exist.
 */
export function unreachableContractReferences(
  source: string,
  ledger: readonly string[],
  forwardMigrations: readonly string[],
): string[] {
  const present = new Set(ledger);
  const forward = new Set(forwardMigrations);
  return parseFilteredMembershipTests(source).filter(
    (file) => present.has(file) && forward.has(file),
  );
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
    const missing = REGISTRATION_SITES.filter(
      (site) => (site === "forward-list" || !registration.semanticLedger) && !sites[site].has(file),
    );
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
  semanticLedger = false,
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
    ...(semanticLedger
      ? [
          "Complete-ledger metadata is already checked against ordered SQL files;",
          "do not add file-count indicators or latest-migration name pins.",
          "",
        ]
      : [
          `Sites 2 and 3 live in \`${COMPLETE_ASSERTION}\` in ${RELEASE_CONTRACT_TEST},`,
          "which pins the UNFILTERED ledger, so the forward-list entry alone does not",
          "satisfy them.",
          "",
        ]),
  );
  lines.push(
    `Do NOT instead pin a fresh hash in the \`${LADDER_NAME}\` ladder. That aggregate`,
    "covers the whole filtered ledger, so a hash computed on your branch is stale the",
    "moment another migration merges first: your pull request stays green and",
    "protected main lands red. If you genuinely mean to advance the governed",
    "checkpoint, do that as its own change against current main.",
  );
  return lines;
}
