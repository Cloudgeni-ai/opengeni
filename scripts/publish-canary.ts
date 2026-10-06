#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import libnpmpublish from "libnpmpublish";

import { lockstepCanaryBase, retiredVersionSet } from "./release/lockstep-version";
import {
  publishableWorkspacePackages,
  repoRoot,
  topologicallySortedPackages,
  type WorkspacePackage,
} from "./publishable-workspaces";

export function workflowCanarySequence(runId?: string, runAttempt?: string): number {
  if (runId === undefined && runAttempt === undefined) return 0;
  if (!runId || !runAttempt || !/^[1-9]\d*$/.test(runId) || !/^[1-9]\d*$/.test(runAttempt)) {
    throw new Error("Canary workflow run identity is invalid");
  }
  const attempt = Number(runAttempt);
  const sequence = Number(runId) * 1000 + attempt;
  if (attempt >= 1000 || !Number.isSafeInteger(sequence)) {
    throw new Error("Canary workflow run identity exceeds the safe sequence range");
  }
  return sequence;
}

export function nextCanaryVersion(
  baseVersion: string,
  lastCanary: string | null,
  minimumSequence = 0,
): string {
  if (!Number.isSafeInteger(minimumSequence) || minimumSequence < 0) {
    throw new Error("Canary minimum sequence is invalid");
  }
  const base = baseVersion.replace(/-canary\.\d+$/, "");
  const prefix = `${base}-canary.`;
  if (lastCanary && lastCanary.startsWith(prefix)) {
    const n = Number(lastCanary.slice(prefix.length));
    if (Number.isSafeInteger(n) && n >= 0) {
      if (minimumSequence > 0 && n >= minimumSequence) {
        throw new Error("Canary workflow attempt is superseded; dispatch a new publication run");
      }
      const next = Math.max(n + 1, minimumSequence);
      if (!Number.isSafeInteger(next)) throw new Error("Canary sequence exhausted");
      return `${prefix}${next}`;
    }
  }
  return `${prefix}${minimumSequence}`;
}

/**
 * Canaries preview the NEXT lockstep release, so their base is the next free
 * patch after the committed version (`1.0.0` -> `1.0.2-canary.N` while the
 * retired `1.0.1` is skipped). They therefore sort after the committed
 * version, even when it is already published, and never reuse a retired base.
 */
export function canaryBasePackages(
  packages: readonly { name: string; version: string }[],
): { name: string; version: string }[] {
  const taken = retiredVersionSet(packages.map((pkg) => pkg.name));
  return packages.map((pkg) => ({
    name: pkg.name,
    version: lockstepCanaryBase(pkg.version, taken),
  }));
}

export function planCanaryVersions(
  packages: readonly { name: string; version: string }[],
  tags: ReadonlyMap<string, string | null>,
  fixedGroups: readonly (readonly string[])[],
  minimumSequence = 0,
): Map<string, string> {
  const versions = new Map(
    packages.map((pkg) => [
      pkg.name,
      nextCanaryVersion(pkg.version, tags.get(pkg.name) ?? null, minimumSequence),
    ]),
  );
  for (const group of fixedGroups) {
    if (group.length === 0) continue;
    const planned = group.map((name) => {
      const version = versions.get(name);
      if (!version) throw new Error(`Fixed canary package is not publishable: ${name}`);
      return version;
    });
    const base = planned[0]!.replace(/-canary\.\d+$/, "");
    if (planned.some((version) => !version.startsWith(`${base}-canary.`))) {
      throw new Error(
        `Fixed canary packages must share a committed base version: ${group.join(", ")}`,
      );
    }
    const next = Math.max(
      ...planned.map((version) => Number(version.slice(`${base}-canary.`.length))),
    );
    for (const name of group) versions.set(name, `${base}-canary.${next}`);
  }
  return versions;
}

type RegistryPackage = {
  "dist-tags": { latest?: string; canary?: string };
  versions: Record<
    string,
    {
      dist?: {
        integrity?: string;
        attestations?: { url?: string; provenance?: { predicateType?: string } };
      };
    }
  >;
};
type RegistryRequest = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const registry = "https://registry.npmjs.org";

