import { expect, test } from "bun:test";

// Radix caches DOM availability on import, so the DOM test runs in its own process.
test("a nested confirmation dialog submits only itself", async () => {
  const child = Bun.spawn({
    cmd: [process.execPath, "test", "./form-dialog-nested.dom-fixture.tsx"],
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
