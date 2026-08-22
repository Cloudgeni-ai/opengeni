#!/usr/bin/env bun

import { dlopen, FFIType } from "bun:ffi";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import process from "node:process";

const DEFAULT_BUILDER = "opengeni-development-sandbox";
// One full headless sandbox build keeps roughly 10-14 GB of BuildKit records
// (Rust/Bun dependency caches, staged sources, exported layers). A cap below
// that working set makes every `bun run dev` evict and rebuild the image, so
// the default leaves room for the current build plus a few source revisions.
const DEFAULT_CACHE_LIMIT = "24gb";
const DEFAULT_IMAGE_RETENTION = 3;
const SOURCE_TAG = /^opengeni-sandbox:local-[0-9a-f]{12,64}-[a-z0-9][a-z0-9-]{0,62}$/u;
const LEASE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const MAINTENANCE_ROOT = join(tmpdir(), "opengeni-development-sandbox-maintenance");
const LEASE_ROOT = join(MAINTENANCE_ROOT, "leases");
const LOCK_FILE = join(MAINTENANCE_ROOT, "maintenance.lock");
const BUILDER_CONFIG_FILE = join(MAINTENANCE_ROOT, "buildkitd.toml");
const LOCK_WAIT_MS = 30 * 60 * 1000;
const LEASE_TOKEN = /^[0-9a-f]{8}-[0-9a-f-]{27,63}$/u;
const LOCK_EXCLUSIVE = 2;
const LOCK_NONBLOCKING = 4;
const LOCK_UNLOCK = 8;

type DockerImage = Readonly<{
  id: string;
  createdAt: string;
  tags: readonly string[];
  managed?: boolean;
}>;

export type DevelopmentSandboxDiskPolicy = Readonly<{
  cacheLimit: string;
  imageRetention: number;
}>;

export type DevelopmentSandboxRetentionPlan = Readonly<{
  keepImageIds: readonly string[];
  removeImageIds: readonly string[];
  removeTags: readonly string[];
}>;

export function developmentSandboxDiskPolicy(
  environment: Readonly<Record<string, string | undefined>>,
): DevelopmentSandboxDiskPolicy {
  const cacheLimit =
    environment.OPENGENI_DEV_SANDBOX_BUILD_CACHE_MAX?.trim().toLowerCase() || DEFAULT_CACHE_LIMIT;
  if (!/^[1-9][0-9]*(?:[kmgt]i?b)?$/u.test(cacheLimit)) {
    throw new TypeError("OPENGENI_DEV_SANDBOX_BUILD_CACHE_MAX must be a positive byte size");
  }
  const retentionSource = environment.OPENGENI_DEV_SANDBOX_IMAGE_RETENTION?.trim();
  const imageRetention = retentionSource
    ? Number.parseInt(retentionSource, 10)
    : DEFAULT_IMAGE_RETENTION;
  if (
    !Number.isSafeInteger(imageRetention) ||
    imageRetention < 1 ||
    String(imageRetention) !== (retentionSource ?? String(DEFAULT_IMAGE_RETENTION))
  ) {
    throw new TypeError("OPENGENI_DEV_SANDBOX_IMAGE_RETENTION must be a positive integer");
  }
  return { cacheLimit, imageRetention };
}

export function planDevelopmentSandboxImageRetention(
  images: readonly DockerImage[],
  protectedImageIds: ReadonlySet<string>,
  currentImage: string,
  retention: number,
): DevelopmentSandboxRetentionPlan {
  if (!SOURCE_TAG.test(currentImage)) {
    throw new TypeError("currentImage must be an exact source-tagged OpenGeni sandbox image");
  }
  if (!Number.isSafeInteger(retention) || retention < 0) {
    throw new TypeError("retention must be a non-negative integer");
  }
  const candidates = images
    .map((image) => ({
      ...image,
      tags: image.tags.filter((tag) => SOURCE_TAG.test(tag)),
    }))
    .filter((image) => image.tags.length > 0)
    .sort((left, right) => {
      const created = Date.parse(right.createdAt) - Date.parse(left.createdAt);
      return created === 0 ? left.id.localeCompare(right.id) : created;
    });
  const currentImageId = candidates.find((image) => image.tags.includes(currentImage))?.id;
  const keepImageIds = new Set(protectedImageIds);
  if (currentImageId) keepImageIds.add(currentImageId);
  for (const image of candidates.slice(0, retention)) keepImageIds.add(image.id);
  const removeTags = candidates
    .filter((image) => !keepImageIds.has(image.id))
    .flatMap((image) => image.tags)
    .sort();
  const removeImageIds = images
    .filter(
      (image) =>
        image.managed === true &&
        image.tags.length === 0 &&
        !keepImageIds.has(image.id) &&
        !protectedImageIds.has(image.id),
    )
    .map((image) => image.id)
    .sort();
  return {
    keepImageIds: [...keepImageIds].sort(),
    removeImageIds,
    removeTags,
  };
}

