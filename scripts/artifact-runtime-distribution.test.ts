import { afterEach, expect, test } from "bun:test";
import { copyKernelSourceFixture } from "./artifact-kernel-source-identity.fixture";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalArtifactKernelBuildReceiptBytes } from "../packages/artifact-tool/kernel/bindings/package-receipt";
import {
  publishArtifactRuntime,
  runtimeDownloadAccept,
  validateRuntimeProducer,
  type RuntimePublisherApi,
} from "./publish-artifact-runtime";
import {
  canonicalRuntimeDistribution,
  resolvePublicRuntimeArchive,
  runtimeArtifactName,
  runtimeDigest,
  runtimeReleaseTag,
  RUNTIME_NATIVE_TARGETS,
  RUNTIME_PROVENANCE_ASSET,
  RUNTIME_REPOSITORY,
  RUNTIME_REPOSITORY_ID,
  type RuntimeDistribution,
  type RuntimeRelease,
  type RuntimeSourceArtifact,
  downloadRuntimePublic,
} from "./artifact-runtime-distribution";
import { parse as parseYaml } from "yaml";
import { resolveDevelopmentArtifactRuntime } from "./resolve-development-artifact-runtime";

const roots: string[] = [];
test("Actions ZIP and release assets use their distinct required API media types", () => {
  expect(runtimeDownloadAccept("actions/artifacts/123/zip")).toBe("application/vnd.github+json");
  expect(runtimeDownloadAccept("releases/assets/123")).toBe("application/octet-stream");
});
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const sourceSha = "a".repeat(40);

test("publication workflow is trusted main-CI completion only, bounded and never rebuilds", async () => {
  const text = await Bun.file(
    join(import.meta.dir, "../.github/workflows/publish-artifact-runtime.yml"),
  ).text();
  const workflow = parseYaml(text);
  expect(workflow.on).toEqual({
    workflow_run: { workflows: ["CI"], types: ["completed"], branches: ["main"] },
  });
  expect(workflow.permissions).toEqual({ contents: "read" });
  const job = workflow.jobs.publish;
  expect(job.permissions).toEqual({ actions: "read", contents: "write" });
  expect(job["timeout-minutes"]).toBe(15);
  expect(job.if).toContain("head_repository.id == 1212552738");
  expect(job.if).toContain("event == 'push'");
  expect(job.if).toContain("conclusion == 'success'");
  expect(job.steps[0].with.ref).toBe("${{ github.sha }}");
  expect(job.steps[0].with["persist-credentials"]).toBe(false);
  expect(job.steps[1].with.path).toBe(".release/runtime-source");
  expect(job.steps[1].with["persist-credentials"]).toBe(false);
  expect(job.steps.filter((step: any) => step.run).map((step: any) => step.run)).toEqual([
    "bun install --frozen-lockfile --ignore-scripts",
    "bun scripts/publish-artifact-runtime.ts",
  ]);
  expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
});

