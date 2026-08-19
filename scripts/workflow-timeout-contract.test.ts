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

/**
 * Remove shell comments while preserving a `#` that sits inside a quoted
 * string. A regex cannot do this: blanking everything after a whitespace-
 * preceded `#` also deletes real budgets on lines like
 * `echo "fixes #42" && bun x t --timeout-seconds 6000`, which would make the
 * guard blind to a spelling it currently catches.
 */
function stripShellComments(source: string): string {
  let out = "";
  let quote: string | null = null;
  let atCommandBoundary = true;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i] as string;
    if (ch === "\n") {
      quote = null;
      atCommandBoundary = true;
      out += ch;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) quote = null;
      out += ch;
      atCommandBoundary = false;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      atCommandBoundary = false;
      continue;
    }
    if (ch === "#" && atCommandBoundary) {
      while (i < source.length && source[i] !== "\n") i += 1;
      i -= 1;
      continue;
    }
    out += ch;
    atCommandBoundary = /[\s;&|(]/u.test(ch);
  }
  return out;
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
          // Distinguishing a real budget from prose needs quote awareness, not
          // a tighter anchor. Two sanitised views are used:
          //
          //  - `commentless` removes only a `#` that genuinely starts a shell
          //    comment. A naive /(^|\s)#.*/ also blanks the rest of a line
          //    after a quoted `#`, which silently deletes real budgets:
          //    `echo "fixes #42" && bun x t --timeout-seconds 6000`.
          //  - `unquoted` additionally blanks quoted spans, so prose inside an
          //    `echo` is not read as a command. Flag-form budgets are matched
          //    on `commentless` so a genuine `bash -c "... --timeout-seconds N"`
          //    still counts.
          const commentless = stripShellComments(String(step.run ?? ""));
          const unquoted = commentless.replace(/'[^']*'|"[^"]*"/gu, (m) => " ".repeat(m.length));
          // Both `--flag N` and `--flag=N` spellings.
          for (const m of commentless.matchAll(/--timeout-seconds[\s=]+(\d+)/gu))
            inner += Number(m[1]) / 60;
          for (const m of commentless.matchAll(/--timeout[\s=]+(\d{5,})/gu))
            inner += Number(m[1]) / 60_000;
          // A bare coreutils `timeout 3600 ...` bounds the step as much as a
          // test-runner flag does. The anchor stays permissive so command
          // positions like `; do timeout ...`, `sudo timeout ...` and
          // `env FOO=bar timeout ...` are still seen - a retry loop is the most
          // common way CI bounds a command. Leading options are consumed
          // explicitly: `-k` and `-s` take a value, and a greedy `-\S+` would
          // read the SIGKILL grace as the duration. Suffixes follow coreutils,
          // where a bare number means seconds.
          const suffixMinutes: Record<string, number> = {
            "": 1 / 60,
            s: 1 / 60,
            m: 1,
            h: 60,
            d: 1440,
          };
          const bareTimeout =
            /(?:^|[\s;&|(])timeout\s+(?:(?:-[ks]\s*\S+|--kill-after[=\s]\S+|--signal[=\s]\S+|--preserve-status|--foreground|-v|--verbose)\s+)*(\d+(?:\.\d+)?)([smhd]?)(?![\w.])/gmu;
          for (const m of unquoted.matchAll(bareTimeout)) {
            inner += Number(m[1]) * (suffixMinutes[m[2] ?? ""] ?? 1 / 60);
          }
          // A step-level timeout-minutes is an upper bound on that step and
          // must fit inside the job cap exactly like any other declared budget.
          const stepCap = step["timeout-minutes"];
          if (typeof stepCap === "number") inner += stepCap;
          // A budget that is only known at runtime cannot be checked
          // statically. Fail closed rather than silently counting it as zero.
          const expressionBudget =
            /--timeout(?:-seconds)?[\s=]+\$\{\{/u.test(commentless) ||
            /(?:^|[\s;&|(])timeout\s+\$\{\{/mu.test(unquoted) ||
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
