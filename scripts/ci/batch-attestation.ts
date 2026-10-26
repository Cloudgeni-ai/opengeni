#!/usr/bin/env bun
// Main-push Batch CI attestation. When the merge batcher fast-forwards main to
// a commit whose exact Git tree already passed a trusted Batch CI attempt on a
// `queue/live/<batchId>` candidate ref, ci.yml reuses that verdict instead of
// re-running its test lanes. Artifact-producing and release jobs still run.
//
// Everything here is fail-closed: any missing, expired, ambiguous, partial,
// inconsistent or unreadable evidence yields `attested=false`, and the ordinary
// full main suite runs. Discovery never fails the workflow.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { GitFailure, GitStore } from "../merge-batcher/git";
import { MAIN_ATTESTATION_JOB, MAIN_ATTESTATION_STEP } from "../merge-batcher/model";
import {
  validInventory,
  verifyBatchTreeProof,
  type BatchTreeExpectation,
  type BatchUnitProof,
} from "./batch-unit-proof";
import {
  findBatchTreeProof,
  githubProofReads,
  optionalUnitProof,
  type ProofReads,
} from "./reuse-batch-units";

export const ATTESTATION_FILE = "batch-attestation.json";
/** Only the active batcher namespace; candidate refs are `queue/live/<64-hex batchId>`. */
export const ATTESTATION_BRANCH = /^queue\/live\/[a-f0-9]{64}$/;
/** ci.yml job/step names; the merge batcher's capacity scan reads the same names. */
export const ATTESTATION_JOB = MAIN_ATTESTATION_JOB;
export const ATTESTATION_STEP = MAIN_ATTESTATION_STEP;
/**
 * Paths that define main's own test lanes, required results or batcher trust
 * (workflows, composite actions, CI scripts, the batcher). A push that lands
 * any of them runs the full suite, so the changed lanes really execute. The
 * impact planner's broader full-mode fences (changesets, lockfile, toolchain)
 * are still tested by Batch CI and do not prevent attestation.
 */
export const ATTESTATION_BLOCKING_PATHS = [
  /^\.github\//,
  /^scripts\/ci\//,
  /^scripts\/merge-batcher\//,
] as const;

export type BatchAttestation = BatchUnitProof;
export type AttestationReads = ProofReads & {
  /** True only when `sha` is `mainSha` or a first-class ancestor of it. */
  isAncestor(sha: string): Promise<boolean>;
};

function reject(reason: string): never {
  throw new Error(`Batch CI attestation rejected: ${reason}`);
}

/**
 * Verifies a complete attestation: the generic exact-tree proof (trusted
 * successful latest Batch attempt, canonical manifest, archive digests and
 * complete receipts), plus the batcher-landing bindings: the run's branch is
 * exactly its manifest's live candidate ref and the tested tip is contained in
 * the attested main commit (fast-forward or tree-preserving refresh merges).
 */
export function verifyBatchAttestation(
  raw: unknown,
  expected: BatchTreeExpectation & {
    testedIsAncestor: boolean;
    /** Every path this push lands (`before..mainSha`), or null when unknown. */
    landedPaths: readonly string[] | null;
  },
): BatchAttestation {
  const proof = verifyBatchTreeProof(raw, { ...expected, branch: ATTESTATION_BRANCH });
  if (proof.batch.head_branch !== `queue/live/${proof.manifest.batchId}`)
    reject("Batch branch is not the manifest's live candidate ref");
  // A Version PR landing is a release tip, and a control-plane landing changes
  // CI or batcher definitions: both keep the full main suite. Both flags are
  // bound into the manifest digest the proof already verified.
  if (
    proof.manifest.pulls.some(
      (pull) => pull.headRef === "changeset-release/main" || pull.controlPlane === true,
    )
  )
    reject("Version PR and control-plane landings run the full main suite");
  requireAttestablePush(expected.landedPaths);
  if (expected.testedIsAncestor !== true) reject("tested Batch tip is not contained in main");
  return proof;
}

/** Rejects an unknown push range or one that changes main's own CI definitions. */
export function requireAttestablePush(landedPaths: readonly string[] | null): void {
  if (!Array.isArray(landedPaths) || landedPaths.length === 0)
    reject("this push's landed paths are unknown");
  const blocking = landedPaths.find((path) =>
    ATTESTATION_BLOCKING_PATHS.some((pattern) => pattern.test(path)),
  );
  if (blocking !== undefined) reject(`push changes CI definition ${blocking}`);
}

/** Bounded discovery of the newest trusted identical-tree live Batch attempt. */
export async function findBatchAttestation(
  reads: AttestationReads,
  context: BatchTreeExpectation & { landedPaths: readonly string[] | null },
): Promise<BatchAttestation | null> {
  requireAttestablePush(context.landedPaths);
  const proof = await findBatchTreeProof(reads, context, {
    branch: ATTESTATION_BRANCH,
    acceptPlan: (plan) => validInventory(plan.unitTests),
    verify: (candidate) =>
      verifyBatchTreeProof(candidate, { ...context, branch: ATTESTATION_BRANCH }),
  });
  if (!proof) return null;
  return verifyBatchAttestation(proof, {
    ...context,
    testedIsAncestor: await reads.isAncestor(proof.batch.head_sha),
  });
}

/** Workflow outputs; anything other than a verified proof is `attested=false`. */
export function attestationOutputs(proof: BatchAttestation | null): Record<string, string> {
  return proof
    ? {
        attested: "true",
        batch_run_id: String(proof.batch.id),
        batch_run_attempt: String(proof.batch.run_attempt),
        batch_head_sha: proof.batch.head_sha,
        batch_id: proof.manifest.batchId,
        tree: proof.tree,
      }
    : { attested: "false" };
}

