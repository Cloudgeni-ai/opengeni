#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  ARTIFACT_RUNTIME_ENVIRONMENT,
  ArtifactRuntimeError,
  validateArtifactRuntimeInstallationManifest,
  type ArtifactRuntimeInstallationManifest,
  type NativeArtifactRuntimeTarget,
} from "../packages/artifact-tool/src/runtime";
import {
  canonicalArtifactRuntimeInstallationManifestBytes,
  doctorVerifiedArtifactRuntime,
  locateVerifiedArtifactRuntime,
} from "../packages/artifact-tool/src/runtime-cli";
import { resolveCurrentArtifactRuntimeTarget } from "../packages/artifact-tool/src/runtime-cli";

const INSTALLATION_MANIFEST = "installation.json";
const SKILL_FACADE = "skill-facade-entry.mjs";
const RUNTIME_CLI = "opengeni-artifact-runtime.mjs";
const MAX_FACADE_BYTES = 32 * 1024 * 1024;
const MAX_SUPPORT_FILES = 256;
const MAX_SKILL_FACADE_SUPPORT_FILE_BYTES = 128 * 1024 * 1024;
const MAX_SUPPORT_BYTES = 256 * 1024 * 1024;

type FileDescriptor = Readonly<{
  path: string;
  bytes: number;
  sha256: `sha256:${string}`;
}>;

export type PrepareArtifactSandboxRuntimeOptions = Readonly<{
  repositoryRoot: string;
  installationRoot: string;
  outputRoot: string;
}>;

export type PreparedArtifactSandboxRuntime = Readonly<{
  target: NativeArtifactRuntimeTarget;
  manifestPath: string;
  skillFacadeEntrypoint: string;
  runtimeCliEntrypoint: string;
  supportFileCount: number;
  supportBytes: number;
}>;

/**
 * Turn one verified server installation into a self-contained sandbox runtime.
 *
 * The source installation deliberately keeps artifact-tool package resolution
 * external because API/materializer images already own a workspace install.
 * Sandboxes do not. This builder bundles the exact facade implementation,
 * vendors only its two target-native renderer closures, pins every resulting
 * file in the canonical installation manifest, and proves the closure with
 * Node before publication.
 */
