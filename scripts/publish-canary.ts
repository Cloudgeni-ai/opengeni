#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import libnpmpublish from "libnpmpublish";
import { admitCanarySource, canaryGit, verifyCanaryController } from "./canary-source-admission";
import { signCanarySource, type SuppliedCanaryProvenance } from "./canary-source-provenance";

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
// npm acknowledges a publication with 202 Accepted and processes it afterwards.
// The version stays unreadable until processing finishes: usually 3-10 minutes,
// sometimes much longer for the largest archives. Confirmation is a separate,
// re-runnable job, so this window only decides when one confirmation attempt
// stops waiting; re-running it resumes against the same published versions.
export const CANARY_VISIBILITY_TIMEOUT_MS = 30 * 60_000;
const CANARY_RECEIPT_REQUEST_TIMEOUT_MS = 10_000;
// npm tags a brand-new package `latest: 0.0.0-stage` while its first version
// waits in the staged-publishing queue for a maintainer's 2FA approval.
const NPM_STAGED_PLACEHOLDER_VERSION = "0.0.0-stage";
// Poll each still-invisible version after 5s, 10s, 20s, 40s, then every minute.
const CANARY_RECEIPT_FIRST_POLL_MS = 5_000;
const CANARY_RECEIPT_MAX_POLL_MS = 60_000;
export const CANARY_RECEIPT_MAX_COHORT = 64;

/** A registry read that failed for a reason that can clear by itself (transport, 429, 5xx). */
export class CanaryRegistryUnavailable extends Error {}

/** npm accepted every write, but some versions were not readable within one confirmation window. */
export class CanaryVisibilityPending extends Error {}

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
  maxPollIntervalMs?: number;
  custody?: CanaryCustody | undefined;
};

