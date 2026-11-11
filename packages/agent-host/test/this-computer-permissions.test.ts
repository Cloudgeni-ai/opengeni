import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ThisComputer, type ThisComputerDeps } from "../src/this-computer";

/** A stand-in agent that records every command it is given. */
async function fakeComputer(state?: object) {
  const dir = await mkdtemp(join(tmpdir(), "og-this-computer-"));
  if (state) await writeFile(join(dir, "this-computer.json"), JSON.stringify(state));
  const agentPath = join(dir, "agent");
  const calls = join(dir, "calls.log");
  await writeFile(agentPath, `#!/bin/sh\necho "$*" >> "${calls}"\necho '{}'\n`);
  await chmod(agentPath, 0o755);
  const opened: string[] = [];
  const deps = {
    platform: "darwin",
    arch: "arm64",
    home: dir,
    env: {},
    agentSigningKey: "",
    fetch: () => Promise.reject(new Error("offline")),
    dataDir: dir,
    logDir: dir,
    agentPath,
    mintEnrollToken: () => Promise.reject(new Error("unused")),
    allowAgents: () => Promise.resolve(),
    openSystemSettings: (url: string) => opened.push(url),
    trash: () => Promise.resolve(),
    onChange: () => undefined,
  } as unknown as ThisComputerDeps;
  const computer = new ThisComputer(deps);
  const requests = async () =>
    (await readFile(calls, "utf8").catch(() => ""))
      .split("\n")
      .filter((line) => line.startsWith("permissions --request"));
  return {
    dir,
    computer,
    opened,
    requests,
    done: async () => {
      await computer.shutdown();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describe("asking macOS for a screen-control permission", () => {
  test("asks the system first, then also opens System Settings when asked again", async () => {
    const { computer, opened, requests, done } = await fakeComputer();
    try {
      await computer.requestPermission("screenRecording");
      expect(await requests()).toEqual(["permissions --request screen-recording"]);
      expect(opened).toEqual([]);

      // Asking again still asks the system, which puts the app back in the
      // list after a reset or reinstall, and opens the list to switch it on.
      await computer.requestPermission("screenRecording");
      expect(await requests()).toHaveLength(2);
      expect(opened).toEqual([
        "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
      ]);
    } finally {
      await done();
    }
  });
});

describe("checking the folders macOS guards", () => {
  // The helper is macOS's /bin/ls; some Linux systems (NixOS) have none there.
  test.skipIf(!existsSync("/bin/ls"))(
    "opens them in helper processes; a missing folder needs nothing",
    async () => {
      const { dir, computer, done } = await fakeComputer({ requested: ["files"] });
      const allowed = () =>
        (computer as unknown as { foldersAllowed(): Promise<boolean> }).foldersAllowed();
      try {
        await mkdir(join(dir, "Desktop"));
        await mkdir(join(dir, "Documents"));
        await chmod(join(dir, "Documents"), 0o000);
        // Downloads doesn't exist.
        const first = allowed();
        // A check asked for while one runs shares it.
        expect(allowed()).toBe(first);
        expect(await first).toBe(process.getuid?.() === 0);
        await chmod(join(dir, "Documents"), 0o755);
        expect(await allowed()).toBe(true);
      } finally {
        await chmod(join(dir, "Documents"), 0o755).catch(() => undefined);
        await done();
      }
    },
  );

  test.skipIf(!existsSync("/bin/ls"))(
    "asks about them every time, and opens System Settings only for a refused one",
    async () => {
      // Asked before, as after a reset: the question is still tried first.
      const { dir, computer, opened, done } = await fakeComputer({ requested: ["files"] });
      try {
        await mkdir(join(dir, "Desktop"));
        await mkdir(join(dir, "Documents"));
        await computer.requestPermission("files");
        expect(opened).toEqual([]);

        await chmod(join(dir, "Documents"), 0o000);
        const first = computer.requestPermission("files");
        const second = computer.requestPermission("files");
        await Promise.all([first, second]);
        expect(opened).toHaveLength(process.getuid?.() === 0 ? 0 : 1);
      } finally {
        await chmod(join(dir, "Documents"), 0o755).catch(() => undefined);
        await done();
      }
    },
  );

  test.skipIf(!existsSync("/bin/ls"))(
    "tells the agent which of them it may read: only the ones that opened",
    async () => {
      const { dir, computer, done } = await fakeComputer();
      const env = (computer as unknown as { agentEnv: Record<string, string> }).agentEnv;
      const allowed = () =>
        (computer as unknown as { foldersAllowed(): Promise<boolean> }).foldersAllowed();
      try {
        const folders = env.OPENGENI_MAC_FOLDERS_ALLOWED!;
        expect(folders).toBe(join(dir, "mac-folders-allowed"));
        expect(existsSync(folders)).toBe(false);
        await mkdir(join(dir, "Desktop"));
        await mkdir(join(dir, "Documents"));
        await chmod(join(dir, "Documents"), 0o000);
        await computer.requestPermission("files");
        const refusable = process.getuid?.() !== 0;
        expect(existsSync(join(folders, "Desktop"))).toBe(true);
        expect(existsSync(join(folders, "Documents"))).toBe(!refusable);
        // A folder that isn't there needs no permission.
        expect(existsSync(join(folders, "Downloads"))).toBe(true);

        // Allowed later in System Settings: the next check records it.
        await chmod(join(dir, "Documents"), 0o755);
        await allowed();
        expect(existsSync(join(folders, "Documents"))).toBe(true);
        // No longer opens (refused, or macOS forgot its answer): taken back.
        await chmod(join(dir, "Desktop"), 0o000);
        await allowed();
        expect(existsSync(join(folders, "Desktop"))).toBe(!refusable);
      } finally {
        await chmod(join(dir, "Documents"), 0o755).catch(() => undefined);
        await chmod(join(dir, "Desktop"), 0o755).catch(() => undefined);
        await done();
      }
    },
  );

  test.skipIf(!existsSync("/bin/ls"))(
    "checks them again as the agent starts, when no status read may",
    async () => {
      const { dir, computer, done } = await fakeComputer();
      const internals = computer as unknown as {
        spawnAgent(apiUrl: string): unknown;
        checkingFolders: Promise<boolean> | null;
        agentEnv: Record<string, string>;
      };
      try {
        const folders = internals.agentEnv.OPENGENI_MAC_FOLDERS_ALLOWED!;
        await mkdir(join(dir, "Desktop"));
        // Never asked about: starting the agent opens nothing.
        internals.spawnAgent("http://127.0.0.1:9");
        expect(internals.checkingFolders).toBeNull();

        await computer.requestPermission("files");
        expect(existsSync(join(folders, "Desktop"))).toBe(true);
        // Taken back in System Settings while nothing was checking.
        await chmod(join(dir, "Desktop"), 0o000);
        internals.spawnAgent("http://127.0.0.1:9");
        await internals.checkingFolders;
        expect(existsSync(join(folders, "Desktop"))).toBe(process.getuid?.() === 0);
      } finally {
        await chmod(join(dir, "Desktop"), 0o755).catch(() => undefined);
        await done();
      }
    },
  );
});
