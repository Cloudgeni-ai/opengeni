#!/usr/bin/env bun
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readArtifactKernelBuildReceipt } from "../packages/artifact-tool/kernel/bindings/package-receipt";
import {
  canonicalRuntimeDistribution,
  readRuntimeDistribution,
  requireRuntimeReleaseAsset,
  runtimeArtifactName,
  runtimeDigest,
  runtimeReleaseTag,
  validateRuntimeRelease,
  validateRuntimeSourceArtifact,
  positiveId,
  RUNTIME_NATIVE_TARGETS,
  RUNTIME_PROVENANCE_ASSET,
  RUNTIME_REPOSITORY,
  RUNTIME_REPOSITORY_ID,
  MAX_RUNTIME_ARCHIVE_BYTES,
  type RuntimeDistribution,
  type RuntimeRelease,
  type RuntimeReleaseAsset,
  type RuntimeSourceArtifact,
} from "./artifact-runtime-distribution";
import { verifyArchive } from "./resolve-development-artifact-runtime";
import { artifactKernelSourceIdentity } from "./artifact-kernel-source-identity";

export type RuntimePublisherApi = {
  get(path: string): Promise<any>;
  optional(path: string): Promise<any | null>;
  post(path: string, body: unknown): Promise<any>;
  patch(path: string, body: unknown): Promise<any>;
  upload(releaseId: number, name: string, bytes: Buffer): Promise<RuntimeReleaseAsset>;
  artifactBytes(id: number): Promise<Buffer>;
  assetBytes(id: number): Promise<Buffer>;
};

/** Provider-owned event fields are only selectors; re-read the canonical run before any mutation. */
export function validateRuntimeProducer(
  run: any,
  expected: { sourceSha: string; runId: number; runAttempt: number },
): void {
  runtimeReleaseTag(expected.sourceSha);
  if (
    !positiveId(expected.runId) ||
    !positiveId(expected.runAttempt) ||
    run.id !== expected.runId ||
    run.run_attempt !== expected.runAttempt ||
    run.head_sha !== expected.sourceSha ||
    run.head_branch !== "main" ||
    run.path !== ".github/workflows/ci.yml" ||
    run.name !== "CI" ||
    run.event !== "push" ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    run.repository?.id !== RUNTIME_REPOSITORY_ID ||
    run.repository.full_name !== RUNTIME_REPOSITORY ||
    run.head_repository?.id !== RUNTIME_REPOSITORY_ID ||
    run.head_repository.full_name !== RUNTIME_REPOSITORY
  ) {
    throw new Error(
      "runtime publication requires the exact successful canonical main-push CI attempt",
    );
  }
}

