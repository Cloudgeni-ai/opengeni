import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
