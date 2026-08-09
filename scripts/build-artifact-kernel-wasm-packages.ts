#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const repoRoot = resolve(import.meta.dir, "..");
const defaultAssetRoot = join(repoRoot, "packages/artifact-tool/kernel/bindings/dist/wasm-web");
const artifactToolPackagePath = join(repoRoot, "packages/artifact-tool/package.json");
const canonicalRebuildRoot = "/tmp/opengeni-artifact-wasm-source-v1";
const modalities = ["spreadsheet", "document", "presentation"] as const;
type ArtifactModality = (typeof modalities)[number];

export const artifactKernelWasmPackageSizeBudgets: Readonly<
  Record<
    ArtifactModality,
    Readonly<{ wasmBytes: number; wasmGzipBytes: number; glueBytes: number }>
  >
> = Object.freeze({
  // Budgets deliberately follow each lazy editor kernel. The 1.8 MiB full
  // tool kernel is not a browser-editor dependency and cannot consume these.
  spreadsheet: Object.freeze({
    wasmBytes: 768 * 1024,
    wasmGzipBytes: 240 * 1024,
    glueBytes: 32 * 1024,
  }),
  document: Object.freeze({
    wasmBytes: 384 * 1024,
    wasmGzipBytes: 128 * 1024,
    glueBytes: 32 * 1024,
  }),
  presentation: Object.freeze({
    wasmBytes: 384 * 1024,
    wasmGzipBytes: 128 * 1024,
    glueBytes: 32 * 1024,
  }),
});
const budgets = artifactKernelWasmPackageSizeBudgets;

type RuntimeIdentity = Readonly<{
  schemaVersion: 1;
  target: "wasm-web";
  modality: ArtifactModality;
  packageName: `@opengeni/artifact-kernel-wasm-${ArtifactModality}`;
  packageVersion: string;
  artifactToolVersion: string;
  buildIdentity: string;
  kernelVersion: string;
  abiVersion: number;
  protocolVersion: number;
  modelSchemaVersion: number;
  commandVersion: number;
}>;

type Capabilities = Readonly<Record<string, unknown>>;

type PackageBuild = Readonly<{
  modality: ArtifactModality;
  packageRoot: string;
  outputRoot: string;
  identity: RuntimeIdentity;
  manifestPath: string;
}>;

export async function buildArtifactKernelWasmPackages(
  options: {
    assetRoot?: string;
    artifactToolPackagePath?: string;
    outputPackagesRoot?: string;
    modalities?: readonly ArtifactModality[];
  } = {},
): Promise<readonly PackageBuild[]> {
  const assetRoot = resolve(options.assetRoot ?? defaultAssetRoot);
  const outputPackagesRoot = resolve(options.outputPackagesRoot ?? join(repoRoot, "packages"));
  const selected = options.modalities ?? modalities;
  assertModalities(selected);
  const artifactToolPackage = await readPackageJson(
    options.artifactToolPackagePath ?? artifactToolPackagePath,
  );
  const builds: PackageBuild[] = [];
  for (const modality of modalities) {
    if (!selected.includes(modality)) continue;
    const packageName = `@opengeni/artifact-kernel-wasm-${modality}` as const;
    const packageRoot = join(outputPackagesRoot, `artifact-kernel-wasm-${modality}`);
    const packageJson = await readPackageJson(join(packageRoot, "package.json"));
    if (packageJson.name !== packageName) {
      throw new Error(`${packageRoot} must declare package name ${packageName}`);
    }
    if (packageJson.version !== artifactToolPackage.version) {
      throw new Error(
        `${packageName} version must exactly match @opengeni/artifact-tool (${artifactToolPackage.version})`,
      );
    }
    const outputRoot = join(packageRoot, "dist");
    builds.push(
      await materializeModality({
        assetRoot,
        outputRoot,
        modality,
        packageName,
        packageVersion: packageJson.version,
        artifactToolVersion: artifactToolPackage.version,
      }),
    );
  }
  return Object.freeze(builds);
}

/**
 * Rewrites version-bearing package identities from the already committed,
 * canonical modality assets. Changesets runs this in clean checkouts where
 * the raw Rust build directory is intentionally absent.
 */
