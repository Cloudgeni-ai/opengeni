import { expect, test } from "bun:test";

// Isolate PATH mutations from other tests. Runner creation builds the wrapper
// without starting Chrome.
for (const selection of ["gnu", "generic", "non-executable-gnu", "absolute"]) {
  test.skipIf(process.platform !== "linux")(
    "managed Chrome stderr tail selection: " + selection,
    async () => {
      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          selectionFixture,
          new URL("../src/runner.ts", import.meta.url).href,
          selection,
        ],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      );
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]).finally(() => clearTimeout(timer));
      expect({ stdout: stdout.trim(), stderr: stderr.trim(), exit }).toEqual({
        stdout: "selected expected tail",
        stderr: "",
        exit: 0,
      });
    },
    15_000,
  );
}

const selectionFixture = String.raw`
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
const { ManagedBrowserRunner } = await import(process.argv[1]);
const selection = process.argv[2];
const root = await mkdtemp("/tmp/og-tail-selection-");
let runner;
try {
  const early = join(root, "early");
  const late = join(root, "late");
  await mkdir(early);
  await mkdir(late);
  const browser = join(root, "chrome");
  await writeFile(browser, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  let expected = "/usr/bin/tail";
  if (selection !== "absolute") {
    expected = join(early, "tail");
    await writeFile(expected, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  }
  if (selection === "gnu" || selection === "non-executable-gnu") {
    const gnu = join(late, "gnutail");
    await writeFile(gnu, "#!/bin/sh\nexit 0\n", {
      mode: selection === "gnu" ? 0o700 : 0o600,
    });
    if (selection === "gnu") expected = gnu;
  }
  process.env.PATH = [early, late].join(":");
  runner = await ManagedBrowserRunner.create({
    profileDirectory: join(root, "profile"), headed: true,
    browserExecutablePath: browser, systemdScope: false, networkIsolation: false,
  });
  const launch = join(root, "chrome-launch");
  const wrapper = (await readdir(launch)).find((name) => name.endsWith(".sh"));
  assert.ok(wrapper);
  const script = await readFile(join(launch, wrapper), "utf8");
  assert.ok(script.includes("'" + expected + "' -c 65536 "), script);
  console.log("selected expected tail");
} finally {
  if (runner) await runner.terminate();
  await rm(root, { recursive: true, force: true });
}
`;
