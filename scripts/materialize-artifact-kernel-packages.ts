#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  ARTIFACT_KERNEL_BUILD_RECEIPT,
  canonicalArtifactKernelBuildReceiptBytes,
  readArtifactKernelBuildReceipt,
  type ArtifactKernelBuildReceipt,
} from "../packages/artifact-tool/kernel/bindings/package-receipt";
import {
  ARTIFACT_RUNTIME_MATRIX,
  ArtifactRuntimeError,
  artifactRuntimeTarget,
  validateArtifactKernelPackageIdentity,
  validateArtifactKernelPackageManifest,
  type ArtifactKernelPackageIdentity,
  type ArtifactKernelPackageManifest,
  type ArtifactRuntimeTarget,
} from "../packages/artifact-tool/src/runtime";
import { canonicalArtifactRuntimeReleaseManifestBytes } from "../packages/artifact-tool/src/runtime-cli";
import targetMatrix from "../packages/artifact-tool/kernel/bindings/packages/targets.json" with { type: "json" };

const NATIVE_ASSET = "opengeni_artifact_kernel.node";
const WASM_ASSET = "artifact_kernel_bg.wasm";
const WASM_GLUE = "artifact_kernel.js";
const WASM_EDITOR_ASSETS = Object.freeze({
  spreadsheet: Object.freeze({
    glue: "artifact_kernel_spreadsheet.js",
    wasm: "artifact_kernel_spreadsheet_bg.wasm",
  }),
  document: Object.freeze({
    glue: "artifact_kernel_document.js",
    wasm: "artifact_kernel_document_bg.wasm",
  }),
  presentation: Object.freeze({
    glue: "artifact_kernel_presentation.js",
    wasm: "artifact_kernel_presentation_bg.wasm",
  }),
});
const PACKAGE_MANIFEST = "artifact-kernel-manifest.json";
const MAX_NATIVE_BYTES = 512 * 1024 * 1024;
const MAX_WASM_BYTES = 128 * 1024 * 1024;
const MAX_GLUE_BYTES = 16 * 1024 * 1024;

type TargetBuildDefinition = Readonly<{
  target: ArtifactRuntimeTarget;
  kind: "native" | "wasm";
  rustTarget: string;
  os: string;
  cpu: string;
  libc?: "glibc" | "musl";
}>;

export type MaterializeArtifactKernelPackagesOptions = Readonly<{
  assetRoot: string;
  outputRoot: string;
  artifactToolVersion: string;
  targets: readonly ArtifactRuntimeTarget[];
  artifactToolIntegrity?: `sha512-${string}`;
}>;

export type MaterializedArtifactKernelPackage = Readonly<{
  target: ArtifactRuntimeTarget;
  packageName: string;
  packageRoot: string;
  manifest: ArtifactKernelPackageManifest;
}>;

/**
 * Produces only explicitly requested target packages from local verified build
 * outputs. It never downloads, substitutes, or invents a missing target.
 */
export async function materializeArtifactKernelPackages(
  options: MaterializeArtifactKernelPackagesOptions,
): Promise<readonly MaterializedArtifactKernelPackage[]> {
  assertAbsoluteDirectoryInput(options.assetRoot, "assetRoot");
  assertAbsoluteDirectoryInput(options.outputRoot, "outputRoot");
  validateMatrixDefinitions();
  if (options.targets.length === 0) throw new Error("At least one target is required");
  if (new Set(options.targets).size !== options.targets.length) {
    throw new Error("Artifact kernel materialization targets must be unique");
  }
  const orderedTargets = ARTIFACT_RUNTIME_MATRIX.map(({ target }) => target).filter((target) =>
    options.targets.includes(target),
  );
  if (orderedTargets.length !== options.targets.length) {
    throw new Error("Artifact kernel materialization includes an unknown target");
  }
  const receipts = await Promise.all(
    orderedTargets.map((target) => readArtifactKernelBuildReceipt(target, options.assetRoot)),
  );
  if (new Set(receipts.map(({ buildIdentity }) => buildIdentity)).size !== 1) {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_INCOMPATIBLE",
      "All materialized target receipts must carry one exact build identity",
    );
  }
  await mkdir(options.outputRoot, { recursive: true });
  const materialized: MaterializedArtifactKernelPackage[] = [];
  for (const [index, target] of orderedTargets.entries()) {
    materialized.push(await materializeTarget(options, target, receipts[index]!));
  }

  if (options.artifactToolIntegrity !== undefined) {
    if (orderedTargets.length !== ARTIFACT_RUNTIME_MATRIX.length) {
      throw new Error("A release manifest requires all eight exact target packages");
    }
    const releaseBytes = canonicalArtifactRuntimeReleaseManifestBytes({
      schemaVersion: 1,
      artifactTool: {
        packageName: "@opengeni/artifact-tool",
        packageVersion: options.artifactToolVersion,
        integrity: options.artifactToolIntegrity,
      },
      targets: materialized.map(({ manifest }) => manifest),
    });
    await writeFile(
      join(options.outputRoot, "artifact-runtime-release-manifest.json"),
      releaseBytes,
    );
  }
  return materialized;
}