type Arguments = Readonly<{
  repositoryRoot: string;
  image: string;
  runtimeBundle: string;
  sourceSha: string;
  leaseId: string;
  leasePid: number;
  leaseToken: string;
}>;

export async function prepareDevelopmentSandboxImage(
  options: Arguments,
  environment: Readonly<Record<string, string | undefined>> = Bun.env,
): Promise<void> {
  if (!isAbsolute(options.repositoryRoot)) throw new TypeError("repositoryRoot must be absolute");
  const repositoryRoot = await realpath(options.repositoryRoot);
  if (!SOURCE_TAG.test(options.image)) {
    throw new TypeError("image must be an exact source-tagged OpenGeni sandbox image");
  }
  if (!/^[0-9a-f]{40}$/u.test(options.sourceSha)) {
    throw new TypeError("sourceSha must be an exact Git SHA");
  }
  if (!LEASE_ID.test(options.leaseId)) throw new TypeError("leaseId is invalid");
  if (!Number.isSafeInteger(options.leasePid) || options.leasePid < 1) {
    throw new TypeError("leasePid must be a positive integer");
  }
  if (!LEASE_TOKEN.test(options.leaseToken)) throw new TypeError("leaseToken is invalid");
  const policy = developmentSandboxDiskPolicy(environment);
  await withMaintenanceLock(async () => {
    await writeLease(options);
    await pruneImages(
      options.image,
      Math.max(0, policy.imageRetention - 1),
      await activeLeasedImages(),
    );
    await ensureBuilder(policy);
    await warnWhenDockerDiskCannotHoldCache(policy);
    let buildError: unknown;
    let cacheError: unknown;
    try {
      await pruneBuilderCache(policy, "before build");
      await buildImage(options, repositoryRoot);
    } catch (error) {
      buildError = error;
    } finally {
      try {
        await pruneBuilderCache(policy, "after build attempt");
      } catch (error) {
        cacheError = error;
      }
      const stopped = await commandResult(["docker", "buildx", "stop", DEFAULT_BUILDER]);
      if (stopped.exitCode !== 0) {
        console.warn(`Unable to stop the OpenGeni development builder: ${stopped.stderr.trim()}`);
      }
    }
    if (buildError && cacheError) {
      throw new AggregateError(
        [buildError, cacheError],
        "Sandbox image build and cache convergence both failed",
      );
    }
    if (buildError) throw buildError;
    if (cacheError) throw cacheError;
    await pruneImages(options.image, policy.imageRetention, await activeLeasedImages());
  });
}

/**
 * BuildKit's built-in GC prunes toward its own defaults (keep ~10% of the
 * Docker disk, prune whenever free space drops under ~20%), which on a busy
 * laptop evicts the sandbox cache between starts no matter what
 * `buildx prune --max-used-space` keeps. The dedicated builder therefore runs
 * with one explicit policy equal to the configured cap; the policy is encoded
 * in the node name so a changed cap recreates the builder once instead of
 * silently running with a stale daemon config.
 */
