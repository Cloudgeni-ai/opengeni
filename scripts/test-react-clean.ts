import { discoverTestFiles } from "./ci/workspace";
import { testConcurrencyBudget } from "./ci/resource-budget";
import { explicitBunTestPath } from "./ci/run-test-shard";
import { planUnitTestProcesses, runBoundedTestProcesses } from "./ci/run-unit-shard";

export function reactRuntimeWarnings(output: string): string[] {
  return output
    .split(/\r?\n/u)
    .filter(
      (line) =>
        /^An update to .* was not wrapped in act/u.test(line) ||
        /^The current testing environment is not configured to support act/u.test(line) ||
        /^(?:\[[^\]]+\]\s*)?Warning:/u.test(line) ||
        /^warning:/iu.test(line),
    );
}

export function reactCleanTestPlan(root: string) {
  const files = discoverTestFiles(root).unit.filter((path) => path.startsWith("packages/react/"));
  // Radix chooses its browser/server hooks once, at import time. DOM teardown
  // cannot undo a server hook cached by an earlier projection-only test file.
  // Match canonical unit isolation rather than weakening renderer assertions.
  return planUnitTestProcesses(root, [], files, 1);
}

async function runFile(path: string, innerConcurrency: number): Promise<number> {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "test",
      `--max-concurrency=${innerConcurrency}`,
      explicitBunTestPath(path),
    ],
    cwd: process.cwd(),
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  // Await the writes before exiting: process.exit immediately after large
  // process.stdout.write calls discarded the failing tail of the CI log.
  await Bun.write(Bun.stdout, stdout);
  await Bun.write(Bun.stderr, stderr);
  const warnings = reactRuntimeWarnings(`${stdout}\n${stderr}`);
  if (warnings.length > 0) {
    await Bun.write(
      Bun.stderr,
      `React tests emitted runtime warnings (${path}):\n${warnings.map((line) => `- ${line}`).join("\n")}\n`,
    );
  }
  if (exitCode !== 0) {
    await Bun.write(Bun.stderr, `React tests failed (${path}): exitCode=${exitCode}\n`);
  }
  return exitCode || (warnings.length > 0 ? 1 : 0);
}

async function main(): Promise<number> {
  const plan = reactCleanTestPlan(process.cwd());
  const budget = testConcurrencyBudget();
  const groups = [
    { tasks: plan.parallel, processes: budget.concurrency, inner: 1 },
    { tasks: plan.explicitConcurrency, processes: 1, inner: budget.concurrency },
    { tasks: plan.wallClockSensitive, processes: 1, inner: 1 },
    { tasks: plan.sharedPostgresExclusive, processes: 1, inner: 1 },
    { tasks: plan.clusterRoleSensitive, processes: 1, inner: 1 },
  ];
  const count = groups.reduce((total, group) => total + group.tasks.length, 0);
  if (count === 0) throw new Error("No React unit tests discovered");
  for (const group of groups) {
    const status = await runBoundedTestProcesses(group.tasks, group.processes, (task) =>
      runFile(task.files[0]!, group.inner),
    );
    if (status !== 0) return status;
  }
  await Bun.write(Bun.stdout, `React warning-free gate passed (${count} isolated files).\n`);
  return 0;
}

if (import.meta.main) process.exitCode = await main();
