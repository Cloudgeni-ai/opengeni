import { expect, test } from "bun:test";

// The page renders against a stand-in desktop bridge and module mocks, so it
// runs in a fresh process of its own.
test("Settings > Computer use: calm permissions with one action", async () => {
  const child = Bun.spawn({
    cmd: [process.execPath, "test", "./this-computer-settings.dom-fixture.tsx"],
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
}, 30_000);
