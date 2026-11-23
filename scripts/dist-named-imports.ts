#!/usr/bin/env bun
/**
 * Prove that every named import between built @opengeni/* packages links.
 *
 * Node and Bun link ESM statically: `import { X } from "@opengeni/y"` fails at
 * load time unless y's built entry exports X by name (directly, or through a
 * static `export *` chain). The workspace resolves package source, so ordinary
 * tests cannot see a bundler that turns a nested `export *` from another
 * package into a runtime-only re-export (6.36.0 @opengeni/core could not be
 * imported because @opengeni/capabilities' dist lost NANGO_TAG that way).
 *
 * Usage: bun scripts/dist-named-imports.ts <node_modules dir>
 * checks installed packages; the publish closure guard checks the workspace.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import * as oxc from "oxc-parser";

export type BuiltPackage = {
  name: string;
  /** Absolute package root containing package.json and dist/. */
  root: string;
  packageJson: {
    main?: string;
    module?: string;
    exports?: unknown;
  };
};

type Exports = { names: Set<string>; open: boolean };
type AstNode = { type: string } & Record<string, unknown>;

const RUNTIME_FILE = /\.(m?js)$/u;

function moduleName(node: unknown): string | null {
  if (!node || typeof node !== "object") return null;
  const record = node as Record<string, unknown>;
  if (typeof record.name === "string") return record.name;
  if (typeof record.value === "string") return record.value;
  return null;
}

function bindingNames(pattern: unknown, into: Set<string>): void {
  if (!pattern || typeof pattern !== "object") return;
  const node = pattern as AstNode;
  switch (node.type) {
    case "Identifier":
      if (typeof node.name === "string") into.add(node.name);
      return;
    case "ObjectPattern":
      for (const property of (node.properties as unknown[]) ?? []) {
        const entry = property as AstNode;
        bindingNames(entry.type === "RestElement" ? entry.argument : entry.value, into);
      }
      return;
    case "ArrayPattern":
      for (const element of (node.elements as unknown[]) ?? []) bindingNames(element, into);
      return;
    case "RestElement":
      bindingNames(node.argument, into);
      return;
    case "AssignmentPattern":
      bindingNames(node.left, into);
      return;
  }
}

/** Map a package export target to its built runtime file (source targets compile to dist). */
function builtTarget(target: string): string {
  if (target.startsWith("./src/") && /\.tsx?$/u.test(target)) {
    return `./dist/${target.slice("./src/".length).replace(/\.tsx?$/u, ".js")}`;
  }
  return target;
}

function runtimeCondition(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const conditions = entry as Record<string, unknown>;
  for (const key of ["import", "node", "bun", "default"]) {
    const nested = runtimeCondition(conditions[key]);
    if (nested) return nested;
  }
  return null;
}