export function verifyCanarySourceBinding(
  env: Record<string, string | undefined>,
  actualHead: string,
  sourceRoot: string,
  scriptRoot: string,
): void {
  const sha = env.GITHUB_SHA;
  if (
    env.GITHUB_ACTIONS !== "true" ||
    env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    env.GITHUB_REPOSITORY !== "Cloudgeni-ai/opengeni" ||
    env.GITHUB_SERVER_URL !== "https://github.com" ||
    env.GITHUB_REF !== "refs/heads/main" ||
    env.GITHUB_WORKFLOW_REF !==
      "Cloudgeni-ai/opengeni/.github/workflows/publish-canary.yml@refs/heads/main" ||
    !sha ||
    !/^[0-9a-f]{40}$/.test(sha) ||
    sha !== env.GITHUB_WORKFLOW_SHA ||
    sha !== env.SOURCE_SHA ||
    sha !== actualHead ||
    resolve(sourceRoot) !== resolve(scriptRoot) ||
    !env.GITHUB_RUN_ID ||
    !env.GITHUB_RUN_ATTEMPT ||
    !env.ACTIONS_ID_TOKEN_REQUEST_URL ||
    !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ||
    !env.NODE_AUTH_TOKEN
  ) {
    throw new Error("Canary source, workflow, registry auth, and provenance identity must agree");
  }
  workflowCanarySequence(env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT);
}

export async function readRegistryPackage(
  name: string,
  request: RegistryRequest = fetch,
  base = registry,
): Promise<RegistryPackage> {
  const response = await request(`${base}/${encodeURIComponent(name)}`, {
    cache: "no-store",
    headers: { accept: "application/vnd.npm.install-v1+json" },
  });
  if (response.status === 404) return { "dist-tags": {}, versions: {} };
  if (!response.ok) throw new Error(`Registry metadata for ${name} failed: ${response.status}`);
  const json = (await response.json()) as Partial<RegistryPackage>;
  if (
    !json["dist-tags"] ||
    typeof json["dist-tags"] !== "object" ||
    Array.isArray(json["dist-tags"]) ||
    (json["dist-tags"].latest !== undefined && typeof json["dist-tags"].latest !== "string") ||
    (json["dist-tags"].canary !== undefined && typeof json["dist-tags"].canary !== "string") ||
    !json.versions ||
    typeof json.versions !== "object" ||
    Array.isArray(json.versions)
  ) {
    throw new Error(`Registry metadata for ${name} is incomplete`);
  }
  return json as RegistryPackage;
}

export function assertCanaryPlan(
  packages: readonly { name: string }[],
  versions: ReadonlyMap<string, string>,
  metadata: ReadonlyMap<string, RegistryPackage>,
): void {
  for (const pkg of packages) {
    const selected = versions.get(pkg.name);
    const existing = metadata.get(pkg.name);
    if (!selected || !existing) throw new Error(`Missing canary plan for ${pkg.name}`);
    if (Object.hasOwn(existing.versions, selected)) {
      throw new Error(`Canary version already exists for ${pkg.name}`);
    }
  }
}

export async function publishCanaryArtifact(
  manifest: Record<string, unknown>,
  tarball: Buffer,
  token: string,
  publish: typeof libnpmpublish.publish = libnpmpublish.publish,
  targetRegistry = registry,
): Promise<void> {
  if (
    typeof manifest.name !== "string" ||
    typeof manifest.version !== "string" ||
    !/^\d+\.\d+\.\d+-canary\.(0|[1-9]\d*)$/.test(manifest.version) ||
    (manifest.tag !== undefined && manifest.tag !== "canary") ||
    (manifest.publishConfig as Record<string, unknown> | undefined)?.access !== "public" ||
    (manifest.publishConfig as Record<string, unknown> | undefined)?.provenance !== true ||
    ((manifest.publishConfig as Record<string, unknown> | undefined)?.tag !== undefined &&
      (manifest.publishConfig as Record<string, unknown>).tag !== "canary") ||
    !token ||
    tarball.length === 0
  ) {
    throw new Error("Canary package, archive, or registry auth is invalid");
  }
  const response = await publish(manifest, tarball, {
    registry: targetRegistry,
    forceAuth: { token },
    defaultTag: "canary",
    access: "public",
    provenance: true,
  });
  if (!response.ok || !response.transparencyLogUrl) {
    throw new Error(`Canary provenance publication was not confirmed for ${manifest.name}`);
  }
}

export async function confirmCanaryPublication(
  name: string,
  version: string,
  previousLatest: string | undefined,
  tarball: Buffer,
  read: typeof readRegistryPackage = readRegistryPackage,
): Promise<void> {
  const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  for (let attempt = 0; attempt < 6; attempt++) {
    const current = await read(name);
    if (current["dist-tags"].latest !== previousLatest) {
      throw new Error(`Stable tag changed during canary publication for ${name}`);
    }
    if (current["dist-tags"].canary === version && Object.hasOwn(current.versions, version)) {
      const dist = current.versions[version]?.dist;
      if (dist?.integrity && dist.integrity !== integrity) {
        throw new Error(`Canary archive integrity differs for ${name}`);
      }
      if (
        dist?.integrity === integrity &&
        typeof dist.attestations?.url === "string" &&
        dist.attestations.provenance?.predicateType === "https://slsa.dev/provenance/v1"
      ) {
        return;
      }
    }
    await Bun.sleep(1000);
  }
  throw new Error(`Canary registry receipt is unavailable for ${name}`);
}

