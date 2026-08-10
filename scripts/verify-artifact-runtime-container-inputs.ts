#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { ARTIFACT_RUNTIME_ENVIRONMENT } from "../packages/artifact-tool/src/runtime";
import { locateVerifiedArtifactRuntime } from "../packages/artifact-tool/src/runtime-cli";
import { ARTIFACT_RUNTIME_CONTAINER_TARGETS } from "./assemble-artifact-runtime-container-inputs";

type ContainerArchitecture = keyof typeof ARTIFACT_RUNTIME_CONTAINER_TARGETS;
const CONTAINER_ARCHITECTURES = ["amd64", "arm64"] as const;
const MAX_CONTAINER_RECEIPT_BYTES = 64 * 1024;

type ArtifactRuntimeContainerReceipt = Readonly<{
  schemaVersion: 1;
  sourceSha: string;
  installations: readonly Readonly<{
    architecture: ContainerArchitecture;
    installationSha256: `sha256:${string}`;
  }>[];
}>;

export function validateArtifactRuntimeContainerReceipt(
  value: unknown,
): ArtifactRuntimeContainerReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Artifact runtime container receipt is invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "installations,schemaVersion,sourceSha" ||
    record.schemaVersion !== 1 ||
    typeof record.sourceSha !== "string" ||
    !/^[0-9a-f]{40}$/u.test(record.sourceSha) ||
    !Array.isArray(record.installations) ||
    record.installations.length !== CONTAINER_ARCHITECTURES.length
  ) {
    throw new Error("Artifact runtime container receipt is invalid");
  }
  const installations = record.installations.map((rawInstallation, index) => {
    if (!rawInstallation || typeof rawInstallation !== "object" || Array.isArray(rawInstallation)) {
      throw new Error("Artifact runtime container receipt is invalid");
    }
    const entry = rawInstallation as Record<string, unknown>;
    if (
      Object.keys(entry).sort().join(",") !== "architecture,installationSha256" ||
      entry.architecture !== CONTAINER_ARCHITECTURES[index] ||
      typeof entry.installationSha256 !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(entry.installationSha256)
    ) {
      throw new Error("Artifact runtime container receipt is invalid");
    }
    return {
      architecture: entry.architecture,
      installationSha256: entry.installationSha256,
    } as const;
  });
  return Object.freeze({
    schemaVersion: 1,
    sourceSha: record.sourceSha,
    installations: Object.freeze(installations),
  });
}

export async function verifyArtifactRuntimeContainerInput(
  rootInput: string,
  sourceSha: string,
  architecture: ContainerArchitecture,
): Promise<void> {
  if (!isAbsolute(rootInput)) throw new TypeError("root must be absolute");
  if (!/^[0-9a-f]{40}$/u.test(sourceSha)) throw new TypeError("sourceSha must be exact");
  const target = ARTIFACT_RUNTIME_CONTAINER_TARGETS[architecture];
  if (!target) throw new TypeError("architecture must be amd64 or arm64");
  const root = await realpath(rootInput);
  const receiptPath = join(root, "artifact-runtime-container-receipt.json");
  const receipt = validateArtifactRuntimeContainerReceipt(
    JSON.parse(await readBoundedText(receiptPath, MAX_CONTAINER_RECEIPT_BYTES)) as unknown,
  );
  if (receipt.sourceSha !== sourceSha) {
    throw new Error("Artifact runtime container receipt differs from the exact source");
  }
  const selected = receipt.installations.find((entry) => entry.architecture === architecture)!;
  const installationRoot = await realpath(join(root, architecture));
  if (installationRoot !== join(root, architecture)) {
    throw new Error("Artifact runtime installation root is not canonical");
  }
  const manifest = join(installationRoot, "installation.json");
  const manifestBytes = new Uint8Array(await readFile(manifest));
  const manifestSha256 = `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`;
  if (selected.installationSha256 !== manifestSha256) {
    throw new Error("Artifact runtime installation differs from its container receipt");
  }
  const location = await locateVerifiedArtifactRuntime({
    environment: {
      [ARTIFACT_RUNTIME_ENVIRONMENT.manifest]: manifest,
      [ARTIFACT_RUNTIME_ENVIRONMENT.toolEntrypoint]: join(
        installationRoot,
        "skill-facade-entry.mjs",
      ),
    },
    expectedTarget: target,
  });
  if (!location.artifactToolArchive) {
    throw new Error("Artifact runtime input is missing its exact packed artifact-tool archive");
  }
}

async function readBoundedText(path: string, maximumBytes: number): Promise<string> {
  const before = await lstat(path);
  if (!before.isFile() || before.size <= 0 || before.size > maximumBytes) {
    throw new Error("Artifact runtime container receipt has an invalid size");
  }
  const bytes = await readFile(path);
  const after = await lstat(path);
  if (after.size !== before.size || bytes.byteLength !== before.size) {
    throw new Error("Artifact runtime container receipt changed while being read");
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

if (import.meta.main) {
  const values = new Map<string, string>();
  const allowed = new Set(["--root", "--source-sha", "--architecture"]);
  for (let index = 0; index < process.argv.slice(2).length; index += 2) {
    const name = process.argv.slice(2)[index];
    const value = process.argv.slice(2)[index + 1];
    if (!name || !allowed.has(name) || !value || values.has(name)) {
      throw new TypeError("Invalid verifier arguments");
    }
    values.set(name, value);
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (!value) throw new TypeError(`${name} is required`);
    return value;
  };
  const architecture = required("--architecture");
  if (architecture !== "amd64" && architecture !== "arm64") {
    throw new TypeError("--architecture must be amd64 or arm64");
  }
  await verifyArtifactRuntimeContainerInput(
    required("--root"),
    required("--source-sha"),
    architecture,
  );
  process.stdout.write(`${JSON.stringify({ architecture, verified: true })}\n`);
}
