import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import { parseSync } from "oxc-parser";
import {
  LEGACY_SUBSCRIPTION_RETIREMENTS,
  type LegacySubscriptionRetirement,
} from "./legacy-subscription-runtime";

/**
 * `check:no-legacy-subscription-runtime`: no runtime source may use a retired
 * provider runtime's decision state. Provider-neutral: every retired provider
 * is an entry in `scripts/legacy-subscription-runtime/` (identifiers, retired
 * call shapes, deleted producers, test-only fixtures and exact exceptions),
 * and this engine applies each entry to every runtime source file.
 */

type Node = { type?: string; start?: number; end?: number; [key: string]: unknown };
function walk(node: unknown, visit: (node: Node) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  const record = node as Node;
  if (record.type) visit(record);
  for (const [key, value] of Object.entries(record)) if (key !== "parent") walk(value, visit);
}
function bindingNames(pattern: any): string[] {
  if (!pattern) return [];
  if (pattern.type === "Identifier") return [pattern.name];
  if (pattern.type === "ObjectPattern")
    return pattern.properties.flatMap((property: any) =>
      bindingNames(property.type === "RestElement" ? property.argument : property.value),
    );
  if (pattern.type === "ArrayPattern") return pattern.elements.flatMap(bindingNames);
  if (pattern.type === "AssignmentPattern") return bindingNames(pattern.left);
  if (pattern.type === "RestElement") return bindingNames(pattern.argument);
  return [];
}
/** The names a top-level statement declares (every binding of a destructuring). */
function declarationNames(node: any): string[] {
  const value = node.declaration ?? node;
  if (value.id?.name) return [value.id.name];
  return (value.declarations ?? []).flatMap((declaration: any) => bindingNames(declaration.id));
}

export type LegacySubscriptionFinding = { file: string; line: number; message: string };

/** The repository-relative module a relative specifier names, without extension or `/index`. */
function resolvedRelativeModule(file: string, specifier: string): string | null {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;
  const resolved = posix.normalize(posix.join(dirname(file).split("\\").join("/"), specifier));
  return resolved.replace(/\.[cm]?[jt]sx?$/, "").replace(/\/index$/, "");
}