export function builderGcConfig(policy: DevelopmentSandboxDiskPolicy): string {
  return [
    "# Generated by scripts/prepare-development-sandbox-image.ts for the OpenGeni",
    "# development sandbox builder. Do not edit; change OPENGENI_DEV_SANDBOX_BUILD_CACHE_MAX.",
    "[worker.oci]",
    "  gc = true",
    "  [[worker.oci.gcpolicy]]",
    "    all = true",
    `    reservedSpace = "${policy.cacheLimit}"`,
    `    maxUsedSpace = "${policy.cacheLimit}"`,
    "",
  ].join("\n");
}

export function builderNodeName(policy: DevelopmentSandboxDiskPolicy): string {
  const digest = createHash("sha256").update(builderGcConfig(policy)).digest("hex").slice(0, 8);
  return `${DEFAULT_BUILDER}-${digest}`;
}

function builderNodeNames(inspectOutput: string): Set<string> {
  return new Set(Array.from(inspectOutput.matchAll(/^Name:\s+(\S+)\s*$/gmu), (match) => match[1]!));
}

async function ensureBuilder(policy: DevelopmentSandboxDiskPolicy): Promise<void> {
  const node = builderNodeName(policy);
  const existing = await commandResult(["docker", "buildx", "inspect", DEFAULT_BUILDER]);
  if (existing.exitCode === 0 && !builderNodeNames(existing.stdout).has(node)) {
    console.log(
      `Recreating the OpenGeni sandbox builder with cache bound ${policy.cacheLimit}; its cache rebuilds once.`,
    );
    await command(["docker", "buildx", "rm", "--force", DEFAULT_BUILDER]);
  }
  if (existing.exitCode !== 0 || !builderNodeNames(existing.stdout).has(node)) {
    await mkdir(MAINTENANCE_ROOT, { recursive: true });
    await writeFile(BUILDER_CONFIG_FILE, builderGcConfig(policy));
    const create = (configFlag: string) =>
      commandResult([
        "docker",
        "buildx",
        "create",
        "--name",
        DEFAULT_BUILDER,
        "--node",
        node,
        "--driver",
        "docker-container",
        configFlag,
        BUILDER_CONFIG_FILE,
      ]);
    // buildx renamed `--config` to `--buildkitd-config` in v0.13; accept both so
    // older distro-packaged plugins still get the explicit GC policy.
    let created = await create("--buildkitd-config");
    if (created.exitCode !== 0 && /unknown flag: --buildkitd-config/u.test(created.stderr)) {
      created = await create("--config");
    }
    if (created.exitCode !== 0) {
      throw new Error(`docker failed: ${created.stderr.trim() || `exit ${created.exitCode}`}`);
    }
  }
  await command(["docker", "buildx", "inspect", DEFAULT_BUILDER, "--bootstrap"]);
}

const BYTE_UNITS: Readonly<Record<string, number>> = {
  b: 1,
  k: 1024,
  m: 1024 ** 2,
  g: 1024 ** 3,
  t: 1024 ** 4,
};

/** Parses the cap syntax accepted by `developmentSandboxDiskPolicy` (go-units RAM sizes). */
export function parseByteSize(value: string): number {
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*([kmgt])?i?b?$/iu.exec(value.trim());
  if (!match) throw new TypeError(`Unsupported byte size: ${value}`);
  return Math.round(Number(match[1]) * BYTE_UNITS[(match[2] ?? "b").toLowerCase()]!);
}

/**
 * The cap is only useful when Docker's disk can actually hold it. Free space
 * is read from the builder container (it shares the Docker VM / host disk),
 * and the already-stored cache counts toward the cap, so the warning fires
 * only when the remaining cap cannot fit. Never fatal: the build still runs.
 */
