import { expect, test } from "bun:test";

// The fixture replaces AppContext; isolate its module graph from other web tests.
test("retained chat image loading, geometry, and thumbnail contracts", async () => {
  const child = Bun.spawn({
    cmd: [process.execPath, "test", "./inline-chat-image.dom-fixture.tsx"],
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
