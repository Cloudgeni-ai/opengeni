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

function keepsArtifactWorkloadPackagesCoalesced(source: string): boolean {
  const sourceBase = stage(source, "source-base");
  const base = stage(source, "base");
  const artifactRuntimeBase = stage(source, "artifact-runtime-base");
  const api = stage(source, "api");
  const materializer = stage(source, "artifact-materializer");

  return (
    sourceBase.startsWith("FROM oven/bun:1.3.14 AS source-base") &&
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
      "apt-get install -y --no-install-recommends ca-certificates ffmpeg git openssh-client",
    ) &&
    aptTransactions(materializer) === 1 &&
    materializer.includes(
      "apt-get install -y --no-install-recommends bubblewrap ca-certificates git openssh-client util-linux",
    )
  );
}

describe("workload image system package contract", () => {
  test("coalesces artifact-runtime workload packages without weakening their runtime base", async () => {
    const dockerfile = await readFile(resolve(root, "docker/opengeni.Dockerfile"), "utf8");

    expect(keepsArtifactWorkloadPackagesCoalesced(dockerfile)).toBe(true);

    const inheritedCommonInstall = dockerfile.replace(
      "FROM source-base AS artifact-runtime-base",
      "FROM base AS artifact-runtime-base",
    );
    expect(keepsArtifactWorkloadPackagesCoalesced(inheritedCommonInstall)).toBe(false);

    const missingApiRuntimeTools = dockerfile.replace(
      "ca-certificates ffmpeg git openssh-client",
      "ffmpeg",
    );
    expect(keepsArtifactWorkloadPackagesCoalesced(missingApiRuntimeTools)).toBe(false);

    const duplicateApiTransaction = dockerfile.replace(
      "FROM artifact-runtime-base AS api\n",
      "FROM artifact-runtime-base AS api\nRUN apt-get update && rm -rf /var/lib/apt/lists/*\n",
    );
    expect(keepsArtifactWorkloadPackagesCoalesced(duplicateApiTransaction)).toBe(false);
  });
});