/** One literal target import; no runtime package-name construction or fallback. */
export function renderArtifactSkillFacadeBootstrap(
  manifest: ArtifactKernelPackageManifest,
  options: Readonly<{ kernelSpecifier?: string }> = {},
): string {
  const validated = validateArtifactKernelPackageManifest(manifest, manifest.target);
  const kernelSpecifier = options.kernelSpecifier ?? validated.packageName;
  if (
    kernelSpecifier !== validated.packageName &&
    !/^\.\/[a-z0-9][a-z0-9._/-]*\.js$/u.test(kernelSpecifier)
  ) {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_MANIFEST_INVALID",
      "Pinned facade kernel specifier must be the exact package name or a normalized local JavaScript path",
    );
  }
  if (
    kernelSpecifier !== validated.packageName &&
    kernelSpecifier
      .slice(2)
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_MANIFEST_INVALID",
      "Pinned facade kernel specifier must remain inside its installation root",
    );
  }
  return [
    'import { configureArtifactRuntime } from "@opengeni/artifact-tool";',
    'import { ArtifactKernelRuntime, ArtifactRuntimeError, validateArtifactKernelPackageIdentity } from "@opengeni/artifact-tool/runtime";',
    `import { artifactKernelPackageIdentity, loadArtifactKernelBinding } from ${JSON.stringify(kernelSpecifier)};`,
    `const expectedManifest = ${JSON.stringify(validated)};`,
    `const expectedIdentity = ${JSON.stringify(packageIdentity(validated))};`,
    `const actualIdentity = validateArtifactKernelPackageIdentity(artifactKernelPackageIdentity, ${JSON.stringify(validated.target)});`,
    "if (JSON.stringify(actualIdentity) !== JSON.stringify(expectedIdentity)) {",
    '  throw new ArtifactRuntimeError("ARTIFACT_RUNTIME_INTEGRITY", "Pinned kernel package identity changed before bootstrap");',
    "}",
    "const binding = await loadArtifactKernelBinding();",
    `configureArtifactRuntime(new ArtifactKernelRuntime(${JSON.stringify(validated.kind)}, binding, expectedManifest));`,
    'export * from "@opengeni/artifact-tool";',
    "",
  ].join("\n");
}

export function artifactKernelTargetBuildDefinitions(): readonly TargetBuildDefinition[] {
  validateMatrixDefinitions();
  return Object.freeze(
    targetMatrix.targets.map((target) => Object.freeze({ ...target })),
  ) as readonly TargetBuildDefinition[];
}

