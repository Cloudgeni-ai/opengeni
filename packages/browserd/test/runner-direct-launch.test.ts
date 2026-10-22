import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, copyFile, link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AgentBrowserCommandError,
  inspectOwnedManagedBrowserProcess,
  ManagedBrowserRunner,
  type ManagedBrowserRunnerOptions,
} from "../src/runner";

const native = process.platform === "linux" || process.platform === "darwin";

/** A stand-in for Chrome: a single executable that accepts Chrome's command
 * line, records it, takes the profile lock and writes DevToolsActivePort as
 * Chrome does for `--remote-debugging-port=0`. A `crash` file next to the
 * profile makes it fail on stderr before it writes the port file. */
const SYNTHETIC_BROWSER = `
import { existsSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("Synthetic Browser"); process.exit(0); }
const profile = args.find((a) => a.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length);
if (!profile) process.exit(2);
writeFileSync(join(dirname(profile), "argv.json"), JSON.stringify(args));
if (existsSync(join(dirname(profile), "crash"))) {
  console.error("synthetic browser: Missing X server or $DISPLAY");
  process.exit(7);
}
symlinkSync("synthetic-host-" + process.pid, join(profile, "SingletonLock"));
writeFileSync(join(profile, ".port"), "45678\\n/devtools/browser/" + crypto.randomUUID() + "\\n");
renameSync(join(profile, ".port"), join(profile, "DevToolsActivePort"));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 60_000);
`;

let root = "";
let browserExecutable = "";

beforeAll(async () => {
  if (!native) return;
  root = await mkdtemp("/tmp/og-direct-launch-");
  const source = join(root, "synthetic-browser.ts");
  browserExecutable = join(root, "synthetic-browser");
  await writeFile(source, SYNTHETIC_BROWSER);
  const build = Bun.spawn(
    [process.execPath, "build", "--compile", source, "--outfile", browserExecutable],
    { stdout: "ignore", stderr: "pipe" },
  );
  const [exitCode, stderr] = await Promise.all([build.exited, new Response(build.stderr).text()]);
  if (exitCode !== 0) throw new Error(`synthetic browser build failed: ${stderr}`);
}, 60_000);

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

async function session(name: string) {
  const directory = join(root, name);
  await mkdir(directory, { mode: 0o700 });
  const options: ManagedBrowserRunnerOptions = {
    profileDirectory: join(directory, "profile"),
    headed: false,
    browserExecutablePath: browserExecutable,
    systemdScope: false,
    networkIsolation: false,
  };
  return { directory, options };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform !== "linux") return true;
  try {
    const stat = require("node:fs").readFileSync(`/proc/${pid}/stat`, "utf8") as string;
    return stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z";
  } catch {
    return false;
  }
}

async function waitUntilGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 250 && alive(pid); attempt++) await Bun.sleep(20);
  expect(alive(pid)).toBe(false);
}

test.skipIf(!native)(
  "the controller launches the browser itself, with no launcher process and no automation switches",
  async () => {
    const { directory, options } = await session("launch");
    const runner = await ManagedBrowserRunner.create(options);
    try {
      const { cdpUrl } = await runner.run<{ cdpUrl: string }>(["get", "cdp-url"]);
      expect(cdpUrl).toMatch(/^ws:\/\/127\.0\.0\.1:45678\/devtools\/browser\/[0-9a-f-]{36}$/u);
      // The same browser answers again without a second launch.
      expect((await runner.run<{ cdpUrl: string }>(["get", "cdp-url"])).cdpUrl).toBe(cdpUrl);

      const pid = Number((await readFile(join(directory, "browser.pid"), "utf8")).trim());
      expect(pid).toBeGreaterThan(1);
      const receipt = await runner.ownedProcessIdentity(cdpUrl, pid);
      expect(receipt?.pid).toBe(pid);
      expect(await inspectOwnedManagedBrowserProcess(receipt!)).toBe("live");
      // A CDP browser process other than the one launched is never adopted.
      await expect(runner.ownedProcessIdentity(cdpUrl, pid + 1)).rejects.toThrow(
        "lineage is unproven",
      );

      const argv = JSON.parse(await readFile(join(directory, "argv.json"), "utf8")) as string[];
      expect(argv).toContain("--remote-debugging-port=0");
      expect(argv).toContain(`--user-data-dir=${options.profileDirectory}`);
      expect(argv).toContain("--headless=new");
      for (const tell of ["--disable-popup-blocking", "--hide-scrollbars", "--enable-automation"])
        expect(argv).not.toContain(tell);

      await expect(runner.run(["click", "@e1"])).rejects.toThrow("only its CDP transport");
      await runner.terminate();
      await waitUntilGone(pid);
    } finally {
      await runner.terminate().catch(() => undefined);
    }
  },
  30_000,
);

