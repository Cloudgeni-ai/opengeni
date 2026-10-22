import { expect, test } from "bun:test";

test.skipIf(process.platform !== "linux")(
  "managed Chrome launches with stderr utilities installed outside FHS directories",
  async () => {
    // Isolate PATH and missing-FHS simulation from other runner tests.
    const child = Bun.spawn(
      [process.execPath, "-e", fixture, new URL("../src/runner.ts", import.meta.url).href],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]).finally(() => clearTimeout(timer));
    expect({ stdout: stdout.trim(), stderr: stderr.trim(), exit }).toEqual({
      stdout: "PATH utilities launched Chrome and drained stderr",
      stderr: "",
      exit: 0,
    });
  },
  15_000,
);

const fixture = `
import { mock } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
const original = { ...fs };
const root = await original.mkdtemp("/tmp/og-platform-tools-");
const bin = join(root, "non-fhs-bin");
await original.mkdir(bin);
for (const name of ["mkfifo", "tail"]) {
  const installed = Bun.which(name);
  assert.ok(installed, name + " must be installed for the fixture");
  await original.symlink(installed, join(bin, name));
}
process.env.PATH = bin + ":" + process.env.PATH;
mock.module("node:fs/promises", () => ({
  ...original,
  access: async (path, ...args) => {
    if (/^\\/(usr\\/)?bin\\/(mkfifo|tail)$/.test(String(path))) {
      throw Object.assign(new Error("FHS utility absent"), { code: "ENOENT" });
    }
    return original.access(path, ...args);
  },
}));
const { ManagedBrowserRunner } = await import(process.argv[1]);
const browserPath = join(root, "chrome");
const browserScript = [
  "#!/bin/sh",
  'for a; do case "$a" in --user-data-dir=*) p=\${a#--user-data-dir=};; esac; done',
  'printf "stderr drained\\\\n" >&2',
  'echo $$ > "$p/../fixture.pid"',
  "printf '45678\\\\n/devtools/browser/11111111-1111-4111-8111-111111111111\\\\n' > \\"$p/DevToolsActivePort\\"",
  "exec sleep 30",
  "",
].join("\\n");
await original.writeFile(browserPath, browserScript, { mode: 0o700 });
let runner;
let browserPid = 0;
try {
  runner = await ManagedBrowserRunner.create({ profileDirectory: join(root, "profile"),
    headed: true, browserExecutablePath: browserPath, systemdScope: false, networkIsolation: false,
  });
  const launch = join(root, "chrome-launch");
  const wrapper = (await original.readdir(launch)).find((name) => name.endsWith(".sh"));
  assert.ok((await original.readFile(join(launch, wrapper), "utf8")).includes(join(bin, "tail")));
  await runner.run(["get", "cdp-url"], { timeoutMs: 3_000 });
  browserPid = Number((await original.readFile(join(root, "fixture.pid"), "utf8")).trim());
  // The reader keeps the browser's last stderr bytes once it closes stderr.
  process.kill(browserPid, "SIGKILL");
  const log = join(root, "chrome-launch", "chrome-stderr.log");
  let content = "";
  for (let attempt = 0; attempt < 50; attempt++) {
    content = await original.readFile(log, "utf8");
    if (content === "stderr drained\\n") break;
    await Bun.sleep(10);
  }
  assert.equal(content, "stderr drained\\n");
  console.log("PATH utilities launched Chrome and drained stderr");
} finally {
  if (browserPid) try { process.kill(browserPid, "SIGKILL"); } catch {}
  if (runner) await runner.terminate();
  await original.rm(root, { recursive: true, force: true });
}
`;
