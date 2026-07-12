import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import type { WorkspacePackage } from "../publishable-workspaces";

export const BUILD_CACHE_SCHEMA_VERSION = 1;

type OutputEntry = { path: string; sha256: string; size: number; mode: number };
type CacheManifest = {
  schemaVersion: 1;
  packageName: string;
  fingerprint: string;
  outputs: OutputEntry[];
};

function normalizePath(path: string): string {
  return path.split(sep).join("/");
}

function sha256(contents: string | Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

function walkFiles(directory: string, output: string[]): void {
  if (!existsSync(directory)) return;
  const metadata = lstatSync(directory);
  if (metadata.isSymbolicLink()) throw new Error(`cache inputs may not be symlinks: ${directory}`);
  if (metadata.isFile()) {
    output.push(directory);
    return;
  }
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.isSymbolicLink())
      throw new Error(`cache inputs may not be symlinks: ${join(directory, entry.name)}`);
    if (!entry.isDirectory() && !entry.isFile()) continue;
    walkFiles(join(directory, entry.name), output);
  }
}

const INPUT_EXCLUDED_DIRECTORIES = new Set([".cache", ".git", "coverage", "dist", "node_modules"]);

function walkInputFiles(directory: string, output: string[]): void {
  if (!existsSync(directory)) return;
  const metadata = lstatSync(directory);
  if (metadata.isSymbolicLink()) throw new Error(`cache inputs may not be symlinks: ${directory}`);
  if (metadata.isFile()) {
    output.push(directory);
    return;
  }
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.isSymbolicLink()) {
      throw new Error(`cache inputs may not be symlinks: ${join(directory, entry.name)}`);
    }
    if (entry.isDirectory() && INPUT_EXCLUDED_DIRECTORIES.has(entry.name)) continue;
    if (!entry.isDirectory() && !entry.isFile()) continue;
    walkInputFiles(join(directory, entry.name), output);
  }
}

function hashFiles(root: string, paths: readonly string[]): string {
  const files: string[] = [];
  for (const path of paths) walkInputFiles(join(root, path), files);
  files.sort((a, b) => a.localeCompare(b));
  const hash = createHash("sha256");
  for (const path of files) {
    const relativePath = normalizePath(relative(root, path));
    const contents = readFileSync(path);
    const mode = statSync(path).mode & 0o777;
    hash.update(`${relativePath}\0${mode}\0${contents.length}\0`);
    hash.update(contents);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function bunConfigurationInputs(root: string): string[] {
  const configPath = join(root, "bunfig.toml");
  if (!existsSync(configPath)) return [];
  const parsed = Bun.TOML.parse(readFileSync(configPath, "utf8"));
  const references = new Set<string>();
  const pending: unknown[] = [parsed];
  while (pending.length > 0) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (value && typeof value === "object") {
      pending.push(...Object.values(value));
      continue;
    }
    if (typeof value !== "string" || (!value.startsWith("./") && !value.startsWith("../"))) {
      continue;
    }
    const absolute = resolve(root, value);
    const relativePath = normalizePath(relative(root, absolute));
    if (relativePath === ".." || relativePath.startsWith("../")) {
      throw new Error(`bunfig.toml references a cache input outside the repository: ${value}`);
    }
    if (existsSync(absolute)) references.add(relativePath);
  }
  return [...references].sort();
}

export function packageBuildFingerprint(options: {
  root: string;
  pkg: WorkspacePackage;
  dependencyFingerprints: ReadonlyMap<string, string>;
  toolchain?: Record<string, string>;
}): string {
  const { root, pkg, dependencyFingerprints } = options;
  // Hash the complete package boundary, not only src/. Build scripts may copy
  // schemas, CSS, fixtures, or other package-owned assets. Tests/docs can cause
  // conservative misses, but an omitted build input could cause a stale hit.
  const packageInputs = [pkg.dir];
  const rootInputs = [
    ".bun-version",
    ".npmrc",
    "bun.lock",
    "bunfig.toml",
    "package.json",
    "patches",
    "tsconfig.base.json",
    "scripts/build-publishable-packages.ts",
    "scripts/publishable-workspaces.ts",
    "scripts/ci/content-cache.ts",
    "scripts/ci/workspace.ts",
    ...bunConfigurationInputs(root),
  ].filter((path) => existsSync(join(root, path)));
  const dependencies = [...dependencyFingerprints.entries()].sort(([a], [b]) => a.localeCompare(b));
  const toolchain = options.toolchain ?? {
    bun: Bun.version,
    platform: process.platform,
    arch: process.arch,
    nodeEnv: process.env.NODE_ENV ?? "",
    bunEnv: process.env.BUN_ENV ?? "",
    ci: process.env.CI ?? "",
    sourceDateEpoch: process.env.SOURCE_DATE_EPOCH ?? "",
    timezone: process.env.TZ ?? "",
    language: process.env.LANG ?? "",
    locale: process.env.LC_ALL ?? "",
  };
  return sha256(
    JSON.stringify({
      schemaVersion: BUILD_CACHE_SCHEMA_VERSION,
      packageName: pkg.name,
      packageInputs: hashFiles(root, packageInputs),
      rootInputs: hashFiles(root, rootInputs),
      dependencies,
      toolchain: Object.entries(toolchain).sort(([a], [b]) => a.localeCompare(b)),
    }),
  );
}

export function packageSourceFingerprint(root: string, pkg: WorkspacePackage): string {
  // This deliberately fingerprints ignored/private workspaces too. A publishable
  // package may import one as a build-time/dev dependency, so excluding it from
  // the dependency map could restore stale declarations or bundled output.
  return hashFiles(root, [pkg.dir]);
}

function safeCacheName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_");
}

