// Shared Batch proof fixtures for batch-unit-proof.test.ts and
// batch-attestation.test.ts: a canonical manifest, complete successful Batch
// result, exact archive digests and an in-memory provider.
import { createHash } from "node:crypto";
import { digest, type BatchSpec } from "../merge-batcher/model";
import type { BatchUnitProof } from "./batch-unit-proof";
import type { ProofReads } from "./reuse-batch-units";

export function fixture() {
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
export function zip(entries: Record<string, unknown>): Uint8Array {
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
export function readsFor(proof: BatchUnitProof): ProofReads {
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
