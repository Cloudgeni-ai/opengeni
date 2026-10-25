import { createHash } from "node:crypto";
import { canonical, digest, validateSpec, type Manifest } from "../merge-batcher/model";
import { verifyResult } from "../merge-batcher/result";

export const BATCH_WORKFLOW = ".github/workflows/batch-ci.yml";
export type ProviderRun = {
  id: number;
  run_attempt: number;
  head_sha: string;
  head_branch: string;
  event: string;
  path: string;
  status: string;
  conclusion: string | null;
  run_started_at: string;
  repository: { full_name: string };
  head_repository: { full_name: string };
};
export type ArtifactIdentity = {
  id: number;
  name: string;
  expired: boolean;
  digest: string;
  created_at: string;
  workflow_run: { id: number; head_sha: string; head_branch: string };
};
export type BatchUnitProof = {
  schemaVersion: 1;
  repository: string;
  mainSha: string;
  tree: string;
  testedTree: string;
  producer: { runId: number; attempt: number };
  batch: ProviderRun;
  manifest: Manifest;
  inventory: string[];
  result: unknown;
  artifacts: ArtifactIdentity[];
};
const sha = /^[a-f0-9]{40}$/;
function requireProof(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(`Batch unit reuse rejected: ${reason}`);
}
export function sameInventory(left: unknown, right: readonly string[]): left is string[] {
  return (
    Array.isArray(left) &&
    left.length > 0 &&
    left.length === right.length &&
    left.every((item) => typeof item === "string") &&
    new Set(left).size === left.length &&
    new Set(right).size === right.length &&
    canonical([...left].sort()) === canonical([...right].sort())
  );
}
export function verifyArtifactBytes(
  artifact: ArtifactIdentity,
  bytes: Uint8Array,
  run: ProviderRun,
  expectedName: string,
): void {
  requireProof(Number.isSafeInteger(artifact.id) && artifact.id > 0, "artifact identity");
  requireProof(
    artifact.name === expectedName && artifact.expired === false,
    "artifact name/expiry",
  );
  requireProof(
    artifact.workflow_run?.id === run.id &&
      artifact.workflow_run.head_sha === run.head_sha &&
      artifact.workflow_run.head_branch === run.head_branch,
    "artifact producer",
  );
  requireProof(
    Number.isFinite(Date.parse(run.run_started_at)) &&
      Date.parse(artifact.created_at) >= Date.parse(run.run_started_at),
    "artifact attempt time",
  );
  requireProof(
    artifact.digest === `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    "artifact archive digest",
  );
}

// The plan job constructs this only after reading the authenticated provider
// run, archive digests and canonical Git manifest. Unit jobs consume the same
// run's immutable plan artifact; it is never a caller-supplied dispatch input.
export function verifyBatchUnitProof(
  raw: unknown,
  expected: {
    repository: string;
    mainSha: string;
    tree: string;
    runId: number;
    attempt: number;
    inventory: readonly string[];
  },
): BatchUnitProof {
  const proof = raw as BatchUnitProof;
  requireProof(proof?.schemaVersion === 1, "schema");
  requireProof(
    proof.repository === expected.repository &&
      proof.mainSha === expected.mainSha &&
      sha.test(proof.mainSha) &&
      proof.tree === expected.tree &&
      sha.test(proof.tree) &&
      proof.testedTree === expected.tree,
    "main tree identity",
  );
  requireProof(
    proof.producer?.runId === expected.runId &&
      proof.producer.attempt === expected.attempt &&
      Number.isSafeInteger(expected.runId) &&
      expected.runId > 0 &&
      Number.isSafeInteger(expected.attempt) &&
      expected.attempt > 0,
    "main attempt identity",
  );
  const run = proof.batch;
  requireProof(
    run &&
      Number.isSafeInteger(run.id) &&
      run.id > 0 &&
      Number.isSafeInteger(run.run_attempt) &&
      run.run_attempt > 0 &&
      sha.test(run.head_sha) &&
      run.path === BATCH_WORKFLOW &&
      run.event === "push" &&
      /^queue\/.+/.test(run.head_branch) &&
      run.repository?.full_name === expected.repository &&
      run.head_repository?.full_name === expected.repository &&
      run.status === "completed" &&
      run.conclusion === "success",
    "trusted Batch attempt",
  );
  requireProof(sameInventory(proof.inventory, expected.inventory), "complete unit inventory");
  const manifest = proof.manifest;
  requireProof(manifest?.tipSha === run.head_sha, "tested manifest head");
  const spec = {
    schemaVersion: manifest.schemaVersion,
    baseSha: manifest.baseSha,
    predecessor: manifest.predecessor,
    createdAt: manifest.createdAt,
    recoveryOf: manifest.recoveryOf,
    pulls: manifest.pulls.map(({ mergeSha: _mergeSha, ...pull }) => pull),
  };
  validateSpec(spec);
  requireProof(digest(spec) === manifest.batchId, "manifest digest");
  const result = verifyResult(proof.result, manifest, run.id, run.run_attempt);
  requireProof(result?.outcome === "success", "complete successful Batch result");
  const jobs = (proof.result as { expectedJobs: string[] }).expectedJobs;
  const shardCount = Math.min(16, Math.ceil(proof.inventory.length / 240));
  requireProof(jobs.length === 2 + shardCount, "complete shard inventory");
  requireProof(
    proof.artifacts?.length === 2 &&
      new Set(proof.artifacts.map((a) => a.id)).size === 2 &&
      proof.artifacts.some((a) => a.name === `batch-plan-${run.run_attempt}`) &&
      proof.artifacts.some((a) => a.name === `batch-result-${run.run_attempt}`),
    "artifact pair",
  );
  return proof;
}
