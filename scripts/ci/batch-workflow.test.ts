import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
const raw = readFileSync(".github/workflows/batch-ci.yml", "utf8");
const workflow = Bun.YAML.parse(raw) as any;

test("one push-tip batch workflow does not run per PR or cancel active work", () => {
  expect(workflow.on).toEqual({ push: { branches: ["queue/**"] } });
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
  expect(workflow.concurrency.group).toContain("github.ref");
  expect(workflow.jobs.ready.name).toBe("Batch ready");
});
test("candidate provenance supplies the whole base-to-tip impact range", () => {
  const plan = workflow.jobs.plan.steps.find((step: any) => step.id === "plan").run;
  expect(plan).toContain('inspect-run --tip "$GITHUB_SHA" --git-dir .git');
  expect(plan).toContain(".baseSha");
  expect(plan).toContain('--base "$base" --head "$GITHUB_SHA"');
  expect(plan).toContain(". / 240");
  expect(plan).toContain(". > 16 then 16");
  expect(workflow.jobs.plan.steps.some((step: any) => step.run?.includes("bun install"))).toBe(
    false,
  );
});
test("controller is the sole retry owner; all unit files retain real DB and deadlines", () => {
  expect(raw).not.toContain("retry-once.ts");
  expect(workflow.jobs.units.env.OPENGENI_REQUIRE_REAL_DB).toBe("1");
  expect(workflow.jobs.units.strategy["fail-fast"]).toBe(false);
  const units = workflow.jobs.units.steps.map((step: any) => step.run ?? "").join("\n");
  expect(units).toContain("--timeout-seconds 1200");
  expect(units).toContain("--shard ${{ matrix.index }} --shards ${{ matrix.total }}");
});
test("receipts never mix attempts and the gate runs even on failed code jobs", () => {
  const gate = workflow.jobs.ready;
  expect(gate.if).toBe("${{ always() }}");
  expect(gate.needs).toEqual(["plan", "source", "units"]);
  expect(
    gate.steps.find((step: any) => step.uses?.startsWith("actions/download-artifact")).with.pattern,
  ).toBe("batch-receipt-${{ github.run_attempt }}-*");
  const upload = gate.steps.find((step: any) => step.uses?.startsWith("actions/upload-artifact"));
  expect(upload.if).toBe("${{ always() }}");
  expect(upload.with.name).toBe("batch-result-${{ github.run_attempt }}");
  expect(gate.env.PLAN_RESULT).toBe("${{ needs.plan.result }}");
  expect(gate.steps.find((step: any) => step.uses?.startsWith("actions/checkout")).with.ref).toBe(
    "${{ needs.plan.outputs.base_sha || github.event.repository.default_branch }}",
  );
});

test("installation and database setup produce explicit receipts before candidate assertions", () => {
  for (const job of [workflow.jobs.source, workflow.jobs.units]) {
    const setup = job.steps.find((step: any) => step.run?.includes("batch-setup.ts install"));
    expect(setup.run).toContain("batch-result.ts run --failure-only --job");
  }
  expect(
    workflow.jobs.units.steps.some((step: any) => step.run?.includes("batch-setup.ts postgres")),
  ).toBe(true);
  const plan = workflow.jobs.plan.steps.find((step: any) => step.id === "plan").run;
  expect(plan).toContain("batch-result.ts run --job plan");
});
test("batch source preserves the complete existing fast contract inventory", () => {
  const source = readFileSync("scripts/ci/batch-source.ts", "utf8");
  for (const check of [
    "generate-site-browser-runtime.ts",
    "changeset",
    "run-typecheck-plan.ts",
    "run-guards-plan.ts",
  ])
    expect(source).toContain(check);
  expect(source).toMatch(/"--exclude",\s*"publish-closure"/);
});