async function materializeTarget(
  options: MaterializeArtifactKernelPackagesOptions,
  target: ArtifactRuntimeTarget,
  receipt: ArtifactKernelBuildReceipt,
): Promise<MaterializedArtifactKernelPackage> {
  const descriptor = artifactRuntimeTarget(target);
  const definition = targetDefinition(target);
  const packageRoot = join(options.outputRoot, descriptor.packageName.slice("@opengeni/".length));
  await rm(packageRoot, { recursive: true, force: true });
  await mkdir(packageRoot, { recursive: true });

  const assetSource =
    descriptor.kind === "native"
      ? join(options.assetRoot, "native", target, NATIVE_ASSET)
      : join(options.assetRoot, "wasm-web", WASM_ASSET);
  const assetName = descriptor.kind === "native" ? NATIVE_ASSET : WASM_ASSET;
  const asset = await exactLocalFile(
    assetSource,
    descriptor.kind === "native" ? MAX_NATIVE_BYTES : MAX_WASM_BYTES,
  );
  const supportFiles: Array<ArtifactKernelPackageManifest["supportFiles"][number]> = [];
  if (descriptor.kind === "wasm") {
    const names = [
      WASM_GLUE,
      ...Object.values(WASM_EDITOR_ASSETS).flatMap(({ glue, wasm }) => [glue, wasm]),
    ].sort();
    for (const name of names) {
      const source = join(options.assetRoot, "wasm-web", name);
      const bytes = await exactLocalFile(
        source,
        name.endsWith(".wasm") ? MAX_WASM_BYTES : MAX_GLUE_BYTES,
      );
      supportFiles.push(fileDescriptor(name, bytes));
      await copyFile(source, join(packageRoot, name));
    }
  }
  assertReceiptFiles(receipt, [fileDescriptor(assetName, asset), ...supportFiles]);

  const identity: ArtifactKernelPackageIdentity = {
    schemaVersion: 1,
    target,
    kind: descriptor.kind,
    packageName: descriptor.packageName,
    packageVersion: options.artifactToolVersion,
    artifactToolVersion: options.artifactToolVersion,
    buildIdentity: receipt.buildIdentity,
  };
  validateArtifactKernelPackageIdentity(identity, target);
  const entrypointSource =
    descriptor.kind === "native"
      ? nativeEntrypointSource(assetName, identity)
      : wasmEntrypointSource(assetName, identity);
  const entrypointBytes = new TextEncoder().encode(entrypointSource);
  const manifest = validateArtifactKernelPackageManifest(
    {
      schemaVersion: 1,
      target,
      kind: descriptor.kind,
      packageName: descriptor.packageName,
      packageVersion: options.artifactToolVersion,
      artifactToolVersion: options.artifactToolVersion,
      buildIdentity: receipt.buildIdentity,
      entrypoint: fileDescriptor("index.js", entrypointBytes),
      asset: fileDescriptor(assetName, asset),
      supportFiles,
    },
    target,
  );

  await Promise.all([
    copyFile(assetSource, join(packageRoot, assetName)),
    writeFile(join(packageRoot, "index.js"), entrypointBytes),
    writeFile(join(packageRoot, "index.d.ts"), declarationSource()),
    writeFile(join(packageRoot, PACKAGE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`),
    writeFile(
      join(packageRoot, ARTIFACT_KERNEL_BUILD_RECEIPT),
      canonicalArtifactKernelBuildReceiptBytes(receipt),
    ),
    writeFile(join(packageRoot, "README.md"), packageReadme(manifest, definition)),
    writeFile(
      join(packageRoot, "LICENSE"),
      await readFile(join(import.meta.dir, "..", "packages", "artifact-tool", "LICENSE")),
    ),
    writeFile(
      join(packageRoot, "package.json"),
      `${JSON.stringify(packageJson(manifest, definition), null, 2)}\n`,
    ),
  ]);
  if (descriptor.kind === "native") await chmod(join(packageRoot, assetName), 0o755);
  return Object.freeze({ target, packageName: descriptor.packageName, packageRoot, manifest });
}

function packageJson(
  manifest: ArtifactKernelPackageManifest,
  definition: TargetBuildDefinition,
): Record<string, unknown> {
  const files = [
    "LICENSE",
    "README.md",
    ARTIFACT_KERNEL_BUILD_RECEIPT,
    PACKAGE_MANIFEST,
    "index.d.ts",
    "index.js",
    manifest.asset.path,
  ];
  files.push(...manifest.supportFiles.map(({ path }) => path));
  const result: Record<string, unknown> = {
    name: manifest.packageName,
    version: manifest.packageVersion,
    description: `Exact OpenGeni artifact kernel binding for ${manifest.target}.`,
    license: "Apache-2.0",
    repository: {
      type: "git",
      url: "git+https://github.com/Cloudgeni-ai/opengeni.git",
      directory: "packages/artifact-tool/kernel/bindings",
    },
    type: "module",
    sideEffects: false,
    files,
    main: "./index.js",
    module: "./index.js",
    types: "./index.d.ts",
    exports: {
      ".": {
        types: "./index.d.ts",
        import: "./index.js",
        default: "./index.js",
      },
    },
    publishConfig: { access: "public", provenance: true },
    engines: { node: "^18.17.0 || ^20.3.0 || >=21.0.0" },
  };
  if (manifest.kind === "native") {
    result.os = [definition.os];
    result.cpu = [definition.cpu];
    if (definition.libc) result.libc = [definition.libc];
  }
  return result;
}

function nativeEntrypointSource(asset: string, identity: ArtifactKernelPackageIdentity): string {
  return [
    'import { createRequire } from "node:module";',
    'import { fileURLToPath } from "node:url";',
    `export const artifactKernelPackageIdentity = Object.freeze(${JSON.stringify(identity)});`,
    "const require = createRequire(import.meta.url);",
    "let binding;",
    "export function loadArtifactKernelBinding() {",
    `  binding ??= require(fileURLToPath(new URL("./${asset}", import.meta.url)));`,
    "  return binding;",
    "}",
    "",
  ].join("\n");
}

function wasmEntrypointSource(asset: string, identity: ArtifactKernelPackageIdentity): string {
  return [
    `import initialize, * as binding from "./${WASM_GLUE}";`,
    `export const artifactKernelPackageIdentity = Object.freeze(${JSON.stringify(identity)});`,
    `export const editableArtifactKernelAssets = Object.freeze(${renderWasmEditorAssets()});`,
    "let initialization;",
    "export async function loadArtifactKernelBinding() {",
    `  initialization ??= initialize({ module_or_path: new URL("./${asset}", import.meta.url) });`,
    "  await initialization;",
    "  return binding;",
    "}",
    "",
  ].join("\n");
}

function declarationSource(): string {
  return [
    "export declare const artifactKernelPackageIdentity: Readonly<Record<string, unknown>>;",
    'export declare const editableArtifactKernelAssets: Readonly<Record<"spreadsheet" | "document" | "presentation", Readonly<{ wasmGlueUrl: URL; wasmBinaryUrl: URL }>>>;',
    "export declare function loadArtifactKernelBinding(): unknown | Promise<unknown>;",
    "",
  ].join("\n");
}

function renderWasmEditorAssets(): string {
  return `{${Object.entries(WASM_EDITOR_ASSETS)
    .map(
      ([modality, { glue, wasm }]) =>
        `${JSON.stringify(modality)}:Object.freeze({wasmGlueUrl:new URL(${JSON.stringify(`./${glue}`)},import.meta.url),wasmBinaryUrl:new URL(${JSON.stringify(`./${wasm}`)},import.meta.url)})`,
    )
    .join(",")}}`;
}

function packageIdentity(manifest: ArtifactKernelPackageManifest): ArtifactKernelPackageIdentity {
  const {
    schemaVersion,
    target,
    kind,
    packageName,
    packageVersion,
    artifactToolVersion,
    buildIdentity,
  } = manifest;
  return {
    schemaVersion,
    target,
    kind,
    packageName,
    packageVersion,
    artifactToolVersion,
    buildIdentity,
  };
}

function packageReadme(
  manifest: ArtifactKernelPackageManifest,
  definition: TargetBuildDefinition,
): string {
  return [
    `# \`${manifest.packageName}\``,
    "",
    `Exact ${manifest.kind} runtime package for \`${manifest.target}\` (Rust target \`${definition.rustTarget}\`).`,
    "It is selected only by a manifest-pinned OpenGeni host bootstrap; it performs no downloads or fallback resolution.",
    "",
  ].join("\n");
}

async function exactLocalFile(path: string, maximumBytes: number): Promise<Uint8Array> {
  let metadata;
  try {
    metadata = await stat(path);
  } catch (cause) {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_UNAVAILABLE",
      `Requested target asset is missing: ${path}`,
      { cause },
    );
  }
  if (!metadata.isFile() || metadata.size <= 0 || metadata.size > maximumBytes) {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_INTEGRITY",
      `Requested target asset has an invalid size: ${path}`,
    );
  }
  const bytes = new Uint8Array(await readFile(path));
  if (bytes.byteLength !== metadata.size) {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_INTEGRITY",
      `Target asset changed while reading: ${path}`,
    );
  }
  return bytes;
}