export async function prepareArtifactSandboxRuntime(
  options: PrepareArtifactSandboxRuntimeOptions,
): Promise<PreparedArtifactSandboxRuntime> {
  for (const [name, value] of Object.entries(options)) requireAbsolute(value, name);
  rejectBroadOutput(options.outputRoot);

  const repositoryRoot = await realpath(options.repositoryRoot);
  const installationRoot = await realpath(options.installationRoot);
  const manifestPath = join(installationRoot, INSTALLATION_MANIFEST);
  const sourceFacade = join(installationRoot, SKILL_FACADE);
  const sourceEnvironment = runtimeEnvironment(manifestPath, sourceFacade);
  const currentTarget = resolveCurrentArtifactRuntimeTarget();
  if (!isSandboxNativeTarget(currentTarget)) {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_INCOMPATIBLE",
      `Sandbox artifact runtime requires a native target, received ${currentTarget}`,
    );
  }
  const source = await locateVerifiedArtifactRuntime({
    environment: sourceEnvironment,
    expectedTarget: currentTarget,
  });
  const sourceManifest = validateArtifactRuntimeInstallationManifest(
    JSON.parse(await readFile(source.manifestPath, "utf8")) as unknown,
    currentTarget,
  );
  if (!source.artifactToolArchive) {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_INTEGRITY",
      "Sandbox runtime input is missing its exact packed artifact-tool archive",
    );
  }

  const outputParent = dirname(options.outputRoot);
  await mkdir(outputParent, { recursive: true });
  await rejectSymlinkIfPresent(options.outputRoot);
  const extractedArtifactTool = await extractExactArtifactTool(
    repositoryRoot,
    source.artifactToolArchive,
    sourceManifest,
  );
  let stagingRoot: string | undefined;
  try {
    stagingRoot = await mkdtemp(join(outputParent, ".artifact-sandbox-runtime-"));
    await copyVerifiedInstallationFiles(installationRoot, stagingRoot, source, sourceManifest);

    const facade = await bundledEntrypoint(source.skillFacadeEntrypoint, {
      externalKernel: true,
      artifactToolAliases: extractedArtifactTool.aliases,
      outputPath: SKILL_FACADE,
      splitChunks: true,
    });
    if (
      facade.entrypoint.bytes.byteLength <= 0 ||
      facade.entrypoint.bytes.byteLength > MAX_FACADE_BYTES
    ) {
      throw new ArtifactRuntimeError(
        "ARTIFACT_RUNTIME_INTEGRITY",
        "Bundled skill facade has an invalid size",
      );
    }
    await writeBundledEntrypoint(stagingRoot, facade, 0o444);

    const dependencyDescriptors = await stageNativeRendererDependencies(
      repositoryRoot,
      stagingRoot,
      currentTarget,
    );
    const cli = await bundledEntrypoint(
      join(extractedArtifactTool.packageRoot, "dist", "runtime-cli-entry.js"),
      {
        externalKernel: false,
        artifactToolAliases: extractedArtifactTool.aliases,
        outputPath: RUNTIME_CLI,
        splitChunks: false,
      },
    );
    await writeBundledEntrypoint(stagingRoot, cli, 0o555);
    const supportFiles = [
      fileDescriptor(RUNTIME_CLI, cli.entrypoint.bytes),
      ...facade.supportFiles.map((output) => fileDescriptor(output.path, output.bytes)),
      ...dependencyDescriptors,
    ].sort(compareDescriptor);
    const supportBytes = supportFiles.reduce((total, file) => total + file.bytes, 0);
    if (supportFiles.length > MAX_SUPPORT_FILES || supportBytes > MAX_SUPPORT_BYTES) {
      throw new ArtifactRuntimeError(
        "ARTIFACT_RUNTIME_INTEGRITY",
        "Sandbox skill facade support closure exceeds its bounded installation limit",
      );
    }

    const installation: ArtifactRuntimeInstallationManifest = {
      ...sourceManifest,
      artifactToolArchive: sourceManifest.artifactToolArchive,
      skillFacadeEntrypoint: fileDescriptor(SKILL_FACADE, facade.entrypoint.bytes),
      skillFacadeSupportFiles: supportFiles,
    };
    await writeFile(
      join(stagingRoot, INSTALLATION_MANIFEST),
      canonicalArtifactRuntimeInstallationManifestBytes(installation),
      { mode: 0o444 },
    );

    const outputEnvironment = runtimeEnvironment(
      join(stagingRoot, INSTALLATION_MANIFEST),
      join(stagingRoot, SKILL_FACADE),
    );
    await doctorVerifiedArtifactRuntime({
      environment: outputEnvironment,
      expectedTarget: currentTarget,
    });
    await smokeArtifactFacade(join(stagingRoot, SKILL_FACADE));
    await runNodeCli(join(stagingRoot, RUNTIME_CLI), outputEnvironment, currentTarget);
    await makeRuntimeReadOnly(stagingRoot);

    await rm(options.outputRoot, { recursive: true, force: true });
    await rename(stagingRoot, options.outputRoot);
    await rm(extractedArtifactTool.extractionRoot, { recursive: true, force: true });
    return Object.freeze({
      target: currentTarget,
      manifestPath: join(options.outputRoot, INSTALLATION_MANIFEST),
      skillFacadeEntrypoint: join(options.outputRoot, SKILL_FACADE),
      runtimeCliEntrypoint: join(options.outputRoot, RUNTIME_CLI),
      supportFileCount: supportFiles.length,
      supportBytes,
    });
  } catch (error) {
    await Promise.all([
      ...(stagingRoot ? [rm(stagingRoot, { recursive: true, force: true })] : []),
      rm(extractedArtifactTool.extractionRoot, { recursive: true, force: true }),
    ]);
    throw error;
  }
}

type VerifiedSource = Awaited<ReturnType<typeof locateVerifiedArtifactRuntime>>;

