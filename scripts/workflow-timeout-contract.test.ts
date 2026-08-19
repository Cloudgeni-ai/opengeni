import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";

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

type Step = Readonly<{ run?: string; uses?: string; "timeout-minutes"?: unknown }>;

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
          // Shell comments are prose, not budgets: a line that mentions
          // `timeout 3600` in passing must not be read as an hour of work.
          const run = String(step.run ?? "").replace(/(^|\s)#[^\n]*/gu, "$1");
          // Both `--flag N` and `--flag=N` spellings.
          for (const m of run.matchAll(/--timeout-seconds[\s=]+(\d+)/gu))
            inner += Number(m[1]) / 60;
          for (const m of run.matchAll(/--timeout[\s=]+(\d{5,})/gu)) inner += Number(m[1]) / 60_000;
          // A bare coreutils `timeout 3600 ...` bounds the step as much as a
          // test-runner flag does. Anchored to a command position - start of
          // line or after a shell separator - so prose inside an `echo` is not
          // read as a budget. Leading options are consumed explicitly: `-k` and
          // `-s` take a value, and a greedy `-\S+` would read the SIGKILL grace
          // as the duration. Suffixes follow coreutils: bare is seconds.
          const suffixMinutes: Record<string, number> = {
            "": 1 / 60,
            s: 1 / 60,
            m: 1,
            h: 60,
            d: 1440,
          };
          const bareTimeout =
            /(?:^|[;&|(])[^\S\n]*timeout\s+(?:(?:-[ks]\s*\S+|--kill-after=\S+|--signal=\S+|--preserve-status|--foreground|-v|--verbose)\s+)*(\d+(?:\.\d+)?)([smhd]?)(?![\w.])/gmu;
          for (const m of run.matchAll(bareTimeout)) {
            inner += Number(m[1]) * (suffixMinutes[m[2] ?? ""] ?? 1 / 60);
          }
          // A step-level timeout-minutes is an upper bound on that step and
          // must fit inside the job cap exactly like any other declared budget.
          const stepCap = step["timeout-minutes"];
          if (typeof stepCap === "number") inner += stepCap;
          // A budget that is only known at runtime cannot be checked
          // statically. Fail closed rather than silently counting it as zero.
          const expressionBudget =
            /--timeout(?:-seconds)?[\s=]+\$\{\{/u.test(run) ||
            /(?:^|[;&|(])[^\S\n]*timeout\s+\$\{\{/mu.test(run) ||
            (stepCap !== undefined && typeof stepCap !== "number");
          if (expressionBudget) {
            violations.push(
              `${file}:${name} declares an expression-valued timeout that cannot be verified statically`,
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
