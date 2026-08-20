import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const workflowDir = resolve(root, ".github/workflows");
const playwrightActionPath = resolve(root, ".github/actions/playwright-browsers/action.yml");
const PLAYWRIGHT_ACTION = "./.github/actions/playwright-browsers";
const MAX_TIMEOUT_MINUTES = 120;
const JOB_SETUP_ALLOWANCE_MINUTES = 1;
const AMBIGUOUS_SHELL_TEXT = "\0";
const ASSEMBLY_FRAGMENT_WINDOW = 24;
const TIMEOUT_SPELLINGS = ["timeout", "gtimeout", "--timeout", "--timeout-seconds"] as const;
const ATTEMPT_TIMEOUT_INPUT = "${{ inputs.attempt-timeout-seconds }}";
const ATTEMPTS_INPUT = "${{ inputs.attempts }}";

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
type Workflows = Readonly<Record<string, Workflow>>;

type PlaywrightAction = Readonly<{
  inputs?: Readonly<Record<string, Readonly<{ default?: unknown }>>>;
  runs?: Readonly<{
    steps?: readonly Readonly<{
      name?: string;
      env?: Readonly<Record<string, unknown>>;
      run?: string;
    }>[];
  }>;
}>;

type MutablePlaywrightAction = {
  inputs: Record<string, { default?: unknown }>;
  runs: { steps: Array<{ name?: string; env?: Record<string, unknown>; run?: string }> };
};

type StepIdentity = Readonly<{
  file: string;
  job: string;
  name: string;
  cap: number;
}>;

const EXPECTED_CAPPED_STEPS: readonly StepIdentity[] = [
  { file: "ci.yml", job: "plan", name: "Install exact dependency tree", cap: 11 },
  {
    file: "ci.yml",
    job: "source-contracts",
    name: "Profile impacted TypeScript 7 projects",
    cap: 11,
  },
  {
    file: "ci.yml",
    job: "source-contracts",
    name: "Run exactly the explained source guards",
    cap: 16,
  },
  { file: "ci.yml", job: "unit-shards", name: "Unit test shard", cap: 21 },
  {
    file: "ci.yml",
    job: "integration-shards",
    name: "Run real PostgreSQL, pgvector, Temporal, NATS, and object-storage tests",
    cap: 31,
  },
  {
    file: "ci.yml",
    job: "e2e-shards",
    name: "Run exactly the impacted E2E tests",
    cap: 13,
  },
  {
    file: "ci.yml",
    job: "package-contracts",
    name: "Build client packages (contracts + SDK + React)",
    cap: 21,
  },
  {
    file: "ci.yml",
    job: "test-suite",
    name: "Real workspace capture acceptance",
    cap: 13,
  },
  {
    file: "ci.yml",
    job: "test-suite",
    name: "Recovery integration regressions",
    cap: 5,
  },
  {
    file: "ci.yml",
    job: "browser-acceptance",
    name: "Session pin browser acceptance",
    cap: 4,
  },
  {
    file: "ci.yml",
    job: "browser-acceptance",
    name: "Responsive knowledge surfaces browser acceptance",
    cap: 6,
  },
  {
    file: "ci.yml",
    job: "browser-acceptance",
    name: "Workbench browser acceptance",
    cap: 4,
  },
  {
    file: "desktop-e2e.yml",
    job: "desktop-image",
    name: "Desktop image e2e",
    cap: 36,
  },
  {
    file: "ci.yml",
    job: "e2e-shards",
    name: "Install pinned browser runtimes",
    cap: 17,
  },
  {
    file: "ci.yml",
    job: "browser-acceptance",
    name: "Install pinned lane browser runtimes",
    cap: 17,
  },
  {
    file: "ci.yml",
    job: "package-contracts",
    name: "Install Chromium for packed WASM package proof",
    cap: 17,
  },
];

