import { expect, test } from "bun:test";

// Radix caches DOM availability when first imported. Other tests deliberately
// import it for SSR, so exercise real dialog portals in a fresh module graph.
test("plugin dialog interactions preserve installation and authorization boundaries", async () => {
  const child = Bun.spawn({
    cmd: [process.execPath, "test", "./plugin-discovery.dom-fixture.tsx"],
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
