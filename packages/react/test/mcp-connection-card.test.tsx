import { expect, test } from "bun:test";

// Radix caches DOM availability on import. Keep portal tests separate from
// server-rendering tests, matching the console's dialog regression harness.
test("connection dialogs preserve account ownership and completion", async () => {
  const child = Bun.spawn({
    cmd: [process.execPath, "test", "./mcp-connection-card.dom-fixture.tsx"],
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