function fileDescriptor(path: string, bytes: Uint8Array) {
  return {
    path,
    bytes: bytes.byteLength,
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const,
  };
}

function assertReceiptFiles(
  receipt: ArtifactKernelBuildReceipt,
  files: readonly ReturnType<typeof fileDescriptor>[],
): void {
  const ordered = [...files].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  if (JSON.stringify(ordered) !== JSON.stringify(receipt.runtimeFiles)) {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_INTEGRITY",
      `Target assets differ from the smoke-produced receipt for ${receipt.target}`,
    );
  }
}

function targetDefinition(target: ArtifactRuntimeTarget): TargetBuildDefinition {
  const definition = artifactKernelTargetBuildDefinitions().find(
    (entry) => entry.target === target,
  );
  if (!definition) throw new Error(`Missing build definition for ${target}`);
  return definition;
}

function validateMatrixDefinitions(): void {
  if (targetMatrix.schemaVersion !== 1) throw new Error("Artifact target matrix schema must be 1");
  const runtimeTargets = ARTIFACT_RUNTIME_MATRIX.map(({ target }) => target);
  const buildTargets = targetMatrix.targets.map(({ target }) => target);
  if (JSON.stringify(runtimeTargets) !== JSON.stringify(buildTargets)) {
    throw new Error("Artifact target build matrix differs from the runtime matrix");
  }
  for (const definition of targetMatrix.targets) {
    const runtime = artifactRuntimeTarget(definition.target as ArtifactRuntimeTarget);
    if (runtime.kind !== definition.kind) {
      throw new Error(`Artifact target kind differs for ${definition.target}`);
    }
  }
}

