import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const workflowDir = resolve(root, ".github/workflows");
const playwrightActionPath = resolve(root, ".github/actions/playwright-browsers/action.yml");
const playwrightInstallScript = resolve(
  root,
  ".github/actions/playwright-browsers/install-browsers.sh",
);
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

function validJobCap(file: string, jobName: string, job: Job): boolean {
  const cap = numericCap(job["timeout-minutes"]);
  if (cap === null) return false;
  const priorityLane = new Map([["ci.yml:automation-admission", "pr"]]).get(`${file}:${jobName}`);
  if (!priorityLane) return cap <= MAX_JOB_TIMEOUT_MINUTES;
  // Five-hour bounded admission wait plus twenty minutes for setup/planning.
  // This is not a wider cap for test/build jobs or arbitrary added workflows.
  return (
    cap === 320 &&
    (job.steps ?? []).filter(
      (step) => step.run === `bun scripts/ci/github-pr-ci.ts priority ${priorityLane}`,
    ).length === 1
  );
}

const EXPECTED_CAPS = [
  [
    "agent-ci.yml",
    "native-command-supervisor",
    "Compile and exercise native protocol and failure cases",
    5,
    "run",
  ],
  ["backup-image.yml", "publish", "Install restic", 2, "run"],
  ["backup-image.yml", "publish", "Test operator runner", 5, "run"],
  ["backup-image.yml", "publish", "Retain digest receipt", 1, "run"],
  ["local-startup.yml", "docker", "Check startup ownership and prerequisite regressions", 2, "run"],
  ["local-startup.yml", "docker", "Verify the runner Docker dependency", 1, "run"],
  ["local-startup.yml", "docker", "Start the documented stack from a clean checkout", 50, "run"],
  ["local-startup.yml", "docker", "Install startup browser runtime", 17, "action"],
  ["local-startup.yml", "docker", "Verify rendered startup and restart", 15, "run"],
  ["local-startup.yml", "docker", "Clean only the acceptance project", 3, "run"],
  ["local-startup.yml", "platform-preflight", "Verify host prerequisite contracts", 2, "run"],
  [
    "publish-artifact-runtime.yml",
    "publish",
    "Install controller dependencies without lifecycle scripts",
    4,
    "run",
  ],
  [
    "publish-artifact-runtime.yml",
    "publish",
    "Verify and retain all seven native archives without rebuilding",
    8,
    "run",
  ],
  [
    "ci.yml",
    "automation-admission",
    "Restore complete checkout history without listing refs",
    5,
    "run",
  ],
  ["ci.yml", "plan", "Restore complete checkout history without listing refs", 5, "run"],
  [
    "ci.yml",
    "source-contracts",
    "Restore complete checkout history without listing refs",
    5,
    "run",
  ],
  ["ci.yml", "unit-shards", "Restore complete checkout history without listing refs", 5, "run"],
  ["ci.yml", "test-suite", "Restore complete checkout history without listing refs", 5, "run"],
  [
    "ci.yml",
    "browser-acceptance",
    "Restore complete checkout history without listing refs",
    5,
    "run",
  ],
  [
    "ci.yml",
    "package-contracts",
    "Restore complete checkout history without listing refs",
    5,
    "run",
  ],
  [
    "open-version-pr.yml",
    "version",
    "Restore complete checkout history without listing refs",
    5,
    "run",
  ],
  [
    "publish-canary.yml",
    "publish",
    "Restore complete checkout history without listing refs",
    5,
    "run",
  ],
  [
    "publish-packages.yml",
    "publish",
    "Restore complete checkout history without listing refs",
    5,
    "run",
  ],
  [
    "publish-stable.yml",
    "publish",
    "Restore complete checkout history without listing refs",
    5,
    "run",
  ],
  [
    "release-acceptance.yml",
    "acceptance",
    "Restore complete checkout history without listing refs",
    5,
    "run",
  ],
  [
    "release-candidate.yml",
    "candidate",
    "Restore complete checkout history without listing refs",
    5,
    "run",
  ],
  [
    "release-embedded.yml",
    "source-verification",
    "Restore complete checkout history without listing refs",
    5,
    "run",
  ],
  [
    "release-embedded.yml",
    "release",
    "Restore complete checkout history without listing refs",
    5,
    "run",
  ],
  [
    "release-publication-admission.yml",
    "verify",
    "Restore complete checkout history without listing refs",
    5,
    "run",
  ],
  ["release.yml", "version", "Restore complete checkout history without listing refs", 5, "run"],
  ["release.yml", "publish", "Restore complete checkout history without listing refs", 5, "run"],
  [
    "staging-canary-dispatch.yml",
    "receipt",
    "Restore complete checkout history without listing refs",
    5,
    "run",
  ],
  ["ci.yml", "plan", "Install exact dependency tree", 11, "run"],
  ["ci.yml", "sandbox-image", "Wait for exact artifact runtime inputs", 60, "run"],
  ["ci.yml", "desktop-image", "Wait for exact artifact runtime inputs", 60, "run"],
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
  ["ci.yml", "browser-acceptance", "Session pin browser acceptance", 8, "run"],
  ["ci.yml", "browser-acceptance", "Responsive knowledge surfaces browser acceptance", 6, "run"],
  ["ci.yml", "browser-acceptance", "Organization onboarding lifecycle acceptance", 8, "run"],
  ["ci.yml", "browser-acceptance", "Browser account session-set acceptance", 14, "run"],
  ["ci.yml", "browser-acceptance", "Workbench browser acceptance", 4, "run"],
  ["ci.yml", "browser-acceptance", "Compact session-search header browser acceptance", 8, "run"],
  [
    "ci.yml",
    "browserd-real-e2e",
    "Verify managed recovery in an owned process namespace",
    2,
    "run",
  ],
  ["ci.yml", "browserd-real-e2e", "Run headless browserd end-to-end suite", 13, "run"],
  ["ci.yml", "browserd-real-e2e", "Run headed browserd streaming and interaction suite", 5, "run"],
  ["desktop-e2e.yml", "desktop-image", "Desktop image e2e", 36, "run"],
  ["ci.yml", "e2e-shards", "Install pinned browser runtimes", 17, "action"],
  ["ci.yml", "browser-acceptance", "Install pinned lane browser runtimes", 17, "action"],
  ["ci.yml", "package-contracts", "Install Chromium for packed WASM package proof", 17, "action"],
  ["ci.yml", "browserd-real-e2e", "Install pinned Chromium", 17, "action"],
] as const;

