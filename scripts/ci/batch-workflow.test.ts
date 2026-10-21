import { expect, test } from "bun:test";
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
  expect(plan).toContain('inspect --tip "$GITHUB_SHA" --git-dir .git');
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
