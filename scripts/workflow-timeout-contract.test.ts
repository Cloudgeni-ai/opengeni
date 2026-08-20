import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";

import { analyzeShellTimeoutBudget, analyzeStepTimeoutBudget } from "./workflow-timeout-budget";

const root = resolve(import.meta.dir, "..");
const workflowDir = resolve(root, ".github/workflows");

// GitHub's default job timeout is 360 minutes. A job that wedges - the observed
// case is an unbounded `playwright install` whose download stalls - therefore
// holds a runner slot for six hours. Because GitHub-hosted concurrency is an
// account-level pool, a handful of wedged jobs stop every other pull request in
// the repository from being dispatched at all. Every job must bound itself so a
// hang degrades to one visible, re-runnable failure instead of a repo outage.
const MAX_TIMEOUT_MINUTES = 120;

type Job = Readonly<{
  uses?: string;
  "timeout-minutes"?: number;
}>;

type Step = Readonly<{
  run?: string;
  uses?: string;
  shell?: string;
  "timeout-minutes"?: unknown;
}>;

async function workflowFiles(): Promise<readonly string[]> {
  const entries = await readdir(workflowDir);
  return entries.filter((entry) => entry.endsWith(".yml") || entry.endsWith(".yaml")).sort();
}

describe("workflow timeout contract", () => {
  test("every job bounds itself well below the 360-minute GitHub default", async () => {
    const files = await workflowFiles();
    expect(files.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of files) {
      const parsed = Bun.YAML.parse(await readFile(resolve(workflowDir, file), "utf8")) as {
        jobs?: Record<string, Job>;
      };
      for (const [name, job] of Object.entries(parsed.jobs ?? {})) {
        // A reusable-workflow call cannot carry timeout-minutes; the called
        // workflow's own jobs are covered by this same test.
        if (job?.uses) continue;
        const timeout = job?.["timeout-minutes"];
        if (typeof timeout !== "number") {
          violations.push(`${file}:${name} has no timeout-minutes`);
          continue;
        }
        if (timeout <= 0 || timeout > MAX_TIMEOUT_MINUTES) {
          violations.push(
            `${file}:${name} has timeout-minutes ${timeout}, outside 1..${MAX_TIMEOUT_MINUTES}`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("every Playwright install is bounded and cached through the shared action", async () => {
    const files = await workflowFiles();
    const inlineInstalls: string[] = [];
    for (const file of files) {
      const source = await readFile(resolve(workflowDir, file), "utf8");
      if (source.includes("playwright install")) {
        inlineInstalls.push(file);
      }
    }
    // An inline `playwright install` is unbounded: it has no per-attempt wall
    // clock and no browser cache, which is exactly the wedge this guards.
    expect(inlineInstalls).toEqual([]);

    const action = await readFile(
      resolve(root, ".github/actions/playwright-browsers/action.yml"),
      "utf8",
    );
    expect(action).toContain("timeout --kill-after=15s");
    expect(action).toContain("path: ~/.cache/ms-playwright");
    // `--with-deps` was previously locked by the four inline call sites. Moving
    // the command into one shared place removed that lock, so re-assert it here.
    expect(action).toContain("playwright install --with-deps");
    // actions/cache's post step is `post-if: success()`, so the combined action
    // never saves after a bounded failure and a cold key on a degraded network
    // can never converge. The split restore/save with always() is what makes a
    // timed-out install genuinely re-runnable.
    expect(action).toContain("actions/cache/restore@");
    expect(action).toContain("actions/cache/save@");
    // Cache entries are immutable, so a __dirlock baked in by a SIGKILLed
    // install is permanent for that key. Cheap to drop, impossible to undo.
    expect(action).toContain("rm -rf ~/.cache/ms-playwright/__dirlock");
    expect(action).toMatch(
      /if: \$\{\{ always\(\) && steps\.restore\.outputs\.cache-hit != 'true' \}\}/u,
    );
  });

  // A job cap below the job's own declared step budgets is worse than no cap:
  // the job is CANCELLED rather than failed, and `if: failure()` artifact
  // uploads do not run on cancellation, so the diagnostics that explain the
  // hang are destroyed exactly when they are needed.
  test("no job cap sits below its own declared inner step budgets", async () => {
    const installBoundMinutes = await (async () => {
      const action = Bun.YAML.parse(
        await readFile(resolve(root, ".github/actions/playwright-browsers/action.yml"), "utf8"),
      ) as { inputs: Record<string, { default?: string }> };
      const perAttempt = Number(action.inputs["attempt-timeout-seconds"]?.default);
      const attempts = Number(action.inputs.attempts?.default);
      expect(Number.isFinite(perAttempt) && Number.isFinite(attempts)).toBe(true);
      // 15s is the SIGKILL grace in `timeout --kill-after=15s`.
      return ((perAttempt + 15) * attempts) / 60;
    })();

    const violations: string[] = [];
    for (const file of await workflowFiles()) {
      const parsed = Bun.YAML.parse(await readFile(resolve(workflowDir, file), "utf8")) as {
        jobs?: Record<
          string,
          { uses?: string; "timeout-minutes"?: number; steps?: readonly Step[] }
        >;
      };
      for (const [name, job] of Object.entries(parsed.jobs ?? {})) {
        if (job?.uses) continue;
        const cap = job?.["timeout-minutes"];
        if (typeof cap !== "number") continue;
        let inner = 0;
        let usesBoundedInstall = false;
        for (const step of job.steps ?? []) {
          const budget = analyzeStepTimeoutBudget(step);
          inner += budget.minutes;
          for (const reason of budget.uncertainties) {
            violations.push(
              `${file}:${name} declares a timeout that cannot be verified: ${reason}`,
            );
          }
          if (String(step.uses ?? "").includes("playwright-browsers")) usesBoundedInstall = true;
        }
        // A job using the bounded install must be checked even with no declared
        // inner budget, or a browser lane with a small cap and no test budget is
        // endorsed despite being guaranteed to cancel mid-install.
        if (inner === 0 && !usesBoundedInstall) continue;
        // 1 minute covers checkout + toolchain + dependency install.
        const needed = 1 + inner + (usesBoundedInstall ? installBoundMinutes : 0);
        if (cap < needed) {
          violations.push(
            `${file}:${name} cap ${cap}m is below its own budgets (${needed.toFixed(1)}m needed)`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("shell budget analysis is quote-aware, conservative, and amplification-aware", () => {
    const exactCases: ReadonlyArray<Readonly<{ name: string; source: string; minutes: number }>> = [
      { name: "bare seconds", source: "timeout 3600 bun run slow", minutes: 60 },
      { name: "quoted duration", source: 'timeout "2h" bun run slow', minutes: 120 },
      {
        name: "kill grace",
        source: "timeout --signal TERM --kill-after=15m 2h bun run slow",
        minutes: 135,
      },
      {
        name: "equals-form kill grace",
        source: "timeout -k15s 1h bun run slow",
        minutes: 60.25,
      },
      {
        name: "flag equals form",
        source: "bun run check --timeout-seconds=1800",
        minutes: 30,
      },
      {
        name: "static quoted shell",
        source: `bash -c 'bun run check --timeout-seconds 1800'`,
        minutes: 30,
      },
      {
        name: "bundled shell options",
        source: `/bin/bash -lc 'timeout 30m bun run slow'`,
        minutes: 30,
      },
      {
        name: "static for amplification",
        source: "for attempt in 1 2 3; do timeout 10m bun run slow; done",
        minutes: 30,
      },
      {
        name: "static retry amplification",
        source: "retry --attempts 3 timeout 10m bun run slow",
        minutes: 30,
      },
      {
        name: "equals-form retry amplification",
        source: "retry --attempts=3 timeout 10m bun run slow",
        minutes: 30,
      },
      {
        name: "mutually exclusive branch ceiling",
        source: "if ready; then timeout 10m fast; else timeout 20m slow; fi",
        minutes: 20,
      },
      {
        name: "subshell budget",
        source: "(timeout 10m bun run slow)",
        minutes: 10,
      },
      {
        name: "nested timeout uses outer ceiling",
        source: `timeout 10m bash -c 'timeout 5m bun run slow'`,
        minutes: 10,
      },
      {
        name: "pipeline uses concurrent ceiling",
        source: "timeout 10m producer | timeout 5m consumer",
        minutes: 10,
      },
      {
        name: "escaped quote and real trailing command",
        source: String.raw`echo "fixes \"#42\" and says timeout 9h" && timeout 1h bun run slow # timeout 1d ignored`,
        minutes: 60,
      },
      {
        name: "heredoc prose",
        source: "cat <<'EOF'\ntimeout 9h is documentation\nEOF\ntimeout 30m bun run slow",
        minutes: 30,
      },
      {
        name: "quoted heredoc marker is prose",
        source: "echo '<<EOF'\ntimeout 30m bun run slow",
        minutes: 30,
      },
    ];
    for (const fixture of exactCases) {
      const result = analyzeShellTimeoutBudget(fixture.source);
      expect(result.uncertainties, fixture.name).toEqual([]);
      expect(result.minutes, fixture.name).toBeCloseTo(fixture.minutes, 8);
    }

    for (const fixture of [
      { name: "echo prose", source: `echo "timeout 9h --timeout-seconds 9999"` },
      { name: "printf prose", source: `printf '%s\\n' 'timeout 9h'` },
      { name: "comment prose", source: "# timeout 9h\necho done" },
    ]) {
      const result = analyzeShellTimeoutBudget(fixture.source);
      expect(result, fixture.name).toEqual({ minutes: 0, uncertainties: [] });
    }
  });

  test("shell budget analysis fails closed on every dynamic or unsupported shape", () => {
    const cases = [
      { name: "bare expression", source: "timeout ${{ env.BUDGET }} bun run slow" },
      { name: "quoted expression", source: 'timeout "${{ env.BUDGET }}" bun run slow' },
      {
        name: "quoted flag expression",
        source: 'bun run check --timeout-seconds="${{ env.BUDGET }}"',
      },
      { name: "dynamic kill grace", source: 'timeout -k "$GRACE" 1h bun run slow' },
      { name: "unknown option", source: "timeout --future-option 1h bun run slow" },
      { name: "non-decimal flag value", source: "bun test --timeout 0x100" },
      {
        name: "unbounded loop amplification",
        source: "while should_retry; do timeout 10m bun run slow; done",
      },
      {
        name: "dynamic for amplification",
        source: "for attempt in $ATTEMPTS; do timeout 10m bun run slow; done",
      },
      {
        name: "glob-expanded for amplification",
        source: "for attempt in attempt-*; do timeout 10m bun run slow; done",
      },
      {
        name: "ambiguous retry count",
        source: "retry --retries 3 timeout 10m bun run slow",
      },
      {
        name: "unsupported case branches",
        source: "case $MODE in fast) timeout 10m fast ;; *) timeout 20m slow ;; esac",
      },
      {
        name: "function call amplification",
        source: "attempt() { timeout 10m bun run slow; }; attempt; attempt",
      },
      { name: "unknown wrapper amplification", source: "repeat-command timeout 10m bun run slow" },
      { name: "dynamic shell", source: 'bash -c "$TIMEOUT_COMMAND"' },
      { name: "single-quoted Actions shell expression", source: "bash -lc '${{ env.CMD }}'" },
      { name: "unterminated heredoc", source: "cat <<EOF\ntimeout 10m is data" },
    ];
    for (const fixture of cases) {
      const result = analyzeShellTimeoutBudget(fixture.source);
      expect(result.uncertainties.length, fixture.name).toBeGreaterThan(0);
    }
  });

  test("a numeric step ceiling replaces nested command budgets without double counting", () => {
    expect(
      analyzeStepTimeoutBudget({
        "timeout-minutes": 12,
        run: `timeout 10m bash -c 'timeout 5m bun run slow'`,
      }),
    ).toEqual({ minutes: 12, uncertainties: [] });
    expect(
      analyzeStepTimeoutBudget({
        "timeout-minutes": "${{ env.BUDGET }}",
        run: "timeout 10m bun run slow",
      }).uncertainties.length,
    ).toBeGreaterThan(0);
  });

  // The runner executes `shell: bash` steps as
  // `bash --noprofile --norc -eo pipefail {0}`. That errexit is applied by the
  // runner and is NOT cleared by a `set -uo pipefail` inside the script, so a
  // retry loop written without an explicit guard silently becomes one attempt
  // with no diagnostic output. Assert the real behaviour by running the real
  // script under the real shell rather than trusting a plain `bash script.sh`.
  test("the install retry loop survives the runner's errexit shell", async () => {
    const action = Bun.YAML.parse(
      await readFile(resolve(root, ".github/actions/playwright-browsers/action.yml"), "utf8"),
    ) as { runs: { steps: readonly { name?: string; run?: string }[] } };
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
      // `timeout` is GNU-only; stub it so this test runs on any host. The stub
      // drops the flags and duration, then execs the command.
      const timeoutStub = [
        "#!/bin/bash",
        'while [[ "$1" == --* ]]; do shift; done',
        "shift",
        '"$@"',
        "",
      ].join("\n");
      await writeFile(join(binDir, "timeout"), timeoutStub);
      // Fail every attempt with 124, the exit code GNU timeout uses on expiry.
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
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(1);

      // Both attempts must actually run.
      expect((await readFile(join(dir, "n"), "utf8")).trim()).toBe("2");
      // And the operator must be told what the bound was, not just "exit 124".
      expect(stdout).toContain("attempt 1/2");
      expect(stdout).toContain("attempt 2/2");
      expect(stdout).toContain("exceeded 360s and was killed");
      expect(stdout).toContain("::error::");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
