import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const workflowDir = resolve(root, ".github/workflows");
const playwrightActionPath = resolve(root, ".github/actions/playwright-browsers/action.yml");
const PLAYWRIGHT_ACTION = "./.github/actions/playwright-browsers";
const MAX_JOB_TIMEOUT_MINUTES = 120;

type Step = Readonly<{
  name?: string;
  run?: string;
  uses?: string;
  with?: Readonly<Record<string, unknown>>;
  "timeout-minutes"?: unknown;
}>;
type Job = Readonly<{
  uses?: string;
  steps?: readonly Step[];
  "timeout-minutes"?: unknown;
}>;
type Workflow = Readonly<{ jobs?: Readonly<Record<string, Job>> }>;

const EXPECTED_CAPS = [
  ["ci.yml", "plan", "Install exact dependency tree", 11, "run"],
  ["ci.yml", "source-contracts", "Profile impacted TypeScript 7 projects", 11, "run"],
  ["ci.yml", "source-contracts", "Run exactly the explained source guards", 16, "run"],
  ["ci.yml", "unit-shards", "Unit test shard", 21, "run"],
  [
    "ci.yml",
    "integration-shards",
    "Run real PostgreSQL, pgvector, Temporal, NATS, and object-storage tests",
    31,
    "run",
  ],
  ["ci.yml", "e2e-shards", "Run exactly the impacted E2E tests", 13, "run"],
  ["ci.yml", "package-contracts", "Build client packages (contracts + SDK + React)", 21, "run"],
  ["ci.yml", "test-suite", "Real workspace capture acceptance", 13, "run"],
  ["ci.yml", "test-suite", "Recovery integration regressions", 5, "run"],
  ["ci.yml", "browser-acceptance", "Session pin browser acceptance", 4, "run"],
  ["ci.yml", "browser-acceptance", "Responsive knowledge surfaces browser acceptance", 6, "run"],
  ["ci.yml", "browser-acceptance", "Organization onboarding lifecycle acceptance", 8, "run"],
  ["ci.yml", "browser-acceptance", "Browser account session-set acceptance", 14, "run"],
  ["ci.yml", "browser-acceptance", "Workbench browser acceptance", 4, "run"],
  ["desktop-e2e.yml", "desktop-image", "Desktop image e2e", 36, "run"],
  ["ci.yml", "e2e-shards", "Install pinned browser runtimes", 17, "action"],
  ["ci.yml", "browser-acceptance", "Install pinned lane browser runtimes", 17, "action"],
  ["ci.yml", "package-contracts", "Install Chromium for packed WASM package proof", 17, "action"],
] as const;

const EXPECTED_JOB_BUDGETS = {
  "ci.yml:plan": { stepCaps: 11, needed: 12, jobCap: 15 },
  "ci.yml:source-contracts": { stepCaps: 27, needed: 28, jobCap: 35 },
  "ci.yml:unit-shards": { stepCaps: 21, needed: 22, jobCap: 30 },
  "ci.yml:integration-shards": { stepCaps: 31, needed: 32, jobCap: 40 },
  "ci.yml:e2e-shards": { stepCaps: 30, needed: 31, jobCap: 35 },
  "ci.yml:test-suite": { stepCaps: 18, needed: 19, jobCap: 30 },
  "ci.yml:browser-acceptance": { stepCaps: 53, needed: 54, jobCap: 60 },
  "ci.yml:package-contracts": { stepCaps: 38, needed: 39, jobCap: 55 },
  "desktop-e2e.yml:desktop-image": { stepCaps: 36, needed: 37, jobCap: 45 },
} as const;

async function loadWorkflows(): Promise<Record<string, Workflow>> {
  const files = (await readdir(workflowDir)).filter((entry) => /\.ya?ml$/u.test(entry)).sort();
  return Object.fromEntries(
    await Promise.all(
      files.map(async (file) => [
        file,
        Bun.YAML.parse(await readFile(resolve(workflowDir, file), "utf8")) as Workflow,
      ]),
    ),
  );
}

