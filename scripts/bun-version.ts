#!/usr/bin/env bun

import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type PackageManifest = {
  packageManager?: string;
  devDependencies?: Record<string, string>;
};

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exactVersionPattern = /^\d+\.\d+\.\d+$/u;
const bunImageDigestPattern = /^sha256:[0-9a-f]{64}$/u;

export async function canonicalBunVersion(root = repositoryRoot): Promise<string> {
  const version = (await readFile(join(root, ".bun-version"), "utf8")).trim();
  if (!exactVersionPattern.test(version)) {
    throw new Error(`.bun-version must contain one exact semantic version, received ${version}`);
  }
  return version;
}

export async function verifyBunVersionContract(
  options: {
    root?: string;
    checkRuntime?: boolean;
  } = {},
): Promise<void> {
  const root = options.root ?? repositoryRoot;
  const version = await canonicalBunVersion(root);
  const manifest = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  ) as PackageManifest;

  if (manifest.packageManager !== `bun@${version}`) {
    throw new Error(
      `package.json packageManager must mirror .bun-version as bun@${version}, received ${String(manifest.packageManager)}`,
    );
  }

  const rootTypes = manifest.devDependencies?.["@types/bun"];
  const extensionManifest = JSON.parse(
    await readFile(join(root, "apps/browser-extension/package.json"), "utf8"),
  ) as PackageManifest;
  const extensionTypes = extensionManifest.devDependencies?.["@types/bun"];
  if (!rootTypes || rootTypes !== extensionTypes) {
    throw new Error("root and browser-extension @types/bun ranges must be identical");
  }
  const typeVersion = /^\^(\d+\.\d+\.\d+)$/u.exec(rootTypes)?.[1];
  if (!typeVersion || majorMinor(typeVersion) !== majorMinor(version)) {
    throw new Error(
      `@types/bun must use a caret range from the canonical Bun ${majorMinor(version)} line, received ${rootTypes}`,
    );
  }

  const lock = await readFile(join(root, "bun.lock"), "utf8");
  for (const expected of [`@types/bun@${typeVersion}`, `bun-types@${typeVersion}`]) {
    if (!lock.includes(expected)) throw new Error(`bun.lock does not resolve ${expected}`);
  }

  for (const path of [
    "docker/opengeni.Dockerfile",
    "docker/sandbox.Dockerfile",
    "docker/desktop.Dockerfile",
  ]) {
    const source = await readFile(join(root, path), "utf8");
    if (!source.includes(`ARG BUN_VERSION=${version}`)) {
      throw new Error(`${path} must mirror .bun-version through ARG BUN_VERSION=${version}`);
    }
    const bunBases = source
      .split("\n")
      .filter((line) => /^FROM\s+(?:--platform=\S+\s+)?oven\/bun:/u.test(line));
    if (
      bunBases.length === 0 ||
      bunBases.some(
        (line) => !/^FROM\s+(?:--platform=\S+\s+)?oven\/bun:\$\{BUN_VERSION\}(?:\s|$)/u.test(line),
      )
    ) {
      throw new Error(`${path} must derive every Bun base from BUN_VERSION`);
    }
  }

  const builder = await readFile(
    join(root, "packages/artifact-tool/kernel/bindings/wasm/Dockerfile.builder"),
    "utf8",
  );
  const builderImage = /^ARG BUN_IMAGE=oven\/bun:(\d+\.\d+\.\d+)@(sha256:[0-9a-f]{64})$/mu.exec(
    builder,
  );
  if (
    !builderImage ||
    builderImage[1] !== version ||
    !bunImageDigestPattern.test(builderImage[2]!)
  ) {
    throw new Error("artifact WASM builder must pin the canonical Bun image and one OCI digest");
  }
  if (!builder.includes("FROM ${BUN_IMAGE} AS bun")) {
    throw new Error("artifact WASM builder must consume its digest-pinned BUN_IMAGE argument");
  }

  const workflowDirectory = join(root, ".github/workflows");
  for (const entry of await readdir(workflowDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || (!entry.name.endsWith(".yml") && !entry.name.endsWith(".yaml"))) {
      continue;
    }
    const source = await readFile(join(workflowDirectory, entry.name), "utf8");
    if (/\bbun-version:\s*['"]?\d+\.\d+\.\d+/u.test(source)) {
      throw new Error(`${entry.name} contains a duplicated Bun version instead of .bun-version`);
    }
    verifyWorkflowBunSetup(entry.name, source);
    if (entry.name === "artifact-runtime.yml" || entry.name === "artifact-runtime.yaml") {
      verifyMuslAssetChecksums(version, source);
    }
  }

  if (options.checkRuntime !== false && Bun.version !== version) {
    throw new Error(`running Bun ${Bun.version} does not match canonical Bun ${version}`);
  }
}

export function verifyMuslAssetChecksums(version: string, source: string): void {
  if (!source.includes('-e BUN_VERSION="$BUN_VERSION"')) {
    throw new Error("artifact-runtime must pass the canonical Bun version into musl containers");
  }
  const checksums = new Set<string>();
  for (const archive of ["bun-linux-x64-musl.zip", "bun-linux-aarch64-musl.zip"]) {
    const escapedArchive = archive.replaceAll(".", "\\.");
    const match = new RegExp(
      `bun_archive:\\s*${escapedArchive}\\s*\\n\\s*bun_sha256:\\s*([0-9a-f]{64})\\s+#\\s+bun-v(\\d+\\.\\d+\\.\\d+)`,
      "u",
    ).exec(source);
    if (!match || match[2] !== version) {
      throw new Error(
        `artifact-runtime ${archive} checksum must be annotated for canonical bun-v${version}`,
      );
    }
    checksums.add(match[1]!);
  }
  if (checksums.size !== 2) {
    throw new Error("artifact-runtime musl archives must use distinct SHA-256 checksums");
  }
}

function majorMinor(version: string): string {
  return version.split(".", 2).join(".");
}

export function verifyWorkflowBunSetup(name: string, source: string): void {
  const canonicalVersionFiles = [".bun-version", ".release/controller/.bun-version"];
  const lines = source.split("\n");
  for (const [index, line] of lines.entries()) {
    if (!line.includes("oven-sh/setup-bun@")) continue;
    const actionIndent = line.length - line.trimStart().length;
    const stepLines: string[] = [line];
    for (const candidate of lines.slice(index + 1)) {
      const candidateIndent = candidate.length - candidate.trimStart().length;
      if (/^\s*-\s+/u.test(candidate) && candidateIndent <= actionIndent) break;
      stepLines.push(candidate);
    }
    const versionFile = stepLines
      .map((candidate) => /^\s*bun-version-file:\s*(\S+)\s*$/u.exec(candidate)?.[1])
      .find((candidate) => candidate !== undefined);
    if (!versionFile || !canonicalVersionFiles.includes(versionFile)) {
      throw new Error(
        `${name} setup-bun step must read the canonical source or retained-controller .bun-version file`,
      );
    }
  }
}

if (import.meta.main) {
  await verifyBunVersionContract();
  process.stdout.write(`[bun-version] canonical Bun ${await canonicalBunVersion()} is coherent\n`);
}
