import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ATTESTED_SKIPPED_LANES,
  digest,
  MAIN_ATTESTATION_JOB,
  MAIN_ATTESTATION_STEP,
} from "../merge-batcher/model";
import {
  ATTESTATION_BRANCH,
  attestationOutputs,
  attestationSummary,
  findBatchAttestation,
  verifyBatchAttestation,
  type AttestationReads,
} from "./batch-attestation";
import { fixture, readsFor } from "./batch-proof-fixture";
import type { BatchUnitProof } from "./batch-unit-proof";

/** A batcher landing: main fast-forwarded to the tested `queue/live/<batchId>` tip. */
function landing(options: { inventory?: string[]; pull?: Record<string, unknown> } = {}) {
  const { proof, context } = fixture();
  if (options.pull) {
    // Re-derive the content-addressed identity so only the pull flag differs.
    const manifest = proof.manifest;
    Object.assign(manifest.pulls[0]!, options.pull);
    const { batchId: _id, tipSha: _tip, ...rest } = manifest;
    manifest.batchId = digest({
      ...rest,
      pulls: manifest.pulls.map(({ mergeSha: _m, ...p }) => p),
    });
    const result = proof.result as { batchId: string; tasks: { batchId: string }[] };
    result.batchId = manifest.batchId;
    for (const task of result.tasks) task.batchId = manifest.batchId;
  }
  const branch = `queue/live/${proof.manifest.batchId}`;
  proof.batch.head_branch = branch;
  for (const artifact of proof.artifacts) artifact.workflow_run.head_branch = branch;
  proof.mainSha = proof.batch.head_sha;
  if (options.inventory) {
    proof.inventory = options.inventory;
    const result = proof.result as {
      expectedJobs: string[];
      jobs: Record<string, string>;
      tasks: { job: string }[];
    };
    const shards = Math.min(16, Math.ceil(options.inventory.length / 240));
    result.expectedJobs = [
      "plan",
      "source",
      ...Array.from({ length: shards }, (_, i) => `unit-${i}`),
    ];
    result.jobs.units = shards ? "success" : "skipped";
    result.tasks = result.expectedJobs.map((job) => ({ ...result.tasks[0]!, job }));
  }
  const expectation = {
    repository: context.repository,
    mainSha: proof.mainSha,
    tree: context.tree,
    runId: context.runId,
    attempt: context.attempt,
  };
  return { proof, expectation };
}
function attestationReads(proof: BatchUnitProof, ancestor = true): AttestationReads {
  return {
    ...readsFor(proof),
    isAncestor: async (sha) => ancestor && sha === proof.batch.head_sha,
  };
}

