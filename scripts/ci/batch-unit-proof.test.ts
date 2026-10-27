import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readResultZip } from "../merge-batcher/github";
import { fixture, readsFor, zip } from "./batch-proof-fixture";
import {
  sameInventory,
  verifyArtifactBytes,
  verifyBatchUnitProof,
  type BatchUnitProof,
} from "./batch-unit-proof";
import { findBatchUnitProof, mainUnitInventory, optionalUnitProof } from "./reuse-batch-units";

test("same tree permits different commit identity but preserves exact tested head", () => {
  const { proof, context } = fixture();
  expect(proof.mainSha).not.toBe(proof.batch.head_sha);
  expect(verifyBatchUnitProof(proof, context)).toBe(proof);
});
test("rerun-failed-jobs can consume the same run's earlier successful plan attempt", () => {
  const { proof, context } = fixture();
  context.attempt = 2;
  expect(verifyBatchUnitProof(proof, context)).toBe(proof);
  proof.producer.runId++;
  expect(() => verifyBatchUnitProof(proof, context)).toThrow("main attempt identity");
});
test.each([0, -1, 1.5, Number.NaN, 3])("rejects invalid/future producer attempt %s", (attempt) => {
  const { proof, context } = fixture();
  context.attempt = 2;
  proof.producer.attempt = attempt;
  expect(() => verifyBatchUnitProof(proof, context)).toThrow("main attempt identity");
});
test("main impact plan is the inventory authority and must be full", () => {
  expect(mainUnitInventory({ schemaVersion: 1, mode: "full", unitTests: ["a.test.ts"] })).toEqual([
    "a.test.ts",
  ]);
  for (const raw of [
    null,
    {},
    { schemaVersion: 1, mode: "selected", unitTests: ["a.test.ts"] },
    { schemaVersion: 1, mode: "full", unitTests: ["a", "a"] },
    { schemaVersion: 1, mode: "full", unitTests: [] },
  ])
    expect(() => mainUnitInventory(raw)).toThrow();
});
test("optional Git/inventory/read errors persist null instead of failing the plan", async () => {
  for (const kind of ["git", "inventory", "provider"]) {
    const writes: unknown[] = [];
    expect(
      await optionalUnitProof(
        async () => {
          throw new Error(kind);
        },
        (p) => {
          writes.push(p);
        },
      ),
    ).toBeNull();
    expect(writes).toEqual([null]);
  }
});
test("proof persistence failure cannot emit reuse, including unwritable fallback", async () => {
  const { proof } = fixture();
  const writes: unknown[] = [];
  expect(
    await optionalUnitProof(
      async () => proof,
      (p) => {
        writes.push(p);
        throw new Error("disk");
      },
    ),
  ).toBeNull();
  expect(writes).toEqual([proof, null]);
});
test.each(["missing Git", "unwritable proof"])("CLI falls back for %s", async (kind) => {
  const directory = mkdtempSync(join(tmpdir(), "e78-unit-reuse-"));
  try {
    if (kind === "unwritable proof") mkdirSync(join(directory, "unit-reuse.json"));
    const child = Bun.spawn(
      [process.execPath, new URL("./reuse-batch-units.ts", import.meta.url).pathname],
      {
        cwd: directory,
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: kind === "missing Git" ? "push" : "pull_request",
          GITHUB_REF: "refs/heads/main",
          GITHUB_OUTPUT: join(directory, "output"),
          GITHUB_STEP_SUMMARY: join(directory, "summary"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(0);
    expect(readFileSync(join(directory, "output"), "utf8")).toBe("reuse=false\n");
    if (kind === "missing Git")
      expect(readFileSync(join(directory, "unit-reuse.json"), "utf8")).toBe("null");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
  expect(unit).toContain('\'[{"index":0,"number":1,"total":1}]\'');
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