async function copyVerifiedInstallationFiles(
  sourceRoot: string,
  outputRoot: string,
  source: VerifiedSource,
  manifest: ArtifactRuntimeInstallationManifest,
): Promise<void> {
  const files = [
    source.releaseManifestPath,
    ...(source.artifactToolArchive ? [source.artifactToolArchive] : []),
    source.kernel.entrypoint,
    source.kernel.asset,
    ...source.kernel.supportFiles,
  ];
  for (const sourcePath of files) {
    const fromRoot = confinedRelativePath(sourceRoot, sourcePath);
    const destination = join(outputRoot, fromRoot);
    await mkdir(dirname(destination), { recursive: true });
    await cp(sourcePath, destination, { errorOnExist: true, force: false });
  }
  const expectedKernelRoot = join(outputRoot, manifest.kernelPackageRoot);
  if (
    !files.some((path) =>
      join(outputRoot, confinedRelativePath(sourceRoot, path)).startsWith(expectedKernelRoot),
    )
  ) {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_INTEGRITY",
      "Verified installation kernel files do not belong to kernelPackageRoot",
    );
  }
}

async function bundledEntrypoint(
  entrypoint: string,
  options: Readonly<{
    externalKernel: boolean;
    artifactToolAliases?: ReadonlyMap<string, string>;
    outputPath: string;
    splitChunks: boolean;
  }>,
): Promise<BundledEntrypointClosure> {
  const plugins: NonNullable<Parameters<typeof Bun.build>[0]["plugins"]> = [];
  const artifactToolAliases = options.artifactToolAliases;
  if (artifactToolAliases) {
    plugins.push({
      name: "exact-packed-artifact-tool",
      setup(builder) {
        builder.onResolve({ filter: /^@opengeni\/artifact-tool(?:\/.*)?$/u }, (args) => {
          const path = artifactToolAliases.get(args.path);
          if (!path) {
            throw new ArtifactRuntimeError(
              "ARTIFACT_RUNTIME_INTEGRITY",
              `Packed artifact-tool does not export ${args.path}`,
            );
          }
          return { path };
        });
      },
    });
  }
  if (options.externalKernel) {
    plugins.push({
      name: "artifact-kernel-installation-boundary",
      setup(builder) {
        builder.onResolve({ filter: /kernel\/index[.]js$/u }, (args) => {
          if (args.path !== "./kernel/index.js") return undefined;
          return { path: args.path, external: true };
        });
      },
    });
  }
  const result = await Bun.build({
    entrypoints: [entrypoint],
    target: "node",
    format: "esm",
    packages: "bundle",
    minify: true,
    sourcemap: "none",
    splitting: options.splitChunks,
    naming: options.splitChunks
      ? {
          entry: options.outputPath,
          chunk: "artifact-tool/[name]-[hash].mjs",
        }
      : { entry: options.outputPath },
    plugins,
  });
  if (!result.success) {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_UNAVAILABLE",
      `Could not bundle sandbox runtime entrypoint: ${result.logs.map(String).join("; ")}`,
    );
  }
  const outputs = await Promise.all(
    result.outputs.map(async (output): Promise<BundledOutput> => {
      const path = confinedBundlerOutputPath(output.path);
      return { path, kind: output.kind, bytes: new Uint8Array(await output.arrayBuffer()) };
    }),
  );
  const entryOutputs = outputs.filter((output) => output.kind === "entry-point");
  const supportFiles = outputs.filter((output) => output.kind === "chunk").sort(compareOutput);
  if (
    entryOutputs.length !== 1 ||
    entryOutputs[0]!.path !== options.outputPath ||
    outputs.length !== entryOutputs.length + supportFiles.length ||
    (!options.splitChunks && supportFiles.length !== 0) ||
    new Set(outputs.map((output) => output.path)).size !== outputs.length
  ) {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_INTEGRITY",
      "Sandbox runtime bundler emitted an unexpected output closure",
    );
  }
  for (const output of outputs) {
    if (
      output.bytes.byteLength <= 0 ||
      output.bytes.byteLength > MAX_SKILL_FACADE_SUPPORT_FILE_BYTES
    ) {
      throw new ArtifactRuntimeError(
        "ARTIFACT_RUNTIME_INTEGRITY",
        "Sandbox runtime bundler emitted an invalid output size",
      );
    }
  }
  return { entrypoint: entryOutputs[0]!, supportFiles };
}

