import { expect, test } from "bun:test";
import { constants } from "node:fs";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { stopEndedManagedBrowserProcess } from "../src/runner";

// Real child processes stand in for a browser an ended session left running:
// the same executable and exact --user-data-dir switch a managed browser has.
async function withProfileProcesses(
  fn: (fixture: {
    profileDirectory: string;
    owned: Bun.Subprocess;
    unrelated: Bun.Subprocess;
    birth: (pid: number) => Promise<string>;
  }) => Promise<void>,
) {
  const root = await mkdtemp("/tmp/og-ended-stop-");
  const profileDirectory = join(root, "profile");
  const spawn = (profile: string) =>
    Bun.spawn(
      [process.execPath, "-e", "setInterval(() => {}, 60000)", `--user-data-dir=${profile}`],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
  const owned = spawn(profileDirectory);
  const unrelated = spawn(join(root, "unrelated-profile"));
  const birth = async (pid: number) => {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const startTime = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/u)[19];
    const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    return `${bootId}:${startTime}`;
  };
  try {
    await fn({ profileDirectory, owned, unrelated, birth });
  } finally {
    for (const child of [owned, unrelated]) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await child.exited;
    }
    await rm(root, { recursive: true, force: true });
  }
}

test.skipIf(process.platform !== "linux")(
  "an ended session's recorded browser is stopped by verified identity; others keep running",
  async () => {
    await withProfileProcesses(async ({ profileDirectory, owned, unrelated, birth }) => {
      await stopEndedManagedBrowserProcess(profileDirectory, {
        pid: owned.pid,
        birth: await birth(owned.pid),
        executablePath: process.execPath,
        profileDirectory,
        cdpEndpoint: "ws://127.0.0.1:12345/devtools/browser/11111111-1111-4111-8111-111111111111",
      });
      await owned.exited;
      expect(owned.signalCode).toBe("SIGTERM");
      expect(() => process.kill(unrelated.pid, 0)).not.toThrow();
    });
  },
  15_000,
);

test.skipIf(process.platform !== "linux")(
  "a reused PID (different birth) is never signalled",
  async () => {
    await withProfileProcesses(async ({ profileDirectory, owned }) => {
      await stopEndedManagedBrowserProcess(profileDirectory, {
        pid: owned.pid,
        birth: "00000000-0000-0000-0000-000000000000:1",
        executablePath: process.execPath,
        profileDirectory,
        cdpEndpoint: "ws://127.0.0.1:12345/devtools/browser/11111111-1111-4111-8111-111111111111",
      });
      expect(() => process.kill(owned.pid, 0)).not.toThrow();
      expect(owned.exitCode).toBeNull();
    });
  },
  15_000,
);

test("an ended session with no recorded or running browser has nothing to stop", async () => {
  const root = await mkdtemp("/tmp/og-ended-stop-");
  try {
    await expect(
      stopEndedManagedBrowserProcess(join(root, "profile"), null),
    ).resolves.toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function processBirth(pid: number): Promise<string> {
  if (process.platform === "linux") {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const startTime = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/u)[19];
    const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    return `${bootId}:${startTime}`;
  }
  return (
    await new Response(Bun.spawn(["/bin/ps", "-p", String(pid), "-o", "lstart="]).stdout).text()
  ).trim();
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// A real launcher process stands in for the agent-browser daemon: a copy of
// the bun executable under the given name starts a browser stand-in and, like
// a daemon, stays its parent and keeps running after the browser exits.
// (macOS refuses to run copies of its own system binaries such as /bin/sh.)
async function withLaunchedBrowser(
  launcherName: string,
  fn: (fixture: {
    profileDirectory: string;
    launcher: Bun.Subprocess;
    browserPid: number;
  }) => Promise<void>,
) {
  const root = await mkdtemp("/tmp/og-ended-daemon-");
  const profileDirectory = join(root, "profile");
  const launcherPath = join(root, launcherName);
  const browserPidFile = join(root, "browser.pid");
  await copyFile(process.execPath, launcherPath, constants.COPYFILE_FICLONE);
  const launcher = Bun.spawn(
    [
      launcherPath,
      "-e",
      [
        "const env = process.env;",
        'const browser = Bun.spawn([env.OG_BROWSER, "-e", "setInterval(() => {}, 60000)", `--user-data-dir=${env.OG_PROFILE}`], { stdio: ["ignore", "ignore", "ignore"] });',
        'require("node:fs").writeFileSync(env.OG_PID_FILE, String(browser.pid));',
        "setInterval(() => {}, 60000);",
      ].join("\n"),
    ],
    {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: {
        ...process.env,
        OG_BROWSER: process.execPath,
        OG_PROFILE: profileDirectory,
        OG_PID_FILE: browserPidFile,
      },
    },
  );
  let browserPid = 0;
  try {
    for (let attempt = 0; attempt < 100 && !browserPid; attempt++) {
      browserPid = Number((await readFile(browserPidFile, "utf8").catch(() => "")).trim());
      if (!browserPid) await Bun.sleep(20);
    }
    expect(browserPid).toBeGreaterThan(1);
    await fn({ profileDirectory, launcher, browserPid });
  } finally {
    if (browserPid && running(browserPid)) process.kill(browserPid, "SIGKILL");
    if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill("SIGKILL");
    await launcher.exited;
    await rm(root, { recursive: true, force: true });
  }
}

test.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
  "ending a lost session also stops the agent-browser daemon that launched its browser",
  async () => {
    await withLaunchedBrowser(
      "agent-browser",
      async ({ profileDirectory, launcher, browserPid }) => {
        await stopEndedManagedBrowserProcess(profileDirectory, {
          pid: browserPid,
          birth: await processBirth(browserPid),
          executablePath: process.execPath,
          profileDirectory,
          cdpEndpoint: "ws://127.0.0.1:12345/devtools/browser/11111111-1111-4111-8111-111111111111",
        });
        expect(running(browserPid)).toBe(false);
        await launcher.exited;
        expect(launcher.signalCode).toBe("SIGTERM");
      },
    );
  },
  15_000,
);

test.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
  "a browser's parent that is not an agent-browser daemon keeps running",
  async () => {
    await withLaunchedBrowser("launcher", async ({ profileDirectory, launcher, browserPid }) => {
      await stopEndedManagedBrowserProcess(profileDirectory, {
        pid: browserPid,
        birth: await processBirth(browserPid),
        executablePath: process.execPath,
        profileDirectory,
        cdpEndpoint: "ws://127.0.0.1:12345/devtools/browser/11111111-1111-4111-8111-111111111111",
      });
      expect(running(browserPid)).toBe(false);
      expect(running(launcher.pid)).toBe(true);
    });
  },
  15_000,
);
