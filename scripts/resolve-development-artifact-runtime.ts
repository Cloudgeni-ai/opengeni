import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { readArtifactKernelBuildReceipt } from "../packages/artifact-tool/kernel/bindings/package-receipt";
import {
  artifactRuntimeTarget,
  type NativeArtifactRuntimeTarget,
} from "../packages/artifact-tool/src/runtime";
import { resolvePublicRuntimeArchive, type RuntimeDownload } from "./artifact-runtime-distribution";

const REPOSITORY = "Cloudgeni-ai/opengeni";
const REPOSITORY_ID = 1212552738;
const MAX_ARCHIVE = 64 * 1024 * 1024;
const MAX_NATIVE = 128 * 1024 * 1024;
const RECEIPT = "artifact-kernel-build-receipt.json";
const NATIVE = "opengeni_artifact_kernel.node";
const WORKFLOWS = new Set([
  ".github/workflows/ci.yml",
  ".github/workflows/release-candidate.yml",
  ".github/workflows/publish-desktop-image.yml",
]);

export type PrebuiltResolution =
  | {
      available: true;
      assetRoot: string;
      sourceSha: string;
      source: "cache" | "actions" | "release";
    }
  | { available: false; diagnostic: string };

type Command = (args: string[], cwd: string, limit: number, timeout: number) => Promise<Buffer>;
type Artifact = {
  id: number;
  name: string;
  digest: string;
  expired: boolean;
  size_in_bytes: number;
  workflow_run: { id: number; head_sha: string; repository_id: number; head_repository_id: number };
};