type BundledOutput = Readonly<{
  path: string;
  kind: BuildArtifact["kind"];
  bytes: Uint8Array;
}>;

type BundledEntrypointClosure = Readonly<{
  entrypoint: BundledOutput;
  supportFiles: readonly BundledOutput[];
}>;

async function writeBundledEntrypoint(
  root: string,
  closure: BundledEntrypointClosure,
  entrypointMode: number,
): Promise<void> {
  for (const output of [closure.entrypoint, ...closure.supportFiles]) {
    const destination = join(root, output.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, output.bytes, {
      mode: output.kind === "entry-point" ? entrypointMode : 0o444,
    });
  }
}

function confinedBundlerOutputPath(path: string): string {
  const normalized = path.startsWith("./") ? path.slice(2) : path;
  if (
    !normalized ||
    isAbsolute(normalized) ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_INTEGRITY",
      "Sandbox runtime bundler emitted an invalid output path",
    );
  }
  return normalized;
}

function compareOutput(left: BundledOutput, right: BundledOutput): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

type ExtractedArtifactTool = Readonly<{
  extractionRoot: string;
  packageRoot: string;
  aliases: ReadonlyMap<string, string>;
}>;

async function extractExactArtifactTool(
  repositoryRoot: string,
  archivePath: string,
  manifest: ArtifactRuntimeInstallationManifest,
): Promise<ExtractedArtifactTool> {
  const temporaryParent = join(repositoryRoot, ".opengeni");
  await mkdir(temporaryParent, { recursive: true });
  const extractionRoot = await mkdtemp(join(temporaryParent, ".sandbox-artifact-tool-"));
  try {
    const listing = await runBoundedCommand(["tar", "-tzf", archivePath], repositoryRoot);
    if (listing.byteLength > 4 * 1024 * 1024) {
      throw new ArtifactRuntimeError(
        "ARTIFACT_RUNTIME_INTEGRITY",
        "Packed artifact-tool archive contains an oversized file listing",
      );
    }
    const paths = new TextDecoder("utf-8", { fatal: true })
      .decode(listing)
      .split("\n")
      .filter(Boolean);
    if (paths.length === 0 || paths.length > 16_384 || !paths.every(isConfinedPackagePath)) {
      throw new ArtifactRuntimeError(
        "ARTIFACT_RUNTIME_INTEGRITY",
        "Packed artifact-tool archive contains an invalid path closure",
      );
    }
    await runBoundedCommand(
      [
        "tar",
        "-xzf",
        archivePath,
        "--directory",
        extractionRoot,
        "--no-same-owner",
        "--no-same-permissions",
      ],
      repositoryRoot,
    );
    const packageRoot = await realpath(join(extractionRoot, "package"));
    await regularFiles(packageRoot);
    const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
      name?: unknown;
      version?: unknown;
      exports?: unknown;
    };
    if (
      packageJson.name !== manifest.artifactTool.packageName ||
      packageJson.version !== manifest.artifactTool.packageVersion
    ) {
      throw new ArtifactRuntimeError(
        "ARTIFACT_RUNTIME_INTEGRITY",
        "Packed artifact-tool package identity differs from its installation manifest",
      );
    }
    const aliases = await packedArtifactToolAliases(
      packageRoot,
      manifest.artifactTool.packageName,
      packageJson.exports,
    );
    for (const entry of ["dist/runtime-cli-entry.js"]) {
      await realpath(join(packageRoot, entry));
    }
    // The packed package is the exact executable source authority. Its bare
    // imports still resolve through the exact source tree's frozen-lockfile
    // dependency installation while Bun produces one pinned output bundle.
    // This build-only link never enters the prepared runtime closure.
    await symlink(
      await realpath(join(repositoryRoot, "packages", "artifact-tool", "node_modules")),
      join(packageRoot, "node_modules"),
      "dir",
    );
    return { extractionRoot, packageRoot, aliases };
  } catch (error) {
    await rm(extractionRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function packedArtifactToolAliases(
  packageRoot: string,
  packageName: string,
  rawExports: unknown,
): Promise<ReadonlyMap<string, string>> {
  if (!rawExports || typeof rawExports !== "object" || Array.isArray(rawExports)) {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_INTEGRITY",
      "Packed artifact-tool has an invalid export map",
    );
  }
  const aliases = new Map<string, string>();
  for (const [subpath, rawEntry] of Object.entries(rawExports)) {
    if (
      (subpath !== "." && !/^[.]\/[a-z0-9/-]+$/u.test(subpath)) ||
      !rawEntry ||
      typeof rawEntry !== "object" ||
      Array.isArray(rawEntry)
    ) {
      throw new ArtifactRuntimeError(
        "ARTIFACT_RUNTIME_INTEGRITY",
        "Packed artifact-tool has an invalid export map entry",
      );
    }
    const entry = rawEntry as Record<string, unknown>;
    if (
      Object.keys(entry).sort().join(",") !== "default,types" ||
      typeof entry.default !== "string" ||
      entry.types !== entry.default
    ) {
      throw new ArtifactRuntimeError(
        "ARTIFACT_RUNTIME_INTEGRITY",
        "Packed artifact-tool export conditions are unsupported",
      );
    }
    const sourceMatch = /^[.]\/src\/([a-z0-9-]+)[.]ts$/u.exec(entry.default);
    if (!sourceMatch) {
      throw new ArtifactRuntimeError(
        "ARTIFACT_RUNTIME_INTEGRITY",
        "Packed artifact-tool export path is unsupported",
      );
    }
    const resolved = await realpath(join(packageRoot, "dist", `${sourceMatch[1]}.js`));
    confinedRelativePath(packageRoot, resolved);
    const specifier = subpath === "." ? packageName : `${packageName}${subpath.slice(1)}`;
    aliases.set(specifier, resolved);
  }
  if (!aliases.has(packageName)) {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_INTEGRITY",
      "Packed artifact-tool export map is missing its root entry",
    );
  }
  return aliases;
}