export function attestationSummary(proof: BatchAttestation | null): string {
  return proof
    ? `Reused identical-tree Batch CI run ${proof.batch.id} attempt ${proof.batch.run_attempt} ` +
        `(${proof.batch.head_branch}, tested head ${proof.batch.head_sha}, tree ${proof.tree}, ` +
        `${proof.inventory.length} selected unit files); main test lanes are not re-run`
    : "No trusted identical-tree Batch CI attempt verified; running the full main suite";
}

async function gitContext(env: Record<string, string | undefined>) {
  const gitDir = (await Bun.$`git rev-parse --absolute-git-dir`.text()).trim();
  const git = new GitStore(gitDir);
  const mainSha = await git.exec(["rev-parse", "HEAD"]);
  const context: BatchTreeExpectation & { landedPaths: string[] | null } = {
    repository: env.GITHUB_REPOSITORY ?? "",
    mainSha,
    tree: await git.exec(["rev-parse", `${mainSha}^{tree}`]),
    runId: Number(env.GITHUB_RUN_ID),
    attempt: Number(env.GITHUB_RUN_ATTEMPT),
    landedPaths: null,
  };
  if (
    env.GITHUB_EVENT_NAME !== "push" ||
    env.GITHUB_REF !== "refs/heads/main" ||
    env.GITHUB_SHA !== mainSha
  )
    reject("only an exact main push can be attested");
  const isAncestor = async (sha: string) => {
    if (!/^[a-f0-9]{40}$/.test(sha)) return false;
    try {
      await git.exec(["merge-base", "--is-ancestor", sha, mainSha]);
      return true;
    } catch (error) {
      if (error instanceof GitFailure && error.exitCode === 1) return false;
      throw error;
    }
  };
  // Everything this push lands: the push event's previous main tip must be a
  // proper ancestor (no force push, branch creation or unknown range).
  context.landedPaths = await pushLandedPaths(git, env.BEFORE_SHA ?? "", mainSha, isAncestor);
  return { git, context, isAncestor };
}

/**
 * Paths changed by a main push from `before` to `mainSha`, or null when the
 * range is unknown: a missing, zero or equal `before`, or one that `mainSha`
 * does not contain (force push).
 */
export async function pushLandedPaths(
  git: Pick<GitStore, "exec">,
  before: string,
  mainSha: string,
  isAncestor: (sha: string) => Promise<boolean>,
): Promise<string[] | null> {
  if (!/^[a-f0-9]{40}$/.test(before) || /^0+$/.test(before) || before === mainSha) return null;
  if (!(await isAncestor(before))) return null;
  const diff = await git.exec(["diff", "--name-only", "--no-renames", before, mainSha]);
  return diff.split("\n").filter(Boolean);
}

function emit(env: Record<string, string | undefined>, proof: BatchAttestation | null) {
  // Missing outputs also select the ordinary full suite.
  try {
    if (env.GITHUB_OUTPUT)
      appendFileSync(
        env.GITHUB_OUTPUT,
        Object.entries(attestationOutputs(proof))
          .map(([key, value]) => `${key}=${value}\n`)
          .join(""),
      );
  } catch {
    /* Default is no attestation. */
  }
  try {
    if (env.GITHUB_STEP_SUMMARY)
      appendFileSync(env.GITHUB_STEP_SUMMARY, `\n${attestationSummary(proof)}.\n`);
  } catch {
    /* Best-effort diagnostic. */
  }
  console.log(attestationSummary(proof));
}

async function main(): Promise<void> {
  const env = process.env;
  if (process.argv[2] === "verify") {
    // Re-verify the persisted proof offline for the exact main push attempt.
    // Reaching this step is the observable attestation signal, so it must
    // never succeed on anything the discovery step would not have emitted.
    const { context, isAncestor } = await gitContext(env);
    const raw = JSON.parse(readFileSync(ATTESTATION_FILE, "utf8"));
    const proof = verifyBatchAttestation(raw, {
      ...context,
      testedIsAncestor: await isAncestor(String(raw?.batch?.head_sha ?? "")),
    });
    const outputs = attestationOutputs(proof);
    for (const key of ["batch_run_id", "batch_run_attempt", "batch_head_sha", "tree"])
      if (env[`EXPECTED_${key.toUpperCase()}`] !== outputs[key])
        reject(`recorded ${key} differs from the discovery output`);
    console.log(attestationSummary(proof));
    if (env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        env.GITHUB_STEP_SUMMARY,
        `\n### Batch CI attestation\n\n${attestationSummary(proof)}.\n`,
      );
    return;
  }
  const proof = await optionalUnitProof(
    async () => {
      if (env.GITHUB_EVENT_NAME !== "push" || env.GITHUB_REF !== "refs/heads/main") return null;
      const { git, context, isAncestor } = await gitContext(env);
      if (!/^[\w.-]+\/[\w.-]+$/.test(context.repository) || !env.GITHUB_TOKEN)
        reject("missing read identity");
      return await findBatchAttestation(
        { ...githubProofReads(context.repository, env.GITHUB_TOKEN, git), isAncestor },
        context,
      );
    },
    (value) => writeFileSync(resolve(ATTESTATION_FILE), JSON.stringify(value)),
  );
  emit(env, proof);
}
if (import.meta.main) await main();
