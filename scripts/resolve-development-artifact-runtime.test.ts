import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { canonicalArtifactKernelBuildReceiptBytes } from "../packages/artifact-tool/kernel/bindings/package-receipt";
import type { NativeArtifactRuntimeTarget } from "../packages/artifact-tool/src/runtime";
import {
  decodeArtifactRuntimeZip,
  resolveDevelopmentArtifactRuntime,
} from "./resolve-development-artifact-runtime";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const sha = "a".repeat(40);
const targets: NativeArtifactRuntimeTarget[] = [
  "linux-x64-gnu",
  "linux-arm64-gnu",
  "linux-x64-musl",
  "linux-arm64-musl",
  "darwin-x64",
  "darwin-arm64",
  "win32-x64-msvc",
];
const receiptName = "artifact-kernel-build-receipt.json";
const nativeName = "opengeni_artifact_kernel.node";
const digest = (bytes: Uint8Array): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

async function fixture(target: NativeArtifactRuntimeTarget = "linux-x64-gnu") {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "artifact-prebuilt-"));
  roots.push(repositoryRoot);
  const native = Buffer.from("not executable; receipt verification fixture");
  const receipt = canonicalArtifactKernelBuildReceiptBytes({
    schemaVersion: 2,
    producer: "opengeni-artifact-kernel-smoke-v2",
    target,
    kind: "native",
    buildIdentity: "opengeni-artifact-kernel/test;abi=1",
    capabilities: { bytes: 1, sha256: digest(Buffer.from("c")) },
    spreadsheetFormulaProjectionCorpusSha256: digest(Buffer.from("corpus")),
    runtimeFiles: [{ path: nativeName, bytes: native.length, sha256: digest(native) }],
  });
  const entries: [string, Buffer][] = [
    [`native/${target}/${receiptName}`, Buffer.from(receipt)],
    [`native/${target}/${nativeName}`, native],
  ];
  const archive = zip(entries);
  const artifact = {
    id: 1,
    name: `artifact-runtime-target-${sha}-${target}`,
    digest: digest(archive),
    expired: false,
    size_in_bytes: archive.length,
    workflow_run: {
      id: 2,
      head_sha: sha,
      repository_id: 1212552738,
      head_repository_id: 1212552738,
    },
  };
  const producer = {
    head_sha: sha,
    repository: { id: 1212552738 },
    head_repository: { id: 1212552738 },
    status: "completed",
    conclusion: "success",
    path: ".github/workflows/ci.yml",
    event: "push",
  };
  const calls: string[][] = [];
  const state = { dirty: false, offline: false, archive };
  const command = async (args: string[], _cwd: string, limit: number, timeout: number) => {
    calls.push(args);
    expect(limit).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThanOrEqual(60_000);
    if (args[0] === "git")
      return Buffer.from(
        args[1] === "rev-parse" ? `${sha}\n` : state.dirty ? " M source.rs\n" : "",
      );
    if (state.offline) throw new Error("offline");
    const path = args.at(-1)!;
    if (path.endsWith("/zip")) return state.archive;
    if (path.includes("actions/runs/")) return Buffer.from(JSON.stringify(producer));
    return Buffer.from(JSON.stringify({ artifacts: [artifact] }));
  };
  const publicDownload = async () => {
    throw new Error("fixture: no public release");
  };
  return {
    repositoryRoot,
    target,
    command,
    calls,
    artifact,
    producer,
    state,
    entries,
    publicDownload,
  };
}

for (const target of targets) {
  test(`verifies exact ${target} download and offline cache without Rust`, async () => {
    const f = await fixture(target);
    const first = await resolveDevelopmentArtifactRuntime(f);
    expect(first).toMatchObject({ available: true, source: "actions", sourceSha: sha });
    f.state.offline = true;
    f.calls.length = 0;
    expect(await resolveDevelopmentArtifactRuntime(f)).toMatchObject({
      available: true,
      source: "cache",
    });
    expect(f.calls.every((args) => args[0] === "git")).toBe(true);
  });
}

test("dirty checkout never reaches download or cache", async () => {
  const f = await fixture();
  f.state.dirty = true;
  expect(await resolveDevelopmentArtifactRuntime(f)).toMatchObject({
    available: false,
    diagnostic: expect.stringContaining("local changes"),
  });
  expect(f.calls.every((args) => args[0] === "git")).toBe(true);
});

