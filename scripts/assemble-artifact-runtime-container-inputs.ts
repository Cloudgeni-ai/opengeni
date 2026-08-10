#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { ArtifactRuntimeTarget } from "../packages/artifact-tool/src/runtime";
import { assembleArtifactRuntimeInstallation } from "./assemble-artifact-runtime-installation";

export const ARTIFACT_RUNTIME_CONTAINER_TARGETS = Object.freeze({
  amd64: "linux-x64-gnu",
  arm64: "linux-arm64-gnu",
} as const satisfies Readonly<Record<"amd64" | "arm64", ArtifactRuntimeTarget>>);

export type AssembleArtifactRuntimeContainerInputsOptions = Readonly<{
  releaseManifestPath: string;
  materializedPackagesRoot: string;
  artifactToolTarballPath: string;
  outputRoot: string;
  sourceSha: string;
}>;

type InstallationAssembler = typeof assembleArtifactRuntimeInstallation;

/** Stages the exact glibc runtime roots consumed by oven/bun workload images. */
export async function assembleArtifactRuntimeContainerInputs(
  options: AssembleArtifactRuntimeContainerInputsOptions,
  assemble: InstallationAssembler = assembleArtifactRuntimeInstallation,
): Promise<void> {
  for (const [name, path] of Object.entries({
    releaseManifestPath: options.releaseManifestPath,
    materializedPackagesRoot: options.materializedPackagesRoot,
    artifactToolTarballPath: options.artifactToolTarballPath,
    outputRoot: options.outputRoot,
  })) {
    if (!isAbsolute(path)) throw new TypeError(`${name} must be absolute`);
  }
  if (resolve(options.outputRoot) === resolve("/")) {
    throw new TypeError("outputRoot must not be the filesystem root");
  }
  if (!/^[0-9a-f]{40}$/u.test(options.sourceSha)) {
    throw new TypeError("sourceSha must be an exact lowercase Git SHA");
  }
  await rejectSymlinkIfPresent(options.outputRoot);
  const outputParent = dirname(options.outputRoot);
  await mkdir(outputParent, { recursive: true });
  const stagingRoot = await mkdtemp(join(outputParent, ".artifact-runtime-containers-"));
  try {
    for (const [architecture, target] of Object.entries(ARTIFACT_RUNTIME_CONTAINER_TARGETS)) {
      await assemble({
        releaseManifestPath: options.releaseManifestPath,
        kernelPackageRoot: join(options.materializedPackagesRoot, `artifact-kernel-${target}`),
        artifactToolTarballPath: options.artifactToolTarballPath,
        outputRoot: join(stagingRoot, architecture),
        target,
      });
    }
    const installations = await Promise.all(
      Object.keys(ARTIFACT_RUNTIME_CONTAINER_TARGETS).map(async (architecture) => {
        const bytes = new Uint8Array(
          await readFile(join(stagingRoot, architecture, "installation.json")),
        );
        return {
          architecture,
          installationSha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        };
      }),
    );
    await writeFile(
      join(stagingRoot, "artifact-runtime-container-receipt.json"),
      `${JSON.stringify({ schemaVersion: 1, sourceSha: options.sourceSha, installations }, null, 2)}\n`,
      { mode: 0o444 },
    );
    await rm(options.outputRoot, { recursive: true, force: true });
    await rename(stagingRoot, options.outputRoot);
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
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

function parseArguments(args: readonly string[]): AssembleArtifactRuntimeContainerInputsOptions {
  const values = new Map<string, string>();
  const allowed = new Set([
    "--release-manifest",
    "--materialized-packages-root",
    "--artifact-tool-tarball",
    "--output",
    "--source-sha",
  ]);
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
    releaseManifestPath: required("--release-manifest"),
    materializedPackagesRoot: required("--materialized-packages-root"),
    artifactToolTarballPath: required("--artifact-tool-tarball"),
    outputRoot: required("--output"),
    sourceSha: required("--source-sha"),
  };
}

if (import.meta.main) {
  await assembleArtifactRuntimeContainerInputs(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify({ targets: ARTIFACT_RUNTIME_CONTAINER_TARGETS })}\n`);
}