describe("main-push Batch CI attestation", () => {
  test("accepts a fast-forward landing of the exact live candidate tip", () => {
    const { proof, expectation } = landing();
    expect(ATTESTATION_BRANCH.test(proof.batch.head_branch)).toBe(true);
    expect(verifyBatchAttestation(proof, { ...expectation, testedIsAncestor: true })).toBe(proof);
  });

  test("accepts a tree-preserving descendant of the tested tip", () => {
    const { proof, expectation } = landing();
    proof.mainSha = "d".repeat(40);
    expectation.mainSha = proof.mainSha;
    expect(verifyBatchAttestation(proof, { ...expectation, testedIsAncestor: true })).toBe(proof);
  });

  test.each([
    ["a non-live queue ref", (p: BatchUnitProof) => (p.batch.head_branch = "queue/test/attempt-2")],
    [
      "another batch's live ref",
      (p: BatchUnitProof) => (p.batch.head_branch = `queue/live/${"0".repeat(64)}`),
    ],
    ["a non-queue branch", (p: BatchUnitProof) => (p.batch.head_branch = "main")],
    ["a failed Batch attempt", (p: BatchUnitProof) => (p.batch.conclusion = "failure")],
    ["another workflow", (p: BatchUnitProof) => (p.batch.path = ".github/workflows/ci.yml")],
    ["a fork", (p: BatchUnitProof) => (p.batch.head_repository.full_name = "fork/opengeni")],
    ["a different tested tree", (p: BatchUnitProof) => (p.testedTree = "e".repeat(40))],
    [
      "an incomplete Batch result",
      (p: BatchUnitProof) => (p.result as { tasks: unknown[] }).tasks.pop(),
    ],
    ["a malformed inventory", (p: BatchUnitProof) => (p.inventory = ["a.test.ts", "a.test.ts"])],
  ])("rejects %s", (_name, mutate) => {
    const { proof, expectation } = landing();
    mutate(proof);
    expect(() => verifyBatchAttestation(proof, { ...expectation, testedIsAncestor: true })).toThrow(
      "rejected",
    );
  });

  test("rejects a tested tip that main does not contain", () => {
    const { proof, expectation } = landing();
    expect(() =>
      verifyBatchAttestation(proof, { ...expectation, testedIsAncestor: false }),
    ).toThrow("not contained in main");
  });

  test.each([
    ["a Version PR", { headRef: "changeset-release/main" }],
    ["a control-plane PR", { controlPlane: true }],
  ])("keeps the full suite for a landing with %s", (_name, pull) => {
    const { proof, expectation } = landing({ pull });
    expect(() => verifyBatchAttestation(proof, { ...expectation, testedIsAncestor: true })).toThrow(
      "Version PR and control-plane landings run the full main suite",
    );
    // The same re-derived identity without the flag is accepted.
    const plain = landing({ pull: { headRef: "feature-2" } });
    expect(
      verifyBatchAttestation(plain.proof, { ...plain.expectation, testedIsAncestor: true }),
    ).toBe(plain.proof);
  });

  test("accepts a complete docs/control-only Batch plan with no unit shards", () => {
    const { proof, expectation } = landing({ inventory: [] });
    expect(
      verifyBatchAttestation(proof, { ...expectation, testedIsAncestor: true }).inventory,
    ).toEqual([]);
    (proof.result as { jobs: Record<string, string> }).jobs.units = "success";
    expect(() =>
      verifyBatchAttestation(proof, { ...expectation, testedIsAncestor: true }),
    ).toThrow();
  });

  test("discovery verifies exact archives, provenance and ancestry", async () => {
    const { proof, expectation } = landing();
    const found = await findBatchAttestation(attestationReads(proof), expectation);
    expect(found?.batch.id).toBe(proof.batch.id);
    expect(attestationOutputs(found)).toEqual({
      attested: "true",
      batch_run_id: String(proof.batch.id),
      batch_run_attempt: String(proof.batch.run_attempt),
      batch_head_sha: proof.batch.head_sha,
      batch_id: proof.manifest.batchId,
      tree: expectation.tree,
    });
    expect(attestationSummary(found)).toContain(`Batch CI run ${proof.batch.id} attempt 2`);
    await expect(findBatchAttestation(attestationReads(proof, false), expectation)).rejects.toThrow(
      "not contained in main",
    );
  });

  test("discovery ignores non-live Batch runs and different trees", async () => {
    const { proof, expectation } = landing();
    proof.batch.head_branch = "queue/test/attempt-2";
    expect(await findBatchAttestation(attestationReads(proof), expectation)).toBeNull();
    const other = landing();
    expect(
      await findBatchAttestation(attestationReads(other.proof), {
        ...other.expectation,
        tree: "e".repeat(40),
      }),
    ).toBeNull();
  });

  test("no verified proof means the full suite", () => {
    expect(attestationOutputs(null)).toEqual({ attested: "false" });
    expect(attestationSummary(null)).toContain("running the full main suite");
  });

  test("CLI emits attested=false outside an exact main push and never fails discovery", () => {
    const directory = mkdtempSync(join(tmpdir(), "batch-attestation-"));
    try {
      const output = join(directory, "output");
      writeFileSync(output, "");
      const run = Bun.spawnSync(["bun", join(import.meta.dir, "batch-attestation.ts")], {
        cwd: directory,
        env: { ...process.env, GITHUB_EVENT_NAME: "pull_request", GITHUB_OUTPUT: output },
      });
      expect(run.exitCode).toBe(0);
      expect(readFileSync(output, "utf8")).toBe("attested=false\n");
      expect(readFileSync(join(directory, "batch-attestation.json"), "utf8")).toBe("null");
      const verify = Bun.spawnSync(
        ["bun", join(import.meta.dir, "batch-attestation.ts"), "verify"],
        {
          cwd: directory,
          env: { ...process.env, GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main" },
        },
      );
      expect(verify.exitCode).not.toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("ci.yml attested topology", () => {
  type Job = {
    name?: string;
    needs?: string | string[];
    if?: string;
    outputs?: Record<string, string>;
    steps?: { name?: string; id?: string; if?: string; run?: string }[];
  };
  const workflow = Bun.YAML.parse(
    readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"),
  ) as { jobs: Record<string, Job> };
  const gate = "needs.plan.outputs.attested != 'true'";
  const needs = (job: Job) => (job.needs === undefined ? [] : [job.needs].flat());

  test("attestation job and verification step carry the names the batcher reads", () => {
    const job = workflow.jobs["batch-attestation"]!;
    expect(job.name).toBe(MAIN_ATTESTATION_JOB);
    expect(job.if).toBe("${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}");
    const step = job.steps!.find((s) => s.name === MAIN_ATTESTATION_STEP)!;
    expect(step.if).toBe("${{ steps.find.outputs.attested == 'true' }}");
    expect(step.run).toBe("bun scripts/ci/batch-attestation.ts verify");
    expect(needs(workflow.jobs.plan!)).toContain("batch-attestation");
    const bind = workflow.jobs.plan!.steps!.find((s) => s.id === "attestation")!;
    expect(bind.run).toContain('[ "$RESULT" = success ]');
    expect(bind.run).toContain('"$(git rev-parse "$GITHUB_SHA^{tree}")" = "$BATCH_TREE"');
  });

  test("exactly the test lanes are gated off, and the batcher knows each of them", () => {
    const gated = Object.entries(workflow.jobs)
      .filter(([, job]) => job.if?.includes(gate))
      .map(([id]) => id)
      .sort();
    expect(gated).toEqual([
      "browser-acceptance",
      "browserd-real-e2e",
      "e2e-shards",
      "integration-shards",
      "package-contracts",
      "source-contracts",
      "test-suite",
      "unit-shards",
    ]);
    // Each gated lane's display name has exactly one batcher prefix, each
    // prefix names exactly one gated lane, and no other job matches any prefix.
    const lanes = (name: string) => ATTESTED_SKIPPED_LANES.filter((lane) => name.startsWith(lane));
    for (const lane of ATTESTED_SKIPPED_LANES)
      expect(gated.filter((id) => workflow.jobs[id]!.name!.startsWith(lane))).toHaveLength(1);
    for (const [id, job] of Object.entries(workflow.jobs))
      expect(lanes(job.name ?? id)).toHaveLength(gated.includes(id) ? 1 : 0);
    for (const id of gated)
      expect(needs(workflow.jobs[id]!)).toEqual(["automation-admission", "plan"]);
  });

  test("artifact, image, aggregate and receipt jobs never depend on the attestation gate", () => {
    for (const [id, job] of Object.entries(workflow.jobs)) {
      if (job.if?.includes(gate)) continue;
      expect(job.if ?? "").not.toContain("attested");
      if (["deployment", "artifact-runtime", "images", "merge-content", "full-green"].includes(id))
        expect(job.if).toBeDefined();
    }
    for (const id of ["test", "release-image-validation"]) {
      const require = workflow.jobs[id]!.steps!.find((s) =>
        s.run?.includes("required-results.jq"),
      )!;
      expect(require.run).toContain('--argjson attested "$ATTESTED"');
    }
    const publish = workflow.jobs["full-green"]!.steps!.find(
      (s) => s.name === "Publish exact-SHA full CI evidence",
    )!;
    expect(publish.run).toContain('mode:"full"');
    expect(publish.run).toContain("{attestation:$attestation}");
  });
});
