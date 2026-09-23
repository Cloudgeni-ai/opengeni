import { expect, test } from "bun:test";

// Other suites mock dialog primitives or initialize Radix without a DOM.
// Keep the real Skills editor portals and governance checks in a fresh module graph.
test("Skills dialog interactions preserve editing and governance boundaries", async () => {
  const child = Bun.spawn({
    cmd: [process.execPath, "test", "./skills-panel.dom-fixture.tsx"],
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
