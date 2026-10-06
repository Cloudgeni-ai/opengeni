#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import libnpmpublish from "libnpmpublish";

import {
  boundedCanaryBody,
  canaryErrorCategory,
  canaryResponseHeaders,
  CanaryReceiptStore,
  withCanaryReadSignal,
  type CanaryCustody,
} from "./canary-publication-receipts";
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
const CANARY_RECEIPT_TIMEOUT_MS = 180_000;
const CANARY_RECEIPT_REQUEST_TIMEOUT_MS = 10_000;
const CANARY_RECEIPT_POLL_INTERVAL_MS = 1_000;

type RegistryReadOptions = {
  signal?: AbortSignal;
  revalidate?: boolean;
  custody?: CanaryCustody | undefined;
  receiptVersion?: string;
  beforeAdditionalRequest?: () => void;
};
type ReceiptPollOptions = {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  pollIntervalMs?: number;
  maxReads?: number;
  custody?: CanaryCustody | undefined;
};

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

async function readRegistryDocument(
  name: string,
  url: string,
  request: RegistryRequest,
  options: RegistryReadOptions,
): Promise<unknown> {
  let response: Response;
  try {
    response = await withCanaryReadSignal(
      request(url, {
        method: "GET",
        cache: "no-store",
        redirect: "manual",
        credentials: "omit",
        headers: {
          accept: options.revalidate ? "application/json" : "application/vnd.npm.install-v1+json",
          ...(options.revalidate ? { "cache-control": "no-cache" } : {}),
        },
        ...(options.signal ? { signal: options.signal } : {}),
      }),
      options.signal,
    );
  } catch (error) {
    const category = canaryErrorCategory(error);
    options.custody?.record("READ_FAILED", { package: name, category });
    if (category === "request_timeout")
      throw new DOMException("Canary read timed out", "TimeoutError");
    // Transport exception text is deliberately excluded from publication logs.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(`Canary registry read failed for ${name}`);
  }
  const bytes = options.custody
    ? await options.custody.capture(name, response, options.signal)
    : await boundedCanaryBody(response, options.signal);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Registry metadata for ${name} failed: ${response.status}`);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error(`Registry metadata for ${name} is invalid JSON`);
  }
}

export async function readRegistryPackage(
  name: string,
  request: RegistryRequest = fetch,
  base = registry,
  options: RegistryReadOptions = {},
): Promise<RegistryPackage> {
  // These are GETs, including registry cache revalidation. A receipt needs the
  // current tags and one immutable version, not every historical manifest.
  const suffix = options.revalidate ? "?write=true" : "";
  if (options.receiptVersion !== undefined) {
    const version = options.receiptVersion;
    if (!/^\d+\.\d+\.\d+-canary\.(0|[1-9]\d*)$/.test(version)) {
      throw new Error("Canary receipt version identity is invalid");
    }
    options.custody?.record("READ_SELECTION", { package: name, selection: "tags" });
    const tagsDocument = await readRegistryDocument(
      name,
      `${base}/-/package/${encodeURIComponent(name)}/dist-tags${suffix}`,
      request,
      options,
    );
    const tags = tagsDocument === undefined ? {} : tagsDocument;
    if (
      !tags ||
      typeof tags !== "object" ||
      Array.isArray(tags) ||
      (Object.hasOwn(tags, "latest") &&
        typeof (tags as Record<string, unknown>).latest !== "string") ||
      (Object.hasOwn(tags, "canary") &&
        typeof (tags as Record<string, unknown>).canary !== "string")
    ) {
      throw new Error(`Registry tags for ${name} are incomplete`);
    }
    // The first request is reserved by the caller; charge a second before I/O.
    // Both requests retain its same signal, monotonic deadline and custody.
    options.signal?.throwIfAborted();
    options.beforeAdditionalRequest?.();
    options.custody?.record("READ_SELECTION", { package: name, selection: "version", version });
    const selected = await readRegistryDocument(
      name,
      `${base}/${encodeURIComponent(name)}/${version}${suffix}`,
      request,
      options,
    );
    if (
      selected !== undefined &&
      (!selected ||
        typeof selected !== "object" ||
        Array.isArray(selected) ||
        (selected as Record<string, unknown>).name !== name ||
        (selected as Record<string, unknown>).version !== version)
    ) {
      throw new Error(`Registry version identity for ${name} is invalid`);
    }
    return {
      "dist-tags": tags as RegistryPackage["dist-tags"],
      versions:
        selected === undefined
          ? {}
          : { [version]: selected as RegistryPackage["versions"][string] },
    };
  }
  const json = (await readRegistryDocument(
    name,
    `${base}/${encodeURIComponent(name)}${suffix}`,
    request,
    options,
  )) as Partial<RegistryPackage> | undefined;
  if (json === undefined) return { "dist-tags": {}, versions: {} };
  if (
    !json ||
    typeof json !== "object" ||
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
  timeoutMs = 120_000,
): Promise<{ status: number; transparencyLogUrl: string; headers: Record<string, string> }> {
  assertCanaryManifest(manifest);
  if (
    !token ||
    tarball.length === 0 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 120_000
  ) {
    throw new Error("Canary package, archive, or registry auth is invalid");
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Canary library publication deadline exceeded; outcome unknown"));
    }, timeoutMs);
  });
  let response: Awaited<ReturnType<typeof publish>>;
  try {
    response = await Promise.race([
      publish(manifest, tarball, {
        registry: targetRegistry,
        forceAuth: { token },
        defaultTag: "canary",
        access: "public",
        provenance: true,
        retry: { retries: 0 },
        timeout: Math.min(30_000, timeoutMs),
        signal: controller.signal,
      }),
      deadline,
    ]);
  } finally {
    clearTimeout(timer!);
  }
  if (
    !response.ok ||
    !Number.isInteger(response.status) ||
    response.status < 200 ||
    response.status >= 300 ||
    !/^https:\/\/search\.sigstore\.dev\/\?logIndex=\d+$/.test(response.transparencyLogUrl ?? "")
  ) {
    throw new Error(`Canary provenance publication was not confirmed for ${manifest.name}`);
  }
  return {
    status: response.status,
    transparencyLogUrl: response.transparencyLogUrl!,
    headers: canaryResponseHeaders(response.headers),
  };
}

function assertCanaryManifest(manifest: Record<string, unknown>): void {
  if (
    typeof manifest.name !== "string" ||
    typeof manifest.version !== "string" ||
    !/^\d+\.\d+\.\d+-canary\.(0|[1-9]\d*)$/.test(manifest.version) ||
    (manifest.tag !== undefined && manifest.tag !== "canary") ||
    (manifest.publishConfig as Record<string, unknown> | undefined)?.access !== "public" ||
    (manifest.publishConfig as Record<string, unknown> | undefined)?.provenance !== true ||
    ((manifest.publishConfig as Record<string, unknown> | undefined)?.tag !== undefined &&
      (manifest.publishConfig as Record<string, unknown>).tag !== "canary")
  ) {
    throw new Error("Canary package, archive, or registry auth is invalid");
  }
}

export type CanaryArchive = {
  name: string;
  version: string;
  previousLatest: string | undefined;
  integrity: string;
  archiveBytes: number;
};

export type FrozenCanaryArtifact = CanaryArchive & {
  manifest: Record<string, unknown>;
  manifestSha256: string;
  packed: Buffer;
};

export function freezeCanaryCohort(
  packages: readonly {
    name: string;
    version: string;
    previousLatest: string | undefined;
    manifest: Record<string, unknown>;
    packed: Buffer;
  }[],
  custody: CanaryCustody,
): readonly FrozenCanaryArtifact[] {
  if (packages.length === 0 || packages.length > 64)
    throw new Error("Canary cohort size is invalid");
  const names = new Set<string>();
  let totalBytes = 0;
  const frozen = packages.map((pkg) => {
    assertCanaryManifest(pkg.manifest);
    if (
      names.has(pkg.name) ||
      pkg.manifest.name !== pkg.name ||
      pkg.manifest.version !== pkg.version ||
      pkg.packed.length === 0 ||
      pkg.packed.length > 64 * 1024 * 1024
    ) {
      throw new Error("Canary packed cohort is invalid");
    }
    names.add(pkg.name);
    totalBytes += pkg.packed.length;
    if (totalBytes > 512 * 1024 * 1024) throw new Error("Canary archives exceed cohort bound");
    const manifest = JSON.parse(JSON.stringify(pkg.manifest)) as Record<string, unknown>;
    return Object.freeze({
      name: pkg.name,
      version: pkg.version,
      previousLatest: pkg.previousLatest,
      manifest: Object.freeze(manifest),
      manifestSha256: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
      packed: pkg.packed,
      integrity: `sha512-${createHash("sha512").update(pkg.packed).digest("base64")}`,
      archiveBytes: pkg.packed.length,
    });
  });
  const plan = frozen.map(({ packed: _packed, manifest: _manifest, ...identity }) => identity);
  custody.record("COHORT_PLAN", {
    packages: plan,
    packageCount: plan.length,
    archiveBytes: totalBytes,
    planSha256: createHash("sha256").update(JSON.stringify(plan)).digest("hex"),
  });
  return Object.freeze(frozen);
}

export async function publishPreparedCanaries(
  packages: readonly FrozenCanaryArtifact[],
  custody: CanaryCustody,
  token: string,
  read: typeof readRegistryPackage = readRegistryPackage,
  publish: typeof libnpmpublish.publish = libnpmpublish.publish,
  timeoutMs = 120_000,
): Promise<void> {
  for (const pkg of packages) {
    if (
      pkg.packed.length !== pkg.archiveBytes ||
      `sha512-${createHash("sha512").update(pkg.packed).digest("base64")}` !== pkg.integrity ||
      createHash("sha256").update(JSON.stringify(pkg.manifest)).digest("hex") !== pkg.manifestSha256
    ) {
      throw new Error(`Frozen canary archive changed for ${pkg.name}`);
    }
    const current = await read(pkg.name, fetch, registry, {
      revalidate: true,
      signal: AbortSignal.timeout(CANARY_RECEIPT_REQUEST_TIMEOUT_MS),
      custody,
    });
    if (current["dist-tags"].latest !== pkg.previousLatest) {
      throw new Error(`Stable tag changed before canary publication for ${pkg.name}`);
    }
    if (Object.hasOwn(current.versions, pkg.version)) {
      throw new Error(`Canary version already exists for ${pkg.name}`);
    }
    const binding = {
      package: pkg.name,
      version: pkg.version,
      integrity: pkg.integrity,
      archiveBytes: pkg.archiveBytes,
      manifestSha256: pkg.manifestSha256,
    };
    const intent = custody.record("WRITE_INTENT", binding);
    try {
      const acknowledgement = await publishCanaryArtifact(
        pkg.manifest,
        pkg.packed,
        token,
        publish,
        registry,
        timeoutMs,
      );
      custody.record("WRITE_ACKNOWLEDGED", {
        ...binding,
        intent,
        ...acknowledgement,
        meaning: "POSITIVE_LIBRARY_HTTP_RESPONSE_NOT_SIGNED_BYTE_ACCEPTANCE",
      });
    } catch {
      // The original intent is already durable; storage failure cannot establish no write.
      try {
        custody.record("WRITE_UNKNOWN", { ...binding, intent, noReplay: true });
      } catch {
        // Retain INTENT without a trusted acknowledgement; never continue or infer idle.
      }
      throw new Error(`Canary write outcome is unknown for ${pkg.name}; no retry was attempted`);
    }
  }
  custody.record("WRITE_PHASE_COMPLETE", { packageCount: packages.length });
}

function receiptObservation(pkg: CanaryArchive, current: RegistryPackage): string {
  if (current["dist-tags"].latest !== pkg.previousLatest) {
    throw new Error(`Stable tag changed during canary publication for ${pkg.name}`);
  }
  if (!Object.hasOwn(current.versions, pkg.version)) return "version_pending";
  if (current["dist-tags"].canary !== pkg.version) return "canary_tag_pending";
  const dist = current.versions[pkg.version]?.dist;
  if (dist?.integrity && dist.integrity !== pkg.integrity) {
    throw new Error(`Canary archive integrity differs for ${pkg.name}`);
  }
  if (!dist?.integrity) return "integrity_pending";
  if (typeof dist.attestations?.url !== "string") return "attestation_pending";
  if (dist.attestations.provenance?.predicateType !== "https://slsa.dev/provenance/v1") {
    return "provenance_pending";
  }
  return "matched";
}

export async function confirmCanaryCohort(
  packages: readonly CanaryArchive[],
  read: typeof readRegistryPackage = readRegistryPackage,
  options: ReceiptPollOptions = {},
): Promise<void> {
  const now = options.now ?? performance.now.bind(performance);
  const sleep = options.sleep ?? Bun.sleep;
  const timeoutMs = options.timeoutMs ?? CANARY_RECEIPT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? CANARY_RECEIPT_POLL_INTERVAL_MS;
  const maxReads = options.maxReads ?? 256;
  if (
    packages.length === 0 ||
    packages.length > 64 ||
    new Set(packages.map((pkg) => pkg.name)).size !== packages.length ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > CANARY_RECEIPT_TIMEOUT_MS ||
    !Number.isFinite(pollIntervalMs) ||
    pollIntervalMs < CANARY_RECEIPT_POLL_INTERVAL_MS ||
    !Number.isInteger(maxReads) ||
    maxReads <= 0 ||
    maxReads > 256
  ) {
    throw new Error("Canary receipt cohort, interval or deadline is invalid");
  }
  const deadline = now() + timeoutMs;
  const pending = new Map(packages.map((pkg) => [pkg.name, pkg]));
  let reads = 0;
  let longestReceiptMs = 0;
  const beforeAdditionalRequest = () => {
    if (reads >= maxReads) throw new Error("Canary receipt read quota exhausted");
    reads++;
  };
  let lastObservation = "not_observed";
  while (now() < deadline && reads < maxReads) {
    const round = [...pending.values()];
    for (
      let offset = 0;
      offset < round.length && now() < deadline && reads < maxReads;
      offset += 4
    ) {
      const batch = round.slice(offset, offset + Math.min(4, maxReads - reads));
      reads += batch.length;
      const results = await Promise.allSettled(
        batch.map(async (pkg) => {
          let observation: string;
          const startedAt = now();
          try {
            const remaining = deadline - now();
            if (remaining <= 0) return { pkg, observation: "read_exceeded_deadline" };
            const current = await read(pkg.name, fetch, registry, {
              revalidate: true,
              receiptVersion: pkg.version,
              beforeAdditionalRequest,
              signal: AbortSignal.timeout(
                Math.max(1, Math.ceil(Math.min(CANARY_RECEIPT_REQUEST_TIMEOUT_MS, remaining))),
              ),
              custody: options.custody,
            });
            observation =
              now() >= deadline ? "read_exceeded_deadline" : receiptObservation(pkg, current);
          } catch (error) {
            if (canaryErrorCategory(error) !== "request_timeout") throw error;
            observation = "request_timeout";
          }
          longestReceiptMs = Math.max(longestReceiptMs, now() - startedAt);
          options.custody?.record("READ_OBSERVATION", {
            package: pkg.name,
            version: pkg.version,
            observation,
          });
          if (now() >= deadline) observation = "read_exceeded_deadline";
          return { pkg, observation };
        }),
      );
      let failure: unknown;
      for (const result of results) {
        if (result.status === "rejected") {
          failure ??= result.reason;
        } else {
          lastObservation = result.value.observation;
          if (lastObservation === "matched") pending.delete(result.value.pkg.name);
        }
      }
      if (failure) throw failure;
      if (pending.size === 0) {
        if (packages.length > maxReads - reads || now() >= deadline) {
          throw new Error("Final canary cohort cannot fit the remaining read bounds");
        }
        for (let finalOffset = 0; finalOffset < packages.length; finalOffset += 4) {
          if (now() >= deadline) throw new Error("Final canary cohort exceeded the deadline");
          const finalBatch = packages.slice(finalOffset, finalOffset + 4);
          if (finalBatch.length > maxReads - reads) {
            throw new Error("Final canary cohort cannot fit the remaining read bounds");
          }
          reads += finalBatch.length;
          const finalResults = await Promise.allSettled(
            finalBatch.map(async (pkg) => {
              const remaining = deadline - now();
              if (remaining <= 0) throw new Error("Final canary cohort exceeded the deadline");
              const current = await read(pkg.name, fetch, registry, {
                revalidate: true,
                receiptVersion: pkg.version,
                beforeAdditionalRequest,
                signal: AbortSignal.timeout(
                  Math.max(1, Math.ceil(Math.min(CANARY_RECEIPT_REQUEST_TIMEOUT_MS, remaining))),
                ),
                custody: options.custody,
              });
              const observation =
                now() >= deadline ? "read_exceeded_deadline" : receiptObservation(pkg, current);
              options.custody?.record("READ_OBSERVATION", {
                package: pkg.name,
                version: pkg.version,
                phase: "final",
                observation,
              });
              if (observation !== "matched" || now() >= deadline) {
                throw new Error(`Final canary cohort receipt did not match for ${pkg.name}`);
              }
            }),
          );
          const rejected = finalResults.filter((result) => result.status === "rejected");
          if (rejected.length) throw rejected[0]!.reason;
        }
        options.custody?.record("COHORT_READS_MATCHED", {
          packageCount: packages.length,
          reads,
          freshCompleteCohort: true,
        });
        if (now() < deadline) return;
        lastObservation = "read_exceeded_deadline";
        break;
      }
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    // Each receipt reads tags and its selected version. Keep a complete fresh
    // cohort in reserve, and spread the remaining polls across the deadline.
    const finalReads = packages.length * 2;
    const remainingPolls = Math.floor((maxReads - reads - finalReads) / (pending.size * 2));
    if (remainingPolls <= 0) {
      lastObservation = "read_limit";
      break;
    }
    // Leave time for the last pending poll and the entire final reread, using
    // the slowest observed receipt plus one interval of scheduling margin.
    const completionBatches = Math.ceil(pending.size / 4) + Math.ceil(packages.length / 4);
    const completionTime = Math.max(
      CANARY_RECEIPT_REQUEST_TIMEOUT_MS,
      longestReceiptMs * completionBatches + pollIntervalMs,
    );
    const wait = Math.min(
      remaining,
      Math.max(pollIntervalMs, (remaining - completionTime) / remainingPolls),
    );
    if (wait > 0 && reads < maxReads) await sleep(wait);
  }
  const category = reads >= maxReads && now() < deadline ? "read_limit" : lastObservation;
  throw new Error(
    `Canary registry receipt is unavailable for ${[...pending.keys()].join(", ") || "cohort"} after ${reads} reads (${category})`,
  );
}

export async function confirmCanaryPublication(
  name: string,
  version: string,
  previousLatest: string | undefined,
  tarball: Buffer,
  read: typeof readRegistryPackage = readRegistryPackage,
  options: ReceiptPollOptions = {},
): Promise<void> {
  return confirmCanaryCohort(
    [
      {
        name,
        version,
        previousLatest,
        integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
        archiveBytes: tarball.length,
      },
    ],
    read,
    options,
  );
}

export async function publishAndVerifyCanaryCohort(
  packages: readonly FrozenCanaryArtifact[],
  custody: CanaryCustody,
  token: string,
  options: ReceiptPollOptions & {
    read?: typeof readRegistryPackage;
    publish?: typeof libnpmpublish.publish;
    writeTimeoutMs?: number;
  } = {},
): Promise<Record<string, string>> {
  const read = options.read ?? readRegistryPackage;
  await publishPreparedCanaries(
    packages,
    custody,
    token,
    read,
    options.publish,
    options.writeTimeoutMs,
  );
  await confirmCanaryCohort(packages, read, { ...options, custody });
  const pins = Object.fromEntries(
    packages
      .filter((pkg) =>
        ["@opengeni/sdk", "@opengeni/react", "@opengeni/codemode", "@opengeni/ogtool"].includes(
          pkg.name,
        ),
      )
      .map((pkg) => [pkg.name, pkg.version]),
  );
  if (Object.keys(pins).length !== 4) throw new Error("Canary Site package cohort is incomplete");
  return pins;
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
  mkdirSync(join(repoRoot, ".release"), { recursive: true });
  const pinsPath = join(repoRoot, ".release/site-package-versions.json");
  if (existsSync(pinsPath)) throw new Error("Canary Site pins already exist; no replay is allowed");
  const custody = new CanaryReceiptStore(join(repoRoot, ".release/canary-receipts"), {
    source: process.env.SOURCE_SHA!,
    workflowSource: process.env.GITHUB_WORKFLOW_SHA!,
    runId: process.env.GITHUB_RUN_ID!,
    attempt: process.env.GITHUB_RUN_ATTEMPT!,
  });
  const packages = topologicallySortedPackages(publishableWorkspacePackages());
  const config = JSON.parse(readFileSync(join(repoRoot, ".changeset/config.json"), "utf8")) as {
    fixed?: string[][];
  };
  const metadata = new Map<string, RegistryPackage>();
  for (let offset = 0; offset < packages.length; offset += 4) {
    const results = await Promise.allSettled(
      packages.slice(offset, offset + 4).map(
        async (pkg) =>
          [
            pkg.name,
            await readRegistryPackage(pkg.name, fetch, registry, {
              custody,
              signal: AbortSignal.timeout(CANARY_RECEIPT_REQUEST_TIMEOUT_MS),
            }),
          ] as const,
      ),
    );
    let failed = false;
    for (const result of results) {
      if (result.status === "fulfilled") metadata.set(...result.value);
      else failed = true;
    }
    if (failed) throw new Error("Canary registry discovery failed; no publication was attempted");
  }
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
  let phase = "packing";
  try {
    const prepared: Parameters<typeof freezeCanaryCohort>[0][number][] = [];
    let archiveBytes = 0;
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
      const size = statSync(tarballPath).size;
      archiveBytes += size;
      if (size <= 0 || size > 64 * 1024 * 1024 || archiveBytes > 512 * 1024 * 1024) {
        throw new Error("Bun packed canary archives exceed cohort bound");
      }
      const packed = readFileSync(tarballPath);
      prepared.push({
        name: pkg.name,
        version: versions.get(pkg.name)!,
        previousLatest: metadata.get(pkg.name)!["dist-tags"].latest,
        manifest,
        packed,
      });
    }
    const frozen = freezeCanaryCohort(prepared, custody);
    phase = "publication_and_receipts";
    const pins = await publishAndVerifyCanaryCohort(frozen, custody, process.env.NODE_AUTH_TOKEN!);
    phase = "site_pins";
    writeFileSync(pinsPath, JSON.stringify(pins, null, 2), { flag: "wx", mode: 0o600 });
    custody.record("SITE_PINS_WRITTEN", {
      sha256: createHash("sha256").update(readFileSync(pinsPath)).digest("hex"),
      count: Object.keys(pins).length,
      metadataOnly: true,
    });
    for (const pkg of packages) {
      process.stdout.write(`${pkg.name}@${versions.get(pkg.name)} published with provenance\n`);
    }
  } catch (error) {
    try {
      custody.record("PUBLICATION_FAILED", { phase, noReplay: true });
    } catch {
      // Existing intents remain authoritative when recording an error also fails.
    }
    throw error;
  } finally {
    rmSync(packDir, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
