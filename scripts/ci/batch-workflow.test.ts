import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
const raw = readFileSync(".github/workflows/batch-ci.yml", "utf8");
const workflow = Bun.YAML.parse(raw) as any;

test("Batch planning starts without a workflow-internal main-priority wait", () => {
  expect(workflow.jobs.plan["timeout-minutes"]).toBe(20);
  expect(raw).not.toContain("github-pr-ci.ts priority");
  expect(workflow.jobs.plan.steps.slice(0, 3).map((step: any) => step.id ?? step.uses)).toEqual([
    "actions/checkout@v6",
    "oven-sh/setup-bun@v2",
    "plan",
  ]);
  expect(workflow.jobs.plan.steps[2].run).toContain('inspect --tip "$GITHUB_SHA" --git-dir .git');
  expect(workflow.jobs.ready.needs).toEqual(["plan", "source", "units", "lanes", "lanes-verdict"]);
  expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
});

test("previous-binary unavailable database records infrastructure, not PR blame", () => {
  const directory = mkdtempSync(join(tmpdir(), "batch-posture-infra-"));
  const step = workflow.jobs.source.steps.find((s: any) =>
    s.run?.includes("batch-setup.ts postgres"),
  );
  try {
    const result = spawnSync(
      "bash",
      [
        "-c",
        `
      bun() {
        if [ "$1" = scripts/ci/batch-result.ts ]; then "$REAL_BUN" "$@"; else return 75; fi
      }
      export -f bun
      ${step.run.replace("-- bun scripts/ci/batch-setup.ts postgres", "-- bash -c 'bun scripts/ci/batch-setup.ts postgres'")}
    `,
      ],
      {
        env: {
          ...process.env,
          REAL_BUN: process.execPath,
          RUNNER_TEMP: directory,
          BATCH_ID: "batch-posture",
          GITHUB_SHA: "a".repeat(40),
          GITHUB_RUN_ID: "123",
          GITHUB_RUN_ATTEMPT: "1",
        },
        encoding: "utf8",
      },
    );
    expect(result.status).toBe(75);
    expect(JSON.parse(readFileSync(join(directory, "receipt-source.json"), "utf8"))).toMatchObject({
      job: "source",
      outcome: "infrastructure",
      exitCode: 75,
      retryable: false,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("one push-tip batch workflow does not run per PR or cancel active work", () => {
  expect(workflow.on).toEqual({ push: { branches: ["queue/**"] } });
  expect(workflow.permissions).toEqual({ contents: "read", actions: "read" });
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
  expect(gate.needs).toEqual(["plan", "source", "units", "lanes", "lanes-verdict"]);
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

test("required source job runs the actual pinned previous-binary database check on the batch tip", () => {
  const source = workflow.jobs.source;
  const step = source.steps.find((s: any) => s.name === "Previous-binary database readiness");
  expect(source.if).toBeUndefined();
  expect(step.if).toBeUndefined();
  expect(step["continue-on-error"]).toBeUndefined();
  expect(source.services.postgres.image).toBe("pgvector/pgvector:pg17");
  const setup = source.steps.find((s: any) => s.run?.includes("batch-setup.ts postgres"));
  expect(setup.run).toContain("--failure-only --job source");
  expect(setup.env.OPENGENI_REQUIRE_REAL_DB).toBe("1");
  expect(setup.env.OPENGENI_TEST_PG_URL).toBe(step.env.OPENGENI_TEST_PG_URL);
  expect(source.steps.indexOf(setup)).toBeLessThan(source.steps.indexOf(step));
  expect(step.env.BASE_SHA).toBe("${{ needs.plan.outputs.base_sha }}");
  expect(step.env.OPENGENI_REQUIRE_REAL_DB).toBe("1");
  expect(step.run).toContain('bun scripts/runtime-posture-baseline.ts "$BASE_SHA"');
  expect(step.run).toContain("readRuntimePostureBaseline");
  expect(step.run).toContain("PRE_COMPATIBILITY_PRODUCTION_SOURCE");
  expect(step.run).toContain('fetch --no-tags origin "$pin"');
  expect(step.run).toContain('fetch --no-tags origin "$old"');
  expect(step.run).toContain(
    "bun test --max-concurrency=1 packages/db/test/runtime-posture-compatibility-postgres.test.ts",
  );
  expect(step.run).toContain(
    'batch-result.ts run --job source --output "$RUNNER_TEMP/receipt-source.json"',
  );
  expect(source.steps.indexOf(step)).toBeGreaterThan(
    source.steps.findIndex((s: any) => s.run?.includes("batch-source.ts")),
  );
  expect(workflow.jobs.ready.needs).toContain("source");
  expect(workflow.jobs.ready.env.SOURCE_RESULT).toBe("${{ needs.source.result }}");
});

test.each([0, 1])(
  "readiness exit %i propagates through the real receipt wrapper (transport stub only)",
  (exitCode) => {
    const directory = mkdtempSync(join(tmpdir(), "batch-posture-"));
    const step = workflow.jobs.source.steps.find(
      (s: any) => s.name === "Previous-binary database readiness",
    );
    try {
      const result = spawnSync(
        "bash",
        [
          "-c",
          `
      bun() {
        case "$1" in
          scripts/ci/batch-result.ts) "$REAL_BUN" "$@" ;;
          -e) printf '%040d\\n' 0 ;;
          run) cat >/dev/null ;;
          *) if [[ "$*" == *runtime-posture-compatibility-postgres.test.ts* ]]; then return "$READINESS_EXIT"; fi ;;
        esac
      }
      git() { return 0; }
      export -f bun git
      ${step.run}
    `,
        ],
        {
          env: {
            ...process.env,
            REAL_BUN: process.execPath,
            READINESS_EXIT: String(exitCode),
            RUNNER_TEMP: directory,
            BASE_SHA: "b".repeat(40),
            BATCH_ID: "batch-posture",
            GITHUB_SHA: "a".repeat(40),
            GITHUB_RUN_ID: "123",
            GITHUB_RUN_ATTEMPT: "1",
          },
          encoding: "utf8",
        },
      );
      expect(result.status).toBe(exitCode);
      const receipt = JSON.parse(readFileSync(join(directory, "receipt-source.json"), "utf8"));
      expect(receipt).toMatchObject({
        job: "source",
        headSha: "a".repeat(40),
        runAttempt: 1,
        exitCode,
        outcome: exitCode ? "code_failure" : "success",
      });
      if (exitCode) expect(receipt.retryable).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("main CI's own lanes run on the exact candidate and gate readiness", () => {
  const ci = Bun.YAML.parse(readFileSync(".github/workflows/ci.yml", "utf8")) as any;
  const lanes = workflow.jobs.lanes;
  expect(lanes.name).toBe("Main CI lanes");
  expect(lanes.needs).toBe("plan");
  expect(lanes.uses).toBe("./.github/workflows/ci.yml");
  expect(lanes.with).toEqual({ batch_base_sha: "${{ needs.plan.outputs.base_sha }}" });
  // No secret reaches the candidate: main-only signing stays behind main guards.
  expect(lanes.secrets).toBeUndefined();
  expect(ci.on.workflow_call.inputs.batch_base_sha).toMatchObject({
    required: true,
    type: "string",
  });
  // A called workflow's job grants must fit inside the caller's grant.
  const granted = lanes.permissions as Record<string, string>;
  const rank = { none: 0, read: 1, write: 2 } as Record<string, number>;
  for (const [name, job] of Object.entries(ci.jobs) as [string, any][])
    for (const [scope, level] of Object.entries(job.permissions ?? {}) as [string, string][])
      expect([name, scope, rank[granted[scope] ?? "none"]! >= rank[level]!]).toEqual([
        name,
        scope,
        true,
      ]);
  const verdict = workflow.jobs["lanes-verdict"];
  expect(verdict.needs).toEqual(["plan", "lanes"]);
  expect(verdict.if).toBe("${{ always() && needs.plan.result == 'success' }}");
  expect(verdict.env.LANES_RESULT).toBe("${{ needs.lanes.result }}");
  const classify = verdict.steps.find((step: any) => step.run?.includes("batch-lanes.ts")).run;
  expect(classify).toContain("batch-result.ts run --job lanes");
  expect(classify).toContain('--caller "Main CI lanes"');
  const upload = verdict.steps.find((step: any) =>
    step.uses?.startsWith("actions/upload-artifact"),
  );
  expect(upload.with.name).toBe("batch-receipt-${{ github.run_attempt }}-lanes");
  // The lane receipt is folded explicitly, never globbed as a separate task.
  expect(upload.with.path).toContain("lanes-receipt.json");
  expect(upload.with.path).not.toMatch(/receipt-[a-z]+\.json/);
  expect(workflow.jobs.ready.env).toMatchObject({
    BATCH_LANES: "required",
    LANES_RESULT: "${{ needs.lanes.result }}",
    LANES_VERDICT_RESULT: "${{ needs.lanes-verdict.result }}",
  });
});

test("ci.yml batch mode plans base..tip, builds without publishing and leaves units to Batch CI", () => {
  const ci = Bun.YAML.parse(readFileSync(".github/workflows/ci.yml", "utf8")) as any;
  const plan = ci.jobs.plan.steps.find((step: any) => step.id === "plan");
  expect(plan.env.BATCH_BASE_SHA).toBe("${{ inputs.batch_base_sha }}");
  expect(plan.run).toContain('impact.ts --base "$BATCH_BASE_SHA" --head "$GITHUB_SHA"');
  expect(plan.run).toContain("^refs/heads/queue/");
  expect(ci.jobs.plan.outputs.batch).toBe("${{ steps.plan.outputs.batch }}");
  expect(ci.jobs["unit-shards"].if).toContain("needs.plan.outputs.batch != 'true'");
  expect(ci.jobs["release-image-validation"].if).toContain("needs.plan.outputs.batch != 'true'");
  // Publication, attestation, approval and signing stay exact-main-push only.
  for (const job of ["batch-attestation", "merge-content"])
    expect(ci.jobs[job].if).toContain("github.ref == 'refs/heads/main'");
  expect(ci.jobs["full-green"].if).toContain("github.ref == 'refs/heads/main'");
  expect(ci.jobs["api-image"].environment).toContain("'ci-build'");
  for (const [name, job] of Object.entries(ci.jobs) as [string, any][])
    for (const step of job.steps ?? []) {
      if (step.with?.push !== undefined)
        expect([name, step.with.push]).toEqual([
          name,
          "${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}",
        ]);
      if (JSON.stringify(step.env ?? {}).includes("OPENGENI_AGENT_MINISIGN_KEY"))
        expect([name, step.if]).toEqual([
          name,
          "${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}",
        ]);
    }
  const aggregate = ci.jobs.test.steps.map((step: any) => step.run ?? "").join("\n");
  expect(aggregate).toContain('--argjson batch "$BATCH"');
});
