import { expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, "../../..");
const fixture = "./apps/worker/test/fixtures/workspace-capture-activity.fixture.ts";
const storageFailureFixture =
  "./apps/worker/test/fixtures/workspace-capture-storage-failure.fixture.ts";

test("persistent workspace churn commits a newer degraded revision", async () => {
  // The fixture replaces module exports before importing the activity. Run it
  // in a child process so Bun's process-global mock.module registry cannot
  // replace SandboxChannelAService in unrelated test files.
  const child = Bun.spawn([process.execPath, "test", fixture], {
    cwd: repositoryRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
});

test("storage and tree boundary failures commit newer degraded revisions", async () => {
  const child = Bun.spawn([process.execPath, "test", storageFailureFixture], {
    cwd: repositoryRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
});
