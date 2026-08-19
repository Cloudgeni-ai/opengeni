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