test("anonymous HTTP rejects off-provider redirects, excess bytes, errors and expired deadline", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  try {
    globalThis.fetch = (async (url: any, options: any) => {
      calls.push(String(url));
      expect(options.headers.Authorization).toBeUndefined();
      return new Response(null, {
        status: 302,
        headers: { location: "https://untrusted.example/runtime.zip" },
      });
    }) as typeof fetch;
    await expect(
      downloadRuntimePublic("https://github.com/runtime", 8, Date.now() + 1000),
    ).rejects.toThrow("GitHub release boundary");
    expect(calls).toHaveLength(1);
    globalThis.fetch = (async () => new Response("123456789")) as unknown as typeof fetch;
    await expect(
      downloadRuntimePublic("https://github.com/runtime", 8, Date.now() + 1000),
    ).rejects.toThrow("byte limit");
    globalThis.fetch = (async () =>
      new Response("not found", { status: 404 })) as unknown as typeof fetch;
    await expect(
      downloadRuntimePublic("https://github.com/runtime", 8, Date.now() + 1000),
    ).rejects.toThrow("HTTP 404");
    await expect(
      downloadRuntimePublic("https://github.com/runtime", 8, Date.now() - 1),
    ).rejects.toThrow("deadline");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

async function fixture() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "runtime-distribution-"));
  roots.push(temporaryRoot);
  const sourceIdentity = await copyKernelSourceFixture(temporaryRoot);
  const archives = new Map<number, Buffer>();
  const targets = RUNTIME_NATIVE_TARGETS.map((target, index) => {
    const bytes = Buffer.from(`fixture-native-${target}`);
    const receipt = canonicalArtifactKernelBuildReceiptBytes({
      schemaVersion: 2,
      producer: "opengeni-artifact-kernel-smoke-v2",
      target,
      kind: "native",
      buildIdentity: `opengeni-artifact-kernel/fixture;abi=1;source=${sourceIdentity};toolchain=test`,
      capabilities: { bytes: 1, sha256: runtimeDigest(Buffer.from("c")) as `sha256:${string}` },
      spreadsheetFormulaProjectionCorpusSha256: `sha256:${"f".repeat(64)}`,
      runtimeFiles: [
        {
          path: "opengeni_artifact_kernel.node",
          bytes: bytes.length,
          sha256: runtimeDigest(bytes) as `sha256:${string}`,
        },
      ],
    });
    const archive = zip([
      [`native/${target}/artifact-kernel-build-receipt.json`, Buffer.from(receipt)],
      [`native/${target}/opengeni_artifact_kernel.node`, bytes],
    ]);
    const artifact: RuntimeSourceArtifact = {
      id: index + 1,
      name: runtimeArtifactName(sourceSha, target),
      digest: runtimeDigest(archive),
      size_in_bytes: archive.length,
      expired: false,
      workflow_run: {
        id: 10,
        head_sha: sourceSha,
        repository_id: RUNTIME_REPOSITORY_ID,
        head_repository_id: RUNTIME_REPOSITORY_ID,
      },
    };
    archives.set(artifact.id, archive);
    return { target, artifact };
  });
  const provenance: RuntimeDistribution = {
    schemaVersion: 1,
    repository: RUNTIME_REPOSITORY,
    repositoryId: RUNTIME_REPOSITORY_ID,
    sourceSha,
    producer: { workflow: ".github/workflows/ci.yml", runId: 10, runAttempt: 1 },
    targets,
  };
  const producer = {
    id: 10,
    run_attempt: 1,
    head_sha: sourceSha,
    head_branch: "main",
    path: ".github/workflows/ci.yml",
    name: "CI",
    event: "push",
    status: "completed",
    conclusion: "success",
    repository: { id: RUNTIME_REPOSITORY_ID, full_name: RUNTIME_REPOSITORY },
    head_repository: { id: RUNTIME_REPOSITORY_ID, full_name: RUNTIME_REPOSITORY },
    updated_at: "2026-09-23T10:00:00Z",
  };
  const state: {
    tag: any;
    release: RuntimeRelease | null;
    runReads: number;
    mutateAfterReads: number;
    immutable: boolean;
    listing: RuntimeSourceArtifact[];
  } = {
    tag: null,
    release: null,
    runReads: 0,
    mutateAfterReads: Infinity,
    immutable: true,
    listing: targets.map((t) => t.artifact),
  };
  const assetBytes = new Map<number, Buffer>();
  const mutations: string[] = [];
  const read = async (path: string): Promise<any> => {
    if (path === "actions/runs/10") {
      state.runReads++;
      return {
        ...producer,
        run_attempt: state.runReads > state.mutateAfterReads ? 2 : producer.run_attempt,
      };
    }
    if (path.startsWith("compare/"))
      return {
        status: "ahead",
        base_commit: { sha: sourceSha },
        merge_base_commit: { sha: sourceSha },
      };
    if (path.includes("/artifacts?"))
      return { artifacts: structuredClone(state.listing), total_count: state.listing.length };
    if (path.startsWith("git/ref/")) return structuredClone(state.tag);
    if (path.startsWith("releases/")) return structuredClone(state.release);
    throw new Error(`unexpected API read ${path}`);
  };
  const api: RuntimePublisherApi = {
    get: read,
    optional: read,
    post: async (path, body: any) => {
      mutations.push(`POST ${path}`);
      if (path === "git/refs")
        return (state.tag = { ref: body.ref, object: { type: "commit", sha: body.sha } });
      if (path === "releases") {
        expect(body.draft).toBe(true);
        expect(body.make_latest).toBe("false");
        state.release = {
          id: 20,
          tag_name: body.tag_name,
          target_commitish: body.target_commitish,
          draft: true,
          prerelease: true,
          immutable: false,
          author: { id: 41898282, login: "github-actions[bot]", type: "Bot" },
          assets: [],
        };
        return structuredClone(state.release);
      }
      throw new Error("unexpected API post");
    },
    patch: async (path, body: any) => {
      mutations.push(`PATCH ${path}`);
      expect(body).toEqual({ draft: false, make_latest: "false" });
      state.release!.draft = false;
      state.release!.immutable = state.immutable;
      return structuredClone(state.release);
    },
    upload: async (_id, name, bytes) => {
      mutations.push(`UPLOAD ${name}`);
      const asset = {
        id: 100 + assetBytes.size,
        name,
        size: bytes.length,
        digest: runtimeDigest(bytes),
        state: "uploaded",
      };
      assetBytes.set(asset.id, bytes);
      state.release!.assets.push(asset);
      return asset;
    },
    artifactBytes: async (id) => archives.get(id)!,
    assetBytes: async (id) => assetBytes.get(id)!,
  };
  const download = async (url: string, limit: number, deadline: number) => {
    expect(deadline).toBeGreaterThan(Date.now());
    let bytes: Buffer;
    if (url.startsWith("https://api.github.com/")) {
      bytes = Buffer.from(JSON.stringify(url.includes("/git/ref/") ? state.tag : state.release));
    } else {
      const asset = state.release!.assets.find((a) => url.endsWith(`/${a.name}`));
      if (!asset) throw new Error("missing release asset");
      bytes = assetBytes.get(asset.id)!;
    }
    expect(bytes.length).toBeLessThanOrEqual(limit);
    return bytes;
  };
  const options = {
    sourceSha,
    runId: 10,
    runAttempt: 1,
    temporaryRoot,
    sourceRoot: temporaryRoot,
    api,
  };
  return { options, producer, state, provenance, archives, assetBytes, mutations, download };
}

