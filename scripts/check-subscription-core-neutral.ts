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
 *    provider-named modules may. They also never name a connection kind
 *    (`subscription`, `api_key`) by literal outside comments, union types
 *    and the one credential-kind mapping: the kind is the provider's
 *    registered kind (`subscriptionCoreConnectionKind`), so an
 *    API-key connector uses every shared path a subscription does. The
 *    check is line-based: a conditional split across lines can evade it, so
 *    review still applies.
 * 2. The TypeScript provider registry and the SQL registry rows
 *    (`opengeni_private.subscription_core_providers`) list the same
 *    providers, each with the same connection kind (the SQL column defaults
 *    to `subscription` and cannot change once registered, so a registry
 *    insert that omits it for an API-key adapter is caught here).
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
/**
 * A connection kind literal (`"subscription"`, `'api_key'`) in a shared
 * module, in TypeScript or SQL text: whether compared, assigned, returned,
 * passed or interpolated, the kind must come from the provider's registered
 * kind instead. Allowed: comments (anywhere on a line), union types
 * (`kind: "subscription" | "api_key"`), and the one mapping from the
 * adapter's credential kind (`CONNECTION_KIND_MAPPING`).
 */
const KIND_LITERAL = String.raw`["'\`](?:subscription|api_key)["'\`]`;
/** Members of a union type: a kind literal next to a single `|` (not `||`). */
const KIND_UNION_MEMBER = new RegExp(
  String.raw`${KIND_LITERAL}(?=\s*\|(?!\|))|(?<=(?<!\|)\|\s*)${KIND_LITERAL}`,
  "g",
);
/** The single place a shared module may name a kind: the adapter credential kind mapping. */
export const CONNECTION_KIND_MAPPING = {
  path: "packages/db/src/subscription-core/provider.ts",
  text: 'return provider.adapter.credentialKind === "api_key" ? "api_key" : "subscription";',
} as const;

/**
 * `source` with every `//` and block comment replaced by spaces (newlines
 * kept, so line numbers hold). Strings, template literals (including nested
 * `${...}` expressions) and regular-expression literals are kept as they are.
 * A `/` starts a regular expression where an expression may begin: at the
 * start, after an operator or opening punctuation, or after a keyword such as
 * `return`; after an identifier, number, `)`, `]` or `}` it is a division.
 */
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "case",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "yield",
  "await",
  "do",
  "else",
]);

function regexMayStart(code: string): boolean {
  let end = code.length - 1;
  while (end >= 0 && /\s/.test(code[end]!)) end -= 1;
  if (end < 0) return true;
  const last = code[end]!;
  if (/[\w$]/.test(last)) {
    let start = end;
    while (start > 0 && /[\w$]/.test(code[start - 1]!)) start -= 1;
    return REGEX_PRECEDING_KEYWORDS.has(code.slice(start, end + 1));
  }
  return "(,=:[!&|?{};+-*%<>~^".includes(last);
}

export function blankComments(source: string): string {
  let out = "";
  let mode: "code" | "line" | "block" | "single" | "double" | "template" | "regex" = "code";
  let regexClass = false;
  const braces: Array<"brace" | "template"> = [];
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    const next = source[index + 1];
    if (mode === "line") {
      if (char === "\n") {
        mode = "code";
        out += char;
      } else out += " ";
    } else if (mode === "block") {
      if (char === "*" && next === "/") {
        mode = "code";
        out += "  ";
        index += 1;
      } else out += char === "\n" ? char : " ";
    } else if (mode === "single" || mode === "double") {
      out += char;
      if (char === "\\" && next !== undefined) {
        out += next;
        index += 1;
      } else if (char === (mode === "single" ? "'" : '"') || char === "\n") mode = "code";
    } else if (mode === "regex") {
      out += char;
      if (char === "\\" && next !== undefined) {
        out += next;
        index += 1;
      } else if (char === "[") regexClass = true;
      else if (char === "]") regexClass = false;
      else if ((char === "/" && !regexClass) || char === "\n") mode = "code";
    } else if (mode === "template") {
      out += char;
      if (char === "\\" && next !== undefined) {
        out += next;
        index += 1;
      } else if (char === "`") mode = "code";
      else if (char === "$" && next === "{") {
        out += next;
        index += 1;
        braces.push("template");
        mode = "code";
      }
    } else if (char === "/" && next === "/") {
      mode = "line";
      out += "  ";
      index += 1;
    } else if (char === "/" && next === "*") {
      mode = "block";
      out += "  ";
      index += 1;
    } else if (char === "/" && regexMayStart(out)) {
      out += char;
      mode = "regex";
      regexClass = false;
    } else {
      out += char;
      if (char === "'") mode = "single";
      else if (char === '"') mode = "double";
      else if (char === "`") mode = "template";
      else if (char === "{") braces.push("brace");
      else if (char === "}" && braces.pop() === "template") mode = "template";
    }
  }
  return out;
}

function namesConnectionKind(path: string, code: string): boolean {
  if (path === CONNECTION_KIND_MAPPING.path && code.trim() === CONNECTION_KIND_MAPPING.text)
    return false;
  return new RegExp(KIND_LITERAL).test(code.replace(KIND_UNION_MEMBER, ""));
}