function isConfinedPackagePath(path: string): boolean {
  if (path.includes("\\") || (!path.startsWith("package/") && path !== "package")) return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

async function runBoundedCommand(command: readonly string[], cwd: string): Promise<Uint8Array> {
  const child = Bun.spawn([...command], { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    readBoundedStream(child.stdout, 4 * 1024 * 1024, () => child.kill()),
    readBoundedStream(child.stderr, 4 * 1024 * 1024, () => child.kill()),
  ]);
  const stderrText = new TextDecoder("utf-8", { fatal: true }).decode(stderr);
  if (exitCode !== 0) {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_INTEGRITY",
      `Sandbox runtime archive command failed: ${stderrText.trim() || command[0]}`,
    );
  }
  return stdout;
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
  cancelProcess: () => void,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        cancelProcess();
        throw new ArtifactRuntimeError(
          "ARTIFACT_RUNTIME_INTEGRITY",
          "Sandbox runtime archive command returned oversized output",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

type RendererDependencySet = Readonly<{
  resvg: string;
  sharp: string;
  sharpLibvips: string;
}>;

export function rendererDependenciesForTarget(
  target: NativeArtifactRuntimeTarget,
): RendererDependencySet {
  switch (target) {
    case "linux-x64-gnu":
      return {
        resvg: "@resvg/resvg-js-linux-x64-gnu",
        sharp: "@img/sharp-linux-x64",
        sharpLibvips: "@img/sharp-libvips-linux-x64",
      };
    case "linux-arm64-gnu":
      return {
        resvg: "@resvg/resvg-js-linux-arm64-gnu",
        sharp: "@img/sharp-linux-arm64",
        sharpLibvips: "@img/sharp-libvips-linux-arm64",
      };
    case "darwin-x64":
      return {
        resvg: "@resvg/resvg-js-darwin-x64",
        sharp: "@img/sharp-darwin-x64",
        sharpLibvips: "@img/sharp-libvips-darwin-x64",
      };
    case "darwin-arm64":
      return {
        resvg: "@resvg/resvg-js-darwin-arm64",
        sharp: "@img/sharp-darwin-arm64",
        sharpLibvips: "@img/sharp-libvips-darwin-arm64",
      };
    default:
      throw new ArtifactRuntimeError(
        "ARTIFACT_RUNTIME_INCOMPATIBLE",
        `Portable sandbox renderer dependencies are unavailable for ${target}`,
      );
  }
}

async function stageNativeRendererDependencies(
  repositoryRoot: string,
  outputRoot: string,
  target: NativeArtifactRuntimeTarget,
): Promise<FileDescriptor[]> {
  const selected = rendererDependenciesForTarget(target);
  const artifactToolNodeModules = join(repositoryRoot, "packages", "artifact-tool", "node_modules");
  const resvgRoot = await realpath(join(artifactToolNodeModules, "@resvg", "resvg-js"));
  const resvgNodeModules = dirname(dirname(resvgRoot));
  const sharpRoot = await realpath(join(artifactToolNodeModules, "sharp"));
  const sharpNodeModules = dirname(sharpRoot);
  const packages = new Map<string, string>([
    ["@resvg/resvg-js", resvgRoot],
    [selected.resvg, join(resvgNodeModules, selected.resvg)],
    ["sharp", sharpRoot],
    ["@img/colour", join(sharpNodeModules, "@img", "colour")],
    [selected.sharp, join(sharpNodeModules, selected.sharp)],
    [selected.sharpLibvips, join(sharpNodeModules, selected.sharpLibvips)],
    ["detect-libc", join(sharpNodeModules, "detect-libc")],
    ["semver", join(sharpNodeModules, "semver")],
  ]);

  for (const [packageName, unresolvedSource] of packages) {
    const source = await realpath(unresolvedSource).catch((cause) => {
      throw new ArtifactRuntimeError(
        "ARTIFACT_RUNTIME_UNAVAILABLE",
        `Locked renderer dependency ${packageName} is unavailable for ${target}`,
        { cause },
      );
    });
    const destination = join(outputRoot, "node_modules", ...packageName.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination, {
      recursive: true,
      dereference: true,
      errorOnExist: true,
      force: false,
    });
    const packageJson = JSON.parse(await readFile(join(destination, "package.json"), "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    if (packageJson.name !== packageName || typeof packageJson.version !== "string") {
      throw new ArtifactRuntimeError(
        "ARTIFACT_RUNTIME_INTEGRITY",
        `Renderer dependency ${packageName} has an invalid package identity`,
      );
    }
  }

  const dependencyRoot = join(outputRoot, "node_modules");
  const files = await regularFiles(dependencyRoot);
  const descriptors: FileDescriptor[] = [];
  let totalBytes = 0;
  for (const file of files) {
    const before = await lstat(file);
    if (!before.isFile() || before.size <= 0 || before.size > MAX_SUPPORT_BYTES) {
      throw new ArtifactRuntimeError(
        "ARTIFACT_RUNTIME_INTEGRITY",
        "Sandbox runtime support closure contains a file with an invalid size",
      );
    }
    totalBytes += before.size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_SUPPORT_BYTES) {
      throw new ArtifactRuntimeError(
        "ARTIFACT_RUNTIME_INTEGRITY",
        "Sandbox runtime support closure exceeds its bounded installation limit",
      );
    }
    const bytes = new Uint8Array(await readFile(file));
    const after = await lstat(file);
    if (after.size !== before.size || bytes.byteLength !== before.size) {
      throw new ArtifactRuntimeError(
        "ARTIFACT_RUNTIME_INTEGRITY",
        "Sandbox runtime support closure changed while it was being hashed",
      );
    }
    descriptors.push(fileDescriptor(confinedRelativePath(outputRoot, file), bytes));
  }
  return descriptors;
}

async function regularFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new ArtifactRuntimeError(
          "ARTIFACT_RUNTIME_INTEGRITY",
          "Sandbox runtime support closure contains a symbolic link",
        );
      }
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) result.push(path);
      else {
        throw new ArtifactRuntimeError(
          "ARTIFACT_RUNTIME_INTEGRITY",
          "Sandbox runtime support closure contains a non-regular file",
        );
      }
    }
  };
  await visit(root);
  return result.sort();
}