async function warnWhenDockerDiskCannotHoldCache(
  policy: DevelopmentSandboxDiskPolicy,
): Promise<void> {
  const free = await commandResult([
    "docker",
    "exec",
    `buildx_buildkit_${builderNodeName(policy)}`,
    "df",
    "-Pk",
    "/var/lib/buildkit",
  ]);
  if (free.exitCode !== 0) return;
  const availableKb = Number(free.stdout.trim().split("\n").at(-1)?.trim().split(/\s+/u)[3]);
  if (!Number.isFinite(availableKb)) return;
  const usage = await commandResult(["docker", "buildx", "du", "--builder", DEFAULT_BUILDER]);
  const storedText = usage.stdout.match(/^Total:\s*(\S+)\s*$/mu)?.[1];
  let stored = 0;
  try {
    stored = storedText ? parseByteSize(storedText) : 0;
  } catch {
    stored = 0;
  }
  const cap = parseByteSize(policy.cacheLimit);
  const available = availableKb * 1024;
  if (available + stored >= cap) return;
  const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  console.warn(
    `Docker has only ${gib(available)} free; the sandbox builder cache bound ${policy.cacheLimit} ` +
      `(${gib(stored)} stored) cannot fit, so BuildKit may evict and rebuild image layers between starts. ` +
      "Free Docker disk (for example `bun run dev:clean` in finished worktrees, or a larger Docker disk) " +
      "or lower OPENGENI_DEV_SANDBOX_BUILD_CACHE_MAX to what fits.",
  );
}

function commonBuildArguments(options: Arguments): string[] {
  return [
    "buildx",
    "build",
    "--builder",
    DEFAULT_BUILDER,
    // Attestations are useless for a local development image and make the
    // exported image identity differ from the cached build result below.
    "--provenance=false",
    "--sbom=false",
    "--label",
    "io.opengeni.development-sandbox=true",
    "-f",
    "docker/sandbox.Dockerfile",
    "--build-arg",
    `OPENGENI_ARTIFACT_RUNTIME_BUNDLE=${options.runtimeBundle}`,
    "--build-arg",
    `OPENGENI_SOURCE_SHA=${options.sourceSha}`,
  ];
}

/**
 * Build through the dedicated builder, then export into the Docker daemon only
 * when the daemon does not already hold this exact result. BuildKit hashes the
 * whole build context, so a dirty worktree still produces a new image; an
 * unchanged one skips the multi-gigabyte `--load` transfer entirely.
 */
async function buildImage(options: Arguments, repositoryRoot: string): Promise<void> {
  const metadataFile = join(MAINTENANCE_ROOT, `build-metadata-${process.pid}.json`);
  await rm(metadataFile, { force: true });
  try {
    await command(
      [
        "docker",
        ...commonBuildArguments(options),
        "--output",
        `type=image,name=${options.image},push=false`,
        "--metadata-file",
        metadataFile,
        ".",
      ],
      repositoryRoot,
    );
    const built = await readBuiltImageDigests(metadataFile);
    const loaded = await loadedImageId(options.image);
    if (loaded && built.has(loaded)) {
      console.log(`Sandbox image ${options.image} is already current (${loaded}); skipped export.`);
      return;
    }
  } finally {
    await rm(metadataFile, { force: true });
  }
  await command(
    ["docker", ...commonBuildArguments(options), "--load", "-t", options.image, "."],
    repositoryRoot,
  );
}

/** Image identities BuildKit reports for the cached result: the OCI manifest
 * digest (what a containerd-backed daemon calls the image id) and the config
 * digest (the classic image store id). An unreadable file means "unknown". */
export async function readBuiltImageDigests(metadataFile: string): Promise<Set<string>> {
  const digests = new Set<string>();
  let metadata: unknown;
  try {
    metadata = JSON.parse(await readFile(metadataFile, "utf8"));
  } catch {
    return digests;
  }
  if (!metadata || typeof metadata !== "object") return digests;
  for (const key of ["containerimage.digest", "containerimage.config.digest"]) {
    const value = (metadata as Record<string, unknown>)[key];
    if (typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value)) digests.add(value);
  }
  return digests;
}

async function loadedImageId(image: string): Promise<string | null> {
  const result = await commandResult(["docker", "image", "inspect", "--format", "{{.Id}}", image]);
  if (result.exitCode !== 0) return null;
  const id = result.stdout.trim();
  return /^sha256:[0-9a-f]{64}$/u.test(id) ? id : null;
}