test("publishes seven receipt-verified archives via draft, then authenticates anonymous cache reuse without gh", async () => {
  const f = await fixture();
  expect(await publishArtifactRuntime(f.options)).toEqual({ releaseId: 20, reused: false });
  expect(f.mutations).toHaveLength(11);
  expect(f.mutations.at(-1)).toBe("PATCH releases/20");
  for (const target of RUNTIME_NATIVE_TARGETS) {
    expect(
      (await resolvePublicRuntimeArchive(sourceSha, target, Date.now() + 10_000, f.download))
        .artifact.name,
    ).toBe(runtimeArtifactName(sourceSha, target));
  }
  const command = async (args: string[]) => {
    if (args[0] !== "git") throw new Error("gh must not run");
    return Buffer.from(args[1] === "rev-parse" ? sourceSha : "");
  };
  const opts = {
    repositoryRoot: f.options.temporaryRoot,
    target: RUNTIME_NATIVE_TARGETS[0],
    command,
    publicDownload: f.download,
  };
  expect(await resolveDevelopmentArtifactRuntime(opts)).toMatchObject({
    available: true,
    source: "release",
  });
  expect(await resolveDevelopmentArtifactRuntime(opts)).toMatchObject({
    available: true,
    source: "cache",
  });
  expect(
    await resolveDevelopmentArtifactRuntime({
      ...opts,
      publicDownload: async () => {
        throw new Error("offline");
      },
    }),
  ).toMatchObject({ available: false });
  f.mutations.length = 0;
  f.state.listing = [];
  f.archives.clear();
  expect(await publishArtifactRuntime(f.options)).toEqual({ releaseId: 20, reused: true });
  expect(f.mutations).toHaveLength(0);
});

test("rejects internally consistent archives built from different source before publication", async () => {
  const f = await fixture();
  await Bun.write(
    join(f.options.sourceRoot, "packages/artifact-tool/kernel/src/review-source.rs"),
    "// changed source\n",
  );
  await expect(publishArtifactRuntime(f.options)).rejects.toThrow("checkout kernel source");
  expect(f.mutations).toHaveLength(0);
});

test("rejects PR, fork, wrong branch/workflow/SHA and unsuccessful producer without writes", async () => {
  const f = await fixture();
  for (const changed of [
    { event: "pull_request" },
    { head_branch: "feature" },
    { head_sha: "b".repeat(40) },
    { path: "evil.yml" },
    { conclusion: "failure" },
    { status: "in_progress" },
    { run_attempt: 2 },
    { head_repository: { id: 42 } },
  ]) {
    expect(() => validateRuntimeProducer({ ...f.producer, ...changed }, f.options)).toThrow();
  }
  f.producer.event = "pull_request";
  await expect(publishArtifactRuntime(f.options)).rejects.toThrow("canonical main-push");
  expect(f.mutations).toHaveLength(0);
});

