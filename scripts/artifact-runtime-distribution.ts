import { createHash } from "node:crypto";
import type { NativeArtifactRuntimeTarget } from "../packages/artifact-tool/src/runtime";

export const RUNTIME_REPOSITORY = "Cloudgeni-ai/opengeni";
export const RUNTIME_REPOSITORY_ID = 1212552738;
export const RUNTIME_NATIVE_TARGETS = [
  "darwin-x64",
  "darwin-arm64",
  "linux-x64-gnu",
  "linux-arm64-gnu",
  "linux-x64-musl",
  "linux-arm64-musl",
  "win32-x64-msvc",
] as const;
export const RUNTIME_PROVENANCE_ASSET = "artifact-runtime-provenance.json";
export const MAX_RUNTIME_ARCHIVE_BYTES = 64 * 1024 * 1024;
export type RuntimeSourceArtifact = {
  id: number;
  name: string;
  digest: string;
  expired: boolean;
  size_in_bytes: number;
  workflow_run: { id: number; head_sha: string; repository_id: number; head_repository_id: number };
};
export type RuntimeDistribution = {
  schemaVersion: 1;
  repository: typeof RUNTIME_REPOSITORY;
  repositoryId: typeof RUNTIME_REPOSITORY_ID;
  sourceSha: string;
  producer: { workflow: ".github/workflows/ci.yml"; runId: number; runAttempt: number };
  targets: { target: NativeArtifactRuntimeTarget; artifact: RuntimeSourceArtifact }[];
};
export type RuntimeReleaseAsset = {
  id: number;
  name: string;
  size: number;
  digest: string;
  state: string;
};
export type RuntimeRelease = {
  id: number;
  tag_name: string;
  target_commitish: string;
  draft: boolean;
  immutable: boolean;
  prerelease: boolean;
  author: { id: number; login: string; type: string };
  assets: RuntimeReleaseAsset[];
};

export function runtimeReleaseTag(sourceSha: string): string {
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error("invalid runtime source SHA");
  return `opengeni-artifact-runtime-${sourceSha}`;
}
export function runtimeArtifactName(
  sourceSha: string,
  target: NativeArtifactRuntimeTarget,
): string {
  runtimeReleaseTag(sourceSha);
  if (!RUNTIME_NATIVE_TARGETS.includes(target))
    throw new Error("unsupported runtime distribution target");
  return `artifact-runtime-target-${sourceSha}-${target}`;
}
export function runtimeDigest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
export function positiveId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

export function validateRuntimeSourceArtifact(
  artifact: RuntimeSourceArtifact,
  sourceSha: string,
  target: NativeArtifactRuntimeTarget,
): void {
  if (
    !positiveId(artifact.id) ||
    artifact.name !== runtimeArtifactName(sourceSha, target) ||
    !/^sha256:[a-f0-9]{64}$/.test(artifact.digest) ||
    !positiveId(artifact.size_in_bytes) ||
    artifact.size_in_bytes > MAX_RUNTIME_ARCHIVE_BYTES ||
    typeof artifact.expired !== "boolean" ||
    artifact.workflow_run?.head_sha !== sourceSha ||
    !positiveId(artifact.workflow_run.id) ||
    artifact.workflow_run.repository_id !== RUNTIME_REPOSITORY_ID ||
    artifact.workflow_run.head_repository_id !== RUNTIME_REPOSITORY_ID
  ) {
    throw new Error("artifact provenance does not match the exact repository/source/target");
  }
}