function writeVersion(pkg: WorkspacePackage, version: string): void {
  const json = JSON.parse(readFileSync(pkg.packagePath, "utf8")) as Record<string, unknown>;
  json.version = version;
  writeFileSync(pkg.packagePath, `${JSON.stringify(json, null, 2)}\n`);
}

function run(command: string, args: string[], cwd?: string): void {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
}

export async function main(): Promise<void> {
  const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const head = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (head.status !== 0) throw new Error("Canary source HEAD cannot be resolved");
  verifyCanarySourceBinding(process.env, head.stdout.trim(), repoRoot, scriptRoot);
  const packages = topologicallySortedPackages(publishableWorkspacePackages());
  const config = JSON.parse(readFileSync(join(repoRoot, ".changeset/config.json"), "utf8")) as {
    fixed?: string[][];
  };
  const metadata = new Map(
    await Promise.all(
      packages.map(async (pkg) => [pkg.name, await readRegistryPackage(pkg.name)] as const),
    ),
  );
  const versions = planCanaryVersions(
    canaryBasePackages(packages),
    new Map(packages.map((pkg) => [pkg.name, metadata.get(pkg.name)!["dist-tags"].canary ?? null])),
    config.fixed ?? [],
    // Registry tags can lag reserved/staged versions. Each workflow attempt
    // therefore starts in a fresh range without guessing or overwriting them.
    workflowCanarySequence(process.env.GITHUB_RUN_ID, process.env.GITHUB_RUN_ATTEMPT),
  );
  assertCanaryPlan(packages, versions, metadata);
  for (const pkg of packages) {
    const next = versions.get(pkg.name)!;
    writeVersion(pkg, next);
    process.stdout.write(`${pkg.name}@${next}\n`);
  }
  run("bun", ["run", "build:packages"], repoRoot);
  run("bun", ["scripts/publish-closure-guard.ts"], repoRoot);
  run("bun", ["scripts/rewrite-workspace-deps.ts", "--strip-dev-dependencies"], repoRoot);
  run("bun", ["scripts/rewrite-entry-points.ts"], repoRoot);
  const packDir = mkdtempSync(join(tmpdir(), "opengeni-canary-pack-"));
  try {
    for (const pkg of packages) {
      run("bun", ["run", "prepublishOnly"], join(repoRoot, pkg.dir));
      const result = spawnSync(
        "bun",
        ["pm", "pack", "--ignore-scripts", "--quiet", "--destination", packDir],
        { cwd: join(repoRoot, pkg.dir), encoding: "utf8", env: process.env },
      );
      if (result.status !== 0) throw new Error(`Bun pack failed for ${pkg.name}`);
      const tarballPath = resolve(packDir, result.stdout.trim());
      if (
        dirname(tarballPath) !== packDir ||
        !/^[a-z0-9][a-z0-9._-]*\.tgz$/.test(basename(tarballPath))
      ) {
        throw new Error(`Bun pack returned an invalid archive name for ${pkg.name}`);
      }
      const manifest = JSON.parse(readFileSync(pkg.packagePath, "utf8")) as Record<string, unknown>;
      if (manifest.name !== pkg.name || manifest.version !== versions.get(pkg.name)) {
        throw new Error(`Canary package metadata is invalid for ${pkg.name}`);
      }
      const packed = readFileSync(tarballPath);
      await publishCanaryArtifact(manifest, packed, process.env.NODE_AUTH_TOKEN!);
      await confirmCanaryPublication(
        pkg.name,
        versions.get(pkg.name)!,
        metadata.get(pkg.name)!["dist-tags"].latest,
        packed,
      );
      process.stdout.write(`${pkg.name}@${versions.get(pkg.name)} published with provenance\n`);
    }
  } finally {
    rmSync(packDir, { recursive: true, force: true });
  }
  mkdirSync(join(repoRoot, ".release"), { recursive: true });
  writeFileSync(
    join(repoRoot, ".release/site-package-versions.json"),
    JSON.stringify(
      Object.fromEntries(
        packages
          .filter((pkg) =>
            ["@opengeni/sdk", "@opengeni/react", "@opengeni/codemode", "@opengeni/ogtool"].includes(
              pkg.name,
            ),
          )
          .map((pkg) => [pkg.name, JSON.parse(readFileSync(pkg.packagePath, "utf8")).version]),
      ),
      null,
      2,
    ),
  );
}

if (import.meta.main) await main();