async function smokeArtifactFacade(entrypoint: string): Promise<void> {
  const module = (await import(
    `${pathToFileURL(entrypoint).href}?smoke=${Date.now()}`
  )) as typeof import("../packages/artifact-tool/src/index");
  const workbook = module.Workbook.create();
  const sheet = workbook.worksheets.add("Smoke");
  sheet.getRange("A1:B2").values = [
    ["Value", "Formula"],
    [2, 3],
  ];
  const xlsx = await module.SpreadsheetFile.exportXlsx(workbook);
  const importedWorkbook = await module.SpreadsheetFile.importXlsx(xlsx);
  if (importedWorkbook.worksheets.getItem("Smoke").getRange("A2").values[0]?.[0] !== 2) {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_INCOMPATIBLE",
      "Sandbox runtime XLSX round-trip smoke returned the wrong value",
    );
  }
  await assertRasterContainsGlyphs(
    await importedWorkbook.render({ sheetName: "Smoke", range: "A1:B2", scale: 1 }),
    entrypoint,
    "imported XLSX",
  );

  const document = module.Document.create();
  document.blocks.addParagraph("OpenGeni artifact runtime smoke");
  const docx = await module.DocumentFile.exportDocx(document);
  const importedDocument = await module.DocumentFile.importDocx(docx);
  if (!JSON.stringify(importedDocument.toJSON()).includes("OpenGeni artifact runtime smoke")) {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_INCOMPATIBLE",
      "Sandbox runtime DOCX round-trip smoke returned the wrong text",
    );
  }
  await assertRasterContainsGlyphs(
    await importedDocument.render({ format: "png", scale: 1 }),
    entrypoint,
    "imported DOCX",
  );

  const presentation = module.Presentation.create({
    slideSize: { width: 1280, height: 720 },
  });
  const slide = presentation.slides.add();
  slide.shapes.add({
    geometry: "textbox",
    text: "OpenGeni artifact runtime smoke",
    position: { left: 80, top: 70, width: 800, height: 90 },
  });
  const pptx = await module.PresentationFile.exportPptx(presentation);
  const importedPresentation = await module.PresentationFile.importPptx(pptx);
  if (
    importedPresentation.slides.items[0]?.shapes.items[0]?.text.toString() !==
    "OpenGeni artifact runtime smoke"
  ) {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_INCOMPATIBLE",
      "Sandbox runtime PPTX round-trip smoke returned the wrong text",
    );
  }
  const importedSlide = importedPresentation.slides.items[0];
  if (!importedSlide) {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_INCOMPATIBLE",
      "Sandbox runtime PPTX round-trip smoke lost its slide",
    );
  }
  await assertRasterContainsGlyphs(
    await importedSlide.export({ format: "png", scale: 1 }),
    entrypoint,
    "imported PPTX",
  );
  const importedWebp = new Uint8Array(
    await (await importedSlide.export({ format: "webp", scale: 1 })).arrayBuffer(),
  );
  if (
    new TextDecoder().decode(importedWebp.subarray(0, 4)) !== "RIFF" ||
    new TextDecoder().decode(importedWebp.subarray(8, 12)) !== "WEBP"
  ) {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_INCOMPATIBLE",
      "Sandbox runtime imported PPTX WebP smoke returned an invalid image",
    );
  }
}

