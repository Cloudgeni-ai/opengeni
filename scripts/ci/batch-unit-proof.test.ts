import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { digest, type BatchSpec } from "../merge-batcher/model";
import { readResultZip } from "../merge-batcher/github";
import {
  sameInventory,
  verifyArtifactBytes,
  verifyBatchUnitProof,
  type BatchUnitProof,
} from "./batch-unit-proof";
import { findBatchUnitProof, type ProofReads } from "./reuse-batch-units";

function fixture() {
  const spec: BatchSpec = {
    schemaVersion: 1,
    baseSha: "a".repeat(40),
    predecessor: null,
    createdAt: "2026-10-25T00:00:00Z",
    recoveryOf: null,
    pulls: [
      {
        number: 1,
        headSha: "b".repeat(40),
        headRef: "feature",
        binding: {
          source: "auto-merge",
          at: "2026-10-25T00:00:00Z",
          eventId: "auto1",
          evidenceId: "1",
          evidenceDigest: "e".repeat(64),
        },
      },
    ],
  };
  const head = "c".repeat(40);
  const manifest = {
    ...spec,
    batchId: digest(spec),
    tipSha: head,
    pulls: spec.pulls.map((p) => ({ ...p, mergeSha: head })),
  };
  const batch = {
    id: 123,
    run_attempt: 2,
    head_sha: head,
    head_branch: "queue/test/attempt-2",
    event: "push",
    path: ".github/workflows/batch-ci.yml",
    status: "completed",
    conclusion: "success",
    run_started_at: "2026-10-25T01:00:00Z",
    repository: { full_name: "Cloudgeni-ai/opengeni" },
    head_repository: { full_name: "Cloudgeni-ai/opengeni" },
  };
  const result = {
    schemaVersion: 1,
    batchId: manifest.batchId,
    headSha: head,
    runId: "123",
    runAttempt: 2,
    reason: "complete",
    retryable: false,
    outcome: "success",
    expectedJobs: ["plan", "source", "unit-0"],
    jobs: { plan: "success", source: "success", units: "success" },
    tasks: ["plan", "source", "unit-0"].map((job) => ({
      schemaVersion: 1,
      batchId: manifest.batchId,
      headSha: head,
      runId: "123",
      runAttempt: 2,
      job,
      exitCode: 0,
      outcome: "success",
      retryable: false,
      startedAt: "2026-10-25T01:01:00Z",
      finishedAt: "2026-10-25T01:02:00Z",
    })),
  };
  const inventory = ["a.test.ts", "b.test.ts"];
  const context = {
    repository: batch.repository.full_name,
    mainSha: "d".repeat(40),
    tree: "f".repeat(40),
    runId: 456,
    attempt: 1,
    inventory,
  };
  const proof: BatchUnitProof = {
    schemaVersion: 1,
    repository: context.repository,
    mainSha: context.mainSha,
    tree: context.tree,
    testedTree: context.tree,
    producer: { runId: 456, attempt: 1 },
    batch,
    manifest,
    inventory,
    result,
    artifacts: ["batch-plan-2", "batch-result-2"].map((name, i) => ({
      id: i + 1,
      name,
      expired: false,
      digest: "sha256:" + "0".repeat(64),
      created_at: "2026-10-25T01:03:00Z",
      workflow_run: { id: 123, head_sha: head, head_branch: batch.head_branch },
    })),
  };
  return { proof, context };
}
function zip(entries: Record<string, unknown>): Uint8Array {
  const locals: Buffer[] = [],
    directory: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const filename = Buffer.from(name),
      data = Buffer.from(JSON.stringify(value));
    const local = Buffer.alloc(30),
      central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, filename, data);
    directory.push(central, filename);
    offset += local.length + filename.length + data.length;
  }
  const end = Buffer.alloc(22),
    table = Buffer.concat(directory);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(table.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, table, end]);
}
function readsFor(proof: BatchUnitProof): ProofReads {
  const archives = [
    zip({ "impact-plan.json": { unitTests: proof.inventory }, "batch.json": proof.manifest }),
    zip({ "batch-result.json": proof.result }),
  ];
  proof.artifacts.forEach((a, i) => {
    a.digest = `sha256:${createHash("sha256").update(archives[i]!).digest("hex")}`;
  });
  return {
    get: async (path) => {
      if (path.includes("workflows/")) return { workflow_runs: [proof.batch] };
      if (path.startsWith("git/"))
        return { sha: proof.batch.head_sha, tree: { sha: proof.testedTree } };
      if (path.includes("artifacts?")) return { total_count: 2, artifacts: proof.artifacts };
      return proof.batch;
    },
    archive: async (id) => archives[id - 1]!,
    tree: async () => proof.testedTree,
    manifest: async () => proof.manifest,
  };
}
test("same tree permits different commit identity but preserves exact tested head", () => {
  const { proof, context } = fixture();
  expect(proof.mainSha).not.toBe(proof.batch.head_sha);
  expect(verifyBatchUnitProof(proof, context)).toBe(proof);
});
test.each([
  [
    "tree",
    (p: BatchUnitProof) => {
      p.testedTree = "0".repeat(40);
    },
  ],
  [
    "main",
    (p: BatchUnitProof) => {
      p.mainSha = "0".repeat(40);
    },
  ],
  [
    "attempt",
    (p: BatchUnitProof) => {
      p.producer.attempt++;
    },
  ],
  [
    "foreign repo",
    (p: BatchUnitProof) => {
      p.batch.head_repository.full_name = "fork/repo";
    },
  ],
  [
    "foreign workflow",
    (p: BatchUnitProof) => {
      p.batch.path = ".github/workflows/pr-ci.yml";
    },
  ],
  [
    "dispatch",
    (p: BatchUnitProof) => {
      p.batch.event = "workflow_dispatch";
    },
  ],
  [
    "branch",
    (p: BatchUnitProof) => {
      p.batch.head_branch = "main";
    },
  ],
  [
    "running",
    (p: BatchUnitProof) => {
      p.batch.status = "in_progress";
    },
  ],
  [
    "failed",
    (p: BatchUnitProof) => {
      p.batch.conclusion = "failure";
    },
  ],
  [
    "selected subset",
    (p: BatchUnitProof) => {
      p.inventory.pop();
    },
  ],
  [
    "invented test",
    (p: BatchUnitProof) => {
      p.inventory[0] = "fake.test.ts";
    },
  ],
  [
    "duplicate test",
    (p: BatchUnitProof) => {
      p.inventory[0] = p.inventory[1]!;
    },
  ],
  [
    "manifest",
    (p: BatchUnitProof) => {
      p.manifest.baseSha = "0".repeat(40);
    },
  ],
  [
    "missing result",
    (p: BatchUnitProof) => {
      p.result = null;
    },
  ],
  [
    "missing artifact",
    (p: BatchUnitProof) => {
      p.artifacts.pop();
    },
  ],
] as const)("rejects %s", (_name, mutate) => {
  const { proof, context } = fixture();
  // The provider proof and expected local inventory must be independent.
  context.inventory = [...context.inventory];
  mutate(proof);
  expect(() => verifyBatchUnitProof(proof, context)).toThrow();
});
test("inventory equality does not depend on order and refuses empty evidence", () => {
  expect(sameInventory(["b", "a"], ["a", "b"])).toBe(true);
  expect(sameInventory([], [])).toBe(false);
});
test("a larger inventory requires the complete additional shard receipts", () => {
  const { proof, context } = fixture();
  proof.inventory = context.inventory = Array.from({ length: 241 }, (_, i) => `${i}.test.ts`);
  expect(() => verifyBatchUnitProof(proof, context)).toThrow("shard inventory");
});
test.each(["digest", "expired", "identity", "head", "time"])("archive rejects %s", (field) => {
  const { proof } = fixture();
  const bytes = zip({ "batch.json": proof.manifest });
  const artifact = proof.artifacts[0]!;
  artifact.digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  verifyArtifactBytes(artifact, bytes, proof.batch, "batch-plan-2");
  if (field === "digest") artifact.digest = "sha256:bad";
  if (field === "expired") artifact.expired = true;
  if (field === "identity") artifact.workflow_run.id++;
  if (field === "head") artifact.workflow_run.head_sha = "a".repeat(40);
  if (field === "time") artifact.created_at = "2026-10-24T00:00:00Z";
  expect(() => verifyArtifactBytes(artifact, bytes, proof.batch, "batch-plan-2")).toThrow();
});
test("full adapter verifies exact archives and different-SHA same-tree proof", async () => {
  const { proof, context } = fixture();
  expect(await findBatchUnitProof(readsFor(proof), context)).toEqual(proof);
});
test.each(["running", "new attempt", "different head"])("final read rejects %s", async (kind) => {
  const { proof, context } = fixture();
  const reads = readsFor(proof),
    original = reads.get;
  reads.get = async (path) =>
    path === "actions/runs/123"
      ? {
          ...proof.batch,
          ...(kind === "running"
            ? { status: "in_progress" }
            : kind === "new attempt"
              ? { run_attempt: 3 }
              : { head_sha: "a".repeat(40) }),
        }
      : original(path);
    await expect(findBatchUnitProof(reads, context)).rejects.toThrow("attempt changed");
});
test("partial selected inventory is never reused even on an identical tree", async () => {
  const { proof, context } = fixture();
  context.inventory = [...proof.inventory, "extra.test.ts"];
  expect(await findBatchUnitProof(readsFor(proof), context)).toBeNull();
});
test.each([
  "incomplete",
  "duplicate",
  "wrong attempt",
  "wrong archive",
  "wrong local tree",
  "wrong manifest",
])("provider boundary rejects %s", async (kind) => {
  const { proof, context } = fixture();
  const reads = readsFor(proof),
    original = reads.get;
  if (kind === "incomplete")
    reads.get = async (path) =>
      path.includes("artifacts?") ? { total_count: 3, artifacts: proof.artifacts } : original(path);
  if (kind === "duplicate")
    reads.get = async (path) =>
      path.includes("artifacts?")
        ? { total_count: 3, artifacts: [...proof.artifacts, proof.artifacts[0]] }
        : original(path);
  if (kind === "wrong attempt") proof.artifacts[0]!.created_at = "2026-10-24T00:00:00Z";
  if (kind === "wrong archive") reads.archive = async () => zip({ wrong: true });
  if (kind === "wrong local tree") reads.tree = async () => "a".repeat(40);
  if (kind === "wrong manifest")
    reads.manifest = async () => ({ ...proof.manifest, tipSha: "a".repeat(40) });
  await expect(findBatchUnitProof(reads, context)).rejects.toThrow();
});
test("provider read exhaustion propagates to the fallback boundary, never a reuse verdict", async () => {
  const { proof, context } = fixture();
  const reads = readsFor(proof);
  reads.get = async () => {
    throw new Error("read unavailable");
  };
  await expect(findBatchUnitProof(reads, context)).rejects.toThrow("read unavailable");
});
test("large plan extraction keeps old result limits unchanged", () => {
  const archive = zip({ "impact-plan.json": "x".repeat(70_000) });
  expect(() => readResultZip(archive, ["impact-plan.json"])).toThrow();
  expect(JSON.parse(readResultZip(archive, ["impact-plan.json"], 1_000_000)).length).toBe(70_000);
  expect(() => readResultZip(archive, ["impact-plan.json"], 1_000_001)).toThrow();
});
test("workflow preserves full-green mode and job results while gating only unit execution", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  const unit = workflow.split("  unit-shards:")[1]!.split("  integration-shards:")[0]!;
  expect(unit).toContain("reuse-batch-units.ts verify");
  expect(unit).toContain("if: ${{ needs.plan.outputs.unit_reuse != 'true' }}");
  expect(unit).toContain('OPENGENI_REQUIRE_REAL_DB: "1"');
  expect(workflow).toContain("bun scripts/ci/impact.ts --full");
  const batch = readFileSync(
    new URL("../../.github/workflows/batch-ci.yml", import.meta.url),
    "utf8",
  );
  expect(batch).toContain(". / 240");
  expect(batch).toContain("if . > 16 then 16");
  expect(batch).toContain("scripts/ci/run-unit-shard.ts --plan");
});