for (const failure of [
  "source",
  "fork",
  "expired",
  "digest",
  "run",
  "workflow",
  "event",
  "receipt",
] as const) {
  test(`rejects ${failure} mismatch with actionable source fallback`, async () => {
    const f = await fixture();
    if (failure === "source") f.artifact.workflow_run.head_sha = "b".repeat(40);
    if (failure === "fork") f.artifact.workflow_run.head_repository_id = 123;
    if (failure === "expired") f.artifact.expired = true;
    if (failure === "digest") f.artifact.digest = digest(Buffer.from("wrong"));
    if (failure === "run") f.producer.conclusion = "failure";
    if (failure === "workflow") f.producer.path = ".github/workflows/untrusted.yml";
    if (failure === "event") f.producer.event = "pull_request";
    if (failure === "receipt") {
      f.entries[1]![1] = Buffer.from("tampered native");
      f.state.archive = zip(f.entries);
      f.artifact.digest = digest(f.state.archive);
      f.artifact.size_in_bytes = f.state.archive.length;
    }
    expect(await resolveDevelopmentArtifactRuntime(f)).toMatchObject({
      available: false,
      diagnostic: expect.stringContaining("pinned Rust source build"),
    });
  });
}

test("corrupt cache is not reused offline", async () => {
  const f = await fixture();
  const first = await resolveDevelopmentArtifactRuntime(f);
  if (!first.available) throw new Error(first.diagnostic);
  await writeFile(join(first.assetRoot, "native", f.target, nativeName), "changed");
  f.state.offline = true;
  expect(await resolveDevelopmentArtifactRuntime(f)).toMatchObject({ available: false });
});

test("cache retention is limited to three generated source-target entries", async () => {
  const first = await fixture();
  for (const target of targets.slice(0, 4)) {
    const f = await fixture(target);
    f.repositoryRoot = first.repositoryRoot;
    expect(await resolveDevelopmentArtifactRuntime(f)).toMatchObject({ available: true });
  }
  expect(
    await readdir(join(first.repositoryRoot, ".opengeni", "artifact-runtime-prebuilt")),
  ).toHaveLength(3);
});

test("rejects symlinked cache roots without writing through them", async () => {
  if (process.platform === "win32") return; // Unprivileged Windows cannot always create symlinks.
  const f = await fixture();
  const other = await fixture();
  await symlink(other.repositoryRoot, join(f.repositoryRoot, ".opengeni"));
  expect(await resolveDevelopmentArtifactRuntime(f)).toMatchObject({ available: false });
  expect(await readdir(other.repositoryRoot)).toHaveLength(0);
});

test("accepts bounded deflate and rejects expansion beyond its declared size", async () => {
  const f = await fixture();
  const compressed = zip(f.entries, true);
  expect(decodeArtifactRuntimeZip(compressed, f.target).get(nativeName)).toEqual(f.entries[1]![1]);
  const central = compressed.readUInt32LE(compressed.length - 6);
  compressed.writeUInt32LE(1, central + 24);
  expect(() => decodeArtifactRuntimeZip(compressed, f.target)).toThrow();
});

test("narrow ZIP rejects traversal, target mismatch, oversized expansion and truncation", async () => {
  const f = await fixture();
  expect(() => decodeArtifactRuntimeZip(f.state.archive, "darwin-arm64")).toThrow();
  expect(() => decodeArtifactRuntimeZip(f.state.archive.subarray(0, -1), f.target)).toThrow();
  f.entries[0]![0] = "../escape";
  expect(() => decodeArtifactRuntimeZip(zip(f.entries), f.target)).toThrow();
  const oversized = Buffer.from(f.state.archive);
  const central = oversized.readUInt32LE(oversized.length - 6);
  oversized.writeUInt32LE(0x7fffffff, central + 24);
  expect(() => decodeArtifactRuntimeZip(oversized, f.target)).toThrow();
});

// Stored ZIP fixture, including standard central directory and local headers.
function zip(entries: [string, Buffer][], compress = false): Buffer {
  const locals: Buffer[] = [],
    directory: Buffer[] = [];
  let offset = 0;
  for (const [path, bytes] of entries) {
    const packed = compress ? deflateRawSync(bytes) : bytes;
    const name = Buffer.from(path);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(compress ? 8 : 0, 8);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(compress ? 8 : 0, 10);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, packed);
    directory.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const cd = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
