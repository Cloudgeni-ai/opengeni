import { expect, test } from "bun:test";

// Load real router/editor/dialog portals after the DOM exists, independently of
// suites that import Radix for SSR or mock the shared confirmation primitive.
test("Skill navigation protects dirty edits before router history changes", async () => {
  const child = Bun.spawn({
    cmd: [process.execPath, "test", "./skills-panel-navigation.dom-fixture.tsx"],
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
}, 15_000);