async function assertRasterContainsGlyphs(
  blob: Blob,
  entrypoint: string,
  label: string,
): Promise<void> {
  const sharpEntrypoint = createRequire(entrypoint).resolve("sharp");
  const { default: sharp } = (await import(pathToFileURL(sharpEntrypoint).href)) as {
    default: (input: Uint8Array) => {
      flatten(options: { background: string }): {
        greyscale(): {
          raw(): { toBuffer(): Promise<Uint8Array> };
        };
      };
    };
  };
  const pixels = await sharp(new Uint8Array(await blob.arrayBuffer()))
    .flatten({ background: "#ffffff" })
    .greyscale()
    .raw()
    .toBuffer();
  let darkPixels = 0;
  for (const value of pixels) if (value < 160) darkPixels += 1;
  if (darkPixels < 10) {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_INCOMPATIBLE",
      `Sandbox runtime ${label} raster omitted its text glyphs`,
    );
  }
}

async function runNodeCli(
  entrypoint: string,
  environment: Readonly<Record<string, string>>,
  expectedTarget: NativeArtifactRuntimeTarget,
): Promise<void> {
  const processHandle = Bun.spawn(["node", entrypoint, "doctor", "--json"], {
    env: { ...process.env, ...environment, NODE_ENV: "production" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_UNAVAILABLE",
      `Sandbox runtime CLI doctor failed: ${stderr.trim() || stdout.trim()}`,
    );
  }
  const report = JSON.parse(stdout) as { target?: unknown };
  if (report.target !== expectedTarget) {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_INTEGRITY",
      "Sandbox runtime CLI doctor returned an invalid report",
    );
  }
}