test("rejects archive corruption, missing or duplicate target before any publication", async () => {
  for (const corruption of ["bytes", "missing", "duplicate", "expired", "foreign-run"] as const) {
    const f = await fixture();
    if (corruption === "bytes") f.archives.set(1, Buffer.from("tampered"));
    if (corruption === "missing") f.state.listing.pop();
    if (corruption === "duplicate") f.state.listing.push(f.state.listing[0]!);
    if (corruption === "expired") f.state.listing[0]!.expired = true;
    if (corruption === "foreign-run") f.state.listing[0]!.workflow_run.id = 11;
    await expect(publishArtifactRuntime(f.options)).rejects.toThrow();
    expect(f.mutations).toHaveLength(0);
  }
});

test("run changes fail before mutation or keep uploaded bytes unpublished", async () => {
  for (const reads of [1, 2]) {
    const f = await fixture();
    f.state.mutateAfterReads = reads;
    await expect(publishArtifactRuntime(f.options)).rejects.toThrow("canonical main-push");
    expect(f.mutations.some((m) => m.startsWith("PATCH"))).toBe(false);
    if (reads === 1) expect(f.mutations).toHaveLength(0);
    else expect(f.state.release?.draft).toBe(true);
  }
});

test("never moves a preexisting wrong-source tag", async () => {
  const f = await fixture();
  f.state.tag = {
    ref: `refs/tags/${runtimeReleaseTag(sourceSha)}`,
    object: { type: "commit", sha: "b".repeat(40) },
  };
  await expect(publishArtifactRuntime(f.options)).rejects.toThrow("never move");
  expect(f.mutations).toHaveLength(0);
});

test("draft retry reuses exact assets without overwrite and refuses mismatched assets", async () => {
  const f = await fixture();
  f.state.mutateAfterReads = 2;
  await expect(publishArtifactRuntime(f.options)).rejects.toThrow();
  f.state.mutateAfterReads = Infinity;
  f.mutations.length = 0;
  const asset = f.state.release!.assets[0]!;
  const original = asset.digest;
  asset.digest = `sha256:${"0".repeat(64)}`;
  await expect(publishArtifactRuntime(f.options)).rejects.toThrow("mismatched");
  expect(f.mutations).toHaveLength(0);
  asset.digest = original;
  expect(await publishArtifactRuntime(f.options)).toMatchObject({ reused: false });
  expect(f.mutations).toEqual(["PATCH releases/20"]);
});

test("provider must actually seal immutable release; no success or anonymous admission otherwise", async () => {
  const f = await fixture();
  f.state.immutable = false;
  await expect(publishArtifactRuntime(f.options)).rejects.toThrow("immutable");
  await expect(
    resolvePublicRuntimeArchive(
      sourceSha,
      RUNTIME_NATIVE_TARGETS[0],
      Date.now() + 10_000,
      f.download,
    ),
  ).rejects.toThrow("immutable");
});

test("anonymous reader rejects changed release, tag, source, digest and noncanonical provenance", async () => {
  for (const corruption of ["tag", "draft", "digest", "provenance", "source", "changed"] as const) {
    const f = await fixture();
    await publishArtifactRuntime(f.options);
    if (corruption === "tag") f.state.tag.object.sha = "b".repeat(40);
    if (corruption === "draft") f.state.release!.draft = true;
    if (corruption === "digest") f.state.release!.assets[0]!.digest = `sha256:${"0".repeat(64)}`;
    if (corruption === "source") f.state.release!.target_commitish = "b".repeat(40);
    if (corruption === "provenance") {
      const asset = f.state.release!.assets.find((a) => a.name === RUNTIME_PROVENANCE_ASSET)!;
      const bytes = Buffer.from(canonicalRuntimeDistribution(f.provenance).toString().trim());
      f.assetBytes.set(asset.id, bytes);
      asset.size = bytes.length;
      asset.digest = runtimeDigest(bytes);
    }
    let releases = 0;
    const download = async (url: string, limit: number, deadline: number) => {
      if (url.includes("/releases/tags/") && ++releases === 2 && corruption === "changed")
        f.state.release!.id++;
      return f.download(url, limit, deadline);
    };
    await expect(
      resolvePublicRuntimeArchive(
        sourceSha,
        RUNTIME_NATIVE_TARGETS[0],
        Date.now() + 10_000,
        download,
      ),
    ).rejects.toThrow();
  }
});

function zip(entries: [string, Buffer][]): Buffer {
  const locals: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const [path, bytes] of entries) {
    const name = Buffer.from(path),
      local = Buffer.alloc(30),
      entry = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt32LE(bytes.length, 20);
    entry.writeUInt32LE(bytes.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    locals.push(local, name, bytes);
    central.push(entry, name);
    offset += 30 + name.length + bytes.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