export function verifyCanarySourceBinding(
  env: Record<string, string | undefined>,
  actualHead: string,
  sourceRoot: string,
  scriptRoot: string,
  controllerHead = actualHead,
): void {
  verifyCanaryController(env, controllerHead);
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
    env.SOURCE_SHA !== actualHead ||
    (sha !== actualHead && resolve(sourceRoot) === resolve(scriptRoot)) ||
    !env.GITHUB_RUN_ID ||
    !env.GITHUB_RUN_ATTEMPT ||
    !env.ACTIONS_ID_TOKEN_REQUEST_URL ||
    !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ||
    !env.NODE_AUTH_TOKEN ||
    !env.GITHUB_OUTPUT
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
    throw new CanaryRegistryUnavailable(`Canary registry read failed for ${name}`);
  }
  const bytes = options.custody
    ? await options.custody.capture(name, response, options.signal)
    : await boundedCanaryBody(response, options.signal);
  if (response.status === 404) return undefined;
  if (response.status === 429 || response.status >= 500) {
    throw new CanaryRegistryUnavailable(`Registry metadata for ${name} failed: ${response.status}`);
  }
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
  supplied?: SuppliedCanaryProvenance,
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
        provenance: !supplied,
        ...(supplied ? { provenanceFile: supplied.file } : {}),
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
    !/^https:\/\/search\.sigstore\.dev\/\?logIndex=\d+$/.test(
      supplied?.transparencyLogUrl ?? response.transparencyLogUrl ?? "",
    )
  ) {
    throw new Error(`Canary provenance publication was not confirmed for ${manifest.name}`);
  }
  return {
    status: response.status,
    transparencyLogUrl: supplied?.transparencyLogUrl ?? response.transparencyLogUrl!,
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

/** Diagnostic only: never converts an unknown write into proof of no write. */
export function canaryWriteFailureDiagnostic(error: unknown): { category: string; code?: string } {
  if (error instanceof Error && /^root was signed by \d+\/\d+ keys$/.test(error.message)) {
    return { category: "tuf_root_signature_verification_failed" };
  }
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (
    typeof code === "string" &&
    [
      "E400",
      "E401",
      "E403",
      "E404",
      "E409",
      "E429",
      "E500",
      "E503",
      "ECONNRESET",
      "ETIMEDOUT",
      "ENOTFOUND",
      "EAI_AGAIN",
    ].includes(code)
  ) {
    return { category: "registry_or_transport_error", code };
  }
  return { category: "publication_or_acknowledgement_failed" };
}

export async function publishPreparedCanaries(
  packages: readonly FrozenCanaryArtifact[],
  custody: CanaryCustody,
  token: string,
  read: typeof readRegistryPackage = readRegistryPackage,
  publish: typeof libnpmpublish.publish = libnpmpublish.publish,
  timeoutMs = 120_000,
  provenance?: (pkg: FrozenCanaryArtifact) => Promise<SuppliedCanaryProvenance>,
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
    const supplied = await provenance?.(pkg);
    if (supplied?.evidence)
      custody.record("PROVENANCE_PREPARED", {
        ...binding,
        provenance: supplied.evidence,
        transparencyLogUrl: supplied.transparencyLogUrl,
        artifact: `canary-source-provenance-${process.env.SOURCE_SHA}`,
        meaning: "SIGNED_INPUT_NOT_REGISTRY_WRITE_ACCEPTANCE",
      });
    const intent = custody.record("WRITE_INTENT", binding);
    try {
      const acknowledgement = await publishCanaryArtifact(
        pkg.manifest,
        pkg.packed,
        token,
        publish,
        registry,
        timeoutMs,
        supplied,
      );
      custody.record("WRITE_ACKNOWLEDGED", {
        ...binding,
        intent,
        ...acknowledgement,
        meaning: "POSITIVE_LIBRARY_HTTP_RESPONSE_NOT_SIGNED_BYTE_ACCEPTANCE",
      });
    } catch (error) {
      // The original intent is already durable; storage failure cannot establish no write.
      try {
        custody.record("WRITE_UNKNOWN", {
          ...binding,
          intent,
          noReplay: true,
          diagnostic: canaryWriteFailureDiagnostic(error),
        });
      } catch {
        // Retain INTENT without a trusted acknowledgement; never continue or infer idle.
      }
      // Raw provider errors may include credential-bearing request details;
      // retain only the allowlisted diagnostic above, never the original cause.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(`Canary write outcome is unknown for ${pkg.name}; no retry was attempted`);
    }
  }
  custody.record("WRITE_PHASE_COMPLETE", { packageCount: packages.length });
}

const CANARY_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)-canary\.(0|[1-9]\d*)$/;

/** True when `candidate` is a canary that sorts after `version` (a later publication). */
export function isLaterCanary(candidate: string, version: string): boolean {
  const later = CANARY_VERSION_PATTERN.exec(candidate)?.slice(1).map(Number);
  const current = CANARY_VERSION_PATTERN.exec(version)?.slice(1).map(Number);
  if (!later || !current) return false;
  for (let index = 0; index < 4; index++) {
    if (later[index] !== current[index]) return later[index]! > current[index]!;
  }
  return false;
}