const EXPECTED_JOB_BUDGETS = {
  "ci.yml:plan": { stepCaps: 11, needed: 12, jobCap: 15 },
  "ci.yml:source-contracts": { stepCaps: 27, needed: 28, jobCap: 35 },
  "ci.yml:unit-shards": { stepCaps: 21, needed: 22, jobCap: 30 },
  "ci.yml:integration-shards": { stepCaps: 31, needed: 32, jobCap: 40 },
  "ci.yml:e2e-shards": { stepCaps: 30, needed: 31, jobCap: 35 },
  "ci.yml:test-suite": { stepCaps: 18, needed: 19, jobCap: 30 },
  "ci.yml:browser-acceptance": { stepCaps: 31, needed: 32, jobCap: 35 },
  "ci.yml:package-contracts": { stepCaps: 38, needed: 39, jobCap: 55 },
  "desktop-e2e.yml:desktop-image": { stepCaps: 36, needed: 37, jobCap: 45 },
} as const;

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function ambiguousShellProjection(source: string): string {
  return source
    .replace(
      /\$'((?:\\[\s\S]|[^']){0,128})'/gu,
      (_whole, body: string) =>
        AMBIGUOUS_SHELL_TEXT +
        body.replace(/\\(?:x[0-9A-Fa-f]{1,2}|u[0-9A-Fa-f]{1,4}|[\s\S])/gu, AMBIGUOUS_SHELL_TEXT) +
        AMBIGUOUS_SHELL_TEXT,
    )
    .replace(/\$\{[^}\r\n]{0,128}\}/gu, AMBIGUOUS_SHELL_TEXT)
    .replace(/\$\([^\r\n)]{0,128}\)/gu, AMBIGUOUS_SHELL_TEXT)
    .replace(/;\s*[A-Za-z_][A-Za-z0-9_]*\s*\+=/gu, AMBIGUOUS_SHELL_TEXT)
    .replace(/\$[A-Za-z_][A-Za-z0-9_]*/gu, AMBIGUOUS_SHELL_TEXT)
    .replace(/["']/gu, "");
}

function hasAmbiguousTimeoutAssembly(source: string): boolean {
  const projection = ambiguousShellProjection(source);
  for (const ambiguity of projection.matchAll(/\0+/gu)) {
    const index = ambiguity.index;
    if (index === undefined) continue;
    const left =
      /(?:--)?[A-Za-z-]+$/u.exec(
        projection.slice(Math.max(0, index - ASSEMBLY_FRAGMENT_WINDOW), index),
      )?.[0] ?? "";
    const right =
      /^(?:--)?[A-Za-z-]+/u.exec(
        projection.slice(index + ambiguity[0].length, index + ASSEMBLY_FRAGMENT_WINDOW),
      )?.[0] ?? "";
    for (const target of TIMEOUT_SPELLINGS) {
      for (
        let leftLength = 0;
        leftLength <= Math.min(left.length, target.length);
        leftLength += 1
      ) {
        const prefix = leftLength === 0 ? "" : left.slice(-leftLength);
        if (leftLength > 0 && !target.startsWith(prefix)) continue;
        for (
          let rightLength = 0;
          rightLength <= Math.min(right.length, target.length - leftLength);
          rightLength += 1
        ) {
          const suffix = right.slice(0, rightLength);
          if (leftLength + rightLength >= 4 && (rightLength === 0 || target.endsWith(suffix))) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

/**
 * This is deliberately lexical, not a shell parser. It joins line continuations
 * and removes quote/backslash spelling noise so known timeout words cannot hide,
 * but it never tries to execute, branch, expand, or add inner command budgets.
 */
function hasTimeoutSpelling(source: string): boolean {
  const normalized = source
    .replace(/\\\r?\n/gu, "")
    .replace(/\\(?=[A-Za-z-])/gu, "")
    .replace(/["']/gu, "");
  if (
    /(^|[^A-Za-z0-9_])(?:gtimeout|timeout|--timeout(?:-seconds)?)(?=$|[^A-Za-z0-9_])/u.test(
      normalized,
    )
  ) {
    return true;
  }

  // This bounded ambiguity projection is not shell evaluation. It collapses
  // nearby expansions, ANSI escapes, and append-shaped text to one marker, then
  // asks whether that marker could complete a known spelling. It never decodes
  // the middle, follows a variable, or infers an inner duration.
  return hasAmbiguousTimeoutAssembly(source);
}

async function loadWorkflows(): Promise<Workflows> {
  const files = (await readdir(workflowDir))
    .filter((entry) => entry.endsWith(".yml") || entry.endsWith(".yaml"))
    .sort();
  return Object.fromEntries(
    await Promise.all(
      files.map(async (file) => [
        file,
        Bun.YAML.parse(await readFile(resolve(workflowDir, file), "utf8")) as Workflow,
      ]),
    ),
  );
}

async function loadPlaywrightAction(): Promise<PlaywrightAction> {
  return Bun.YAML.parse(await readFile(playwrightActionPath, "utf8")) as PlaywrightAction;
}

function mutablePlaywrightAction(action: PlaywrightAction): MutablePlaywrightAction {
  return structuredClone(action) as MutablePlaywrightAction;
}

function mutableInstallStep(action: MutablePlaywrightAction) {
  const step = action.runs.steps.find(
    (candidate) => candidate.name === "Install pinned Playwright browsers",
  );
  if (!step?.env || !step.run) throw new Error("missing Playwright install fixture");
  return step;
}

function playwrightBoundMinutes(
  action: PlaywrightAction,
  caller: Step,
): Readonly<{ minutes: number | null; reason?: string }> {
  const install = action.runs?.steps?.find(
    (step) => step.name === "Install pinned Playwright browsers",
  );
  if (install?.env?.ATTEMPT_TIMEOUT_SECONDS !== ATTEMPT_TIMEOUT_INPUT) {
    return { minutes: null, reason: "Playwright attempt timeout input is not bound to runtime" };
  }
  if (install.env.ATTEMPTS !== ATTEMPTS_INPUT) {
    return { minutes: null, reason: "Playwright attempts input is not bound to runtime" };
  }
  const grace = Number(install.env.KILL_AFTER_SECONDS);
  if (!Number.isFinite(grace) || grace < 0) {
    return { minutes: null, reason: "Playwright kill grace is not statically numeric" };
  }
  const command = String(install.run ?? "").replace(/\\\r?\n\s*/gu, " ");
  if (
    !/\btimeout --kill-after="\$\{KILL_AFTER_SECONDS\}s" "\$\{ATTEMPT_TIMEOUT_SECONDS\}s"(?:\s|$)/u.test(
      command,
    )
  ) {
    return { minutes: null, reason: "Playwright timeout command is not bound to runtime inputs" };
  }
  const duration = Number(
    caller.with?.["attempt-timeout-seconds"] ?? action.inputs?.["attempt-timeout-seconds"]?.default,
  );
  const attempts = Number(caller.with?.attempts ?? action.inputs?.attempts?.default);
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    !Number.isSafeInteger(attempts) ||
    attempts <= 0 ||
    !Number.isFinite(grace)
  ) {
    return { minutes: null, reason: "Playwright install budget is not statically numeric" };
  }
  return { minutes: ((duration + grace) * attempts) / 60 };
}

type Inspection = Readonly<{
  violations: readonly string[];
  cappedSteps: readonly string[];
  playwrightCallers: readonly string[];
  jobs: Readonly<Record<string, Readonly<{ stepCaps: number; needed: number; jobCap: number }>>>;
}>;

function inspectWorkflowCaps(workflows: Workflows, action: PlaywrightAction): Inspection {
  const violations: string[] = [];
  const cappedSteps: string[] = [];
  const playwrightCallers: string[] = [];
  const jobs: Record<string, { stepCaps: number; needed: number; jobCap: number }> = {};

  for (const [file, workflow] of Object.entries(workflows)) {
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      if (job.uses) continue;
      const jobId = `${file}:${jobName}`;
      const jobCap = positiveNumber(job["timeout-minutes"]);
      if (jobCap === null) {
        violations.push(`${jobId} job timeout-minutes must be a positive static number`);
      }

      let stepCaps = 0;
      for (const [stepIndex, step] of (job.steps ?? []).entries()) {
        const stepName = step.name ?? `step-${stepIndex + 1}`;
        const stepId = `${jobId}:${stepName}`;
        const rawCap = step["timeout-minutes"];
        const stepCap = positiveNumber(rawCap);
        if (rawCap !== undefined && stepCap === null) {
          violations.push(`${stepId} timeout-minutes must be a positive static number`);
        }
        if (stepCap !== null) {
          stepCaps += stepCap;
          cappedSteps.push(stepId);
        }

        if (step.run && hasTimeoutSpelling(step.run) && stepCap === null) {
          violations.push(`${stepId} contains a timeout spelling and requires timeout-minutes`);
        }

        if (step.uses === PLAYWRIGHT_ACTION) {
          playwrightCallers.push(stepId);
          if (stepCap === null) {
            violations.push(
              `${stepId} calls the local Playwright action and requires timeout-minutes`,
            );
          } else {
            const bound = playwrightBoundMinutes(action, step);
            if (bound.minutes === null) {
              violations.push(`${stepId} ${bound.reason ?? "has an invalid Playwright bound"}`);
            } else if (stepCap < bound.minutes) {
              violations.push(
                `${stepId} cap ${stepCap}m is below the Playwright install bound ${bound.minutes.toFixed(2)}m`,
              );
            }
          }
        }
      }

      const needed = JOB_SETUP_ALLOWANCE_MINUTES + stepCaps;
      if (jobCap !== null) {
        jobs[jobId] = { stepCaps, needed, jobCap };
        if (jobCap < needed) {
          violations.push(
            `${jobId} cap ${jobCap}m is below 1m setup plus step caps (${needed}m needed)`,
          );
        }
      }
    }
  }

  return { violations, cappedSteps, playwrightCallers, jobs };
}

function mutableWorkflows(workflows: Workflows): Record<string, { jobs?: Record<string, Job> }> {
  return structuredClone(workflows) as Record<string, { jobs?: Record<string, Job> }>;
}

function findStep(
  workflows: Record<string, { jobs?: Record<string, Job> }>,
  id: StepIdentity,
): Step {
  const step = workflows[id.file]?.jobs?.[id.job]?.steps?.find(
    (candidate) => candidate.name === id.name,
  );
  if (!step) throw new Error(`missing fixture step ${id.file}:${id.job}:${id.name}`);
  return step;
}

function syntheticWorkflow(run: string, stepCap?: unknown): Workflows {
  return {
    "fixture.yml": {
      jobs: {
        fixture: {
          "timeout-minutes": 60,
          steps: [
            {
              name: "fixture",
              run,
              ...(stepCap === undefined ? {} : { "timeout-minutes": stepCap }),
            },
          ],
        },
      },
    },
  };
}

describe("workflow timeout contract", () => {
  test("every ordinary job has a positive bounded timeout", async () => {
    const violations: string[] = [];
    for (const [file, workflow] of Object.entries(await loadWorkflows())) {
      for (const [name, job] of Object.entries(workflow.jobs ?? {})) {
        if (job.uses) continue;
        const timeout = positiveNumber(job["timeout-minutes"]);
        if (timeout === null || timeout > MAX_TIMEOUT_MINUTES) {
          violations.push(`${file}:${name} timeout-minutes is outside 0..${MAX_TIMEOUT_MINUTES}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("Playwright installation remains bounded, cached, and lock-clean", async () => {
    const inlineInstalls: string[] = [];
    for (const [file] of Object.entries(await loadWorkflows())) {
      const source = await readFile(resolve(workflowDir, file), "utf8");
      if (source.includes("playwright install")) inlineInstalls.push(file);
    }
    expect(inlineInstalls).toEqual([]);

    const action = await readFile(playwrightActionPath, "utf8");
    expect(action).toContain('KILL_AFTER_SECONDS: "15"');
    expect(action).toContain(
      'timeout --kill-after="${KILL_AFTER_SECONDS}s" "${ATTEMPT_TIMEOUT_SECONDS}s"',
    );
    expect(action).toContain("playwright install --with-deps");
    expect(action).toContain("actions/cache/restore@");
    expect(action).toContain("actions/cache/save@");
    expect(action).toContain("path: ~/.cache/ms-playwright");
    // Cache entries are immutable, so a __dirlock baked in by a SIGKILLed
    // install is permanent for that key. Cheap to drop, impossible to undo.
    expect(action).toContain("rm -rf ~/.cache/ms-playwright/__dirlock");
    expect(action).toMatch(
      /if: \$\{\{ always\(\) && steps\.restore\.outputs\.cache-hit != 'true' \}\}/u,
    );
  });

  test("the exact 16-step workflow corpus uses native caps once", async () => {
    const workflows = await loadWorkflows();
    const inspection = inspectWorkflowCaps(workflows, await loadPlaywrightAction());
    expect(inspection.violations).toEqual([]);
    expect(inspection.cappedSteps).toHaveLength(16);
    expect(inspection.playwrightCallers).toHaveLength(3);

    const mutable = mutableWorkflows(workflows);
    const allSteps = Object.values(mutable).flatMap((workflow) =>
      Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? []),
    );
    expect(
      allSteps.filter((step) => step.run && positiveNumber(step["timeout-minutes"]) !== null),
    ).toHaveLength(13);
    expect(
      allSteps.filter(
        (step) =>
          step.uses === PLAYWRIGHT_ACTION && positiveNumber(step["timeout-minutes"]) !== null,
      ),
    ).toHaveLength(3);
    for (const expected of EXPECTED_CAPPED_STEPS) {
      expect(findStep(mutable, expected)["timeout-minutes"], expected.name).toBe(expected.cap);
    }
    for (const [job, expected] of Object.entries(EXPECTED_JOB_BUDGETS)) {
      expect(inspection.jobs[job], job).toEqual(expected);
    }

    const browserSteps = mutable["ci.yml"]?.jobs?.["browser-acceptance"]?.steps ?? [];
    const browserCallers = browserSteps.filter((step) => step.uses === PLAYWRIGHT_ACTION);
    expect(browserCallers).toHaveLength(1);
    expect(browserCallers[0]?.with?.browsers).toBe(
      "${{ matrix.lane == 'workbench' && 'chromium firefox webkit' || 'chromium' }}",
    );
  });

  test("removing any one of the 16 native caps fails closed", async () => {
    const workflows = await loadWorkflows();
    const action = await loadPlaywrightAction();
    for (const expected of EXPECTED_CAPPED_STEPS) {
      const mutated = mutableWorkflows(workflows);
      delete (findStep(mutated, expected) as { "timeout-minutes"?: unknown })["timeout-minutes"];
      const inspection = inspectWorkflowCaps(mutated, action);
      expect(
        inspection.violations.some((violation) =>
          violation.includes(`${expected.file}:${expected.job}:${expected.name}`),
        ),
        expected.name,
      ).toBe(true);
    }
  });

  test("dynamic and non-positive step caps fail", async () => {
    const action = await loadPlaywrightAction();
    for (const cap of [0, -1, Number.NaN, "${{ env.TIMEOUT_MINUTES }}", null]) {
      const inspection = inspectWorkflowCaps(syntheticWorkflow("timeout 10m job", cap), action);
      expect(inspection.violations.length, String(cap)).toBeGreaterThan(0);
    }
  });

  test("lowering any affected job below one minute plus its step caps fails", async () => {
    const workflows = await loadWorkflows();
    const action = await loadPlaywrightAction();
    for (const [jobId, expected] of Object.entries(EXPECTED_JOB_BUDGETS)) {
      const mutated = mutableWorkflows(workflows);
      const [file, jobName] = jobId.split(":") as [string, string];
      const job = mutated[file]?.jobs?.[jobName];
      if (!job) throw new Error(`missing fixture job ${jobId}`);
      (job as { "timeout-minutes"?: unknown })["timeout-minutes"] = expected.needed - 1;
      expect(
        inspectWorkflowCaps(mutated, action).violations.some((violation) =>
          violation.includes(`${jobId} cap ${expected.needed - 1}m is below`),
        ),
        jobId,
      ).toBe(true);
    }
  });

  test("normalized timeout spellings require a cap and then count only that cap", async () => {
    const action = await loadPlaywrightAction();
    const probes = [
      "cat <<EOF\n$(timeout 10h job)\nEOF",
      'echo "$(timeout 10h job)"',
      'VALUE="$(timeout 10h job)"',
      'consume "$(timeout 10h job)"',
      "eval 'timeout 10h job'",
      'time""out 10h job',
      "ti\\meout 10h job",
      "time\\\nout 10h job",
      'bun test --time""out 720000',
      'cmd=timeout; "$cmd" 10h job',
      "gtimeout 10h job",
      'timeout "${{ env.BUDGET }}" job',
      'bun test --timeout="${{ env.BUDGET }}"',
      'bun test --timeout-seconds="${{ env.BUDGET }}"',
      "time$''out 10h job",
      "time$'\\x6f'ut 10h job",
      "$'time\\x6fut' 10h job",
      "EMPTY=; time${EMPTY}out 10h job",
      'cmd=time; cmd+=out; "$cmd" 10h job',
      'time$(printf "")out 10h job',
      "gtime$''out 10h job",
      "gtime$'\\x6f'ut 10h job",
      "bun test --time${EMPTY}out 720000",
      "bun test --time$'\\x6f'ut-seconds 720",
      'flag=--time; flag+=out-seconds; bun test "$flag" 720',
      "ti$''meout 10h job",
      "gti${EMPTY}meout 10h job",
      'bun test --timeo$(printf "")ut 720000',
      'flag=--ti; flag+=meout-seconds; bun test "$flag" 720',
    ];
    for (const probe of probes) {
      expect(inspectWorkflowCaps(syntheticWorkflow(probe), action).violations.length, probe).toBe(
        1,
      );
      const capped = inspectWorkflowCaps(syntheticWorkflow(probe, 12), action);
      expect(capped.violations, probe).toEqual([]);
      expect(capped.jobs["fixture.yml:fixture"], probe).toEqual({
        stepCaps: 12,
        needed: 13,
        jobCap: 60,
      });
    }
  });

  test("shell structure never creates inferred inner sums", async () => {
    const action = await loadPlaywrightAction();
    const probes = [
      "timeout 10m bash -c 'timeout 5m job'",
      "retry --attempts 3 timeout 10m job",
      "timeout 10m producer | timeout 5m consumer",
      "while retrying; do timeout 10m job; done",
      "cat <<EOF\ntimeout 10m is data\nEOF",
      "alias t=timeout; t 10m job",
      "eval 'timeout 10m job'",
      'cmd=timeout; "$cmd" 10m job',
    ];
    for (const probe of probes) {
      const inspection = inspectWorkflowCaps(syntheticWorkflow(probe, 12), action);
      expect(inspection.violations, probe).toEqual([]);
      // Nested 10m + 5m is still one native 12m step, never 27m.
      expect(inspection.jobs["fixture.yml:fixture"]?.stepCaps, probe).toBe(12);
      expect(inspection.jobs["fixture.yml:fixture"]?.needed, probe).toBe(13);
    }
  });

  test("Playwright duration, attempts, and kill grace must fit the 17-minute caller cap", async () => {
    const workflows = await loadWorkflows();
    const action = await loadPlaywrightAction();
    expect(inspectWorkflowCaps(workflows, action).violations).toEqual([]);

    const tooLong = mutablePlaywrightAction(action);
    tooLong.inputs["attempt-timeout-seconds"] = { default: "1006" };
    expect(inspectWorkflowCaps(workflows, tooLong).violations.length).toBeGreaterThan(0);

    const tooMany = mutablePlaywrightAction(action);
    tooMany.inputs.attempts = { default: "2" };
    expect(inspectWorkflowCaps(workflows, tooMany).violations.length).toBeGreaterThan(0);

    const tooMuchGrace = mutablePlaywrightAction(action);
    const install = mutableInstallStep(tooMuchGrace);
    install.env.KILL_AFTER_SECONDS = "121";
    expect(inspectWorkflowCaps(workflows, tooMuchGrace).violations.length).toBeGreaterThan(0);

    for (const literal of ["900", "1006"]) {
      const unbound = mutablePlaywrightAction(action);
      const step = mutableInstallStep(unbound);
      step.env.ATTEMPT_TIMEOUT_SECONDS = literal;
      expect(inspectWorkflowCaps(workflows, unbound).violations.length, literal).toBeGreaterThan(0);
    }

    const literalDuration = mutablePlaywrightAction(action);
    const literalStep = mutableInstallStep(literalDuration);
    literalStep.run = literalStep.run.replace('"${ATTEMPT_TIMEOUT_SECONDS}s"', '"900s"');
    expect(inspectWorkflowCaps(workflows, literalDuration).violations.length).toBeGreaterThan(0);

    const literalGrace = mutablePlaywrightAction(action);
    const literalGraceStep = mutableInstallStep(literalGrace);
    literalGraceStep.run = literalGraceStep.run.replace('"${KILL_AFTER_SECONDS}s"', '"15s"');
    expect(inspectWorkflowCaps(workflows, literalGrace).violations.length).toBeGreaterThan(0);

    const literalAttempts = mutablePlaywrightAction(action);
    const literalAttemptsStep = mutableInstallStep(literalAttempts);
    literalAttemptsStep.env.ATTEMPTS = "1";
    expect(inspectWorkflowCaps(workflows, literalAttempts).violations.length).toBeGreaterThan(0);
  });

  // The runner executes `shell: bash` steps as
  // `bash --noprofile --norc -eo pipefail {0}`. Assert the real retry behavior
  // rather than trusting a plain `bash script.sh` invocation.
  test("the install retry loop survives the runner's errexit shell", async () => {
    const action = await loadPlaywrightAction();
    const script = action.runs?.steps?.find(
      (step) => step.name === "Install pinned Playwright browsers",
    )?.run;
    expect(typeof script).toBe("string");

    const dir = await mkdtemp(join(tmpdir(), "playwright-install-contract-"));
    try {
      const scriptPath = join(dir, "install.sh");
      const binDir = join(dir, "bin");
      await mkdir(binDir);
      await writeFile(scriptPath, script as string);
      const timeoutStub = [
        "#!/bin/bash",
        'while [[ "$1" == --* ]]; do shift; done',
        "shift",
        '"$@"',
        "",
      ].join("\n");
      await writeFile(join(binDir, "timeout"), timeoutStub);
      const counter = join(dir, "n");
      const bunStub = [
        "#!/bin/bash",
        `n=$(cat ${counter} 2>/dev/null || echo 0)`,
        "n=$((n+1))",
        `echo "$n" > ${counter}`,
        "exit 124",
        "",
      ].join("\n");
      await writeFile(join(binDir, "bun"), bunStub);
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
      expect(await readFile(join(dir, "n"), "utf8")).toBe("2\n");
      expect(stdout).toContain("attempt 1/2");
      expect(stdout).toContain("attempt 2/2");
      expect(stdout).toContain("exceeded 360s and was killed");
      expect(stdout).toContain("::error::");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