function assertAbsoluteDirectoryInput(path: string, name: string): void {
  if (!isAbsolute(path)) throw new Error(`${name} must be an absolute path`);
  if (resolve(path) === resolve("/")) throw new Error(`${name} must not be the filesystem root`);
}

type ParsedArguments = MaterializeArtifactKernelPackagesOptions;

function parseArguments(args: readonly string[]): ParsedArguments {
  const values = new Map<string, string[]>();
  const allowed = new Set([
    "--asset-root",
    "--output",
    "--artifact-tool-version",
    "--target",
    "--artifact-tool-integrity",
  ]);
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || value === undefined)
      throw new Error("Every option requires a value");
    if (!allowed.has(name)) throw new Error(`Unknown option: ${name}`);
    const entries = values.get(name) ?? [];
    entries.push(value);
    values.set(name, entries);
  }
  const required = (name: string): string => {
    const entries = values.get(name);
    if (!entries || entries.length !== 1 || entries[0]!.length === 0)
      throw new Error(`${name} is required once`);
    return entries[0]!;
  };
  const targetValues = values.get("--target") ?? [];
  if (targetValues.includes("all") && targetValues.length !== 1) {
    throw new Error("--target all cannot be combined with another target");
  }
  const targets = targetValues.includes("all")
    ? ARTIFACT_RUNTIME_MATRIX.map(({ target }) => target)
    : (targetValues as ArtifactRuntimeTarget[]);
  const integrityValues = values.get("--artifact-tool-integrity") ?? [];
  if (integrityValues.length > 1) throw new Error("--artifact-tool-integrity may be supplied once");
  const integrity = integrityValues[0] as `sha512-${string}` | undefined;
  return {
    assetRoot: required("--asset-root"),
    outputRoot: required("--output"),
    artifactToolVersion: required("--artifact-tool-version"),
    targets,
    ...(integrity ? { artifactToolIntegrity: integrity } : {}),
  };
}

if (import.meta.main) {
  const result = await materializeArtifactKernelPackages(parseArguments(process.argv.slice(2)));
  process.stdout.write(
    `${JSON.stringify({ packages: result.map(({ target, packageName, packageRoot }) => ({ target, packageName, packageRoot })) })}\n`,
  );
}