test.skipIf(!native)(
  "a browser that dies during launch reports the browser's own stderr",
  async () => {
    const { directory, options } = await session("crash");
    await writeFile(join(directory, "crash"), "");
    const runner = await ManagedBrowserRunner.create(options);
    try {
      const failure = await runner.run(["get", "cdp-url"]).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(AgentBrowserCommandError);
      expect((failure as AgentBrowserCommandError).code).toBe("driver_rejected");
      expect((failure as AgentBrowserCommandError).driverMessage).toContain(
        "Missing X server or $DISPLAY",
      );
    } finally {
      await runner.terminate().catch(() => undefined);
    }
  },
  30_000,
);

test.skipIf(!native)(
  "a replacement controller reattaches a live browser from its receipt and retires it, repeatably",
  async () => {
    const { options } = await session("reattach");
    const first = await ManagedBrowserRunner.create(options);
    let pid = 0;
    try {
      const { cdpUrl } = await first.run<{ cdpUrl: string }>(["get", "cdp-url"]);
      const receipt = (await first.ownedProcessIdentity(cdpUrl))!;
      pid = receipt.pid;
      const second = await ManagedBrowserRunner.create({
        ...options,
        recoverOwnedProcess: receipt,
      });
      expect(second.reattachedOwnedProcess).toEqual(receipt);
      expect((await second.run<{ cdpUrl: string }>(["get", "cdp-url"])).cdpUrl).toBe(cdpUrl);
      expect(await second.ownedProcessIdentity(cdpUrl)).toEqual(receipt);
      await second.terminate();
      await waitUntilGone(pid);
      await second.terminate();
      await expect(second.run(["get", "cdp-url"])).rejects.toThrow();
    } finally {
      if (pid && alive(pid)) process.kill(pid, "SIGKILL");
      await first.terminate().catch(() => undefined);
    }
  },
  30_000,
);

test.skipIf(!native)(
  "a browser an earlier release started through agent-browser is retired together with its launcher",
  async () => {
    const { directory, options } = await session("legacy");
    await mkdir(options.profileDirectory, { mode: 0o700 });
    // A legacy launcher is recognized by its executable name.
    const launcherExecutable = join(directory, "agent-browser");
    await link(process.execPath, launcherExecutable).catch(
      async () => await copyFile(process.execPath, launcherExecutable),
    );
    await chmod(launcherExecutable, 0o700);
    const { BUN_FEATURE_FLAG_NO_ORPHANS: _noOrphans, ...launcherEnvironment } = process.env;
    const launcher = Bun.spawn(
      [
        launcherExecutable,
        "--no-env-file",
        "-e",
        `const b = require("node:child_process").spawn(${JSON.stringify(browserExecutable)}, [${JSON.stringify(`--user-data-dir=${options.profileDirectory}`)}], { stdio: "ignore" }); console.log(b.pid); setInterval(() => {}, 60000);`,
      ],
      { env: launcherEnvironment, stdout: "pipe", stderr: "ignore" },
    );
    let browserPid = 0;
    try {
      const reader = launcher.stdout.getReader();
      browserPid = Number(new TextDecoder().decode((await reader.read()).value).trim());
      reader.releaseLock();
      const port = join(options.profileDirectory, "DevToolsActivePort");
      for (let attempt = 0; attempt < 250; attempt++) {
        if (await Bun.file(port).exists()) break;
        await Bun.sleep(20);
      }
      const [portNumber, path] = (await readFile(port, "utf8")).trim().split("\n");
      const cdpUrl = `ws://127.0.0.1:${portNumber}${path}`;
      await writeFile(join(directory, "browser.pid"), `${browserPid}\n`);
      const discovering = await ManagedBrowserRunner.create(options);
      const receipt = (await discovering.ownedProcessIdentity(cdpUrl))!;
      expect(receipt.pid).toBe(browserPid);

      const recovered = await ManagedBrowserRunner.create({
        ...options,
        recoverOwnedProcess: receipt,
      });
      await recovered.terminate();
      await waitUntilGone(browserPid);
      await launcher.exited;
    } finally {
      if (browserPid && alive(browserPid)) process.kill(browserPid, "SIGKILL");
      if (launcher.exitCode === null) launcher.kill("SIGKILL");
      await launcher.exited;
    }
  },
  30_000,
);