/** Canonical closed source receipt: historical run facts remain useful after Actions expiry. */
export function canonicalRuntimeDistribution(value: RuntimeDistribution): Buffer {
  runtimeReleaseTag(value.sourceSha);
  if (
    value.schemaVersion !== 1 ||
    value.repository !== RUNTIME_REPOSITORY ||
    value.repositoryId !== RUNTIME_REPOSITORY_ID ||
    value.producer?.workflow !== ".github/workflows/ci.yml" ||
    !positiveId(value.producer.runId) ||
    !positiveId(value.producer.runAttempt) ||
    value.targets?.length !== RUNTIME_NATIVE_TARGETS.length
  )
    throw new Error("invalid runtime distribution provenance");
  const targets = RUNTIME_NATIVE_TARGETS.map((target, index) => {
    const item = value.targets[index];
    if (!item || item.target !== target)
      throw new Error("runtime distribution requires the ordered seven native targets");
    const a = item.artifact;
    validateRuntimeSourceArtifact(a, value.sourceSha, target);
    if (a.expired || a.workflow_run.id !== value.producer.runId)
      throw new Error("runtime distribution mixes producer runs or expired artifacts");
    return {
      target,
      artifact: {
        id: a.id,
        name: a.name,
        digest: a.digest,
        expired: false,
        size_in_bytes: a.size_in_bytes,
        workflow_run: {
          id: a.workflow_run.id,
          head_sha: a.workflow_run.head_sha,
          repository_id: a.workflow_run.repository_id,
          head_repository_id: a.workflow_run.head_repository_id,
        },
      },
    };
  });
  if (new Set(targets.map((t) => t.artifact.id)).size !== targets.length)
    throw new Error("duplicate runtime artifact identity");
  return Buffer.from(
    `${JSON.stringify({
      schemaVersion: 1,
      repository: RUNTIME_REPOSITORY,
      repositoryId: RUNTIME_REPOSITORY_ID,
      sourceSha: value.sourceSha,
      producer: {
        workflow: value.producer.workflow,
        runId: value.producer.runId,
        runAttempt: value.producer.runAttempt,
      },
      targets,
    })}\n`,
  );
}

export function readRuntimeDistribution(bytes: Buffer, sourceSha: string): RuntimeDistribution {
  if (bytes.length > 256 * 1024) throw new Error("runtime provenance exceeds limit");
  const value = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  ) as RuntimeDistribution;
  if (value.sourceSha !== sourceSha || !canonicalRuntimeDistribution(value).equals(bytes))
    throw new Error("runtime provenance is noncanonical or for another source");
  return value;
}

export function validateRuntimeRelease(
  release: RuntimeRelease,
  sourceSha: string,
  tag: { ref: string; object: { type: string; sha: string } },
  allowDraft = false,
): void {
  const expectedTag = runtimeReleaseTag(sourceSha);
  if (
    !positiveId(release.id) ||
    release.tag_name !== expectedTag ||
    release.target_commitish !== sourceSha ||
    release.prerelease !== true ||
    release.author?.id !== 41898282 ||
    release.author.login !== "github-actions[bot]" ||
    release.author.type !== "Bot" ||
    (allowDraft
      ? release.draft !== true && release.immutable !== true
      : release.draft !== false || release.immutable !== true) ||
    tag.ref !== `refs/tags/${expectedTag}` ||
    tag.object?.type !== "commit" ||
    tag.object.sha !== sourceSha
  ) {
    throw new Error("runtime release is not an exact-source immutable bot publication");
  }
  if (
    !Array.isArray(release.assets) ||
    release.assets.length > 8 ||
    new Set(release.assets.map((a) => a.name)).size !== release.assets.length
  )
    throw new Error("unexpected or duplicate runtime release assets");
}

export function requireRuntimeReleaseAsset(
  release: RuntimeRelease,
  name: string,
  expected?: { digest: string; size_in_bytes: number },
): RuntimeReleaseAsset {
  const asset = release.assets.find((a) => a.name === name);
  if (
    !asset ||
    !positiveId(asset.id) ||
    asset.state !== "uploaded" ||
    !positiveId(asset.size) ||
    asset.size > (name === RUNTIME_PROVENANCE_ASSET ? 256 * 1024 : MAX_RUNTIME_ARCHIVE_BYTES) ||
    !/^sha256:[a-f0-9]{64}$/.test(asset.digest) ||
    (expected && (asset.digest !== expected.digest || asset.size !== expected.size_in_bytes))
  ) {
    throw new Error(`runtime release asset is missing or mismatched: ${name}`);
  }
  return asset;
}

