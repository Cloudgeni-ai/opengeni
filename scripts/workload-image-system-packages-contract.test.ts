import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function stage(source: string, name: string): string {
  const marker = new RegExp(`^FROM\\s+.+\\s+AS\\s+${name}$`, "mu");
  const match = marker.exec(source);
  if (!match) return "";
  const next = source.slice(match.index + match[0].length).search(/^FROM\s+/mu);
  return next < 0
    ? source.slice(match.index)
    : source.slice(match.index, match.index + match[0].length + next);
}

function aptTransactions(source: string): number {
  return source.match(/RUN apt-get update/gmu)?.length ?? 0;
}

function keepsSpecializedWorkloadPackagesCoalesced(source: string): boolean {
  const sourceBase = stage(source, "source-base");
  const base = stage(source, "base");
  const artifactRuntimeBase = stage(source, "artifact-runtime-base");
  const api = stage(source, "api");
  const worker = stage(source, "worker");
  const materializer = stage(source, "artifact-materializer");

  return (
    sourceBase.startsWith("FROM oven/bun:${BUN_VERSION} AS source-base") &&
    sourceBase.includes("RUN bun install --frozen-lockfile") &&
    aptTransactions(sourceBase) === 0 &&
    base.startsWith("FROM source-base AS base") &&
    aptTransactions(base) === 1 &&
    base.includes(
      "apt-get install -y --no-install-recommends ca-certificates git openssh-client",
    ) &&
    artifactRuntimeBase.startsWith("FROM source-base AS artifact-runtime-base") &&
    aptTransactions(artifactRuntimeBase) === 0 &&
    artifactRuntimeBase.includes(
      "RUN bun packages/artifact-tool/src/runtime-cli-entry.ts doctor --json",
    ) &&
    aptTransactions(api) === 1 &&
    api.includes(
      "apt-get install -y --no-install-recommends ca-certificates curl ffmpeg git gnupg openssh-client",
    ) &&
    api.includes("apt-get install -y --no-install-recommends docker-ce-cli") &&
    api.includes("docker --version") &&
    worker.startsWith("FROM source-base AS worker") &&
    aptTransactions(worker) === 1 &&
    worker.includes(
      "apt-get install -y --no-install-recommends ca-certificates curl ffmpeg git gnupg openssh-client python3",
    ) &&
    worker.includes("apt-get install -y --no-install-recommends docker-ce-cli") &&
    worker.includes("/usr/bin/python3 -c 'import pty'") &&
    aptTransactions(materializer) === 1 &&
    materializer.includes(
      "apt-get install -y --no-install-recommends bubblewrap ca-certificates git openssh-client util-linux",
    )
  );
}

describe("workload image system package contract", () => {
  test("coalesces specialized workload packages without weakening their runtime base", async () => {
    const dockerfile = await readFile(resolve(root, "docker/opengeni.Dockerfile"), "utf8");

    expect(keepsSpecializedWorkloadPackagesCoalesced(dockerfile)).toBe(true);

    const inheritedCommonInstall = dockerfile.replace(
      "FROM source-base AS artifact-runtime-base",
      "FROM base AS artifact-runtime-base",
    );
    expect(keepsSpecializedWorkloadPackagesCoalesced(inheritedCommonInstall)).toBe(false);

    const missingApiRuntimeTools = dockerfile.replace(
      "ca-certificates curl ffmpeg git gnupg openssh-client",
      "ffmpeg",
    );
    expect(keepsSpecializedWorkloadPackagesCoalesced(missingApiRuntimeTools)).toBe(false);

    const missingApiDockerCli = dockerfile.replace(
      "apt-get install -y --no-install-recommends docker-ce-cli",
      "true",
    );
    expect(keepsSpecializedWorkloadPackagesCoalesced(missingApiDockerCli)).toBe(false);

    const duplicateApiTransaction = dockerfile.replace(
      "FROM artifact-runtime-base AS api\n",
      "FROM artifact-runtime-base AS api\nRUN apt-get update && rm -rf /var/lib/apt/lists/*\n",
    );
    expect(keepsSpecializedWorkloadPackagesCoalesced(duplicateApiTransaction)).toBe(false);

    const inheritedWorkerCommonInstall = dockerfile.replace(
      "FROM source-base AS worker",
      "FROM base AS worker",
    );
    expect(keepsSpecializedWorkloadPackagesCoalesced(inheritedWorkerCommonInstall)).toBe(false);

    const missingWorkerSourceControlTools = dockerfile.replace(
      "ca-certificates curl ffmpeg git gnupg openssh-client python3",
      "ca-certificates curl ffmpeg gnupg python3",
    );
    expect(keepsSpecializedWorkloadPackagesCoalesced(missingWorkerSourceControlTools)).toBe(false);

    const duplicateWorkerTransaction = dockerfile.replace(
      "FROM source-base AS worker\n",
      "FROM source-base AS worker\nRUN apt-get update && rm -rf /var/lib/apt/lists/*\n",
    );
    expect(keepsSpecializedWorkloadPackagesCoalesced(duplicateWorkerTransaction)).toBe(false);
  });
});