/** Findings of every given retired runtime in one source file. */
export function checkLegacySubscriptionSource(
  file: string,
  source: string,
  runtimes: readonly LegacySubscriptionRetirement[] = LEGACY_SUBSCRIPTION_RETIREMENTS,
): LegacySubscriptionFinding[] {
  const result = parseSync(file, source);
  if (result.errors.length) return [{ file, line: 1, message: "Cannot parse runtime source" }];
  const findings: LegacySubscriptionFinding[] = [];
  const report = (offset: number, message: string) =>
    findings.push({ file, line: source.slice(0, offset).split("\n").length, message });
  // Ignore comments, but inspect identifiers AND strings/templates (including raw
  // SQL and dynamic table-name constants). Type imports do not bypass the guard.
  let executable = source;
  for (const comment of [...result.comments].sort((a, b) => b.start - a.start)) {
    executable =
      executable.slice(0, comment.start) +
      " ".repeat(comment.end - comment.start) +
      executable.slice(comment.end);
  }
  const literals: Array<{ start: number; end: number; value: string }> = [];
  walk(result.program, (node) => {
    if (node.type === "Literal" && typeof node.value === "string") {
      literals.push({ start: node.start!, end: node.end!, value: node.value });
    }
    // A template without substitutions is a string literal too, so
    // ``import(`./deleted`)`` cannot bypass the module checks.
    if (
      node.type === "TemplateLiteral" &&
      Array.isArray(node.expressions) &&
      node.expressions.length === 0 &&
      Array.isArray(node.quasis) &&
      node.quasis.length === 1
    ) {
      const cooked = (node.quasis[0] as { value?: { cooked?: unknown } }).value?.cooked;
      if (typeof cooked === "string")
        literals.push({ start: node.start!, end: node.end!, value: cooked });
    }
  });
  for (const runtime of runtimes) {
    const exception = runtime.exceptions[file];
    const inventoryLiterals = literals.filter((literal) =>
      exception?.literals?.includes(literal.value),
    );
    const excused = (offset: number): string | undefined | null => {
      const statement = result.program.body.find(
        (node) => node.start <= offset && node.end > offset,
      );
      const names = statement ? declarationNames(statement) : [];
      // A statement is excused only when everything it declares is declared
      // in the exception: one excused binding never excuses its neighbours.
      if (names.length > 0 && names.every((name) => exception?.declarations.includes(name)))
        return null;
      const name = names.join(", ") || undefined;
      if (inventoryLiterals.some((range) => range.start <= offset && range.end > offset))
        return null;
      return name;
    };
    for (const identifier of runtime.identifiers) {
      const pattern = new RegExp(`(?<![A-Za-z0-9_])${identifier}(?![A-Za-z0-9_])`, "g");
      for (const match of executable.matchAll(pattern)) {
        const name = excused(match.index);
        if (name === null) continue;
        report(
          match.index,
          `Retired ${runtime.name} decision state ${identifier}${name ? ` in ${name}` : ""}`,
        );
      }
    }
    for (const { pattern, message } of runtime.patterns ?? []) {
      const global = new RegExp(
        pattern.source,
        pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
      );
      for (const match of executable.matchAll(global)) {
        const name = excused(match.index);
        if (name === null) continue;
        report(match.index, `${message}${name ? ` in ${name}` : ""}`);
      }
    }
    for (const literal of literals) {
      // Production cannot smuggle the historical test fixtures back into a
      // runtime via import, export-from, require or dynamic import.
      const value = literal.value;
      if (
        runtime.testFixtures &&
        new RegExp(
          `(?:^|/)${runtime.testFixtures.source}(?:/|$|\\.[cm]?[jt]s)`,
          runtime.testFixtures.flags.replace("g", ""),
        ).test(value) &&
        /(?:^|\/)(?:test|tests|fixtures)(?:\/|$)/.test(value) &&
        /(?:^\.|^@opengeni\/|^\/workspace\/)/.test(value)
      ) {
        report(literal.start, `Runtime source references ${runtime.name} test-only code`);
      }
      if (runtime.deletedModules?.some((module) => module.test(value))) {
        report(literal.start, `Runtime references a deleted ${runtime.name} producer`);
        continue;
      }
      const resolved = runtime.deletedPaths ? resolvedRelativeModule(file, value) : null;
      if (resolved && runtime.deletedPaths!.includes(resolved)) {
        report(literal.start, `Runtime references a deleted ${runtime.name} producer`);
      }
    }
  }
  return findings;
}

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (["node_modules", "dist", "build", ".git", "test", "tests"].includes(entry.name)) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? files(path)
      : /\.[cm]?[jt]sx?$/.test(path) && !/\.(?:test|e2e|integration)\./.test(path)
        ? [path]
        : [];
  });
}

/** The guard's own sources list the retired names; they are not runtime code. */
const GUARD_SOURCES =
  /^scripts\/(?:check-no-legacy-subscription-runtime\.ts|legacy-subscription-runtime\/)/;

export function checkNoLegacySubscriptionRuntime(
  root: string,
  runtimes: readonly LegacySubscriptionRetirement[] = LEGACY_SUBSCRIPTION_RETIREMENTS,
): LegacySubscriptionFinding[] {
  return ["apps", "packages", "scripts"]
    .flatMap((dir) => files(join(root, dir)))
    .flatMap((path) => {
      const file = relative(root, path);
      if (GUARD_SOURCES.test(file)) return [];
      return checkLegacySubscriptionSource(file, readFileSync(path, "utf8"), runtimes);
    });
}

if (import.meta.main) {
  const findings = checkNoLegacySubscriptionRuntime(process.cwd());
  for (const finding of findings)
    console.error(`${finding.file}:${finding.line}: ${finding.message}`);
  if (findings.length) process.exitCode = 1;
  else
    console.log(
      `No executable legacy subscription decision state (${LEGACY_SUBSCRIPTION_RETIREMENTS.map(
        (runtime) => runtime.name,
      ).join(", ")}); exact declared exceptions only.`,
    );
}
