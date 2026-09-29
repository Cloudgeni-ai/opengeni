import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverTestFiles } from "./ci/workspace";
import { reactCleanTestPlan, reactRuntimeWarnings } from "./test-react-clean";

test("the warning gate runs every canonical React unit file in its own process", () => {
  const root = process.cwd();
  const plan = reactCleanTestPlan(root);
  const tasks = Object.values(plan).flat();
  expect(tasks.every((task) => task.files.length === 1 && task.isolated)).toBe(true);
  expect(tasks.flatMap((task) => task.files).sort()).toEqual(
    discoverTestFiles(root).unit.filter((path) => path.startsWith("packages/react/")),
  );
  expect(
    tasks.some((task) => task.files.includes("packages/react/test/timeline-renderers.test.tsx")),
  ).toBe(true);
  expect(
    tasks.some((task) => task.files.includes("packages/react/test/timeline-exchange-fold.test.ts")),
  ).toBe(true);
});

test("runtime warning detection retains all existing warning classes", () => {
  const warnings = [
    "An update to MessageTimeline was not wrapped in act(...).",
    "The current testing environment is not configured to support act(...)",
    "Warning: ordinary React warning",
    "[react] Warning: prefixed warning",
    "warning: runtime warning",
  ];
  expect(reactRuntimeWarnings(warnings.join("\r\n"))).toEqual(warnings);
  expect(reactRuntimeWarnings("(pass) warning detection test\n 2 pass\n 0 fail")).toEqual([]);
});

async function runFixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "opengeni-react-clean-"));
  try {
    const directory = join(root, "packages/react/test");
    await mkdir(directory, { recursive: true });
    for (const [name, source] of Object.entries(files)) {
      await writeFile(join(directory, name), source);
    }
    const child = Bun.spawn(
      [process.execPath, fileURLToPath(new URL("./test-react-clean.ts", import.meta.url))],
      { cwd: root, env: process.env, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("the real gate isolates process globals without omitting either file", async () => {
  const result = await runFixture({
    "a.test.ts": `import { test } from "bun:test";
      globalThis.reactCleanProbe = true;
      test("first file", () => {});`,
    "b.test.ts": `import { expect, test } from "bun:test";
      test("fresh global", () => expect(globalThis.reactCleanProbe).toBeUndefined());`,
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("passed (2 isolated files)");
  expect(result.stderr).toContain("first file");
  expect(result.stderr).toContain("fresh global");
});

test("a passing test that emits a warning still fails the real gate", async () => {
  const result = await runFixture({
    "warning.test.ts": `import { test } from "bun:test";
      test("warning", () => console.warn("Warning: warning-gate-sentinel"));`,
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("React tests emitted runtime warnings");
  expect(result.stderr).toContain("warning-gate-sentinel");
});

test("a failing test retains its diagnostic tail after large output", async () => {
  const result = await runFixture({
    "failure.test.ts": `import { expect, test } from "bun:test";
      test("failure-tail-sentinel", () => {
        console.error("x".repeat(128 * 1024));
        expect(1).toBe(2);
      });`,
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("(fail) failure-tail-sentinel");
  expect(result.stderr).toContain("1 fail");
  expect(result.stderr).toContain("React tests failed (packages/react/test/failure.test.ts)");
});
