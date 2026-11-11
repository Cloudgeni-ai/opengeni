import { expect, test } from "bun:test";
test("retained artifact link, playback and fallback flows", async () => {
  const child = Bun.spawn({
    cmd: [process.execPath, "test", "./retained-file-preview.dom-fixture.tsx"],
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code, `${stdout}\n${stderr}`).toBe(0);
}, 15_000);
