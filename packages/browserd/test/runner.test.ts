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
    expect(browserLaunchArguments("linux")).toBe(
      "--restore-last-session,--disable-background-timer-throttling,--disable-renderer-backgrounding,--password-store=basic",
    );
    expect(browserLaunchArguments("darwin")).toBe(
      "--restore-last-session,--disable-background-timer-throttling,--disable-renderer-backgrounding,--use-mock-keychain",
    );
    expect(browserLaunchArguments("win32")).toBe(
      "--restore-last-session,--disable-background-timer-throttling,--disable-renderer-backgrounding",
    );
  });

  test.skipIf(process.platform !== "darwin")(
    "launches a managed browser through the lifecycle-preserving background helper",
    async () => {
      const root = await mkdtemp("/tmp/og-runner-background-");
      const browserPath = join(root, "Fixture Browser.app", "Contents", "MacOS", "Fixture Browser");
      const helperPath = join(root, "opengeni-computer-native");
      const binaryPath = join(root, "fixture-agent-browser");
      await mkdir(join(root, "Fixture Browser.app", "Contents", "MacOS"), {
        recursive: true,
      });
      await writeFile(browserPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      await writeFile(helperPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      await writeFile(
        binaryPath,
        `#!/usr/bin/env bun\nconsole.log(JSON.stringify({ success: true, data: { executable: process.env.AGENT_BROWSER_EXECUTABLE_PATH, backgroundExecutable: process.env.OPENGENI_BACKGROUND_BROWSER_EXECUTABLE, browserPidFile: process.env.OPENGENI_BACKGROUND_BROWSER_PID_FILE }, error: null }));\n`,
        { mode: 0o700 },
      );
      const runner = await AgentBrowserJsonRunner.create({
        namespace: "og",
        sessionName: "background",
        socketDirectory: join(root, "socket"),
        profileDirectory: join(root, "profile"),
        downloadDirectory: join(root, "downloads"),
        screenshotDirectory: join(root, "screenshots"),
        headed: true,
        browserExecutablePath: browserPath,
        browserLaunchHelperPath: helperPath,
        binary: {
          path: binaryPath,
          name: "agent-browser-darwin-arm64",
          version: "0.33.2",
          sha256: "fixture",
        },
      });
      try {
        const result = await runner.run<{
          executable: string;
          backgroundExecutable: string;
          browserPidFile: string;
        }>(["open", "about:blank"]);
        expect(result).toEqual({
          executable: helperPath,
          backgroundExecutable: browserPath,
          browserPidFile: join(root, "browser.pid"),
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

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
    await writeFile(join(runDirectory, "cleanup.pid"), String(daemon.pid), {
      mode: 0o600,
    });
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
    "keeps proxy authority in the isolated daemon environment and out of argv",
    async () => {
      const root = await mkdtemp("/tmp/og-runner-route-");
      const binaryPath = join(root, "fixture-agent-browser");
      await writeFile(
        binaryPath,
        `#!/usr/bin/env bun\nconsole.log(JSON.stringify({ success: true, data: { argv: process.argv.slice(2), proxy: process.env.AGENT_BROWSER_PROXY, proxyUsername: process.env.AGENT_BROWSER_PROXY_USERNAME, proxyPassword: process.env.AGENT_BROWSER_PROXY_PASSWORD, args: process.env.AGENT_BROWSER_ARGS, timezone: process.env.TZ }, error: null }));\n`,
        { mode: 0o700 },
      );
      const proxyUrl = "http://route-user:route-password@proxy.test:8443/";
      const runner = await AgentBrowserJsonRunner.create({
        namespace: "og",
        sessionName: "route",
        socketDirectory: join(root, "socket"),
        profileDirectory: join(root, "profile"),
        downloadDirectory: join(root, "downloads"),
        screenshotDirectory: join(root, "screenshots"),
        headed: false,
        proxyUrl,
        launchArguments: [
          "--lang=en-US",
          "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        ],
        timezone: "Europe/Oslo",
        binary: {
          path: binaryPath,
          name: "agent-browser-darwin-arm64",
          version: "0.33.2",
          sha256: "fixture",
        },
      });
      try {
        const result = await runner.run<{
          argv: string[];
          proxy: string;
          proxyUsername: string;
          proxyPassword: string;
          args: string;
          timezone: string;
        }>(["open", "about:blank"]);
        expect(result.proxy).toBe("http://proxy.test:8443");
        expect(result.proxyUsername).toBe("route-user");
        expect(result.proxyPassword).toBe("route-password");
        expect(result.argv.join(" ")).not.toContain("route-password");
        expect(result.argv.join(" ")).toContain("http://proxy.test:8443");
        expect(result.args).toContain("--lang=en-US");
        expect(result.args).toContain("--force-webrtc-ip-handling-policy");
        expect(result.timezone).toBe("Europe/Oslo");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "passes remote-provider authority only through the isolated daemon environment",
    async () => {
      const root = await mkdtemp("/tmp/og-runner-provider-");
      const binaryPath = join(root, "fixture-agent-browser");
      await writeFile(
        binaryPath,
        `#!/usr/bin/env bun
console.log(JSON.stringify({ success: true, data: { argv: process.argv.slice(2), kernelKey: process.env.KERNEL_API_KEY, endpoint: process.env.KERNEL_ENDPOINT, headless: process.env.KERNEL_HEADLESS, stealth: process.env.KERNEL_STEALTH, timeout: process.env.KERNEL_TIMEOUT_SECONDS }, error: null }));
`,
        { mode: 0o700 },
      );
      const runner = await AgentBrowserJsonRunner.create({
        namespace: "og",
        sessionName: "provider",
        socketDirectory: join(root, "socket"),
        profileDirectory: join(root, "profile"),
        downloadDirectory: join(root, "downloads"),
        screenshotDirectory: join(root, "screenshots"),
        headed: false,
        provider: {
          id: "kernel",
          apiKey: "kernel-private-key",
          endpoint: "https://kernel.example.test/",
          timeoutSeconds: 7_200,
          stealth: true,
        },
        binary: {
          path: binaryPath,
          name: "agent-browser-darwin-arm64",
          version: "0.33.2",
          sha256: "fixture",
        },
      });
      try {
        const result = await runner.run<{
          argv: string[];
          kernelKey: string;
          endpoint: string;
          headless: string;
          stealth: string;
          timeout: string;
        }>(["open", "about:blank"]);
        expect(result.argv).toContain("--provider");
        expect(result.argv).toContain("kernel");
        expect(result.argv.join(" ")).not.toContain("kernel-private-key");
        expect(result).toMatchObject({
          kernelKey: "kernel-private-key",
          endpoint: "https://kernel.example.test",
          headless: "true",
          stealth: "true",
          timeout: "7200",
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

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
