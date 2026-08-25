/**
 * Shared helpers for the full-ledger migration-test budget guard.
 *
 * A test that calls `migrate()` replays the whole migration ledger against a
 * fresh database, so its cost grows with every migration that lands and is
 * unrelated to the size of the file it lives in. CI packs unit shards by source
 * file BYTE SIZE (`deterministicShards` in `scripts/ci/workspace.ts`), so these
 * tests can be clustered into one shard by any unrelated file addition and then
 * run concurrently against a single shared PostgreSQL container, where each
 * takes several times its usual wall time.
 *
 * That is not hypothetical. At commit d13a9849b one added file re-packed all six
 * full-ledger replays into shard 3; each took roughly five times its usual wall
 * time, and the only one of them without an explicit budget was killed at the
 * shard default, turning protected main red.
 *
 * The budget is the protection, so every such test must declare one, and it must
 * actually be larger than the default it is meant to override.
 */
import { readFileSync } from "node:fs";
import { parseSync } from "oxc-parser";

/**
 * The cap `scripts/ci/run-unit-shard.ts` passes as `--timeout`. An explicit
 * value at or below it buys nothing over the default, so it does not count as a
 * budget.
 */
export const SHARD_DEFAULT_TIMEOUT_MS = 30_000;

/** What sibling full-ledger tests use, and what the guard suggests. */
export const CONVENTIONAL_BUDGET_MS = 180_000;

/**
 * The shared-container helpers replay the ledger too, and that is the larger
 * surface. `acquire*TestDatabase` funnels through `ensureContainerAndAcquire`,
 * which inside the container lock runs `ensureTemplateBuilt` ->
 * `await migrate(templateUrl)` (plus, on a cold runner, the container start and
 * image pull). The template name is content-hashed over the ledger, so every new
 * migration invalidates it and forces a rebuild. Whichever acquiring test in a
 * shard runs first pays all of it, inside its own hook, and which one that is
 * comes down to shard packing.
 *
 * Keying only on a literal `migrate()` call missed 21 such hooks.
 */
const LEDGER_REPLAY_CALLS = new Set([
  "migrate",
  // The SDK-named thin wrapper over `migrate` (`packages/db/src/migrate.ts`),
  // re-exported from the package index. Same full replay, different word.
  "runMigrations",
  "acquireSharedTestDatabase",
  "acquireBlankTestDatabase",
  "acquireOwnerMigratedTestDatabase",
]);

const TEST_CALLS = new Set(["test", "it"]);
const HOOK_CALLS = new Set(["beforeAll", "beforeEach", "afterAll", "afterEach"]);

export type BudgetViolation = {
  file: string;
  line: number;
  /** `test` / `it`, or the hook name. */
  kind: string;
  /** The declared timeout, or null when none was given. */
  timeout: number | null;
};

/**
 * The leftmost identifier of a callee.
 *
 * Both wrappers have to be unwrapped: `test.only(...)` nests a MemberExpression,
 * and `test.each([...])(...)` nests a CallExpression in the callee position, so
 * walking only members silently misses every table-driven test.
 */
function calleeRoot(node: unknown): string | null {
  let current = node as
    | { type?: string; object?: unknown; callee?: unknown; name?: string }
    | undefined;
  while (current && (current.type === "MemberExpression" || current.type === "CallExpression")) {
    current = (
      current.type === "MemberExpression" ? current.object : current.callee
    ) as typeof current;
  }
  return current && current.type === "Identifier" ? (current.name ?? null) : null;
}

function walk(node: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  const record = node as Record<string, unknown>;
  if (typeof record.type === "string") visit(record);
  for (const key of Object.keys(record)) {
    if (key === "parent") continue;
    walk(record[key], visit);
  }
}

/**
 * A numeric timeout on a `test`/hook call, whether positional (`}, 180_000)`) or
 * an option object (`{ timeout: 180_000 }`). The largest wins, because that is
 * the one that actually applies.
 */
function declaredTimeout(
  call: Record<string, unknown>,
  constants: ReadonlyMap<string, number>,
): number | null {
  let timeout: number | null = null;
  const take = (value: unknown) => {
    if (typeof value === "number" && Number.isFinite(value)) {
      // Largest wins: it is the one that actually applies.
      timeout = timeout === null ? value : Math.max(timeout, value);
    }
  };
  // `}, MIGRATION_TIMEOUT_MS)` is a real style in this repo, and reading only
  // numeric literals would report it as having no budget at all.
  const resolve = (argument: Record<string, unknown>) =>
    argument.type === "Identifier" ? constants.get(argument.name as string) : undefined;
  for (const argument of (call.arguments as Record<string, unknown>[] | undefined) ?? []) {
    if (argument.type === "Literal" || argument.type === "NumericLiteral") take(argument.value);
    else if (argument.type === "Identifier") take(resolve(argument));
    else if (argument.type === "ObjectExpression") {
      for (const property of (argument.properties as Record<string, unknown>[] | undefined) ?? []) {
        const key = property.key as { name?: string; value?: unknown } | undefined;
        const name = key?.name ?? key?.value;
        if (name !== "timeout") continue;
        const value = property.value as Record<string, unknown> | undefined;
        take(value?.type === "Identifier" ? resolve(value) : value?.value);
      }
    }
  }
  return timeout;
}