export async function publishArtifactRuntime(options: {
  sourceRoot: string;
  sourceSha: string;
  runId: number;
  runAttempt: number;
  temporaryRoot: string;
  api: RuntimePublisherApi;
}): Promise<{ releaseId: number; reused: boolean }> {
  const { api, sourceSha, runId, runAttempt } = options;
  const expectedSource = await artifactKernelSourceIdentity(options.sourceRoot);
  const tagName = runtimeReleaseTag(sourceSha);
  const runPath = `actions/runs/${runId}`;
  const firstRun = await api.get(runPath);
  validateRuntimeProducer(firstRun, options);
  const verifySource = async () => {
    const comparison = await api.get(`compare/${sourceSha}...main`);
    if (
      comparison.base_commit?.sha !== sourceSha ||
      comparison.merge_base_commit?.sha !== sourceSha ||
      !["ahead", "identical"].includes(comparison.status)
    )
      throw new Error("runtime source is not retained on canonical main");
  };
  await verifySource();
  const tagPath = `git/ref/tags/${tagName}`;
  let release = (await api.optional(`releases/tags/${tagName}`)) as RuntimeRelease | null;
  let tag = await api.optional(tagPath);
  if (
    tag &&
    (tag.ref !== `refs/tags/${tagName}` ||
      tag.object?.type !== "commit" ||
      tag.object.sha !== sourceSha)
  )
    throw new Error("existing runtime tag differs from exact source; never move it");
  if (release) {
    validateRuntimeRelease(release, sourceSha, tag, true);
    if (!release.draft) {
      // Durable idempotence does not depend on Actions artifacts still being retained.
      const asset = requireRuntimeReleaseAsset(release, RUNTIME_PROVENANCE_ASSET);
      const bytes = await api.assetBytes(asset.id);
      if (bytes.length !== asset.size || runtimeDigest(bytes) !== asset.digest)
        throw new Error("published provenance digest mismatch");
      const provenance = readRuntimeDistribution(bytes, sourceSha);
      if (release.assets.length !== 8) throw new Error("published runtime release is incomplete");
      for (const item of provenance.targets)
        requireRuntimeReleaseAsset(release, `${item.artifact.name}.zip`, item.artifact);
      return { releaseId: release.id, reused: true };
    }
  }

  const listing = await api.get(`actions/runs/${runId}/artifacts?per_page=100`);
  if (!Array.isArray(listing.artifacts) || listing.total_count > 100)
    throw new Error("runtime producer artifact listing exceeds bounded page");
  const artifacts = RUNTIME_NATIVE_TARGETS.map((target) => {
    const matches = listing.artifacts.filter(
      (a: RuntimeSourceArtifact) => a.name === runtimeArtifactName(sourceSha, target),
    );
    if (matches.length !== 1) throw new Error(`expected one exact producer artifact for ${target}`);
    const artifact = matches[0] as RuntimeSourceArtifact;
    validateRuntimeSourceArtifact(artifact, sourceSha, target);
    if (artifact.expired || artifact.workflow_run.id !== runId)
      throw new Error("expired or foreign-run native artifact");
    return { target, artifact };
  });
  const provenance: RuntimeDistribution = {
    schemaVersion: 1,
    repository: RUNTIME_REPOSITORY,
    repositoryId: RUNTIME_REPOSITORY_ID,
    sourceSha,
    producer: { workflow: ".github/workflows/ci.yml", runId, runAttempt },
    targets: artifacts,
  };
  const provenanceBytes = canonicalRuntimeDistribution(provenance);
  const uploads = new Map<string, Buffer>([[RUNTIME_PROVENANCE_ASSET, provenanceBytes]]);
  await mkdir(options.temporaryRoot, { recursive: true });
  const staging = await mkdtemp(join(options.temporaryRoot, "runtime-publication-"));
  try {
    let buildIdentity: string | undefined;
    let corpusDigest: string | undefined;
    for (const { target, artifact } of artifacts) {
      const archive = await api.artifactBytes(artifact.id);
      await verifyArchive(archive, artifact, target, staging, true, expectedSource);
      const receipt = await readArtifactKernelBuildReceipt(target, staging);
      if (
        buildIdentity &&
        (receipt.buildIdentity !== buildIdentity ||
          receipt.spreadsheetFormulaProjectionCorpusSha256 !== corpusDigest)
      )
        throw new Error("runtime matrix mixes kernel identities or formula corpus receipts");
      buildIdentity = receipt.buildIdentity;
      corpusDigest = receipt.spreadsheetFormulaProjectionCorpusSha256;
      uploads.set(`${artifact.name}.zip`, archive);
    }
    const recheck = async () => {
      const current = await api.get(runPath);
      validateRuntimeProducer(current, options);
      if (current.updated_at !== firstRun.updated_at)
        throw new Error("runtime producer changed during publication");
      await verifySource();
    };
    await recheck();
    // No mutation until the complete matrix has passed receipt and provider digest verification.
    if (!tag) {
      await api.post("git/refs", { ref: `refs/tags/${tagName}`, sha: sourceSha });
      tag = await api.get(tagPath);
    }
    if (!release) {
      release = (await api.post("releases", {
        tag_name: tagName,
        target_commitish: sourceSha,
        name: `OpenGeni native artifact runtime ${sourceSha}`,
        body: "Exact-source native runtime inputs verified from successful canonical main CI. Not a product release.",
        draft: true,
        prerelease: true,
        make_latest: "false",
      })) as RuntimeRelease;
    }
    validateRuntimeRelease(release, sourceSha, await api.get(tagPath), true);
    if (!release.draft)
      throw new Error("runtime release published concurrently; retry to verify, never overwrite");
    for (const asset of release.assets) {
      const expected = uploads.get(asset.name);
      if (!expected)
        throw new Error("draft contains an unexpected asset; refusing deletion/overwrite");
      requireRuntimeReleaseAsset(release, asset.name, {
        digest: runtimeDigest(expected),
        size_in_bytes: expected.length,
      });
    }
    for (const [name, bytes] of uploads) {
      if (release.assets.some((a) => a.name === name)) continue;
      // Upload does not use --clobber; duplicate names are a hard failure.
      await api.upload(release.id, name, bytes);
    }
    release = (await api.get(`releases/${release.id}`)) as RuntimeRelease;
    validateRuntimeRelease(release, sourceSha, await api.get(tagPath), true);
    if (!release.draft || release.assets.length !== 8)
      throw new Error("draft changed or is incomplete");
    for (const [name, bytes] of uploads)
      requireRuntimeReleaseAsset(release, name, {
        digest: runtimeDigest(bytes),
        size_in_bytes: bytes.length,
      });
    await recheck();
    await api.patch(`releases/${release.id}`, { draft: false, make_latest: "false" });
    const published = (await api.get(`releases/${release.id}`)) as RuntimeRelease;
    validateRuntimeRelease(published, sourceSha, await api.get(tagPath));
    if (published.assets.length !== 8) throw new Error("published runtime matrix changed");
    for (const [name, bytes] of uploads)
      requireRuntimeReleaseAsset(published, name, {
        digest: runtimeDigest(bytes),
        size_in_bytes: bytes.length,
      });
    return { releaseId: published.id, reused: false };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export function runtimeDownloadAccept(path: string): string {
  // Actions ZIP endpoints redirect to the archive but require the JSON API
  // media type. Release-asset endpoints require octet-stream for binary data.
  return path.startsWith("actions/") ? "application/vnd.github+json" : "application/octet-stream";
}

function githubPublisherApi(token: string): RuntimePublisherApi {
  const base = `https://api.github.com/repos/${RUNTIME_REPOSITORY}/`;
  const request = async (method: string, path: string, body?: unknown, optional = false) => {
    const response = await fetch(`${base}${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (optional && response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`GitHub runtime publication ${method} failed (HTTP ${response.status})`);
    }
    return JSON.parse((await boundedResponse(response, 1024 * 1024)).toString());
  };
  const ghBytes = async (path: string, limit: number) => {
    const child = Bun.spawn(
      [
        "gh",
        "api",
        "--hostname",
        "github.com",
        "-H",
        `Accept: ${runtimeDownloadAccept(path)}`,
        `repos/${RUNTIME_REPOSITORY}/${path}`,
      ],
      {
        env: { ...process.env, GH_TOKEN: token },
        stdout: "pipe",
        stderr: "ignore",
        stdin: "ignore",
      },
    );
    const timer = setTimeout(() => child.kill(), 60_000);
    try {
      const bytes = await boundedResponse(new Response(child.stdout), limit);
      if ((await child.exited) !== 0) throw new Error("GitHub runtime artifact download failed");
      return bytes;
    } finally {
      clearTimeout(timer);
      child.kill();
    }
  };
  return {
    get: (path) => request("GET", path),
    optional: (path) => request("GET", path, undefined, true),
    post: (path, body) => request("POST", path, body),
    patch: (path, body) => request("PATCH", path, body),
    artifactBytes: (id) => ghBytes(`actions/artifacts/${id}/zip`, MAX_RUNTIME_ARCHIVE_BYTES),
    assetBytes: (id) => ghBytes(`releases/assets/${id}`, 256 * 1024),
    upload: async (id, name, bytes) => {
      const response = await fetch(
        `https://uploads.github.com/repos/${RUNTIME_REPOSITORY}/releases/${id}/assets?name=${encodeURIComponent(name)}`,
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(60_000),
          body: new Uint8Array(bytes).buffer,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": name.endsWith(".zip") ? "application/zip" : "application/json",
          },
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(
          `GitHub runtime asset upload failed (HTTP ${response.status}); no overwrite attempted`,
        );
      }
      return JSON.parse((await boundedResponse(response, 256 * 1024)).toString());
    },
  };
}