export function verifyDistNamedImports(packages: readonly BuiltPackage[]): string[] {
  const failures: string[] = [];
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const parsed = new Map<string, AstNode[] | null>();
  const exportCache = new Map<string, Exports>();

  function body(file: string): AstNode[] | null {
    if (parsed.has(file)) return parsed.get(file) ?? null;
    let program: AstNode[] | null = null;
    try {
      const result = oxc.parseSync(file, readFileSync(file, "utf8"), { sourceType: "module" });
      if (result.errors.length > 0) {
        failures.push(`${file}: ${result.errors.map((error) => error.message).join("; ")}`);
      } else {
        program = (result.program as unknown as { body: AstNode[] }).body;
      }
    } catch (error) {
      failures.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    parsed.set(file, program);
    return program;
  }

  /** Resolve a bare @opengeni/* specifier to a built file, null for other packages. */
  function resolvePackage(specifier: string): string | null | undefined {
    const match = /^(@opengeni\/[^/]+|opengeni)(\/.*)?$/u.exec(specifier);
    if (!match) return null;
    const pkg = byName.get(match[1]!);
    if (!pkg) return null;
    const subpath = match[2] ? `.${match[2]}` : ".";
    const exportsField = pkg.packageJson.exports;
    let target: string | null = null;
    if (exportsField && typeof exportsField === "object" && !Array.isArray(exportsField)) {
      const map = exportsField as Record<string, unknown>;
      target = runtimeCondition(map[subpath]);
      if (!target) {
        for (const [key, value] of Object.entries(map)) {
          const star = key.indexOf("*");
          if (star < 0) continue;
          const prefix = key.slice(0, star);
          const suffix = key.slice(star + 1);
          if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
          const middle = subpath.slice(prefix.length, subpath.length - suffix.length);
          target = runtimeCondition(value)?.replaceAll("*", middle) ?? null;
          if (target) break;
        }
      }
    } else if (subpath === ".") {
      target = pkg.packageJson.module ?? pkg.packageJson.main ?? "./index.js";
    } else {
      target = subpath;
    }
    if (!target) return undefined;
    const file = resolve(pkg.root, builtTarget(target));
    return existsSync(file) ? file : undefined;
  }

  function resolveRelative(fromFile: string, specifier: string): string | undefined {
    const base = resolve(dirname(fromFile), specifier);
    for (const candidate of [base, `${base}.js`, `${base}.mjs`, join(base, "index.js")]) {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
    return undefined;
  }

  function exportsOf(file: string, seen = new Set<string>()): Exports {
    const cached = exportCache.get(file);
    if (cached) return cached;
    const result: Exports = { names: new Set(), open: false };
    if (seen.has(file)) return result;
    seen.add(file);
    for (const statement of body(file) ?? []) {
      if (statement.type === "ExportDefaultDeclaration") {
        result.names.add("default");
      } else if (statement.type === "ExportNamedDeclaration") {
        const declaration = statement.declaration as AstNode | null;
        if (declaration?.type === "VariableDeclaration") {
          for (const declarator of (declaration.declarations as AstNode[]) ?? []) {
            bindingNames(declarator.id, result.names);
          }
        } else if (declaration) {
          const name = moduleName(declaration.id);
          if (name) result.names.add(name);
        }
        for (const specifier of (statement.specifiers as AstNode[]) ?? []) {
          const name = moduleName(specifier.exported);
          if (name) result.names.add(name);
        }
      } else if (statement.type === "ExportAllDeclaration") {
        const alias = moduleName(statement.exported);
        if (alias) {
          result.names.add(alias);
          continue;
        }
        const source = moduleName(statement.source);
        if (!source) continue;
        const target = source.startsWith(".")
          ? resolveRelative(file, source)
          : resolvePackage(source);
        if (!target) {
          // Another package's names are its own contract; unresolvable files
          // are reported where they are imported.
          if (target === null || !source.startsWith(".")) result.open = true;
          continue;
        }
        const nested = exportsOf(target, seen);
        for (const name of nested.names) if (name !== "default") result.names.add(name);
        if (nested.open) result.open = true;
      }
    }
    exportCache.set(file, result);
    return result;
  }

  function check(file: string, specifier: string, names: readonly string[]): void {
    if (names.length === 0) return;
    const target = resolvePackage(specifier);
    if (target === null) return;
    if (target === undefined) {
      failures.push(`${file} imports ${specifier}, which has no built runtime entry.`);
      return;
    }
    const available = exportsOf(target);
    if (available.open) return;
    const missing = names.filter((name) => !available.names.has(name));
    if (missing.length > 0) {
      failures.push(
        `${file} imports { ${missing.join(", ")} } from ${specifier}, but its built entry ${target} does not export ${missing.length === 1 ? "it" : "them"} by name.`,
      );
    }
  }

  function runtimeFiles(dir: string): string[] {
    if (!existsSync(dir)) return [];
    const files: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) files.push(...runtimeFiles(path));
      else if (RUNTIME_FILE.test(entry.name)) files.push(path);
    }
    return files;
  }

  for (const pkg of packages) {
    for (const file of runtimeFiles(join(pkg.root, "dist"))) {
      for (const statement of body(file) ?? []) {
        const source = moduleName(statement.source);
        if (!source || source.startsWith(".")) continue;
        if (statement.type === "ImportDeclaration") {
          if (statement.importKind === "type") continue;
          const names: string[] = [];
          for (const specifier of (statement.specifiers as AstNode[]) ?? []) {
            if (specifier.type === "ImportDefaultSpecifier") names.push("default");
            else if (specifier.type === "ImportSpecifier" && specifier.importKind !== "type") {
              const name = moduleName(specifier.imported);
              if (name) names.push(name);
            }
          }
          check(file, source, names);
        } else if (statement.type === "ExportNamedDeclaration") {
          if (statement.exportKind === "type") continue;
          const names = ((statement.specifiers as AstNode[]) ?? [])
            .filter((specifier) => specifier.exportKind !== "type")
            .map((specifier) => moduleName(specifier.local))
            .filter((name): name is string => name !== null);
          check(file, source, names);
        }
      }
    }
  }
  return failures;
}

/** Installed packages under a node_modules directory (for checking published tarballs). */
export function installedPackages(nodeModules: string): BuiltPackage[] {
  const packages: BuiltPackage[] = [];
  const add = (root: string) => {
    const manifest = join(root, "package.json");
    if (!existsSync(manifest)) return;
    const packageJson = JSON.parse(
      readFileSync(manifest, "utf8"),
    ) as BuiltPackage["packageJson"] & {
      name: string;
    };
    packages.push({ name: packageJson.name, root, packageJson });
  };
  const scope = join(nodeModules, "@opengeni");
  if (existsSync(scope)) for (const entry of readdirSync(scope)) add(join(scope, entry));
  add(join(nodeModules, "opengeni"));
  return packages;
}

if (import.meta.main) {
  const nodeModules = process.argv[2];
  if (!nodeModules) throw new Error("usage: bun scripts/dist-named-imports.ts <node_modules dir>");
  const packages = installedPackages(resolve(nodeModules));
  const failures = verifyDistNamedImports(packages);
  for (const failure of failures) process.stderr.write(`${failure}\n`);
  process.stdout.write(
    `Checked named imports across ${packages.length} packages: ${failures.length} failure(s)\n`,
  );
  process.exit(failures.length > 0 ? 1 : 0);
}