export type NeutralityViolation = { path: string; line: number; text: string; rule: string };

export function findViolations(path: string, source: string): NeutralityViolation[] {
  const violations: NeutralityViolation[] = [];
  // Provider names are refused in comments too; connection kinds only in code.
  const code = blankComments(source).split("\n");
  source.split("\n").forEach((text, index) => {
    if (PROVIDER_NAMES.test(text) || XAI_NAME.test(text))
      violations.push({ path, line: index + 1, text: text.trim(), rule: "provider name" });
    else if (PROVIDER_CONDITIONALS.some((pattern) => pattern.test(text)))
      violations.push({ path, line: index + 1, text: text.trim(), rule: "provider conditional" });
    else if (namesConnectionKind(path, code[index] ?? ""))
      violations.push({
        path,
        line: index + 1,
        text: text.trim(),
        rule: "connection kind literal",
      });
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

/** Split `text` on `separator` outside single-quoted strings and parentheses. */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = "";
  for (const char of text) {
    if (char === "'") quoted = !quoted;
    else if (!quoted && char === "(") depth += 1;
    else if (!quoted && char === ")") depth -= 1;
    if (!quoted && depth === 0 && char === separator) {
      parts.push(current.trim());
      current = "";
    } else current += char;
  }
  if (current.trim().length > 0) parts.push(current.trim());
  return parts;
}

/** Each provider the migrations insert into the SQL registry, with its connection kind. */
export function sqlRegistryConnectionKinds(root: string): Record<string, string> {
  const directory = join(root, "packages/db/drizzle");
  const providers: Record<string, string> = {};
  const insert =
    /INSERT INTO opengeni_private\.subscription_core_providers\s*\(([^)]*)\)\s*VALUES\s*([^;]+);/gi;
  for (const file of readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    const sql = readFileSync(join(directory, file), "utf8");
    for (const match of sql.matchAll(insert)) {
      const columns = match[1]!.split(",").map((column) => column.trim().toLowerCase());
      const providerIndex = columns.indexOf("provider");
      const kindIndex = columns.indexOf("connection_kind");
      // The VALUES list ends at its last top-level tuple; a trailing
      // ON CONFLICT or RETURNING clause is not part of it.
      const valuesList = match[2]!.replace(/\s+(?:ON\s+CONFLICT|RETURNING)\b[\s\S]*$/i, "");
      for (const tuple of splitTopLevel(valuesList.trim(), ",")) {
        const values = splitTopLevel(tuple.replace(/^\(|\)$/g, ""), ",");
        const provider = /^'([a-z][a-z0-9_]*)'$/.exec(values[providerIndex] ?? "")?.[1];
        if (!provider) throw new Error(`${file}: unreadable registry row ${tuple}`);
        const kind =
          kindIndex < 0 ? "subscription" : /^'([a-z_]+)'$/.exec(values[kindIndex] ?? "")?.[1];
        if (!kind) throw new Error(`${file}: unreadable connection kind in ${tuple}`);
        providers[provider] = kind;
      }
    }
    if (/DELETE FROM opengeni_private\.subscription_core_providers/i.test(sql))
      throw new Error(`${file} deletes registry rows; teach this check about removals first`);
  }
  return providers;
}

/** Provider ids the migrations insert into the SQL registry. */
export function sqlRegistryProviders(root: string): string[] {
  return Object.keys(sqlRegistryConnectionKinds(root)).sort();
}

export async function checkSubscriptionCoreNeutral(root: string): Promise<string[]> {
  const errors: string[] = [];
  for (const path of sharedCoreFiles(root)) {
    for (const violation of findViolations(path, readFileSync(join(root, path), "utf8"))) {
      errors.push(`${violation.path}:${violation.line}: ${violation.rule}: ${violation.text}`);
    }
  }
  const { subscriptionCoreProviderIds, subscriptionCoreProvider } = await import(
    join(root, "packages/db/src/subscription-core-providers.ts")
  );
  const { subscriptionCoreConnectionKind } = await import(
    join(root, "packages/db/src/subscription-core/provider.ts")
  );
  const registered = (subscriptionCoreProviderIds as () => string[])();
  const seededKinds = sqlRegistryConnectionKinds(root);
  const seeded = Object.keys(seededKinds).sort();
  if (JSON.stringify(registered) !== JSON.stringify(seeded)) {
    errors.push(
      `provider registry mismatch: TypeScript registers ${registered.join(", ") || "none"}; ` +
        `the SQL registry seeds ${seeded.join(", ") || "none"}`,
    );
  }
  for (const id of registered.filter((entry) => entry in seededKinds)) {
    const kind = (subscriptionCoreConnectionKind as (provider: unknown) => string)(
      (subscriptionCoreProvider as (providerId: string) => unknown)(id),
    );
    if (kind !== seededKinds[id])
      errors.push(
        `connection kind mismatch for ${id}: the adapter's credential kind gives ${kind}; ` +
          `the SQL registry seeds ${seededKinds[id]}`,
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