describe("base-comparison runs (batch-base-comparison/v1)", () => {
  const plan = workflow.jobs.plan.steps.find((step: any) => step.id === "plan").run as string;
  const branches = plan.split('if [ "$purpose" = "base-comparison" ]; then');

  test("a base tip executes its frozen plan, never a recomputed impact", () => {
    expect(workflow.jobs.plan.outputs.purpose).toBe("${{ steps.plan.outputs.purpose }}");
    expect(branches).toHaveLength(3);
    const [frozen, candidate] = branches[1]!.split("else");
    expect(frozen).toContain("batch-comparison.ts freeze --manifest");
    expect(frozen).toContain("batch-result.ts run --job plan");
    expect(frozen).not.toContain("impact.ts");
    expect(candidate).toContain("scripts/ci/impact.ts");
    // Base inventory failure is infrastructure; candidate inventory is best-effort.
    const [baseInventory, candidateInventory] = branches[2]!.split("elif");
    expect(baseInventory).toContain("batch-result.ts run --job plan");
    expect(baseInventory).toContain("batch-comparison.ts inventory");
    expect(candidateInventory).toContain("|| echo");
    expect(candidate).toContain("batch-comparison.ts plan --impact");
    expect(candidate).toMatch(/batch-comparison\.ts plan[^\n]*\|\| echo/);
    const upload = workflow.jobs.plan.steps.find(
      (step: any) => step.with?.name === "batch-plan-${{ github.run_attempt }}",
    );
    expect(upload.with.path).toContain("execution-plan.json");
    expect(upload.with.path).toContain("inventory.json");
  });

  test("only base runs continue past failures; limits and deadlines are unchanged", () => {
    const flag = "${{ needs.plan.outputs.purpose == 'base-comparison' && '--continue' || '' }}";
    expect(workflow.jobs.source.env.BATCH_CONTINUE).toBe(flag);
    expect(workflow.jobs.units.env.BATCH_CONTINUE).toBe(flag);
    const source = workflow.jobs.source.steps.map((step: any) => step.run ?? "").join("\n");
    expect(source).toContain("--role source --steps");
    expect(source).toContain('--steps "$RUNNER_TEMP/source-steps.json" $BATCH_CONTINUE');
    const units = workflow.jobs.units.steps.map((step: any) => step.run ?? "").join("\n");
    expect(units).toContain("--role unit --postgres-evidence");
    expect(units).toContain(
      '--outcomes "$RUNNER_TEMP/unit-outcomes-${{ matrix.index }}.json" $BATCH_CONTINUE',
    );
    expect(units).toContain('BATCH_POSTGRES_EVIDENCE="$RUNNER_TEMP/batch-postgres.json"');
    expect(units).toContain("--timeout-seconds 1200");
    expect(workflow.jobs.units["timeout-minutes"]).toBe(25);
    expect(workflow.jobs.source["timeout-minutes"]).toBe(25);
  });

  test("the base-checked-out verifier emits run-bound comparison evidence for every run", () => {
    const gate = workflow.jobs.ready;
    const planDownload = gate.steps.find(
      (step: any) => step.with?.name === "batch-plan-${{ github.run_attempt }}",
    );
    expect(planDownload["continue-on-error"]).toBe(true);
    const aggregate = gate.steps.find((step: any) => step.run?.includes("aggregate")).run;
    expect(aggregate).toContain('--plan-dir "$RUNNER_TEMP/batch-plan"');
    expect(aggregate).toContain('--comparison-output "$RUNNER_TEMP/batch-comparison.json"');
    const upload = gate.steps.find(
      (step: any) => step.with?.name === "batch-comparison-${{ github.run_attempt }}",
    );
    expect(upload.if).toBe("${{ always() }}");
    expect(upload.with.path).toBe("${{ runner.temp }}/batch-comparison.json");
  });

  test("the comparison contract marker is present for historical-base detection", () => {
    expect(JSON.parse(readFileSync("scripts/ci/batch-comparison.json", "utf8"))).toEqual({
      comparisonSchema: "batch-base-comparison/v1",
    });
  });
});
