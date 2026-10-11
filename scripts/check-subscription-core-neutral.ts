import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Keeps the shared subscription core provider-neutral: one runtime for every
 * source of model access, with per-provider differences only in adapters.
 *
 * 1. Shared core modules (the database core and the pure policy package)
 *    name no provider (in code, SQL text or comments) and select no
 *    behaviour by provider id (comparisons with literals or named
 *    constants, switches, literal lookups). Only adapters, the registry and
 *    provider-named modules may. The check is line-based: a conditional
 *    split across lines can evade it, so review still applies.
 * 2. The TypeScript provider registry and the SQL registry rows
 *    (`opengeni_private.subscription_core_providers`) list the same providers.
 */

/** Directories whose every module is shared: the database core and the pure policy package. */
export const SHARED_CORE_DIRECTORIES = [
  "packages/db/src/subscription-core",
  "packages/subscriptions/src",
] as const;
/** Shared core modules outside those directories (kept at their M3 paths). */
export const SHARED_CORE_MODULES = [
  "packages/db/src/subscription-core-placement-world.ts",
  "packages/db/src/subscription-core-repository.ts",
  "packages/db/src/subscription-core-acceptance-authority.ts",
] as const;

/** Provider and vendor names a shared module must not contain (any case). */
const PROVIDER_NAMES =
  /codex|openai|chatgpt|fedramp|wham|claude|anthropic|grok|openrouter|vercel|(?<![a-z])xai(?![a-z])/i;
/** The xAI vendor name in its other spellings (case-sensitive: `maxAiTokens` is not one). */
const XAI_NAME = /(?<![A-Za-z])xAI|Xai(?![a-z])|(?<![A-Z])XAI(?![A-Z])/;
/** An expression that names a provider id (`provider`, `providerId`, `row.provider`, `provider_id`). */
const ID = String.raw`[\w.]*\bprovider(?:Id|_id)?\b`;
/**
 * A provider id compared with or selected by a literal or a named constant,
 * in TypeScript or SQL text.
 */
const PROVIDER_CONDITIONALS: readonly RegExp[] = [
  // provider === "acme", provider !== ACME_ID
  new RegExp(String.raw`${ID}\s*(?:===|!==|==|!=)\s*(?:["'\`][a-z]|[A-Z][A-Z0-9_]{2,}\b)`),
  // "acme" === provider
  new RegExp(String.raw`["'\`][a-z][^"'\`]*["'\`]\s*(?:===|!==|==|!=)\s*${ID}`),
  // switch (provider)
  new RegExp(String.raw`\bswitch\s*\(\s*${ID}\s*\)`),
  // ["acme"].includes(provider), { acme: true }[provider]
  new RegExp(String.raw`\]\s*\.\s*(?:includes|indexOf|some)\s*\(\s*${ID}`),
  new RegExp(String.raw`\}\s*\[\s*${ID}\s*\]`),
  // provider.startsWith("ac")
  new RegExp(String.raw`${ID}\s*\.\s*(?:startsWith|endsWith|includes|match|localeCompare)\s*\(`),
  // SQL: provider = 'acme', provider <> 'acme', provider in ('acme'), provider = any('{acme}'),
  // provider is [not] distinct from 'acme'
  /\bprovider(?:_id)?\s*(?:=|<>|!=)\s*(?:'[a-z]|any\s*\(\s*')/i,
  /\bprovider(?:_id)?\s+(?:not\s+)?in\s*\(\s*'[a-z]/i,
  /\bprovider(?:_id)?\s+is\s+(?:not\s+)?distinct\s+from\s+'[a-z]/i,
];

export type NeutralityViolation = { path: string; line: number; text: string; rule: string };

export function findViolations(path: string, source: string): NeutralityViolation[] {
  const violations: NeutralityViolation[] = [];
  source.split("\n").forEach((text, index) => {
    if (PROVIDER_NAMES.test(text) || XAI_NAME.test(text))
      violations.push({ path, line: index + 1, text: text.trim(), rule: "provider name" });
    else if (PROVIDER_CONDITIONALS.some((pattern) => pattern.test(text)))
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
  return [
    ...SHARED_CORE_DIRECTORIES.flatMap((directory) => filesUnder(root, directory)),
    ...SHARED_CORE_MODULES,
  ].sort();
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
  const { subscriptionCoreProviderIds } = await import(
    join(root, "packages/db/src/subscription-core-providers.ts")
  );
  const registered = (subscriptionCoreProviderIds as () => string[])();
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
