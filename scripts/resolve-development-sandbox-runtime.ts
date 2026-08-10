#!/usr/bin/env bun

import { mkdir, mkdtemp, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { verifyArtifactRuntimeContainerInput } from "./verify-artifact-runtime-container-inputs";

const SOURCE_RECEIPT = "artifact-runtime-container-receipt.json";
const MAX_COMMAND_OUTPUT_BYTES = 8 * 1024 * 1024;
const RUNTIME_SOURCE_PATHS = Object.freeze([
  "bun.lock",
  "package.json",
  "packages/artifact-tool",
  "packages/contracts",
  "scripts/assemble-artifact-runtime-container-inputs.ts",
  "scripts/assemble-artifact-runtime-installation.ts",
  "scripts/build-artifact-runtime-target.ts",
  "scripts/materialize-artifact-kernel-packages.ts",
  "scripts/prepare-artifact-sandbox-runtime.ts",
  "scripts/resolve-development-sandbox-runtime.ts",
  "scripts/verify-artifact-runtime-container-inputs.ts",
  "docker/sandbox.Dockerfile",
]);

export type DevelopmentSandboxRuntimeInputs = Readonly<{
  sourceSha: string;
  sourceTag: string;
  outputRoot: string;
  artifactName: string;
  reused: boolean;
}>;

/** Resolve the exact clean-HEAD CI artifact; never guesses or reuses a stale runtime. */
export async function resolveDevelopmentSandboxRuntimeInputs(
  repositoryRootInput: string,
  outputRootInput: string,
): Promise<DevelopmentSandboxRuntimeInputs> {
  requireAbsolute(repositoryRootInput, "repositoryRoot");
  requireAbsolute(outputRootInput, "outputRoot");
  const repositoryRoot = await realpath(repositoryRootInput);
  const outputRoot = resolve(outputRootInput);
  rejectBroadOutput(outputRoot);
  const sourceSha = (await command(["git", "rev-parse", "HEAD"], repositoryRoot)).trim();
  if (!/^[0-9a-f]{40}$/u.test(sourceSha)) throw new Error("Git HEAD is not an exact SHA");
  const dirty = (
    await command(
      ["git", "status", "--porcelain=v1", "--untracked-files=all", "--", ...RUNTIME_SOURCE_PATHS],
      repositoryRoot,
    )
  ).trim();
  if (dirty) {
    throw new Error(
      `Artifact runtime sources differ from clean HEAD; exact sandbox runtime is unavailable:\n${dirty}`,
    );
  }

  const artifactName = `artifact-runtime-containers-${sourceSha}`;
  if (await reusableOutput(outputRoot, sourceSha)) {
    await verifyRuntimeInputs(outputRoot, sourceSha);
    return {
      sourceSha,
      sourceTag: sourceSha.slice(0, 12),
      outputRoot,
      artifactName,
      reused: true,
    };
  }

  const repository = await githubRepository(repositoryRoot);
  const runs = JSON.parse(
    await command(
      [
        "gh",
        "run",
        "list",
        "--repo",
        repository,
        "--workflow",
        "ci.yml",
        "--commit",
        sourceSha,
        "--status",
        "success",
        "--limit",
        "20",
        "--json",
        "databaseId,headSha,createdAt",
      ],
      repositoryRoot,
    ),
  ) as Array<{ databaseId?: unknown; headSha?: unknown; createdAt?: unknown }>;
  const run = runs
    .filter(
      (candidate): candidate is { databaseId: number; headSha: string; createdAt: string } =>
        Number.isSafeInteger(candidate.databaseId) &&
        candidate.headSha === sourceSha &&
        typeof candidate.createdAt === "string",
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  if (!run) {
    throw new Error(`No successful exact-head CI run is available for ${sourceSha}`);
  }

  const parent = dirname(outputRoot);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(join(parent, ".artifact-runtime-download-"));
  try {
    await command(
      [
        "gh",
        "run",
        "download",
        String(run.databaseId),
        "--repo",
        repository,
        "--name",
        artifactName,
        "--dir",
        staging,
      ],
      repositoryRoot,
    );
    await verifyRuntimeInputs(staging, sourceSha);
    await rm(outputRoot, { recursive: true, force: true });
    await rename(staging, outputRoot);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return {
    sourceSha,
    sourceTag: sourceSha.slice(0, 12),
    outputRoot,
    artifactName,
    reused: false,
  };
}

async function verifyRuntimeInputs(root: string, sourceSha: string): Promise<void> {
  await Promise.all(
    (["amd64", "arm64"] as const).map((architecture) =>
      verifyArtifactRuntimeContainerInput(root, sourceSha, architecture),
    ),
  );
}

async function reusableOutput(root: string, sourceSha: string): Promise<boolean> {
  try {
    const receipt = JSON.parse(await readFile(join(root, SOURCE_RECEIPT), "utf8")) as {
      schemaVersion?: unknown;
      sourceSha?: unknown;
    };
    return receipt.schemaVersion === 1 && receipt.sourceSha === sourceSha;
  } catch {
    return false;
  }
}

async function githubRepository(repositoryRoot: string): Promise<string> {
  const remote = (await command(["git", "remote", "get-url", "origin"], repositoryRoot)).trim();
  const match = /github[.]com[/:]([^/]+)\/([^/]+?)(?:[.]git)?$/u.exec(remote);
  if (!match) throw new Error("Origin is not a GitHub repository");
  return `${match[1]}/${match[2]}`;
}

async function command(args: readonly string[], cwd: string): Promise<string> {
  const child = Bun.spawn([...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    readBounded(child.stdout, MAX_COMMAND_OUTPUT_BYTES, () => child.kill()),
    readBounded(child.stderr, MAX_COMMAND_OUTPUT_BYTES, () => child.kill()),
  ]);
  const stderrText = new TextDecoder("utf-8", { fatal: true }).decode(stderr);
  if (exitCode !== 0) {
    throw new Error(`${args[0]} failed: ${stderrText.trim() || `exit ${exitCode}`}`);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(stdout);
}

async function readBounded(
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
        throw new Error("Command returned oversized output");
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

function requireAbsolute(path: string, name: string): void {
  if (!isAbsolute(path)) throw new TypeError(`${name} must be absolute`);
}

function rejectBroadOutput(path: string): void {
  if (path === resolve("/") || path === dirname(path))
    throw new TypeError("outputRoot is too broad");
}

function parseArguments(args: readonly string[]): { repositoryRoot: string; outputRoot: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name || !["--repository-root", "--output"].includes(name) || !value || values.has(name)) {
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
    outputRoot: required("--output"),
  };
}

if (import.meta.main) {
  const options = parseArguments(process.argv.slice(2));
  process.stdout.write(
    `${JSON.stringify(await resolveDevelopmentSandboxRuntimeInputs(options.repositoryRoot, options.outputRoot))}\n`,
  );
}