async function boundedResponse(response: Response, limit: number): Promise<Buffer> {
  if (!response.body || Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new Error("runtime publication response exceeds limit");
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > limit) throw new Error("runtime publication response exceeds limit");
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}

if (import.meta.main) {
  if (
    process.env.GITHUB_REPOSITORY !== RUNTIME_REPOSITORY ||
    process.env.GITHUB_EVENT_NAME !== "workflow_run"
  )
    throw new Error("runtime publication runs only in canonical workflow_run automation");
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH!, "utf8"));
  if (event.action !== "completed" || event.repository?.id !== RUNTIME_REPOSITORY_ID)
    throw new Error("unexpected publication event");
  const run = event.workflow_run;
  const options = {
    sourceSha: run.head_sha as string,
    runId: run.id as number,
    runAttempt: run.run_attempt as number,
  };
  validateRuntimeProducer(run, options);
  const sourceRoot = resolve(process.env.RUNTIME_SOURCE_ROOT ?? "");
  const child = Bun.spawn(["git", "rev-parse", "HEAD"], {
    cwd: sourceRoot,
    stdout: "pipe",
    stderr: "ignore",
  });
  const head = (await new Response(child.stdout).text()).trim();
  if ((await child.exited) !== 0 || head !== options.sourceSha)
    throw new Error("publication source checkout mismatch");
  const token = process.env.GH_TOKEN;
  if (!token || !process.env.RUNNER_TEMP)
    throw new Error("publication token and runner temporary root required");
  console.log(
    JSON.stringify(
      await publishArtifactRuntime({
        ...options,
        sourceRoot,
        temporaryRoot: process.env.RUNNER_TEMP,
        api: githubPublisherApi(token),
      }),
    ),
  );
}