/** Setup only: never looks up latest, borrows another source, or executes downloaded code. */
export async function resolveDevelopmentArtifactRuntime(options: {
  repositoryRoot: string;
  target: NativeArtifactRuntimeTarget;
  command?: Command;
  publicDownload?: RuntimeDownload;
}): Promise<PrebuiltResolution> {
  const command = options.command ?? boundedCommand;
  const deadline = Date.now() + 90_000;
  const run = (args: string[], limit = 1024 * 1024) =>
    command(
      args,
      options.repositoryRoot,
      limit,
      Math.max(1, Math.min(60_000, deadline - Date.now())),
    );
  let staging: string | undefined;
  try {
    if (artifactRuntimeTarget(options.target).kind !== "native") {
      throw new Error("prebuilt development setup requires a supported native host target");
    }
    // Conservatively require the entire source tree to match HEAD, including untracked inputs.
    const sourceSha = (await run(["git", "rev-parse", "HEAD"])).toString().trim();
    if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error("checkout has no exact source SHA");
    if ((await run(["git", "status", "--porcelain", "--untracked-files=all"])).length) {
      throw new Error("checkout has local changes; commit them or use the source build");
    }
    const recheckSource = async () => {
      if (
        (await run(["git", "rev-parse", "HEAD"])).toString().trim() !== sourceSha ||
        (await run(["git", "status", "--porcelain", "--untracked-files=all"])).length
      ) {
        throw new Error("source changed during prebuilt resolution");
      }
    };
    const cacheParent = join(options.repositoryRoot, ".opengeni", "artifact-runtime-prebuilt");
    for (const path of [join(options.repositoryRoot, ".opengeni"), cacheParent]) {
      await mkdir(path, { recursive: true });
      if (!(await lstat(path)).isDirectory() || (await lstat(path)).isSymbolicLink()) {
        throw new Error("prebuilt cache must be a real directory");
      }
    }
    const cache = join(cacheParent, `${sourceSha}-${options.target}`);
    const name = `artifact-runtime-target-${sourceSha}-${options.target}`;
    const validateArtifact = (artifact: Artifact) => {
      if (
        !Number.isSafeInteger(artifact.id) ||
        artifact.id <= 0 ||
        artifact.name !== name ||
        !/^sha256:[a-f0-9]{64}$/.test(artifact.digest) ||
        !Number.isSafeInteger(artifact.size_in_bytes) ||
        artifact.size_in_bytes <= 0 ||
        artifact.size_in_bytes > MAX_ARCHIVE ||
        artifact.workflow_run?.head_sha !== sourceSha ||
        !Number.isSafeInteger(artifact.workflow_run.id) ||
        artifact.workflow_run.id <= 0 ||
        artifact.workflow_run.repository_id !== REPOSITORY_ID ||
        artifact.workflow_run.head_repository_id !== REPOSITORY_ID
      ) {
        throw new Error("artifact provenance does not match the exact repository/source/target");
      }
    };
    try {
      if ((await lstat(cache)).isSymbolicLink()) throw new Error("cache symlink");
      const metadata = JSON.parse(
        (await boundedFile(join(cache, "provenance.json"), 1024 * 1024)).toString(),
      );
      validateArtifact(metadata);
      const archive = await boundedFile(join(cache, "archive.zip"), MAX_ARCHIVE);
      await verifyArchive(archive, metadata, options.target, cache, false);
      await recheckSource();
      return { available: true, assetRoot: cache, sourceSha, source: "cache" };
    } catch {
      /* A missing/corrupt cache never supplies executable authority. */
    }

    let publicFailure = "";
    try {
      const published = await resolvePublicRuntimeArchive(
        sourceSha,
        options.target,
        Math.min(deadline, Date.now() + 30_000),
        options.publicDownload,
      );
      validateArtifact(published.artifact);
      staging = await mkdtemp(join(cacheParent, ".download-"));
      await verifyArchive(published.archive, published.artifact, options.target, staging, true);
      await writeFile(join(staging, "archive.zip"), published.archive);
      await writeFile(join(staging, "provenance.json"), JSON.stringify(published.artifact));
      await rm(cache, { recursive: true, force: true });
      await rename(staging, cache);
      staging = undefined;
      await pruneCache(cacheParent, cache);
      await recheckSource();
      return { available: true, assetRoot: cache, sourceSha, source: "release" };
    } catch (error) {
      publicFailure = error instanceof Error ? error.message : "public release unavailable";
      if (staging) {
        await rm(staging, { recursive: true, force: true });
        staging = undefined;
      }
    }
    const api = async (path: string) =>
      JSON.parse(
        (
          await run(["gh", "api", "--hostname", "github.com", `repos/${REPOSITORY}/${path}`])
        ).toString(),
      );
    const listing = await api(`actions/artifacts?name=${name}&per_page=10`);
    let selected: Artifact | undefined;
    for (const artifact of (listing.artifacts ?? []).slice(0, 10) as Artifact[]) {
      validateArtifact(artifact);
      if (artifact.expired) continue;
      const producer = await api(`actions/runs/${artifact.workflow_run.id}`);
      if (
        producer.head_sha !== sourceSha ||
        producer.repository?.id !== REPOSITORY_ID ||
        producer.head_repository?.id !== REPOSITORY_ID ||
        producer.status !== "completed" ||
        producer.conclusion !== "success" ||
        !WORKFLOWS.has(producer.path) ||
        !["push", "workflow_dispatch"].includes(producer.event)
      )
        continue;
      selected = artifact;
      break;
    }
    if (!selected)
      throw new Error(
        `public release unavailable (${publicFailure}); no successful exact-source artifact within the bounded 10-artifact lookup (CI retention is 3 days)`,
      );
    const archive = await run(
      [
        "gh",
        "api",
        "--hostname",
        "github.com",
        `repos/${REPOSITORY}/actions/artifacts/${selected.id}/zip`,
      ],
      MAX_ARCHIVE,
    );
    staging = await mkdtemp(join(cacheParent, ".download-"));
    await verifyArchive(archive, selected, options.target, staging, true);
    await writeFile(join(staging, "archive.zip"), archive);
    await writeFile(join(staging, "provenance.json"), JSON.stringify(selected));
    // Remove only this exact generated cache key. Never touch a source build or installation.
    await rm(cache, { recursive: true, force: true });
    await rename(staging, cache);
    staging = undefined;
    await pruneCache(cacheParent, cache);
    await recheckSource();
    return { available: true, assetRoot: cache, sourceSha, source: "actions" };
  } catch (error) {
    return {
      available: false,
      diagnostic: `Prebuilt artifact runtime unavailable: ${error instanceof Error ? error.message : "resolution failed"}. Falling back to pinned Rust source build. Anonymous setup requires an immutable exact-source runtime release; optional Actions fallback requires gh with Actions read access and an unexpired artifact.`,
    };
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
  }
}

/** Retain at most three exact generated entries, never traverse links or other names. */
async function pruneCache(parent: string, current: string): Promise<void> {
  const entries: { path: string; modified: number }[] = [];
  for (const name of await readdir(parent)) {
    if (
      !/^[a-f0-9]{40}-(?:darwin-(?:x64|arm64)|linux-(?:x64|arm64)-(?:gnu|musl)|win32-x64-msvc)$/.test(
        name,
      )
    )
      continue;
    const path = join(parent, name);
    const metadata = await lstat(path);
    if (path !== current && metadata.isDirectory() && !metadata.isSymbolicLink())
      entries.push({ path, modified: metadata.mtimeMs });
  }
  entries.sort((left, right) => right.modified - left.modified);
  for (const entry of entries.slice(2)) await rm(entry.path, { recursive: true, force: true });
}