const EXPECTED_JOB_BUDGETS = {
  "agent-ci.yml:native-command-supervisor": { stepCaps: 5, needed: 6, jobCap: 6 },
  "backup-image.yml:publish": { stepCaps: 8, needed: 9, jobCap: 30 },
  "local-startup.yml:docker": { stepCaps: 88, needed: 89, jobCap: 90 },
  "local-startup.yml:platform-preflight": { stepCaps: 2, needed: 3, jobCap: 5 },
  "publish-artifact-runtime.yml:publish": { stepCaps: 12, needed: 13, jobCap: 15 },
  "ci.yml:plan": { stepCaps: 16, needed: 17, jobCap: 17 },
  "ci.yml:sandbox-image": { stepCaps: 60, needed: 61, jobCap: 75 },
  "ci.yml:desktop-image": { stepCaps: 60, needed: 61, jobCap: 75 },
  "ci.yml:source-contracts": { stepCaps: 32, needed: 33, jobCap: 35 },
  "ci.yml:unit-shards": { stepCaps: 26, needed: 27, jobCap: 30 },
  "ci.yml:integration-shards": { stepCaps: 31, needed: 32, jobCap: 40 },
  "ci.yml:e2e-shards": { stepCaps: 30, needed: 31, jobCap: 35 },
  "ci.yml:test-suite": { stepCaps: 23, needed: 24, jobCap: 30 },
  "ci.yml:browser-acceptance": { stepCaps: 70, needed: 71, jobCap: 71 },
  "ci.yml:package-contracts": { stepCaps: 43, needed: 44, jobCap: 55 },
  "ci.yml:browserd-real-e2e": { stepCaps: 37, needed: 38, jobCap: 40 },
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
  test("extended admission caps require exact job, lane and bounded timeout", () => {
    const job: Job = {
      "timeout-minutes": 320,
      steps: [{ run: "bun scripts/ci/github-pr-ci.ts priority pr" }],
    };
    expect(validJobCap("ci.yml", "automation-admission", job)).toBe(true);
    expect(validJobCap("pr-ci.yml", "plan", job)).toBe(false);
    expect(validJobCap("ci.yml", "unit-shards", job)).toBe(false);
    expect(validJobCap("ci.yml", "automation-admission", { ...job, "timeout-minutes": 321 })).toBe(
      false,
    );
    expect(validJobCap("ci.yml", "automation-admission", { ...job, steps: [] })).toBe(false);
    expect(validJobCap("other.yml", "plan", job)).toBe(false);
  });
  test("all jobs and the exact 52 run plus 5 action steps use static native caps", async () => {
    const workflows = await loadWorkflows();
    const capped: Array<readonly [string, string, string, number, "run" | "action"]> = [];
    const budgets: Record<string, { stepCaps: number; needed: number; jobCap: number }> = {};
    const violations: string[] = [];

    for (const [file, workflow] of Object.entries(workflows)) {
      for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
        if (job.uses) continue;
        const jobCap = numericCap(job["timeout-minutes"]);
        if (jobCap === null || !validJobCap(file, jobName, job)) {
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
    expect(capped.filter((row) => row[4] === "run")).toHaveLength(52);
    expect(capped.filter((row) => row[4] === "action")).toHaveLength(5);
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
    expect(callers).toHaveLength(6);
    expect(callers.find(({ job }) => job === "browser-acceptance")?.step.with?.browsers).toBe(
      "${{ matrix.lane == 'workbench' && 'chromium firefox webkit' || matrix.lane == 'accounts' && matrix.engine || 'chromium' }}",
    );
    expect(
      callers.find(({ file }) => file === "compact-session-view.yml")?.step.with?.browsers,
    ).toBe("chromium");

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
      SYSTEM_DEPS_BUDGET_SECONDS: "${{ inputs.system-deps-budget-seconds }}",
      KILL_AFTER_SECONDS: "15",
    });
    expect(install?.run).toBe(
      'PLAYWRIGHT_DEB_DIR="${HOME}/.cache/playwright-debs" bash "${PLAYWRIGHT_ACTION_PATH}/install-browsers.sh"',
    );
    const script = (await readFile(playwrightInstallScript, "utf8")).replace(/\\\r?\n\s*/gu, " ");
    expect(script).toContain('timeout --kill-after="${KILL_AFTER_SECONDS}s" "${attempt_timeout}s"');
    // The system packages phase is carved out of the first attempt, as
    // `--with-deps` was, so the worst case below still holds.
    expect(script).toContain("attempt_timeout=$((ATTEMPT_TIMEOUT_SECONDS - (SECONDS - started)))");
    const duration = Number(action.inputs["attempt-timeout-seconds"]?.default);
    const attempts = Number(action.inputs.attempts?.default);
    const systemDepsBudget = Number(action.inputs["system-deps-budget-seconds"]?.default);
    expect(((duration + 15) * attempts) / 60).toBeLessThanOrEqual(17);
    expect(systemDepsBudget).toBeLessThan(duration / 2);
  });

  test("Playwright retry, cache, and dirlock cleanup behavior stays intact", async () => {
    for (const file of Object.keys(await loadWorkflows())) {
      expect(await readFile(resolve(workflowDir, file), "utf8")).not.toContain(
        "playwright install",
      );
    }
    const actionSource = await readFile(playwrightActionPath, "utf8");
    expect(actionSource).toContain("actions/cache/restore@");
    expect(actionSource).toContain("actions/cache/save@");
    expect(actionSource).toContain("rm -rf ~/.cache/ms-playwright/__dirlock");
    // Browser builds differ per OS release, so the cache key must name it.
    expect(actionSource).toContain(". /etc/os-release");
    expect(actionSource).toContain('echo "key=playwright-${platform}-${version}-${slug}"');

    // Every browser attempt failing (killed at its timeout) fails the step
    // after exactly ATTEMPTS attempts.
    const killed = await runPlaywrightInstall({ dryRun: ["-"], install: [124, 124] });
    expect(killed.exitCode).toBe(1);
    expect(killed.calls.filter((call) => call.includes("bun install chromium"))).toHaveLength(2);
    expect(killed.stdout).toContain("attempt 1/2");
    expect(killed.stdout).toContain("attempt 2/2");
    expect(killed.stdout).toContain("exceeded 360s and was killed");
    expect(killed.sourcesList).toStartWith("# Disabled for Playwright");
  });

  test("Playwright system packages come from a shared deb cache, not the Ubuntu archive", async () => {
    const action = Bun.YAML.parse(await readFile(playwrightActionPath, "utf8")) as {
      runs: {
        steps: Array<{ id?: string; if?: string; uses?: string; with?: Record<string, string> }>;
      };
    };
    const restore = action.runs.steps.find((step) => step.id === "restore-debs");
    expect(restore?.uses).toStartWith("actions/cache/restore@");
    expect(restore?.with).toMatchObject({
      path: "~/.cache/playwright-debs",
      key: "${{ steps.pinned.outputs.debs-key }}",
      "restore-keys": "${{ steps.pinned.outputs.debs-restore-key }}",
    });
    const save = action.runs.steps.find(
      (step) =>
        step.uses?.startsWith("actions/cache/save@") && step.with?.path === restore?.with?.path,
    );
    expect(save?.with?.key).toBe("${{ steps.pinned.outputs.debs-key }}");
    // Only a cache that serves every browser is saved.
    expect(save?.if).toContain("steps.install.outputs.debs-complete == 'true'");
    expect(save?.if).toContain("steps.restore-debs.outputs.cache-hit != 'true'");

    // Nothing missing: no apt and no cache at all.
    const present = await runPlaywrightInstall({ dryRun: ["-"], install: [0] });
    expect(present.exitCode).toBe(0);
    expect(present.calls).toEqual([
      "sudo python3",
      "bun install-deps --dry-run chromium",
      expect.stringMatching(/^timeout \d+s bun install chromium$/u),
    ]);
    expect(present.stdout).toContain("already installed; skipping apt");

    // Restored cache: installs offline, never touches the network.
    const hit = await runPlaywrightInstall({
      dryRun: ["fonts-a libb", "fonts-a libb libc", "-"],
      debs: ["fonts-a", "libb", "libc"],
      install: [0],
    });
    expect(hit.exitCode).toBe(0);
    expect(hit.calls).toEqual([
      "sudo python3",
      "bun install-deps --dry-run chromium",
      "bun install-deps --dry-run chromium chromium-headless-shell firefox webkit",
      "apt no-download fonts-a libb",
      "bun install-deps --dry-run chromium",
      expect.stringMatching(/^timeout \d+s bun install chromium$/u),
    ]);
    expect(hit.outputs).toContain("debs-complete=true");
    expect(hit.stdout).toContain("from the deb cache");

    // The image's package lists moved on: dpkg installs the cached debs.
    const moved = await runPlaywrightInstall({
      dryRun: ["libb", "libb", "-"],
      debs: ["libb"],
      apt: [100],
      install: [0],
    });
    expect(moved.exitCode).toBe(0);
    expect(moved.calls).toContain("apt no-download libb");
    expect(moved.calls).toContainEqual(
      expect.stringMatching(/^sudo dpkg -i --refuse-downgrade \S+\/libb_1_amd64\.deb$/u),
    );
    expect(moved.calls.some((call) => call.startsWith("bun install-deps chromium"))).toBe(false);

    // Cold cache: downloads every browser's debs once, then installs offline.
    const cold = await runPlaywrightInstall({
      dryRun: ["libb", "libb libc", "-"],
      apt: [0, 0],
      install: [0],
    });
    expect(cold.exitCode).toBe(0);
    expect(cold.calls.slice(3, 5)).toEqual(["apt download libb libc", "apt no-download libb"]);
    expect(cold.debs).toEqual(["libb_1_amd64.deb", "libc_1_amd64.deb"]);
    expect(cold.outputs).toContain("debs-complete=true");
    expect(cold.aptConf).toContain('Acquire::Retries "5";');
    expect(cold.mirrors).toBe(
      "https://archive.ubuntu.com/ubuntu/\tpriority:1\n" +
        "https://mirrors.edge.kernel.org/ubuntu/\tpriority:10\n",
    );
  });

  test("Playwright system packages fall back to apt with backoff, then to the browsers' own libraries", async () => {
    // Archive unreachable and nothing cached: bounded download attempts with
    // backoff, bounded apt attempts, then the browsers still install and only
    // fonts are missing, so the step continues.
    const down = await runPlaywrightInstall({
      dryRun: ["fonts-a", "fonts-a libb"],
      apt: [100, 100, 100, 100, 100, 100, 100],
      deps: [100, 100, 100, 100],
      install: [0],
    });
    expect(down.exitCode).toBe(0);
    expect(down.calls.filter((call) => call === "apt download fonts-a libb")).toHaveLength(4);
    expect(down.calls.filter((call) => call === "apt update")).toHaveLength(3);
    expect(down.calls.filter((call) => call.includes("bun install-deps chromium"))).toHaveLength(4);
    expect(down.calls.filter((call) => call.startsWith("sleep"))).toEqual([
      "sleep 10",
      "sleep 20",
      "sleep 40",
      "sleep 10",
      "sleep 20",
      "sleep 40",
    ]);
    expect(down.outputs).not.toContain("debs-complete=true");
    expect(down.stdout).toContain("every library the browsers link resolves; continuing");

    // A missing shared library still fails the step.
    const broken = await runPlaywrightInstall({
      dryRun: ["libb", "libb"],
      apt: [100, 100, 100, 100, 100, 100, 100],
      deps: [100, 100, 100, 100],
      install: [0],
      ldd: "\tlibb.so.1 => not found",
    });
    expect(broken.exitCode).toBe(1);
    expect(broken.stdout).toContain("libb.so.1 => not found");

    // Without a deb cache apt recovers after one failure.
    const recovered = await runPlaywrightInstall({
      dryRun: ["libb"],
      deps: [100, 0],
      install: [0],
      noDebCache: true,
    });
    expect(recovered.exitCode).toBe(0);
    expect(recovered.calls).toEqual([
      "sudo python3",
      "bun install-deps --dry-run chromium",
      expect.stringMatching(/^timeout (300|299)s bun install-deps chromium$/u),
      "sudo dpkg --configure -a",
      "sleep 10",
      expect.stringMatching(/^timeout \d+s bun install-deps chromium$/u),
      expect.stringMatching(/^timeout \d+s bun install chromium$/u),
    ]);

    // The headless shell checks its own dependency set; the mirror is added once.
    const shell = await runPlaywrightInstall({
      dryRun: ["-"],
      install: [0],
      onlyShell: true,
      mirrorPresent: true,
    });
    expect(shell.calls).toContain("bun install-deps --dry-run chromium-headless-shell");
    expect(shell.calls.at(-1)).toMatch(/^timeout \d+s bun install --only-shell chromium$/u);

    // Other runners keep Playwright's own `--with-deps` and never touch apt.
    const mac = await runPlaywrightInstall({ dryRun: [], install: [0], os: "macOS" });
    expect(mac.exitCode).toBe(0);
    expect(mac.calls).toEqual([
      expect.stringMatching(/^timeout 360s bun install --with-deps chromium$/u),
    ]);
    expect(mac.aptConf).toBe("");
  });
});