function assertSafeCacheAncestors(cacheRoot: string, packageName: string): void {
  for (const path of [
    cacheRoot,
    join(cacheRoot, `v${BUILD_CACHE_SCHEMA_VERSION}`),
    join(cacheRoot, `v${BUILD_CACHE_SCHEMA_VERSION}`, safeCacheName(packageName)),
  ]) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
      throw new Error(`build cache path may not be a symlink: ${path}`);
    }
  }
}

export function packageCacheDirectory(
  cacheRoot: string,
  packageName: string,
  fingerprint: string,
): string {
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) throw new Error("invalid build fingerprint");
  return join(cacheRoot, `v${BUILD_CACHE_SCHEMA_VERSION}`, safeCacheName(packageName), fingerprint);
}

function outputEntries(directory: string): OutputEntry[] {
  const files: string[] = [];
  walkFiles(directory, files);
  return files
    .map((path) => {
      const metadata = statSync(path);
      return {
        path: normalizePath(relative(directory, path)),
        sha256: sha256(readFileSync(path)),
        size: metadata.size,
        mode: metadata.mode & 0o777,
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

function safeOutputPath(root: string, path: string): string {
  if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").includes("..")) {
    throw new Error(`unsafe cache output path: ${path}`);
  }
  const resolved = resolve(root, path);
  if (resolved !== resolve(root) && !resolved.startsWith(`${resolve(root)}${sep}`)) {
    throw new Error(`cache output escapes destination: ${path}`);
  }
  return resolved;
}

function validateManifest(value: unknown): CacheManifest {
  const manifest = value as Partial<CacheManifest>;
  if (
    manifest.schemaVersion !== BUILD_CACHE_SCHEMA_VERSION ||
    typeof manifest.packageName !== "string" ||
    !/^[0-9a-f]{64}$/.test(manifest.fingerprint ?? "") ||
    !Array.isArray(manifest.outputs) ||
    manifest.outputs.length > 100_000
  ) {
    throw new Error("malformed build cache manifest");
  }
  for (const entry of manifest.outputs) {
    if (
      typeof entry?.path !== "string" ||
      !/^[0-9a-f]{64}$/.test(entry.sha256) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      !Number.isSafeInteger(entry.mode) ||
      entry.mode < 0 ||
      entry.mode > 0o777
    ) {
      throw new Error("malformed build cache output entry");
    }
  }
  const totalBytes = manifest.outputs.reduce((sum, entry) => sum + entry.size, 0);
  if (!Number.isSafeInteger(totalBytes) || totalBytes > 512 * 1024 * 1024) {
    throw new Error("build cache manifest exceeds output size limit");
  }
  return manifest as CacheManifest;
}

export function restorePackageBuild(options: {
  root: string;
  pkg: WorkspacePackage;
  cacheRoot: string;
  fingerprint: string;
}): { hit: true } | { hit: false; reason: string } {
  const cacheDirectory = packageCacheDirectory(
    options.cacheRoot,
    options.pkg.name,
    options.fingerprint,
  );
  const cacheDist = join(cacheDirectory, "dist");
  const manifestPath = join(cacheDirectory, "manifest.json");
  if (!existsSync(cacheDist) || !existsSync(manifestPath))
    return { hit: false, reason: "not-found" };
  let safeToRemove = false;
  try {
    assertSafeCacheAncestors(options.cacheRoot, options.pkg.name);
    if (lstatSync(cacheDirectory).isSymbolicLink()) {
      throw new Error("cached content-address entry is a symlink");
    }
    safeToRemove = true;
    if (lstatSync(cacheDist).isSymbolicLink()) throw new Error("cached dist is a symlink");
    const manifest = validateManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
    if (manifest.packageName !== options.pkg.name || manifest.fingerprint !== options.fingerprint) {
      throw new Error("cache identity mismatch");
    }
    const actual = outputEntries(cacheDist);
    if (JSON.stringify(actual) !== JSON.stringify(manifest.outputs)) {
      throw new Error("cached output digest mismatch");
    }
    const destination = join(options.root, options.pkg.dir, "dist");
    rmSync(destination, { recursive: true, force: true });
    mkdirSync(destination, { recursive: true });
    for (const entry of manifest.outputs) {
      const source = safeOutputPath(cacheDist, entry.path);
      const target = safeOutputPath(destination, entry.path);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(source, target);
      chmodSync(target, entry.mode);
    }
    return { hit: true };
  } catch (error) {
    if (safeToRemove) rmSync(cacheDirectory, { recursive: true, force: true });
    return { hit: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function savePackageBuild(options: {
  root: string;
  pkg: WorkspacePackage;
  cacheRoot: string;
  fingerprint: string;
}): void {
  const source = join(options.root, options.pkg.dir, "dist");
  if (!existsSync(source)) throw new Error(`${options.pkg.name} build did not produce dist/`);
  const destination = packageCacheDirectory(
    options.cacheRoot,
    options.pkg.name,
    options.fingerprint,
  );
  const parent = dirname(destination);
  assertSafeCacheAncestors(options.cacheRoot, options.pkg.name);
  mkdirSync(parent, { recursive: true });
  assertSafeCacheAncestors(options.cacheRoot, options.pkg.name);
  const temporary = `${destination}.tmp-${process.pid}-${crypto.randomUUID()}`;
  rmSync(temporary, { recursive: true, force: true });
  mkdirSync(join(temporary, "dist"), { recursive: true });
  cpSync(source, join(temporary, "dist"), { recursive: true, errorOnExist: true });
  const outputs = outputEntries(join(temporary, "dist"));
  const manifest: CacheManifest = {
    schemaVersion: BUILD_CACHE_SCHEMA_VERSION,
    packageName: options.pkg.name,
    fingerprint: options.fingerprint,
    outputs,
  };
  writeFileSync(join(temporary, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  // Cache entries are immutable. If another local writer won the same content
  // address, prove it produced byte-identical outputs before discarding this
  // temporary entry. Different bytes for one input address are nondeterminism
  // (or a missing environment fence), never a valid last-writer-wins cache hit.
  if (existsSync(destination)) {
    if (lstatSync(destination).isSymbolicLink()) {
      rmSync(destination, { force: true });
      renameSync(temporary, destination);
    } else {
      try {
        const existingManifest = validateManifest(
          JSON.parse(readFileSync(join(destination, "manifest.json"), "utf8")),
        );
        const existingOutputs = outputEntries(join(destination, "dist"));
        if (
          existingManifest.packageName !== options.pkg.name ||
          existingManifest.fingerprint !== options.fingerprint ||
          JSON.stringify(existingManifest.outputs) !== JSON.stringify(existingOutputs)
        ) {
          throw new Error("existing cache entry is corrupt");
        }
        if (JSON.stringify(existingOutputs) !== JSON.stringify(outputs)) {
          throw new Error(
            `${options.pkg.name} produced nondeterministic output for ${options.fingerprint}`,
          );
        }
        rmSync(temporary, { recursive: true, force: true });
      } catch (error) {
        if (error instanceof Error && error.message.includes("nondeterministic output")) {
          rmSync(temporary, { recursive: true, force: true });
          throw error;
        }
        rmSync(destination, { recursive: true, force: true });
        renameSync(temporary, destination);
      }
    }
  } else renameSync(temporary, destination);
  // Resolve once after rename so a surprising cache symlink/mount fails immediately.
  realpathSync(destination);
}

export function prunePackageBuildCache(options: { cacheRoot: string; keepPerPackage?: number }): {
  removedEntries: number;
  keptEntries: number;
} {
  const keepPerPackage = options.keepPerPackage ?? 2;
  if (!Number.isSafeInteger(keepPerPackage) || keepPerPackage < 1 || keepPerPackage > 10) {
    throw new Error("keepPerPackage must be an integer from 1 to 10");
  }
  const versionRoot = join(options.cacheRoot, `v${BUILD_CACHE_SCHEMA_VERSION}`);
  if (!existsSync(versionRoot)) return { removedEntries: 0, keptEntries: 0 };
  if (lstatSync(options.cacheRoot).isSymbolicLink()) {
    throw new Error("build cache root may not be a symlink");
  }
  if (lstatSync(versionRoot).isSymbolicLink()) {
    rmSync(versionRoot, { recursive: true, force: true });
    return { removedEntries: 1, keptEntries: 0 };
  }

  let removedEntries = 0;
  let keptEntries = 0;
  for (const packageEntry of readdirSync(versionRoot, { withFileTypes: true })) {
    const packageDirectory = join(versionRoot, packageEntry.name);
    if (packageEntry.isSymbolicLink()) {
      rmSync(packageDirectory, { recursive: true, force: true });
      removedEntries += 1;
      continue;
    }
    if (!packageEntry.isDirectory()) continue;
    const entries = readdirSync(packageDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[0-9a-f]{64}$/.test(entry.name))
      .map((entry) => {
        const path = join(packageDirectory, entry.name);
        const manifestPath = join(path, "manifest.json");
        return {
          path,
          name: entry.name,
          modifiedAt: existsSync(manifestPath) ? statSync(manifestPath).mtimeMs : 0,
        };
      })
      .sort((a, b) => b.modifiedAt - a.modifiedAt || b.name.localeCompare(a.name));
    for (const [index, entry] of entries.entries()) {
      if (index < keepPerPackage) keptEntries += 1;
      else {
        rmSync(entry.path, { recursive: true, force: true });
        removedEntries += 1;
      }
    }
  }
  return { removedEntries, keptEntries };
}