export async function verifyArchive(
  archive: Buffer,
  artifact: Artifact,
  target: NativeArtifactRuntimeTarget,
  root: string,
  extract: boolean,
) {
  if (archive.length !== artifact.size_in_bytes || digest(archive) !== artifact.digest) {
    throw new Error("provider archive size/digest mismatch");
  }
  const files = decodeArtifactRuntimeZip(archive, target);
  const directory = join(root, "native", target);
  if (extract) {
    await mkdir(directory, { recursive: true });
    for (const [name, bytes] of files) await writeFile(join(directory, name), bytes);
  } else {
    for (const path of [join(root, "native"), directory]) {
      if ((await lstat(path)).isSymbolicLink()) throw new Error("cache symlink");
    }
    for (const [name, bytes] of files) {
      if (!(await boundedFile(join(directory, name), MAX_NATIVE)).equals(bytes))
        throw new Error("cache tampering");
    }
  }
  const receipt = await readArtifactKernelBuildReceipt(target, root);
  if (receipt.runtimeFiles.length !== 1 || receipt.runtimeFiles[0]?.path !== NATIVE)
    throw new Error("unexpected native receipt files");
  const proof = receipt.runtimeFiles[0];
  const bytes = files.get(NATIVE)!;
  if (proof.bytes !== bytes.length || proof.sha256 !== digest(bytes))
    throw new Error("native receipt digest mismatch");
}

/** Narrow ZIP reader: two named regular files, stored/deflate, no ZIP64, no filesystem paths. */
export function decodeArtifactRuntimeZip(
  archive: Buffer,
  target: NativeArtifactRuntimeTarget,
): Map<string, Buffer> {
  if (archive.length > MAX_ARCHIVE || archive.length < 22) throw new Error("invalid ZIP size");
  let end = archive.length - 22;
  while (end >= Math.max(0, archive.length - 65557) && archive.readUInt32LE(end) !== 0x06054b50)
    end--;
  if (
    end < 0 ||
    archive.readUInt32LE(end) !== 0x06054b50 ||
    end + 22 + archive.readUInt16LE(end + 20) !== archive.length ||
    archive.readUInt32LE(end + 4) !== 0 ||
    archive.readUInt16LE(end + 8) !== 2 ||
    archive.readUInt16LE(end + 10) !== 2
  )
    throw new Error("unsupported ZIP directory");
  let cursor = archive.readUInt32LE(end + 16);
  if (cursor + archive.readUInt32LE(end + 12) !== end)
    throw new Error("invalid ZIP directory bounds");
  const result = new Map<string, Buffer>();
  for (let index = 0; index < 2; index++) {
    if (cursor + 46 > end || archive.readUInt32LE(cursor) !== 0x02014b50)
      throw new Error("invalid ZIP entry");
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const packed = archive.readUInt32LE(cursor + 20);
    const size = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    const basename =
      name === `native/${target}/${RECEIPT}`
        ? RECEIPT
        : name === `native/${target}/${NATIVE}`
          ? NATIVE
          : undefined;
    const mode = archive.readUInt32LE(cursor + 38) >>> 16;
    if (
      !basename ||
      result.has(basename) ||
      flags & ~0x808 ||
      ![0, 8].includes(method) ||
      ((mode & 0xf000) !== 0 && (mode & 0xf000) !== 0x8000) ||
      size <= 0 ||
      size > (basename === RECEIPT ? 256 * 1024 : MAX_NATIVE)
    )
      throw new Error("unexpected ZIP file/type/size");
    const local = archive.readUInt32LE(cursor + 42);
    if (local + 30 > cursor || archive.readUInt32LE(local) !== 0x04034b50)
      throw new Error("invalid local ZIP entry");
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    if (start + packed > archive.readUInt32LE(end + 16)) throw new Error("invalid ZIP data bounds");
    const compressed = archive.subarray(start, start + packed);
    const bytes = method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: size });
    if (bytes.length !== size) throw new Error("ZIP expanded size mismatch");
    result.set(basename, bytes);
    cursor +=
      46 + nameLength + archive.readUInt16LE(cursor + 30) + archive.readUInt16LE(cursor + 32);
  }
  if (cursor !== end) throw new Error("unexpected ZIP trailing directory data");
  return result;
}

function digest(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function boundedFile(path: string, limit: number): Promise<Buffer> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.size > limit) throw new Error("invalid cached file");
  const bytes = await readFile(path);
  if (bytes.length !== metadata.size) throw new Error("cached file changed while reading");
  return bytes;
}

async function boundedCommand(
  args: string[],
  cwd: string,
  limit: number,
  timeout: number,
): Promise<Buffer> {
  const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeout);
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of child.stdout) {
      size += chunk.length;
      if (size > limit) throw new Error(`${args[0]} output exceeds setup limit`);
      chunks.push(Buffer.from(chunk));
    }
    if ((await child.exited) !== 0 || timedOut)
      throw new Error(
        `${args[0]} ${timedOut ? "timed out" : "failed (check installation/access)"}`,
      );
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}