export type RuntimeDownload = (url: string, limit: number, deadline: number) => Promise<Buffer>;

/** Anonymous, fixed-provider HTTPS only; deadline/byte/redirect bounded, never forwards credentials. */
export const downloadRuntimePublic: RuntimeDownload = async (url, limit, deadline) => {
  for (let redirects = 0; redirects <= 3; redirects++) {
    const location = new URL(url);
    if (
      location.protocol !== "https:" ||
      location.username ||
      location.password ||
      location.port ||
      !["api.github.com", "github.com", "release-assets.githubusercontent.com"].includes(
        location.hostname,
      )
    )
      throw new Error("runtime download left the GitHub release boundary");
    if (Date.now() >= deadline) throw new Error("runtime download deadline exceeded");
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(deadline - Date.now()),
      headers: { Accept: "application/vnd.github+json" },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = response.headers.get("location");
      await response.body?.cancel();
      if (!next) throw new Error("runtime release redirect missing location");
      url = new URL(next, url).href;
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`GitHub runtime release request failed (HTTP ${response.status})`);
    }
    if (Number(response.headers.get("content-length")) > limit) {
      await response.body.cancel();
      throw new Error("runtime download exceeds byte limit");
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        size += result.value.length;
        if (size > limit) throw new Error("runtime download exceeds byte limit");
        chunks.push(Buffer.from(result.value));
      }
    } finally {
      await reader.cancel();
    }
    return Buffer.concat(chunks);
  }
  throw new Error("runtime download redirect limit exceeded");
};

export async function resolvePublicRuntimeArchive(
  sourceSha: string,
  target: NativeArtifactRuntimeTarget,
  deadline: number,
  download = downloadRuntimePublic,
) {
  const base = `https://api.github.com/repos/${RUNTIME_REPOSITORY}`;
  const tagName = runtimeReleaseTag(sourceSha);
  const json = async (path: string) =>
    JSON.parse((await download(`${base}/${path}`, 256 * 1024, deadline)).toString());
  const release = (await json(`releases/tags/${tagName}`)) as RuntimeRelease;
  const tag = await json(`git/ref/tags/${tagName}`);
  validateRuntimeRelease(release, sourceSha, tag);
  const provenanceAsset = requireRuntimeReleaseAsset(release, RUNTIME_PROVENANCE_ASSET);
  const assetUrl = (name: string) =>
    `https://github.com/${RUNTIME_REPOSITORY}/releases/download/${tagName}/${name}`;
  const provenanceBytes = await download(assetUrl(RUNTIME_PROVENANCE_ASSET), 256 * 1024, deadline);
  if (
    provenanceBytes.length !== provenanceAsset.size ||
    runtimeDigest(provenanceBytes) !== provenanceAsset.digest
  )
    throw new Error("runtime release provenance provider digest mismatch");
  const provenance = readRuntimeDistribution(provenanceBytes, sourceSha);
  if (release.assets.length !== 8) throw new Error("runtime release is incomplete");
  for (const item of provenance.targets)
    requireRuntimeReleaseAsset(release, `${item.artifact.name}.zip`, item.artifact);
  const artifact = provenance.targets.find((t) => t.target === target)!.artifact;
  const archive = await download(
    assetUrl(`${artifact.name}.zip`),
    MAX_RUNTIME_ARCHIVE_BYTES,
    deadline,
  );
  if (archive.length !== artifact.size_in_bytes || runtimeDigest(archive) !== artifact.digest)
    throw new Error("runtime release archive provider digest mismatch");
  // A changed projection is not admitted even if its old bytes happened to download.
  const finalRelease = (await json(`releases/tags/${tagName}`)) as RuntimeRelease;
  validateRuntimeRelease(finalRelease, sourceSha, await json(`git/ref/tags/${tagName}`));
  if (
    finalRelease.id !== release.id ||
    JSON.stringify(finalRelease.assets) !== JSON.stringify(release.assets)
  )
    throw new Error("runtime release changed during download");
  return { archive, artifact };
}