async function makeRuntimeReadOnly(root: string): Promise<void> {
  const visit = async (path: string): Promise<void> => {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      throw new ArtifactRuntimeError(
        "ARTIFACT_RUNTIME_INTEGRITY",
        "Sandbox runtime contains a symbolic link",
      );
    }
    if (metadata.isDirectory()) {
      for (const entry of await readdir(path)) await visit(join(path, entry));
      await chmod(path, 0o555);
      return;
    }
    if (!metadata.isFile()) {
      throw new ArtifactRuntimeError(
        "ARTIFACT_RUNTIME_INTEGRITY",
        "Sandbox runtime contains a non-regular file",
      );
    }
    await chmod(path, path.endsWith(RUNTIME_CLI) ? 0o555 : 0o444);
  };
  await visit(root);
}

function runtimeEnvironment(manifest: string, entrypoint: string): Record<string, string> {
  return {
    [ARTIFACT_RUNTIME_ENVIRONMENT.manifest]: manifest,
    [ARTIFACT_RUNTIME_ENVIRONMENT.toolEntrypoint]: entrypoint,
  };
}

function isSandboxNativeTarget(value: string): value is NativeArtifactRuntimeTarget {
  return value !== "wasm-web";
}

function fileDescriptor(path: string, bytes: Uint8Array): FileDescriptor {
  return {
    path,
    bytes: bytes.byteLength,
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

function compareDescriptor(left: FileDescriptor, right: FileDescriptor): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function confinedRelativePath(root: string, path: string): string {
  const result = relative(root, path);
  if (!result || result === ".." || result.startsWith(`..${sep}`) || isAbsolute(result)) {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_INTEGRITY",
      "Sandbox runtime source escapes its verified installation root",
    );
  }
  return result;
}

function requireAbsolute(path: string, name: string): void {
  if (!isAbsolute(path)) throw new TypeError(`${name} must be absolute`);
}

function rejectBroadOutput(path: string): void {
  const normalized = resolve(path);
  if (normalized === resolve("/") || normalized === dirname(normalized)) {
    throw new TypeError("outputRoot is too broad");
  }
}

async function rejectSymlinkIfPresent(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink())
      throw new TypeError("outputRoot must not be a symlink");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function parseArguments(args: readonly string[]): PrepareArtifactSandboxRuntimeOptions {
  const values = new Map<string, string>();
  const allowed = new Set(["--repository-root", "--installation-root", "--output"]);
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name || !allowed.has(name) || !value || values.has(name)) {
      throw new TypeError(`Invalid or duplicate option: ${name ?? "<missing>"}`);
    }
    values.set(name, value);
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (!value) throw new TypeError(`${name} is required`);
    return value;
  };
  return {
    repositoryRoot: required("--repository-root"),
    installationRoot: required("--installation-root"),
    outputRoot: required("--output"),
  };
}

if (import.meta.main) {
  const result = await prepareArtifactSandboxRuntime(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