/** Whether a subtree actually invokes something that replays the ledger. */
function replaysLedger(node: unknown): boolean {
  let found = false;
  walk(node, (candidate) => {
    if (found || candidate.type !== "CallExpression") return;
    const root = calleeRoot(candidate.callee);
    if (root && LEDGER_REPLAY_CALLS.has(root)) found = true;
  });
  return found;
}

/**
 * Module-level `const NAME = <number>` bindings, for timeouts passed by name.
 *
 * Only declarations directly in `program.body` count, and a name declared more
 * than once with different values is dropped rather than resolved. Walking the
 * whole program instead would make the answer depend on traversal order: an
 * unrelated inner `const budget = 500` further down the file would silently
 * override a module-level `const budget = 180_000` and report a real budget as
 * too small. Nineteen unit test files already redeclare the same numeric name
 * with different values.
 */
function numericConstants(program: unknown): Map<string, number> {
  const constants = new Map<string, number>();
  const conflicting = new Set<string>();
  const body = (program as { body?: unknown[] } | undefined)?.body ?? [];
  for (const statement of body) {
    const declaration = statement as Record<string, unknown> | undefined;
    if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") continue;
    for (const entry of (declaration.declarations as Record<string, unknown>[] | undefined) ?? []) {
      const id = entry.id as { type?: string; name?: string } | undefined;
      const init = entry.init as { type?: string; value?: unknown } | undefined;
      if (id?.type !== "Identifier" || !id.name) continue;
      if (init?.type !== "Literal" && init?.type !== "NumericLiteral") continue;
      if (typeof init.value !== "number" || !Number.isFinite(init.value)) continue;
      const existing = constants.get(id.name);
      if (existing !== undefined && existing !== init.value) {
        conflicting.add(id.name);
        continue;
      }
      constants.set(id.name, init.value);
    }
  }
  for (const name of conflicting) constants.delete(name);
  return constants;
}

/**
 * Every `migrate()`-calling test or hook in one file that does not declare a
 * budget above the shard default.
 *
 * A file-level `setDefaultTimeout(n)` above the default covers the whole file,
 * which is why it is checked first: a regex over `}, <number>);` cannot see that
 * shape at all and would report the file as unprotected.
 */
export function budgetViolations(file: string, source: string): BudgetViolation[] {
  const program = parseSync(file, source).program;
  const constants = numericConstants(program);
  let fileDefault: number | null = null;
  const candidates: BudgetViolation[] = [];
  walk(program, (node) => {
    if (node.type !== "CallExpression") return;
    const root = calleeRoot(node.callee);
    if (root === "setDefaultTimeout") {
      const value = declaredTimeout(node, constants);
      if (value !== null) fileDefault = fileDefault === null ? value : Math.max(fileDefault, value);
      return;
    }
    if (!root || (!TEST_CALLS.has(root) && !HOOK_CALLS.has(root))) return;
    // Real call expressions, not the text. Matching text would flag any test
    // whose fixture strings or comments merely mention them - this guard's own
    // test file being the first casualty.
    if (!replaysLedger(node)) return;
    candidates.push({
      file,
      line: source.slice(0, node.start as number).split("\n").length,
      kind: root,
      timeout: declaredTimeout(node, constants),
    });
  });
  if (fileDefault !== null && fileDefault > SHARD_DEFAULT_TIMEOUT_MS) return [];
  return candidates.filter(
    (candidate) => candidate.timeout === null || candidate.timeout <= SHARD_DEFAULT_TIMEOUT_MS,
  );
}

export function budgetViolationsForFile(path: string): BudgetViolation[] {
  return budgetViolations(path, readFileSync(path, "utf8"));
}

export function budgetFixLines(): string[] {
  return [
    `Give each one an explicit budget above ${SHARD_DEFAULT_TIMEOUT_MS} ms - the convention`,
    `for these tests is ${CONVENTIONAL_BUDGET_MS.toLocaleString("en-US").replace(/,/g, "_")}:`,
    "",
    "      });                    ->    }, 180_000);",
    "",
    "A `migrate()` test replays the whole ledger against a fresh database, so its",
    "cost grows with every migration that lands and has nothing to do with the size",
    "of its file. CI packs shards by source-file byte size, so these tests can be",
    "clustered into one shard by any unrelated file addition and then run",
    "concurrently against a single PostgreSQL container, several times slower than",
    "usual. Without a budget above the shard default, that is a failure rather than",
    "a slow shard.",
  ];
}
