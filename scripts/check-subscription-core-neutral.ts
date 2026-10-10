import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Keeps the shared subscription core provider-neutral: one runtime for every
 * source of model access, with per-provider differences only in adapters.
 *
 * 1. Shared core modules name no provider (in code, SQL text or comments) and
 *    compare no provider id against a literal. Only adapters, the registry
 *    and provider-named modules may.
 * 2. The TypeScript provider registry and the SQL registry rows
 *    (`opengeni_private.subscription_core_providers`) list the same providers.
 */

export const SHARED_CORE_DIRECTORY = "packages/db/src/subscription-core";
/** Shared core modules outside the directory (kept at their M3 paths). */
export const SHARED_CORE_MODULES = [
  "packages/db/src/subscription-core-placement-world.ts",
  "packages/db/src/subscription-core-repository.ts",
  "packages/db/src/subscription-core-acceptance-authority.ts",
  "packages/subscriptions/src/adapter.ts",
] as const;

/** Provider and vendor names a shared module must not contain (any case). */
const PROVIDER_NAMES =
  /codex|openai|chatgpt|fedramp|wham|claude|anthropic|grok|openrouter|vercel|(?<![a-z])xai(?![a-z])|Xai(?![a-z])|XAI/i;
/** A provider id compared with a literal, in TypeScript or SQL text. */
const PROVIDER_CONDITIONAL =
  /\bprovider(?:Id)?\s*(?:===|!==|==|!=)\s*["'`][a-z]|\bprovider\s*(?:=|<>|!=)\s*'[a-z]|\bprovider\s+(?:not\s+)?in\s*\(\s*'[a-z]/i;

export type NeutralityViolation = { path: string; line: number; text: string; rule: string };

export function findViolations(path: string, source: string): NeutralityViolation[] {
  const violations: NeutralityViolation[] = [];
  source.split("\n").forEach((text, index) => {
    if (PROVIDER_NAMES.test(text))
      violations.push({ path, line: index + 1, text: text.trim(), rule: "provider name" });
    else if (PROVIDER_CONDITIONAL.test(text))
      violations.push({ path, line: index + 1, text: text.trim(), rule: "provider conditional" });
  });
  return violations;
}

function filesUnder(root: string, directory: string): string[] {
  return readdirSync(join(root, directory)).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(join(root, path)).isDirectory()) return filesUnder(root, path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

export function sharedCoreFiles(root: string): string[] {
  return [...filesUnder(root, SHARED_CORE_DIRECTORY), ...SHARED_CORE_MODULES].sort();
}

/** Provider ids the migrations insert into the SQL registry. */
export function sqlRegistryProviders(root: string): string[] {
  const directory = join(root, "packages/db/drizzle");
  const providers = new Set<string>();
  const insert =
    /INSERT INTO opengeni_private\.subscription_core_providers\s*\([^)]*\)\s*VALUES\s*([^;]+);/gi;
  for (const file of readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    const sql = readFileSync(join(directory, file), "utf8");
    for (const match of sql.matchAll(insert)) {
      for (const row of match[1]!.matchAll(/\(\s*'([a-z][a-z0-9_]*)'/g)) providers.add(row[1]!);
    }
    if (/DELETE FROM opengeni_private\.subscription_core_providers/i.test(sql))
      throw new Error(`${file} deletes registry rows; teach this check about removals first`);
  }
  return [...providers].sort();
}

export async function checkSubscriptionCoreNeutral(root: string): Promise<string[]> {
  const errors: string[] = [];
  for (const path of sharedCoreFiles(root)) {
    for (const violation of findViolations(path, readFileSync(join(root, path), "utf8"))) {
      errors.push(`${violation.path}:${violation.line}: ${violation.rule}: ${violation.text}`);
    }
  }
  const { SUBSCRIPTION_CORE_PROVIDERS } = await import(
    join(root, "packages/db/src/subscription-core-providers.ts")
  );
  const registered = [
    ...(SUBSCRIPTION_CORE_PROVIDERS as ReadonlyMap<string, unknown>).keys(),
  ].sort();
  const seeded = sqlRegistryProviders(root);
  if (JSON.stringify(registered) !== JSON.stringify(seeded)) {
    errors.push(
      `provider registry mismatch: TypeScript registers ${registered.join(", ") || "none"}; ` +
        `the SQL registry seeds ${seeded.join(", ") || "none"}`,
    );
  }
  return errors;
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  const errors = await checkSubscriptionCoreNeutral(root);
  if (errors.length > 0) {
    console.error(
      `Shared subscription-core modules must stay provider-neutral (${relative(process.cwd(), root) || "."}):`,
    );
    for (const error of errors) console.error(`  ${error}`);
    process.exit(1);
  }
  console.log(
    `subscription core is provider-neutral (${sharedCoreFiles(root).length} shared modules)`,
  );
}