export async function refreshArtifactKernelWasmPackageIdentities(
  options: {
    artifactToolPackagePath?: string;
    outputPackagesRoot?: string;
    modalities?: readonly ArtifactModality[];
  } = {},
): Promise<readonly PackageBuild[]> {
  const outputPackagesRoot = resolve(options.outputPackagesRoot ?? join(repoRoot, "packages"));
  const selected = options.modalities ?? modalities;
  assertModalities(selected);
  const builds: PackageBuild[] = [];
  for (const modality of selected) {
    const packageRoot = join(outputPackagesRoot, `artifact-kernel-wasm-${modality}`);
    builds.push(
      ...(await buildArtifactKernelWasmPackages({
        assetRoot: join(packageRoot, "dist"),
        artifactToolPackagePath: options.artifactToolPackagePath,
        outputPackagesRoot,
        modalities: [modality],
      })),
    );
  }
  return Object.freeze(builds);
}

async function materializeModality(input: {
  assetRoot: string;
  outputRoot: string;
  modality: ArtifactModality;
  packageName: RuntimeIdentity["packageName"];
  packageVersion: string;
  artifactToolVersion: string;
}): Promise<PackageBuild> {
  const stem = `artifact_kernel_${input.modality}`;
  const glueName = `${stem}.js`;
  const wasmName = `${stem}_bg.wasm`;
  const wasmTypesName = `${stem}_bg.wasm.d.ts`;
  const bindingTypesName = `${stem}.d.ts`;
  const gluePath = join(input.assetRoot, glueName);
  const wasmPath = join(input.assetRoot, wasmName);
  const [glue, wasm, bindingTypes, wasmTypes] = await Promise.all([
    exactFile(gluePath, budgets[input.modality].glueBytes, `${input.modality} glue`),
    exactFile(wasmPath, budgets[input.modality].wasmBytes, `${input.modality} WASM`),
    exactFile(join(input.assetRoot, bindingTypesName), 128 * 1024, `${input.modality} types`),
    exactFile(join(input.assetRoot, wasmTypesName), 32 * 1024, `${input.modality} WASM types`),
  ]);
  const gzipBytes = gzipSync(wasm, { level: 9, mtime: 0 }).byteLength;
  if (gzipBytes > budgets[input.modality].wasmGzipBytes) {
    throw new Error(
      `${input.modality} WASM gzip size ${gzipBytes} exceeds ${budgets[input.modality].wasmGzipBytes}`,
    );
  }

  const module = (await import(
    `${pathToFileURL(gluePath).href}?opengeni-package-build=${Date.now()}-${input.modality}`
  )) as {
    default(input: { module_or_path: ArrayBuffer }): Promise<unknown>;
    buildIdentity(): Uint8Array;
    capabilities(): Uint8Array;
  };
  const wasmBuffer = wasm.buffer.slice(
    wasm.byteOffset,
    wasm.byteOffset + wasm.byteLength,
  ) as ArrayBuffer;
  await module.default({ module_or_path: wasmBuffer });
  const buildIdentity = utf8(module.buildIdentity(), "build identity", 512);
  const capabilityBytes = exactBytes(module.capabilities(), "capabilities", 16 * 1024);
  const capabilities = parseCapabilities(capabilityBytes, input.modality);
  const identity: RuntimeIdentity = Object.freeze({
    schemaVersion: 1,
    target: "wasm-web",
    modality: input.modality,
    packageName: input.packageName,
    packageVersion: input.packageVersion,
    artifactToolVersion: input.artifactToolVersion,
    buildIdentity,
    kernelVersion: buildIdentity,
    abiVersion: positiveInteger(capabilities.abiVersion, "abiVersion"),
    protocolVersion: positiveInteger(
      capabilities.editableArtifactIntentVersion,
      "editableArtifactIntentVersion",
    ),
    modelSchemaVersion: modelSchemaVersion(input.modality, capabilities),
    commandVersion: commandVersion(input.modality, capabilities),
  });
  const entrypoint = new TextEncoder().encode(renderEntrypoint(identity, glueName, wasmName));
  const declarations = new TextEncoder().encode(renderDeclarations(identity));
  const manifest = Object.freeze({
    schemaVersion: 1,
    runtimeIdentity: identity,
    capabilities: Object.freeze({
      bytes: capabilityBytes.byteLength,
      sha256: sha256(capabilityBytes),
    }),
    sizeBudget: Object.freeze({
      wasmBytes: budgets[input.modality].wasmBytes,
      wasmGzipBytes: budgets[input.modality].wasmGzipBytes,
      glueBytes: budgets[input.modality].glueBytes,
    }),
    files: Object.freeze(
      [
        descriptor("index.js", entrypoint),
        descriptor("index.d.ts", declarations),
        descriptor(glueName, glue, gzipBytesFor(glue)),
        descriptor(wasmName, wasm, gzipBytes),
        descriptor(bindingTypesName, bindingTypes),
        descriptor(wasmTypesName, wasmTypes),
      ].sort((left, right) => left.path.localeCompare(right.path)),
    ),
  });

  await rm(input.outputRoot, { recursive: true, force: true });
  await mkdir(input.outputRoot, { recursive: true });
  await Promise.all([
    writeFile(join(input.outputRoot, "index.js"), entrypoint),
    writeFile(join(input.outputRoot, "index.d.ts"), declarations),
    writeFile(join(input.outputRoot, glueName), glue),
    writeFile(join(input.outputRoot, wasmName), wasm),
    writeFile(join(input.outputRoot, bindingTypesName), bindingTypes),
    writeFile(join(input.outputRoot, wasmTypesName), wasmTypes),
    writeFile(
      join(input.outputRoot, "artifact-kernel-runtime.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    ),
  ]);
  return Object.freeze({
    modality: input.modality,
    packageRoot: resolve(input.outputRoot, ".."),
    outputRoot: input.outputRoot,
    identity,
    manifestPath: join(input.outputRoot, "artifact-kernel-runtime.json"),
  });
}

function renderEntrypoint(identity: RuntimeIdentity, glueName: string, wasmName: string): string {
  return [
    `export const artifactKernelRuntimeIdentity = Object.freeze(${JSON.stringify(identity)});`,
    `export const artifactKernelPackageIdentity = artifactKernelRuntimeIdentity;`,
    "export const editableArtifactKernelAssets = Object.freeze({",
    `  modality: ${JSON.stringify(identity.modality)},`,
    `  wasmGlueUrl: new URL(${JSON.stringify(`./${glueName}`)}, import.meta.url),`,
    `  wasmBinaryUrl: new URL(${JSON.stringify(`./${wasmName}`)}, import.meta.url),`,
    "});",
    "export const editableArtifactKernelRuntime = Object.freeze({",
    "  ...editableArtifactKernelAssets,",
    "  kernelVersion: artifactKernelRuntimeIdentity.kernelVersion,",
    "  protocolVersion: artifactKernelRuntimeIdentity.protocolVersion,",
    "  modelSchemaVersion: artifactKernelRuntimeIdentity.modelSchemaVersion,",
    "  commandVersion: artifactKernelRuntimeIdentity.commandVersion,",
    "});",
    "let initialization;",
    "export async function loadArtifactKernelBinding() {",
    "  initialization ??= (async () => {",
    "    const binding = await import(/* @vite-ignore */ editableArtifactKernelAssets.wasmGlueUrl.href);",
    "    await binding.default({ module_or_path: editableArtifactKernelAssets.wasmBinaryUrl });",
    "    return binding;",
    "  })();",
    "  return initialization;",
    "}",
    "",
  ].join("\n");
}

function renderDeclarations(identity: RuntimeIdentity): string {
  const modality = JSON.stringify(identity.modality);
  const packageName = JSON.stringify(identity.packageName);
  const exact = (value: string | number): string => JSON.stringify(value);
  return [
    "export type ArtifactKernelRuntimeIdentity = Readonly<{",
    "  schemaVersion: 1;",
    '  target: "wasm-web";',
    `  modality: ${modality};`,
    `  packageName: ${packageName};`,
    `  packageVersion: ${exact(identity.packageVersion)};`,
    `  artifactToolVersion: ${exact(identity.artifactToolVersion)};`,
    `  buildIdentity: ${exact(identity.buildIdentity)};`,
    `  kernelVersion: ${exact(identity.kernelVersion)};`,
    `  abiVersion: ${exact(identity.abiVersion)};`,
    `  protocolVersion: ${exact(identity.protocolVersion)};`,
    `  modelSchemaVersion: ${exact(identity.modelSchemaVersion)};`,
    `  commandVersion: ${exact(identity.commandVersion)};`,
    "}>;",
    "export declare const artifactKernelRuntimeIdentity: ArtifactKernelRuntimeIdentity;",
    "export declare const artifactKernelPackageIdentity: ArtifactKernelRuntimeIdentity;",
    "export declare const editableArtifactKernelAssets: Readonly<{",
    `  modality: ${modality};`,
    "  wasmGlueUrl: URL;",
    "  wasmBinaryUrl: URL;",
    "}>;",
    "export declare const editableArtifactKernelRuntime: Readonly<{",
    `  modality: ${modality};`,
    "  wasmGlueUrl: URL;",
    "  wasmBinaryUrl: URL;",
    `  kernelVersion: ${exact(identity.kernelVersion)};`,
    `  protocolVersion: ${exact(identity.protocolVersion)};`,
    `  modelSchemaVersion: ${exact(identity.modelSchemaVersion)};`,
    `  commandVersion: ${exact(identity.commandVersion)};`,
    "}>;",
    `export declare function loadArtifactKernelBinding(): Promise<typeof import("./artifact_kernel_${identity.modality}.js")>;`,
    "",
  ].join("\n");
}

function parseCapabilities(bytes: Uint8Array, modality: ArtifactModality): Capabilities {
  let value: unknown;
  try {
    value = JSON.parse(utf8(bytes, "capabilities", 16 * 1024));
  } catch (cause) {
    throw new Error(`${modality} capabilities are not valid JSON`, { cause });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${modality} capabilities must be an object`);
  }
  const capabilities = value as Record<string, unknown>;
  const expected = {
    collaboration: modality === "spreadsheet",
    document: modality === "document",
    documentStatefulSessions: modality === "document",
    presentation: modality === "presentation",
    presentationStatefulSessions: modality === "presentation",
    textLayout: false,
    textLayoutStatefulSessions: false,
    workbookMetadataQueries: modality === "spreadsheet",
  } as const;
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (capabilities[key] !== expectedValue) {
      throw new Error(`${modality} capability ${key} must be ${expectedValue}`);
    }
  }
  if (
    capabilities.safeRust !== true ||
    capabilities.statefulSessions !== true ||
    capabilities.sessionForks !== true ||
    capabilities.transport !== "bounded-uint8array"
  ) {
    throw new Error(`${modality} package lacks the production stateful safe-Rust ABI`);
  }
  return Object.freeze({ ...capabilities });
}

function modelSchemaVersion(modality: ArtifactModality, capabilities: Capabilities): number {
  return positiveInteger(
    capabilities[
      modality === "spreadsheet"
        ? "collaborationSnapshotVersion"
        : modality === "document"
          ? "documentSnapshotVersion"
          : "presentationSnapshotVersion"
    ],
    `${modality} model schema version`,
  );
}

function commandVersion(modality: ArtifactModality, capabilities: Capabilities): number {
  return positiveInteger(
    capabilities[
      modality === "spreadsheet"
        ? "spreadsheetCommandVersion"
        : modality === "document"
          ? "documentCommandVersion"
          : "presentationCommandVersion"
    ],
    `${modality} command version`,
  );
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 65_535) {
    throw new Error(`${label} must be a positive 16-bit integer`);
  }
  return value as number;
}

function exactBytes(value: unknown, label: string, maximumBytes: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > maximumBytes) {
    throw new Error(`${label} must be non-empty bytes within ${maximumBytes}`);
  }
  return value;
}

function utf8(value: unknown, label: string, maximumBytes: number): string {
  const bytes = exactBytes(value, label, maximumBytes);
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!text || text.trim() !== text) throw new Error("not canonical text");
    return text;
  } catch (cause) {
    throw new Error(`${label} must be canonical UTF-8`, { cause });
  }
}

async function exactFile(path: string, maximumBytes: number, label: string): Promise<Uint8Array> {
  const metadata = await stat(path).catch((cause: unknown) => {
    throw new Error(`${label} is missing: ${path}`, { cause });
  });
  if (!metadata.isFile() || metadata.size <= 0 || metadata.size > maximumBytes) {
    throw new Error(`${label} has invalid size ${metadata.size}; maximum is ${maximumBytes}`);
  }
  const bytes = new Uint8Array(await readFile(path));
  if (bytes.byteLength !== metadata.size) throw new Error(`${label} changed while being read`);
  return bytes;
}

function descriptor(path: string, bytes: Uint8Array, gzipBytes?: number) {
  return Object.freeze({
    path,
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
    ...(gzipBytes === undefined ? {} : { gzipBytes }),
  });
}

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function gzipBytesFor(bytes: Uint8Array): number {
  return gzipSync(bytes, { level: 9, mtime: 0 }).byteLength;
}

async function readPackageJson(path: string): Promise<{ name?: string; version: string }> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as { name?: unknown; version?: unknown };
  if (
    (parsed.name !== undefined && typeof parsed.name !== "string") ||
    typeof parsed.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(parsed.version)
  ) {
    throw new Error(`Package manifest is invalid: ${path}`);
  }
  return { ...(parsed.name ? { name: parsed.name } : {}), version: parsed.version };
}

function assertModalities(values: readonly ArtifactModality[]): void {
  if (values.length === 0 || new Set(values).size !== values.length) {
    throw new Error("At least one unique artifact modality is required");
  }
  for (const value of values) {
    if (!modalities.includes(value)) throw new Error(`Unknown artifact modality: ${value}`);
  }
}

async function digestTree(root: string): Promise<Readonly<Record<string, string>>> {
  const result: Record<string, string> = {};
  async function visit(directory: string, prefix: string): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(path, relative);
      else if (entry.isFile())
        result[relative] = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
      else throw new Error(`Generated package contains unsupported entry: ${path}`);
    }
  }
  await visit(root, "");
  return Object.freeze(result);
}

async function rebuildBindings(outputRoot: string): Promise<void> {
  assertCanonicalArtifactKernelWasmRebuildHost();
  const kernelRoot = join(repoRoot, "packages/artifact-tool/kernel");
  const buildScript = join(kernelRoot, "bindings/wasm/scripts/build.sh");
  for (const modality of modalities) {
    const child = Bun.spawn(["sh", buildScript, "web", outputRoot, modality], {
      // rustup discovers the checked-in rust-toolchain.toml from this cwd.
      cwd: kernelRoot,
      env: process.env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    if ((await child.exited) !== 0) throw new Error(`Failed rebuilding ${modality} WASM`);
  }
}

export function assertCanonicalArtifactKernelWasmRebuildHost(
  platform = process.platform,
  architecture = process.arch,
  sourceRoot = repoRoot,
): void {
  if (
    platform !== "linux" ||
    architecture !== "x64" ||
    resolve(sourceRoot) !== canonicalRebuildRoot
  ) {
    throw new Error(
      `Rust-to-WASM byte regeneration requires the canonical linux/x64 builder at ${canonicalRebuildRoot}; ordinary package materialization and checks remain cross-platform`,
    );
  }
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function parseModality(value: string | undefined): readonly ArtifactModality[] {
  if (!value) return modalities;
  if (!modalities.includes(value as ArtifactModality)) {
    throw new Error(`--modality must be one of ${modalities.join(", ")}`);
  }
  return [value as ArtifactModality];
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const rebuild = process.argv.includes("--rebuild");
  const refreshPackageIdentities = process.argv.includes("--refresh-package-identities");
  if (refreshPackageIdentities) {
    if (
      check ||
      rebuild ||
      process.argv.includes("--asset-root") ||
      process.argv.includes("--modality")
    ) {
      throw new TypeError("--refresh-package-identities cannot be combined with build options");
    }
    const builds = await refreshArtifactKernelWasmPackageIdentities();
    process.stdout.write(
      `${JSON.stringify({ packages: builds.map(({ identity }) => identity), refreshed: true })}\n`,
    );
    process.exit(0);
  }
  const selected = parseModality(argument("--modality"));
  const temporaryRoot =
    check || rebuild ? await mkdtemp(join(tmpdir(), "opengeni-wasm-packages-")) : null;
  try {
    const assetRoot = rebuild
      ? join(temporaryRoot!, "bindings")
      : resolve(argument("--asset-root") ?? defaultAssetRoot);
    if (rebuild) await rebuildBindings(assetRoot);
    const outputPackagesRoot = check
      ? join(temporaryRoot!, "packages")
      : join(repoRoot, "packages");
    if (check) {
      for (const modality of selected) {
        const sourcePackage = join(repoRoot, "packages", `artifact-kernel-wasm-${modality}`);
        const targetPackage = join(outputPackagesRoot, `artifact-kernel-wasm-${modality}`);
        await mkdir(targetPackage, { recursive: true });
        await copyFile(join(sourcePackage, "package.json"), join(targetPackage, "package.json"));
      }
    }
    const builds = await buildArtifactKernelWasmPackages({
      assetRoot,
      outputPackagesRoot,
      modalities: selected,
    });
    if (check) {
      for (const build of builds) {
        const committed = join(repoRoot, "packages", basename(build.packageRoot), "dist");
        const [actual, expected] = await Promise.all([
          digestTree(build.outputRoot),
          digestTree(committed),
        ]);
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          throw new Error(
            `${build.identity.packageName} committed package differs from a clean ${rebuild ? "Rust rebuild" : "materialization"}`,
          );
        }
      }
    }
    process.stdout.write(
      `${JSON.stringify({ packages: builds.map(({ identity }) => identity), checked: check })}\n`,
    );
  } finally {
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  }
}