function numericCap(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

describe("workflow timeout contract", () => {
  test("all jobs and the exact 15 run plus 3 action steps use static native caps", async () => {
    const workflows = await loadWorkflows();
    const capped: Array<readonly [string, string, string, number, "run" | "action"]> = [];
    const budgets: Record<string, { stepCaps: number; needed: number; jobCap: number }> = {};
    const violations: string[] = [];

    for (const [file, workflow] of Object.entries(workflows)) {
      for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
        if (job.uses) continue;
        const jobCap = numericCap(job["timeout-minutes"]);
        if (jobCap === null || jobCap > MAX_JOB_TIMEOUT_MINUTES) {
          violations.push(`${file}:${jobName} has an invalid job cap`);
          continue;
        }
        let stepCaps = 0;
        for (const step of job.steps ?? []) {
          const cap = numericCap(step["timeout-minutes"]);
          if (step["timeout-minutes"] !== undefined && cap === null) {
            violations.push(`${file}:${jobName}:${step.name ?? "unnamed"} has an invalid step cap`);
          }
          if (cap === null) continue;
          stepCaps += cap;
          const kind = step.run ? "run" : step.uses === PLAYWRIGHT_ACTION ? "action" : null;
          if (!kind || !step.name) {
            violations.push(`${file}:${jobName} has a capped step outside the approved corpus`);
          } else {
            capped.push([file, jobName, step.name, cap, kind]);
          }
        }
        budgets[`${file}:${jobName}`] = { stepCaps, needed: stepCaps + 1, jobCap };
        if (jobCap < stepCaps + 1) violations.push(`${file}:${jobName} cap is below native steps`);
      }
    }

    expect(violations).toEqual([]);
    const byIdentity = (
      left: readonly [string, string, string, number, "run" | "action"],
      right: readonly [string, string, string, number, "run" | "action"],
    ) => left.slice(0, 3).join("\0").localeCompare(right.slice(0, 3).join("\0"));
    expect(capped.toSorted(byIdentity)).toEqual(EXPECTED_CAPS.toSorted(byIdentity));
    expect(capped.filter((row) => row[4] === "run")).toHaveLength(15);
    expect(capped.filter((row) => row[4] === "action")).toHaveLength(3);
    for (const [job, expected] of Object.entries(EXPECTED_JOB_BUDGETS)) {
      expect(budgets[job], job).toEqual(expected);
    }
  });

  test("the consolidated browser lane and Playwright runtime budget stay structurally bound", async () => {
    const workflows = await loadWorkflows();
    const callers = Object.entries(workflows).flatMap(([file, workflow]) =>
      Object.entries(workflow.jobs ?? {}).flatMap(([job, definition]) =>
        (definition.steps ?? [])
          .filter((step) => step.uses === PLAYWRIGHT_ACTION)
          .map((step) => ({ file, job, step })),
      ),
    );
    expect(callers).toHaveLength(3);
    expect(callers.find(({ job }) => job === "browser-acceptance")?.step.with?.browsers).toBe(
      "${{ matrix.lane == 'workbench' && 'chromium firefox webkit' || matrix.lane == 'accounts' && matrix.engine || 'chromium' }}",
    );

    const action = Bun.YAML.parse(await readFile(playwrightActionPath, "utf8")) as {
      inputs: Record<string, { default?: unknown }>;
      runs: { steps: Array<{ name?: string; env?: Record<string, unknown>; run?: string }> };
    };
    const install = action.runs.steps.find(
      (step) => step.name === "Install pinned Playwright browsers",
    );
    expect(install?.env).toMatchObject({
      ATTEMPT_TIMEOUT_SECONDS: "${{ inputs.attempt-timeout-seconds }}",
      ATTEMPTS: "${{ inputs.attempts }}",
      KILL_AFTER_SECONDS: "15",
    });
    const command = String(install?.run ?? "").replace(/\\\r?\n\s*/gu, " ");
    expect(command).toContain(
      'timeout --kill-after="${KILL_AFTER_SECONDS}s" "${ATTEMPT_TIMEOUT_SECONDS}s"',
    );
    const duration = Number(action.inputs["attempt-timeout-seconds"]?.default);
    const attempts = Number(action.inputs.attempts?.default);
    expect(((duration + 15) * attempts) / 60).toBeLessThanOrEqual(17);
  });

  test("Playwright retry, cache, and dirlock cleanup behavior stays intact", async () => {
    for (const file of Object.keys(await loadWorkflows())) {
      expect(await readFile(resolve(workflowDir, file), "utf8")).not.toContain(
        "playwright install",
      );
    }
    const actionSource = await readFile(playwrightActionPath, "utf8");
    expect(actionSource).toContain("playwright install --with-deps");
    expect(actionSource).toContain("actions/cache/restore@");
    expect(actionSource).toContain("actions/cache/save@");
    expect(actionSource).toContain("rm -rf ~/.cache/ms-playwright/__dirlock");

    const action = Bun.YAML.parse(actionSource) as {
      runs: { steps: Array<{ name?: string; run?: string }> };
    };
    const script = action.runs.steps.find(
      (step) => step.name === "Install pinned Playwright browsers",
    )?.run;
    expect(typeof script).toBe("string");
    const dir = await mkdtemp(join(tmpdir(), "playwright-install-contract-"));
    try {
      const scriptPath = join(dir, "install.sh");
      const binDir = join(dir, "bin");
      await mkdir(binDir);
      await writeFile(scriptPath, script as string);
      await writeFile(
        join(binDir, "timeout"),
        ["#!/bin/bash", 'while [[ "$1" == --* ]]; do shift; done', "shift", '"$@"', ""].join("\n"),
      );
      const counter = join(dir, "n");
      await writeFile(
        join(binDir, "bun"),
        [
          "#!/bin/bash",
          `n=$(cat ${counter} 2>/dev/null || echo 0)`,
          "n=$((n+1))",
          `echo "$n" > ${counter}`,
          "exit 124",
          "",
        ].join("\n"),
      );
      await chmod(join(binDir, "timeout"), 0o755);
      await chmod(join(binDir, "bun"), 0o755);
      const proc = Bun.spawn(["bash", "--noprofile", "--norc", "-eo", "pipefail", scriptPath], {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          PLAYWRIGHT_BROWSERS: "chromium",
          PLAYWRIGHT_ONLY_SHELL: "false",
          ATTEMPT_TIMEOUT_SECONDS: "360",
          ATTEMPTS: "2",
          KILL_AFTER_SECONDS: "15",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(1);
      expect(await readFile(counter, "utf8")).toBe("2\n");
      expect(stdout).toContain("attempt 1/2");
      expect(stdout).toContain("attempt 2/2");
      expect(stdout).toContain("exceeded 360s and was killed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