async function pruneBuilderCache(
  policy: DevelopmentSandboxDiskPolicy,
  phase: string,
): Promise<void> {
  const result = await commandResult([
    "docker",
    "buildx",
    "prune",
    "--builder",
    DEFAULT_BUILDER,
    "--force",
    "--max-used-space",
    policy.cacheLimit,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`Unable to bound the OpenGeni development builder cache ${phase}`, {
      cause: new Error(result.stderr.trim() || `exit ${result.exitCode}`),
    });
  }
  const reclaimed = result.stdout.match(/^Total:\s*(\S+)\s*$/mu)?.[1];
  if (reclaimed && reclaimed !== "0B") {
    console.log(
      `Bounded the OpenGeni sandbox builder cache to ${policy.cacheLimit} ${phase} (reclaimed ${reclaimed}).` +
        (phase === "after build attempt"
          ? " If every start rebuilds the image, one build's working set exceeds OPENGENI_DEV_SANDBOX_BUILD_CACHE_MAX; raise it."
          : ""),
    );
  }
}

async function pruneImages(
  currentImage: string,
  retention: number,
  leasedImages: ReadonlySet<string>,
): Promise<void> {
  const [listedRepository, listedManaged] = await Promise.all([
    commandOutput(["docker", "image", "ls", "--all", "opengeni-sandbox", "--format", "{{.ID}}"]),
    commandOutput([
      "docker",
      "image",
      "ls",
      "--all",
      "--filter",
      "label=io.opengeni.development-sandbox=true",
      "--format",
      "{{.ID}}",
    ]),
  ]);
  const ids = [
    ...new Set(
      `${listedRepository}\n${listedManaged}`
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  if (ids.length === 0) return;
  const inspected = JSON.parse(
    await commandOutput(["docker", "image", "inspect", ...ids]),
  ) as Array<{
    Id?: unknown;
    Created?: unknown;
    RepoTags?: unknown;
    Config?: { Labels?: unknown };
  }>;
  const images = inspected.flatMap((image): DockerImage[] => {
    if (typeof image.Id !== "string" || typeof image.Created !== "string") {
      return [];
    }
    const labels = image.Config?.Labels;
    return [
      {
        id: image.Id,
        createdAt: image.Created,
        tags: Array.isArray(image.RepoTags)
          ? image.RepoTags.filter((tag): tag is string => typeof tag === "string")
          : [],
        managed:
          labels !== null &&
          typeof labels === "object" &&
          "io.opengeni.development-sandbox" in labels &&
          labels["io.opengeni.development-sandbox"] === "true",
      },
    ];
  });
  const containerIds = (await commandOutput(["docker", "container", "ls", "--all", "--quiet"]))
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
  const protectedImageIds = new Set<string>();
  if (containerIds.length > 0) {
    const containers = JSON.parse(
      await commandOutput(["docker", "container", "inspect", ...containerIds]),
    ) as Array<{ Image?: unknown }>;
    for (const container of containers) {
      if (typeof container.Image === "string") protectedImageIds.add(container.Image);
    }
  }
  for (const image of images) {
    if (image.tags.some((tag) => leasedImages.has(tag))) protectedImageIds.add(image.id);
  }
  const plan = planDevelopmentSandboxImageRetention(
    images,
    protectedImageIds,
    currentImage,
    retention,
  );
  const removals = [...plan.removeTags, ...plan.removeImageIds];
  if (removals.length === 0) return;
  const result = await commandResult(["docker", "image", "rm", ...removals]);
  if (result.exitCode !== 0) {
    console.warn(
      `Unable to retire every stale OpenGeni development sandbox image: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
    );
  } else {
    console.log(
      `Retired ${removals.length} stale OpenGeni development sandbox image reference(s).`,
    );
  }
}

async function writeLease(options: Arguments): Promise<void> {
  await mkdir(LEASE_ROOT, { recursive: true });
  const destination = join(LEASE_ROOT, `${options.leaseId}.json`);
  const staging = `${destination}.${process.pid}.tmp`;
  await writeFile(
    staging,
    `${JSON.stringify({
      schemaVersion: 1,
      leaseId: options.leaseId,
      pid: options.leasePid,
      token: options.leaseToken,
      image: options.image,
      repositoryRoot: options.repositoryRoot,
    })}\n`,
  );
  await rename(staging, destination);
}

async function activeLeasedImages(): Promise<Set<string>> {
  await mkdir(LEASE_ROOT, { recursive: true });
  const active = new Set<string>();
  for (const name of await readdir(LEASE_ROOT)) {
    if (!name.endsWith(".json")) continue;
    const path = join(LEASE_ROOT, name);
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as {
        pid?: unknown;
        token?: unknown;
        image?: unknown;
      };
      if (
        typeof value.pid === "number" &&
        Number.isSafeInteger(value.pid) &&
        value.pid > 0 &&
        typeof value.token === "string" &&
        LEASE_TOKEN.test(value.token) &&
        typeof value.image === "string" &&
        SOURCE_TAG.test(value.image) &&
        (await processOwnsLease(value.pid, value.token))
      ) {
        active.add(value.image);
      } else {
        await rm(path, { force: true });
      }
    } catch {
      await rm(path, { force: true });
    }
  }
  return active;
}

async function withMaintenanceLock<T>(operation: () => Promise<T>): Promise<T> {
  await mkdir(MAINTENANCE_ROOT, { recursive: true });
  const handle = await open(LOCK_FILE, "a+");
  const library = loadFlockLibrary();
  const started = Date.now();
  try {
    while (library.symbols.flock(handle.fd, LOCK_EXCLUSIVE | LOCK_NONBLOCKING) !== 0) {
      if (Date.now() - started > LOCK_WAIT_MS) {
        throw new Error("Timed out waiting for another OpenGeni sandbox image build");
      }
      await Bun.sleep(250);
    }
    return await operation();
  } finally {
    library.symbols.flock(handle.fd, LOCK_UNLOCK);
    await handle.close();
    library.close();
  }
}

function loadFlockLibrary() {
  const candidates =
    process.platform === "darwin"
      ? ["/usr/lib/libSystem.B.dylib"]
      : process.platform === "linux"
        ? ["libc.so.6", "libc.so"]
        : [];
  let cause: unknown;
  for (const candidate of candidates) {
    try {
      return dlopen(candidate, {
        flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      });
    } catch (error) {
      cause = error;
    }
  }
  throw new Error(
    `Unsupported host for OpenGeni development sandbox locking: ${process.platform}`,
    {
      cause,
    },
  );
}

export async function processOwnsLease(pid: number, token: string): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid < 1 || !LEASE_TOKEN.test(token)) return false;
  const result = await commandResult(["ps", "-p", String(pid), "-o", "command="]);
  if (result.exitCode !== 0) return false;
  return result.stdout
    .split(/\r?\n/u)
    .some((line) => line.trim().split(/\s+/u).includes(`--opengeni-dev-stack-token=${token}`));
}

async function command(args: readonly string[], cwd?: string): Promise<void> {
  const result = await commandResult(args, cwd, true);
  if (result.exitCode !== 0) {
    throw new Error(`${args[0]} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
  }
}

async function commandOutput(args: readonly string[], cwd?: string): Promise<string> {
  const result = await commandResult(args, cwd);
  if (result.exitCode !== 0) {
    throw new Error(`${args[0]} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
  }
  return result.stdout;
}

async function commandResult(
  args: readonly string[],
  cwd = resolve("."),
  inherit = false,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([...args], {
    cwd,
    stdout: inherit ? "inherit" : "pipe",
    stderr: inherit ? "inherit" : "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    inherit ? Promise.resolve("") : new Response(child.stdout).text(),
    inherit ? Promise.resolve("") : new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function parseArguments(args: readonly string[]): Arguments {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      !name ||
      ![
        "--repository-root",
        "--image",
        "--runtime-bundle",
        "--source-sha",
        "--lease-id",
        "--lease-pid",
        "--lease-token",
      ].includes(name) ||
      !value ||
      values.has(name)
    ) {
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
    image: required("--image"),
    runtimeBundle: required("--runtime-bundle"),
    sourceSha: required("--source-sha"),
    leaseId: required("--lease-id"),
    leasePid: Number(required("--lease-pid")),
    leaseToken: required("--lease-token"),
  };
}

if (import.meta.main) {
  await prepareDevelopmentSandboxImage(parseArguments(Bun.argv.slice(2)));
}
