import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AgentBrowserJsonRunner,
  browserLaunchArguments,
  browserProfileCryptoPolicy,
} from "../src/runner";

describe("managed browser profile cryptography", () => {
  test("declares only explicitly pinned portable policies", () => {
    expect(browserProfileCryptoPolicy("linux")).toBe("chromium_basic");
    expect(browserProfileCryptoPolicy("darwin")).toBe("chromium_mock_keychain");
    expect(browserProfileCryptoPolicy("win32")).toBe("platform_bound");
    expect(browserLaunchArguments("linux")).toBe("--restore-last-session,--password-store=basic");
    expect(browserLaunchArguments("darwin")).toBe("--restore-last-session,--use-mock-keychain");
    expect(browserLaunchArguments("win32")).toBe("--restore-last-session");
  });

  test("terminates only the daemon named by its private PID sidecar", async () => {
    const root = await mkdtemp("/tmp/og-runner-stop-");
    const socketDirectory = join(root, "socket");
    const runner = await AgentBrowserJsonRunner.create({
      namespace: "og",
      sessionName: "cleanup",
      socketDirectory,
      profileDirectory: join(root, "profile"),
      downloadDirectory: join(root, "downloads"),
      screenshotDirectory: join(root, "screenshots"),
      headed: false,
      binary: {
        path: process.execPath,
        name: "agent-browser-darwin-arm64",
        version: "0.33.2",
        sha256: "fixture",
      },
    });
    const daemon = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 60_000)"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    const runDirectory = join(socketDirectory, "namespaces", "og", "run");
    await mkdir(runDirectory, { recursive: true });
    await writeFile(join(runDirectory, "cleanup.pid"), String(daemon.pid), { mode: 0o600 });
    try {
      await runner.terminate();
      expect(await daemon.exited).not.toBe(0);
      expect(() => process.kill(daemon.pid, 0)).toThrow();
    } finally {
      if (daemon.exitCode === null) {
        daemon.kill("SIGKILL");
        await daemon.exited;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")(
    "times out even when a daemon inherits the command pipes",
    async () => {
      const root = await mkdtemp("/tmp/og-runner-timeout-");
      const binaryPath = join(root, "pipe-holder.sh");
      await writeFile(binaryPath, "#!/bin/sh\nsleep 1 &\nexit 0\n", {
        mode: 0o700,
      });
      await chmod(binaryPath, 0o700);
      const runner = await AgentBrowserJsonRunner.create({
        namespace: "og",
        sessionName: "timeout",
        socketDirectory: join(root, "socket"),
        profileDirectory: join(root, "profile"),
        downloadDirectory: join(root, "downloads"),
        screenshotDirectory: join(root, "screenshots"),
        headed: false,
        binary: {
          path: binaryPath,
          name: "agent-browser-darwin-arm64",
          version: "0.33.2",
          sha256: "fixture",
        },
      });
      const startedAt = Date.now();
      try {
        await expect(runner.run(["open"], { timeoutMs: 100 })).rejects.toMatchObject({
          code: "timeout",
        });
        expect(Date.now() - startedAt).toBeLessThan(2_000);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