/**
 * Runs install-browsers.sh as the runner does, with `bun`, `timeout`, `sudo`,
 * `apt-get`, `dpkg`, `ldd` and `sleep` replaced by recorders. Each dry run
 * reports the next missing-package list ("-" for none); every other command
 * exits with the next code from its list.
 */
async function runPlaywrightInstall(options: {
  dryRun: string[];
  deps?: number[];
  install: number[];
  apt?: number[];
  debs?: string[];
  ldd?: string;
  noDebCache?: boolean;
  onlyShell?: boolean;
  mirrorPresent?: boolean;
  os?: string;
}) {
  const dir = await mkdtemp(join(tmpdir(), "playwright-install-contract-"));
  try {
    const binDir = join(dir, "bin");
    const aptRoot = join(dir, "apt");
    const confDir = join(aptRoot, "apt.conf.d");
    // The install step keeps its debs under ~/.cache; HOME is `dir` here.
    const debDir = join(dir, ".cache", "playwright-debs");
    await mkdir(binDir);
    await mkdir(confDir, { recursive: true });
    await mkdir(debDir, { recursive: true });
    for (const deb of options.debs ?? []) {
      await writeFile(join(debDir, `${deb}_1_amd64.deb`), "");
    }
    const log = join(dir, "calls");
    await writeFile(log, "");
    const outputs = join(dir, "outputs");
    await writeFile(outputs, "");
    await writeFile(join(dir, "ldd-output"), `${options.ldd ?? "\tlibc.so.6 => /lib/libc.so.6"}\n`);
    await mkdir(join(dir, "browsers", "chromium-1"), { recursive: true });
    await writeFile(join(dir, "browsers", "chromium-1", "chrome"), "", { mode: 0o755 });
    await writeFile(
      join(aptRoot, "sources.list"),
      "deb https://dl.google.com/linux/chrome-stable/deb stable main\n",
    );
    const mirrors = join(aptRoot, "apt-mirrors.txt");
    await writeFile(
      mirrors,
      "https://archive.ubuntu.com/ubuntu/\tpriority:1\n" +
        (options.mirrorPresent ? "https://mirrors.edge.kernel.org/ubuntu/\tpriority:10\n" : ""),
    );
    for (const [name, values] of [
      ["dry-run", options.dryRun],
      ["deps", options.deps ?? []],
      ["install", options.install],
      ["apt", options.apt ?? [0]],
    ] as const) {
      await writeFile(join(dir, `codes-${name}`), values.map((value) => `${value}\n`).join(""));
    }
    const pop = (name: string) =>
      `code=$(head -n 1 ${dir}/codes-${name}); sed -i 1d ${dir}/codes-${name}`;
    const scripts: Record<string, string[]> = {
      // `timeout [--kill-after=N] DURATION command...`: record the duration.
      timeout: [
        'while [[ "$1" == --* ]]; do shift; done',
        'duration="$1"; shift',
        `case " $* " in *" --dry-run "*|*" apt-get "*) ;; *) printf 'timeout %s ' "$duration" >> ${log} ;; esac`,
        '"$@"',
      ],
      bun: [
        "shift 2 # x playwright",
        `echo "bun $*" >> ${log}`,
        'if [ "$1" = install-deps ] && [ "$2" = --dry-run ]; then',
        `  ${pop("dry-run")}`,
        '  [ "$code" = "-" ] && { echo "All system dependencies are installed."; exit 0; }',
        '  echo "Missing system dependencies (n):"; for p in $code; do echo "  $p"; done; exit 1',
        "fi",
        `kind=install; [ "$1" = install-deps ] && kind=deps; ${pop("$kind")}`,
        'exit "${code:-99}"',
      ],
      "apt-get": [
        'mode=install; archives=""; packages=()',
        'for arg in "$@"; do case "$arg" in',
        "  update) mode=update ;; --download-only) mode=download ;; --no-download) mode=no-download ;;",
        '  Dir::Cache::archives=*) archives=${arg#*=} ;; -*|install) ;; *) packages+=("$arg") ;;',
        "esac; done",
        `echo "apt $mode \${packages[*]}" | sed 's/ *$//' >> ${log}`,
        pop("apt"),
        'if [ "${code:-99}" = 0 ] && [ "$mode" = download ]; then for p in "${packages[@]}"; do : > "$archives/${p}_1_amd64.deb"; done; fi',
        'exit "${code:-99}"',
      ],
      // The Chrome source filter takes the apt root; everything else runs as is.
      sudo: [
        `if [ "$1" = python3 ]; then echo "sudo python3" >> ${log}; exec "$@" ${aptRoot}; fi`,
        `if [ "$1" = dpkg ]; then echo "sudo $*" >> ${log}; exit 0; fi`,
        'exec "$@"',
      ],
      dpkg: ['[ "$1" = --print-architecture ] && echo amd64'],
      ldd: [`cat ${dir}/ldd-output`],
      sleep: [`echo "sleep $*" >> ${log}`],
    };
    for (const [name, body] of Object.entries(scripts)) {
      await writeFile(join(binDir, name), ["#!/bin/bash", ...body, ""].join("\n"));
      await chmod(join(binDir, name), 0o755);
    }
    // Run the step's command exactly as the runner does.
    const action = Bun.YAML.parse(await readFile(playwrightActionPath, "utf8")) as {
      runs: { steps: Array<{ id?: string; run?: string }> };
    };
    const stepRun = String(action.runs.steps.find((step) => step.id === "install")?.run);
    const proc = Bun.spawn(
      [
        "bash",
        "--noprofile",
        "--norc",
        "-eo",
        "pipefail",
        "-c",
        options.noDebCache ? 'bash "${PLAYWRIGHT_ACTION_PATH}/install-browsers.sh"' : stepRun,
      ],
      {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          HOME: dir,
          GITHUB_OUTPUT: outputs,
          PLAYWRIGHT_BROWSERS: "chromium",
          PLAYWRIGHT_ONLY_SHELL: options.onlyShell ? "true" : "false",
          ATTEMPT_TIMEOUT_SECONDS: "360",
          ATTEMPTS: String(Math.max(1, options.install.length)),
          SYSTEM_DEPS_BUDGET_SECONDS: "300",
          KILL_AFTER_SECONDS: "15",
          PLAYWRIGHT_RUNNER_OS: options.os ?? "Linux",
          PLAYWRIGHT_ACTION_PATH: resolve(root, ".github/actions/playwright-browsers"),
          PLAYWRIGHT_APT_CONF_DIR: confDir,
          PLAYWRIGHT_APT_MIRRORS: mirrors,
          PLAYWRIGHT_BROWSERS_PATH: join(dir, "browsers"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    const calls = (await readFile(log, "utf8"))
      .replace(/(timeout \S+) \n?bun/gu, "$1 bun")
      .split("\n")
      .filter(Boolean)
      .map((call) => call.replace(/ +/gu, " ").trim());
    const aptConf = await readFile(join(confDir, "99playwright-browsers-network"), "utf8").catch(
      () => "",
    );
    return {
      exitCode,
      stdout,
      calls,
      aptConf,
      outputs: await readFile(outputs, "utf8"),
      debs: (await readdir(debDir).catch(() => [] as string[])).sort(),
      mirrors: await readFile(mirrors, "utf8"),
      sourcesList: await readFile(join(aptRoot, "sources.list"), "utf8"),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