function receiptObservation(pkg: CanaryArchive, current: RegistryPackage): string {
  // npm always points `latest` at a package's first published version, whatever
  // tag the publish asked for. For a package with no stable release yet that is
  // this canary, or npm's staged-publishing placeholder when the registry holds
  // the new package for maintainer approval. Nothing else may have moved the tag.
  const latest = current["dist-tags"].latest;
  const staged = pkg.previousLatest === undefined && latest === NPM_STAGED_PLACEHOLDER_VERSION;
  const firstPublication = pkg.previousLatest === undefined && (latest === pkg.version || staged);
  if (latest !== pkg.previousLatest && !firstPublication) {
    throw new Error(`Stable tag changed during canary publication for ${pkg.name}`);
  }
  if (!Object.hasOwn(current.versions, pkg.version)) {
    return staged ? "staged_approval_pending" : "version_pending";
  }
  // A re-run confirmation can observe a later canary publication's tag; that
  // later publication could only start after this one's writes were accepted.
  const canary = current["dist-tags"].canary;
  if (canary !== pkg.version && !(canary !== undefined && isLaterCanary(canary, pkg.version))) {
    return "canary_tag_pending";
  }
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

/**
 * Waits until npm has processed every acknowledged write, then qualifies the
 * complete cohort with one fresh reread. Waiting is time-based: each pending
 * version is polled with backoff until the window ends. Waiting reads record one
 * observation each; the final complete-cohort reread retains full response custody.
 * Transport failures, 429 and 5xx responses count as "not yet"; a moved stable
 * tag, different archive integrity or invalid identity fail immediately.
 */
export async function confirmCanaryCohort(
  packages: readonly CanaryArchive[],
  read: typeof readRegistryPackage = readRegistryPackage,
  options: ReceiptPollOptions = {},
): Promise<void> {
  const now = options.now ?? performance.now.bind(performance);
  const waitForNextPoll = options.sleep ?? sleep;
  const timeoutMs = options.timeoutMs ?? CANARY_VISIBILITY_TIMEOUT_MS;
  const firstPollMs = options.pollIntervalMs ?? CANARY_RECEIPT_FIRST_POLL_MS;
  const maxPollMs = options.maxPollIntervalMs ?? CANARY_RECEIPT_MAX_POLL_MS;
  if (
    packages.length === 0 ||
    packages.length > CANARY_RECEIPT_MAX_COHORT ||
    new Set(packages.map((pkg) => pkg.name)).size !== packages.length ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isFinite(firstPollMs) ||
    firstPollMs <= 0 ||
    !Number.isFinite(maxPollMs) ||
    maxPollMs < firstPollMs
  ) {
    throw new Error("Canary receipt cohort, interval or deadline is invalid");
  }
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  const pending = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const lastObservation = new Map(packages.map((pkg) => [pkg.name, "not_observed"]));
  let observations = 0;
  const observe = async (pkg: CanaryArchive, final: boolean): Promise<string> => {
    const remaining = deadline - now();
    if (remaining <= 0) return "read_exceeded_deadline";
    observations++;
    let observation: string;
    try {
      const current = await read(pkg.name, fetch, registry, {
        revalidate: true,
        receiptVersion: pkg.version,
        signal: AbortSignal.timeout(
          Math.max(1, Math.ceil(Math.min(CANARY_RECEIPT_REQUEST_TIMEOUT_MS, remaining))),
        ),
        custody: final ? options.custody : undefined,
      });
      observation = now() >= deadline ? "read_exceeded_deadline" : receiptObservation(pkg, current);
    } catch (error) {
      if (canaryErrorCategory(error) === "request_timeout") observation = "request_timeout";
      else if (error instanceof CanaryRegistryUnavailable) observation = "registry_unavailable";
      else throw error;
    }
    options.custody?.record("READ_OBSERVATION", {
      package: pkg.name,
      version: pkg.version,
      ...(final ? { phase: "final" } : {}),
      observation,
    });
    return observation;
  };
  const observeAll = async (cohort: readonly CanaryArchive[], final: boolean) => {
    const results: { pkg: CanaryArchive; observation: string }[] = [];
    for (let offset = 0; offset < cohort.length; offset += 4) {
      const settled = await Promise.allSettled(
        cohort
          .slice(offset, offset + 4)
          .map(async (pkg) => ({ pkg, observation: await observe(pkg, final) })),
      );
      for (const result of settled) {
        if (result.status === "rejected") throw result.reason;
        results.push(result.value);
      }
    }
    return results;
  };
  let interval = firstPollMs;
  while (true) {
    const staged: string[] = [];
    for (const { pkg, observation } of await observeAll([...pending.values()], false)) {
      lastObservation.set(pkg.name, observation);
      if (observation === "matched") pending.delete(pkg.name);
      if (observation === "staged_approval_pending") staged.push(`${pkg.name}@${pkg.version}`);
    }
    // Polling cannot clear a staged first publication; only a maintainer can.
    if (staged.length) {
      throw new Error(
        `npm staged publishing holds the first publication of ${staged.join(", ")}. ` +
          "A maintainer must approve it with 2FA (npm stage list, then npm stage approve <id>, " +
          "or the Staged Packages tab on npmjs.com); then re-run the confirmation job.",
      );
    }
    if (pending.size === 0) {
      // Every version has been seen once. Qualify the whole cohort together;
      // anything that no longer matches goes back to waiting.
      for (const { pkg, observation } of await observeAll(packages, true)) {
        if (observation === "matched") continue;
        lastObservation.set(pkg.name, observation);
        pending.set(pkg.name, pkg);
      }
      if (pending.size === 0) {
        options.custody?.record("COHORT_READS_MATCHED", {
          packageCount: packages.length,
          observations,
          elapsedMs: Math.round(now() - startedAt),
          freshCompleteCohort: true,
        });
        return;
      }
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await waitForNextPoll(Math.min(interval, remaining));
    interval = Math.min(maxPollMs, interval * 2);
    if (now() >= deadline) break;
  }
  const unavailable = [...pending.values()]
    .map((pkg) => `${pkg.name}@${pkg.version} (${lastObservation.get(pkg.name)})`)
    .join(", ");
  throw new CanaryVisibilityPending(
    `Canary registry receipt is unavailable for ${unavailable} after ` +
      `${Math.round((now() - startedAt) / 1000)}s and ${observations} observations`,
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

const SITE_PACKAGES = [
  "@opengeni/sdk",
  "@opengeni/react",
  "@opengeni/codemode",
  "@opengeni/ogtool",
] as const;

export function canarySitePins(packages: readonly CanaryArchive[]): Record<string, string> {
  const pins = Object.fromEntries(
    packages
      .filter((pkg) => (SITE_PACKAGES as readonly string[]).includes(pkg.name))
      .map((pkg) => [pkg.name, pkg.version]),
  );
  if (Object.keys(pins).length !== SITE_PACKAGES.length) {
    throw new Error("Canary Site package cohort is incomplete");
  }
  return pins;
}

export const CANARY_COHORT_SCHEMA = "opengeni.canary-cohort.v1";
export type CanaryCohort = {
  schema: typeof CANARY_COHORT_SCHEMA;
  source: string;
  workflowSource: string;
  runId: string;
  attempt: string;
  packages: CanaryArchive[];
};

/** The acknowledged cohort the publish job hands to the confirmation job. */
export function canaryCohortHandoff(
  packages: readonly CanaryArchive[],
  identity: Omit<CanaryCohort, "schema" | "packages">,
): string {
  const cohort: CanaryCohort = {
    schema: CANARY_COHORT_SCHEMA,
    ...identity,
    packages: packages.map((pkg) => ({
      name: pkg.name,
      version: pkg.version,
      ...(pkg.previousLatest === undefined ? {} : { previousLatest: pkg.previousLatest }),
      integrity: pkg.integrity,
      archiveBytes: pkg.archiveBytes,
    })) as CanaryArchive[],
  };
  return JSON.stringify(parseCanaryCohort(JSON.stringify(cohort), identity));
}

export function parseCanaryCohort(
  text: string,
  expected: { source: string; workflowSource: string; runId: string },
): CanaryCohort {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Canary cohort handoff is not JSON");
  }
  const isObject = (item: unknown): item is Record<string, unknown> =>
    item !== null && typeof item === "object" && !Array.isArray(item);
  const onlyKeys = (item: Record<string, unknown>, keys: string[]) =>
    Object.keys(item).every((key) => keys.includes(key));
  if (
    !isObject(value) ||
    !onlyKeys(value, ["schema", "source", "workflowSource", "runId", "attempt", "packages"]) ||
    value.schema !== CANARY_COHORT_SCHEMA ||
    value.source !== expected.source ||
    value.workflowSource !== expected.workflowSource ||
    value.runId !== expected.runId ||
    typeof value.attempt !== "string" ||
    !/^[1-9]\d{0,2}$/.test(value.attempt) ||
    !Array.isArray(value.packages) ||
    value.packages.length === 0 ||
    value.packages.length > CANARY_RECEIPT_MAX_COHORT
  ) {
    throw new Error("Canary cohort handoff identity differs");
  }
  const names = new Set<string>();
  for (const pkg of value.packages) {
    if (
      !isObject(pkg) ||
      !onlyKeys(pkg, ["name", "version", "previousLatest", "integrity", "archiveBytes"]) ||
      typeof pkg.name !== "string" ||
      !/^@opengeni\/[a-z0-9][a-z0-9-]*$/.test(pkg.name) ||
      names.has(pkg.name) ||
      typeof pkg.version !== "string" ||
      !CANARY_VERSION_PATTERN.test(pkg.version) ||
      (pkg.previousLatest !== undefined &&
        (typeof pkg.previousLatest !== "string" ||
          !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(pkg.previousLatest))) ||
      typeof pkg.integrity !== "string" ||
      !/^sha512-[A-Za-z0-9+/]{86}==$/.test(pkg.integrity) ||
      !Number.isSafeInteger(pkg.archiveBytes) ||
      (pkg.archiveBytes as number) <= 0 ||
      (pkg.archiveBytes as number) > 64 * 1024 * 1024
    ) {
      throw new Error("Canary cohort handoff package is invalid");
    }
    names.add(pkg.name);
  }
  return value as CanaryCohort;
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
  if (process.versions.bun) {
    throw new Error("Canary publication requires native Node for Sigstore/TUF verification");
  }
  const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const head = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (head.status !== 0) throw new Error("Canary source HEAD cannot be resolved");
  verifyCanarySourceBinding(
    process.env,
    head.stdout.trim(),
    repoRoot,
    scriptRoot,
    canaryGit(scriptRoot, ["rev-parse", "HEAD"]),
  );
  await admitCanarySource(scriptRoot);
  mkdirSync(join(scriptRoot, ".release"), { recursive: true });
  const provenanceDirectory = join(scriptRoot, ".release/canary-provenance");
  if (process.env.SOURCE_SHA !== process.env.GITHUB_SHA)
    mkdirSync(provenanceDirectory, { mode: 0o700 });
  const custody = new CanaryReceiptStore(join(scriptRoot, ".release/canary-receipts"), {
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
    canarySitePins(frozen);
    phase = "publication";
    await publishPreparedCanaries(
      frozen,
      custody,
      process.env.NODE_AUTH_TOKEN!,
      readRegistryPackage,
      libnpmpublish.publish,
      undefined,
      process.env.SOURCE_SHA !== process.env.GITHUB_SHA
        ? (pkg: FrozenCanaryArtifact) =>
            signCanarySource(pkg.manifest, pkg.packed, provenanceDirectory)
        : undefined,
    );
    // npm processes accepted writes asynchronously. The separate confirmation
    // job waits for visibility and can be re-run without publishing again.
    phase = "cohort_handoff";
    appendFileSync(
      process.env.GITHUB_OUTPUT!,
      `cohort=${canaryCohortHandoff(frozen, {
        source: process.env.SOURCE_SHA!,
        workflowSource: process.env.GITHUB_WORKFLOW_SHA!,
        runId: process.env.GITHUB_RUN_ID!,
        attempt: process.env.GITHUB_RUN_ATTEMPT!,
      })}\n`,
    );
    for (const pkg of packages) {
      process.stdout.write(`${pkg.name}@${versions.get(pkg.name)} accepted by npm\n`);
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
