import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  link,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  writeFile,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import {
  ManagedBrowserRunner,
  assertManagedBrowserProfileUnused,
  browserLaunchArguments,
  browserProfileCryptoPolicy,
  browserScopeEntry,
  linuxHeadlessChromeArguments,
  macosOffscreenChromeArguments,
  MANAGED_CHROME_DISABLED_FEATURES_ARGUMENT,
  parseMacosDisplayGeometry,
  reapManagedBrowserProcesses,
  reapOrphanedAgentBrowserDaemons,
  stopEndedManagedBrowserProcess,
  inspectOwnedManagedBrowserProcess,
} from "../src/runner";

describe("managed browser profile cryptography", () => {
  test("a browser scope is requested from the user manager, and Chrome keeps the launch's own bus", async () => {
    const root = await mkdtemp("/tmp/og-scope-entry-");
    try {
      const record = join(root, "systemd-run.env");
      const systemdRun = join(root, "systemd-run");
      // Records the bus it was asked to use, then execs the command after `--`
      // in place, as `systemd-run --scope` does.
      await writeFile(
        systemdRun,
        `#!/bin/sh\nprintf '%s|%s\\n' "\${DBUS_SESSION_BUS_ADDRESS-unset}" "\${XDG_RUNTIME_DIR-unset}" > '${record}'\nwhile [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n`,
        { mode: 0o700 },
      );
      const wrapper = join(root, "wrapper.sh");
      await writeFile(
        wrapper,
        `#!/bin/sh\n${browserScopeEntry(
          {
            systemdRun,
            busctl: "/usr/bin/busctl",
            managerEnvironment: {
              DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
              XDG_RUNTIME_DIR: "/run/user/1000",
            },
          },
          "opengeni-browser-fixture.scope",
          wrapper,
        )}printf '%s|%s|%s|%s\\n' "\${DBUS_SESSION_BUS_ADDRESS-unset}" "\${XDG_RUNTIME_DIR-unset}" "\${OPENGENI_BROWSER_SCOPE-unset}" "$1"\n`,
        { mode: 0o700 },
      );
      const linked = spawnSync(wrapper, ["operand with space"], {
        env: {
          PATH: process.env.PATH,
          DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/desktop/bus",
          XDG_RUNTIME_DIR: "/tmp/desktop",
        },
        encoding: "utf8",
      });
      expect(linked.status).toBe(0);
      expect(await readFile(record, "utf8")).toBe("unix:path=/run/user/1000/bus|/run/user/1000\n");
      expect(linked.stdout).toBe(
        "unix:path=/tmp/desktop/bus|/tmp/desktop|unset|operand with space\n",
      );

      const unsetBus = spawnSync(wrapper, ["x"], {
        env: { PATH: process.env.PATH, XDG_RUNTIME_DIR: "/tmp/desktop" },
        encoding: "utf8",
      });
      expect(unsetBus.status).toBe(0);
      expect(unsetBus.stdout).toBe("unset|/tmp/desktop|unset|x\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("offscreen macOS browsers present the host display and an ordinary User-Agent", async () => {
    const geometry = parseMacosDisplayGeometry(
      JSON.stringify({ w: 1920, h: 1080, x: 0, y: 88, vw: 1920, vh: 962, scale: 1 }),
    );
    expect(geometry).toEqual({
      width: 1920,
      height: 1080,
      scale: 1,
      insets: { left: 0, right: 0, top: 30, bottom: 88 },
    });
    expect(parseMacosDisplayGeometry("")).toBeNull();
    expect(parseMacosDisplayGeometry(JSON.stringify({ w: 1920, h: 1080 }))).toBeNull();
    expect(
      parseMacosDisplayGeometry(
        JSON.stringify({ w: 1920, h: 1080, x: 0, y: -5, vw: 1920, vh: 962, scale: 1 }),
      ),
    ).toBeNull();
    expect(
      await macosOffscreenChromeArguments("/Applications/Fixture", {
        chromeMajorVersion: async () => 155,
        mainDisplay: async () => geometry!,
      }),
    ).toEqual([
      "--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
      "--screen-info={1920x1080 devicePixelRatio=1 workAreaLeft=0 workAreaRight=0 workAreaTop=30 workAreaBottom=88}",
    ]);
    // Chrome reads --screen-info in device pixels: a Retina display measured
    // in points is passed at its pixel size so pages see its point size.
    expect(
      await macosOffscreenChromeArguments("/Applications/Fixture", {
        chromeMajorVersion: async () => 155,
        mainDisplay: async () => ({
          width: 1728,
          height: 1117,
          scale: 2,
          insets: { left: 0, right: 0, top: 33, bottom: 0 },
        }),
      }),
    ).toContain(
      "--screen-info={3456x2234 devicePixelRatio=2 workAreaLeft=0 workAreaRight=0 workAreaTop=66 workAreaBottom=0}",
    );
  });

  test("headless Linux browsers present an ordinary desktop User-Agent and screen", async () => {
    expect(
      await linuxHeadlessChromeArguments("/usr/bin/fixture-chrome", {
        chromeMajorVersion: async () => 155,
      }),
    ).toEqual([
      "--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
      "--screen-info={1920x1080 devicePixelRatio=1 workAreaTop=32}",
    ]);
    expect(
      await linuxHeadlessChromeArguments("/usr/bin/fixture-chrome", {
        chromeMajorVersion: async () => {
          throw new Error("managed browser version is unavailable");
        },
      }),
    ).toEqual(["--screen-info={1920x1080 devicePixelRatio=1 workAreaTop=32}"]);
  });

  test("declares only explicitly pinned portable policies", () => {
    expect(browserProfileCryptoPolicy("linux")).toBe("chromium_basic");
    expect(browserProfileCryptoPolicy("darwin")).toBe("chromium_mock_keychain");
    expect(browserProfileCryptoPolicy("win32")).toBe("platform_bound");
    expect(browserLaunchArguments("linux").join(",")).toBe(
      "--restore-last-session,--disable-field-trial-config,--disable-background-timer-throttling,--disable-renderer-backgrounding,--disable-features=OptimizationGuideOnDeviceModel,--disk-cache-size=67108864,--disable-blink-features=AutomationControlled,--enable-features=CDPScreenshotNewSurface,--test-type,--ignore-gpu-blocklist,--enable-unsafe-swiftshader,--password-store=basic",
    );
    expect(browserLaunchArguments("darwin").join(",")).toBe(
      "--restore-last-session,--disable-field-trial-config,--disable-background-timer-throttling,--disable-renderer-backgrounding,--disable-features=OptimizationGuideOnDeviceModel,--disk-cache-size=67108864,--disable-blink-features=AutomationControlled,--enable-features=CDPScreenshotNewSurface,--use-mock-keychain",
    );
    expect(browserLaunchArguments("win32").join(",")).toBe(
      "--restore-last-session,--disable-field-trial-config,--disable-background-timer-throttling,--disable-renderer-backgrounding,--disable-features=OptimizationGuideOnDeviceModel,--disk-cache-size=67108864,--disable-blink-features=AutomationControlled,--enable-features=CDPScreenshotNewSurface",
    );
  });

  test("uses presentation-independent screenshots for every managed browser", () => {
    const feature = "--enable-features=CDPScreenshotNewSurface";
    for (const platform of ["linux", "darwin", "win32"] as const) {
      expect(browserLaunchArguments(platform)).toContain(feature);
    }
    // Chromium honors only the last switch: an additional one is folded in.
    const merged = browserLaunchArguments("linux", [
      "--enable-features=OverlayScrollbar",
      "--lang=en-US",
      "--enable-features=CDPScreenshotNewSurface,Extra",
    ]);
    expect(merged.filter((argument) => argument.startsWith("--enable-features="))).toEqual([
      "--enable-features=CDPScreenshotNewSurface,OverlayScrollbar,Extra",
    ]);
    expect(merged.at(-1)).toBe("--lang=en-US");
  });

  test.skipIf(process.platform !== "darwin")(
    "launches an offscreen managed browser as the real browser without a window",
    async () => {
      const root = await mkdtemp("/tmp/og-runner-offscreen-");
      const contents = join(root, "Fixture Browser.app", "Contents");
      const browserPath = join(contents, "MacOS", "Fixture Browser");
      const helperPath = join(root, "opengeni-computer-native");
      await mkdir(join(contents, "MacOS"), { recursive: true });
      await writeFile(browserPath, fixtureBrowserScript(), { mode: 0o700 });
      await writeFile(
        join(contents, "Info.plist"),
        "<plist><dict><key>CFBundleShortVersionString</key>\n\t<string>155.0.8059.82</string></dict></plist>",
      );
      await writeFile(helperPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      const runner = await ManagedBrowserRunner.create({
        profileDirectory: join(root, "profile"),
        headed: true,
        offscreen: true,
        browserExecutablePath: browserPath,
        browserLaunchHelperPath: helperPath,
      });
      try {
        await runner.run(["get", "cdp-url"]);
        const { argv, environment } = await fixtureBrowserLaunch(root);
        // The real browser itself runs, never the windowed background helper.
        expect(environment.OPENGENI_BACKGROUND_BROWSER_EXECUTABLE).toBeUndefined();
        expect(argv).toContain("--headless=new");
        expect(argv.find((argument) => argument.startsWith("--user-agent="))).toStartWith(
          "--user-agent=Mozilla/5.0 (Macintosh;",
        );
        expect(argv.join(" ")).toContain("Chrome/155.0.0.0 Safari/537.36");
        expect(argv.find((argument) => argument.startsWith("--screen-info="))).toMatch(
          /^--screen-info=\{\d+x\d+ devicePixelRatio=\d+ /u,
        );
        expect(argv.join(" ")).not.toContain("HeadlessChrome");
        // Chromium honors only the last --disable-features switch, so the
        // complete list comes last.
        expect(argv.at(-1)).toBe(MANAGED_CHROME_DISABLED_FEATURES_ARGUMENT);
        expect(MANAGED_CHROME_DISABLED_FEATURES_ARGUMENT).toBe(
          "--disable-features=Translate,OptimizationGuideOnDeviceModel,WebUIOmniboxPopup,WebUIOmniboxAimPopup,PassageEmbedder",
        );
      } finally {
        await stopFixtureBrowser(root);
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform !== "darwin")(
    "launches a managed browser through the lifecycle-preserving background helper",
    async () => {
      const root = await mkdtemp("/tmp/og-runner-background-");
      const browserPath = join(root, "Fixture Browser.app", "Contents", "MacOS", "Fixture Browser");
      const helperPath = join(root, "opengeni-computer-native");
      await mkdir(join(root, "Fixture Browser.app", "Contents", "MacOS"), { recursive: true });
      await writeFile(browserPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      // The helper stands in for the background launch: it records its own
      // command line and environment and writes the browser's port file.
      await writeFile(helperPath, fixtureBrowserScript(), { mode: 0o700 });
      const runner = await ManagedBrowserRunner.create({
        profileDirectory: join(root, "profile"),
        headed: true,
        browserExecutablePath: browserPath,
        browserLaunchHelperPath: helperPath,
      });
      try {
        await runner.run(["get", "cdp-url"]);
        const { argv, environment } = await fixtureBrowserLaunch(root);
        expect(environment.OPENGENI_BACKGROUND_BROWSER_EXECUTABLE).toBe(browserPath);
        expect(environment.OPENGENI_BACKGROUND_BROWSER_PID_FILE).toBe(join(root, "browser.pid"));
        expect(argv).toContain(`--user-data-dir=${join(root, "profile")}`);
        expect(argv).not.toContain("--headless=new");
      } finally {
        await stopFixtureBrowser(root);
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  for (const headed of [true, false]) {
    test.skipIf(process.platform !== "linux")(
      `drains noisy managed ${headed ? "headed" : "headless"} Chrome stderr without blocking its process`,
      async () => {
        const root = await mkdtemp("/tmp/og-chrome-stderr-");
        const browserPath = join(root, "fixture chrome");
        // 256 KiB of stderr before the port file: an undrained pipe would
        // block the browser long before it could answer.
        await writeFile(
          browserPath,
          fixtureBrowserScript(
            'i=0\nwhile [ "$i" -lt 256 ]; do\n  printf "%01024d" 0 >&2\n  i=$((i + 1))\ndone\nprintf "END_MARKER\\n" >&2\n',
          ),
          { mode: 0o700 },
        );
        const runner = await ManagedBrowserRunner.create({
          profileDirectory: join(root, "profile"),
          headed,
          browserExecutablePath: browserPath,
          systemdScope: false,
          networkIsolation: false,
        });
        try {
          await runner.run(["get", "cdp-url"], { timeoutMs: 3_000 });
          const launchFiles = await readdir(join(root, "chrome-launch"));
          const wrapper = launchFiles.find((name) => name.endsWith(".sh"));
          const fifo = launchFiles.find((name) => name.endsWith(".stderr.fifo"));
          expect((await stat(join(root, "chrome-launch", wrapper!))).mode & 0o777).toBe(0o700);
          expect((await stat(join(root, "chrome-launch", fifo!))).mode & 0o777).toBe(0o600);
          // The reader keeps the last bytes once the browser closes its stderr.
          await stopFixtureBrowser(root);
          const log = join(root, "chrome-launch", "chrome-stderr.log");
          let content = new Uint8Array();
          for (let attempt = 0; attempt < 50; attempt += 1) {
            content = new Uint8Array(await readFile(log));
            if (Buffer.from(content).toString().endsWith("END_MARKER\n")) break;
            await Bun.sleep(10);
          }
          expect(content.byteLength).toBe(64 * 1024);
          expect(Buffer.from(content).toString().endsWith("END_MARKER\n")).toBe(true);
          await runner.terminate();
          expect(await readdir(join(root, "chrome-launch"))).toEqual(["chrome-stderr.log"]);
        } finally {
          await stopFixtureBrowser(root);
          await rm(root, { recursive: true, force: true });
        }
      },
    );
  }

  test.skipIf(process.platform === "win32")(
    "keeps proxy credentials in the controller and out of the browser's argv and environment",
    async () => {
      const root = await mkdtemp("/tmp/og-runner-route-");
      const browserPath = join(root, "fixture-browser");
      await writeFile(browserPath, fixtureBrowserScript(), { mode: 0o700 });
      const runner = await ManagedBrowserRunner.create({
        profileDirectory: join(root, "profile"),
        headed: false,
        browserExecutablePath: browserPath,
        proxyUrl: "http://route-user:route-password@proxy.test:8443/",
        launchArguments: [
          "--lang=en-US",
          "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        ],
        timezone: "Europe/Oslo",
        systemdScope: false,
        networkIsolation: false,
      });
      try {
        expect(runner.proxyCredentials).toEqual({
          username: "route-user",
          password: "route-password",
        });
        await runner.run(["get", "cdp-url"]);
        const { argv, environment } = await fixtureBrowserLaunch(root);
        expect(argv).toContain("--proxy-server=http://proxy.test:8443");
        expect(argv).toContain("--lang=en-US");
        expect(argv).toContain("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
        expect(environment.TZ).toBe("Europe/Oslo");
        const launched = JSON.stringify({ argv, environment });
        expect(launched).not.toContain("route-password");
        expect(launched).not.toContain("route-user");
      } finally {
        await stopFixtureBrowser(root);
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "a browser that never opens its DevTools endpoint times out and is stopped",
    async () => {
      const root = await mkdtemp("/tmp/og-runner-timeout-");
      const browserPath = join(root, "silent-browser");
      await writeFile(
        browserPath,
        `#!/bin/sh\necho $$ > ${JSON.stringify(join(root, "silent.pid"))}\nexec sleep 30\n`,
        { mode: 0o700 },
      );
      const runner = await ManagedBrowserRunner.create({
        profileDirectory: join(root, "profile"),
        headed: false,
        browserExecutablePath: browserPath,
        systemdScope: false,
        networkIsolation: false,
      });
      const startedAt = Date.now();
      try {
        await expect(runner.run(["get", "cdp-url"], { timeoutMs: 300 })).rejects.toMatchObject({
          code: "timeout",
        });
        expect(Date.now() - startedAt).toBeLessThan(2_000);
        const pid = Number((await readFile(join(root, "silent.pid"), "utf8")).trim());
        let running = true;
        for (let attempt = 0; attempt < 100 && running; attempt++) {
          try {
            process.kill(pid, 0);
            await Bun.sleep(20);
          } catch {
            running = false;
          }
        }
        expect(running).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform !== "linux")(
    "terminates the exact managed Linux browser left behind by an earlier controller",
    async () => {
      const root = await mkdtemp("/tmp/og-linux-stop-");
      const profileDirectory = join(root, "profile");
      const runner = await ManagedBrowserRunner.create({
        profileDirectory,
        headed: true,
        browserExecutablePath: process.execPath,
      });
      const browser = Bun.spawn(
        [
          process.execPath,
          "-e",
          "setInterval(() => {}, 60_000)",
          `--user-data-dir=${profileDirectory}`,
        ],
        { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
      );
      try {
        expect(() => process.kill(browser.pid, 0)).not.toThrow();
        await runner.terminate();
        expect(await browser.exited).not.toBe(0);
        expect(() => process.kill(browser.pid, 0)).toThrow();
      } finally {
        if (browser.exitCode === null) {
          browser.kill("SIGKILL");
          await browser.exited;
        }
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform !== "linux")(
    "reaps stale private Chrome launch pipes without deleting bounded diagnostics",
    async () => {
      const root = await mkdtemp("/tmp/og-chrome-launch-reap-");
      const launch = join(
        root,
        "sessions",
        "11111111-1111-4111-8111-111111111111",
        "chrome-launch",
      );
      const id = "22222222-2222-4222-8222-222222222222";
      await mkdir(launch, { recursive: true, mode: 0o700 });
      await writeFile(join(launch, `${id}.sh`), "stale");
      await writeFile(join(launch, `${id}.stderr.fifo`), "stale");
      await writeFile(join(launch, `${id}.stderr.done`), "");
      await writeFile(join(launch, "chrome-stderr.log"), "bounded diagnostic");
      try {
        await reapManagedBrowserProcesses(root);
        expect(await readdir(launch)).toEqual(["chrome-stderr.log"]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

test.skipIf(process.platform !== "linux" || process.getuid?.() === 0)(
  "an unused profile is proven unused on a real host whose other-user processes hide their executables",
  async () => {
    // An unprivileged agent can't read the executable link of root's or other
    // users' processes. Hosts without any such process can't exercise this.
    let unreadableExecutables = 0;
    for (const name of await readdir("/proc")) {
      if (!/^[1-9][0-9]*$/u.test(name)) continue;
      try {
        await readlink(`/proc/${name}/exe`);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? "";
        if (code === "EACCES" || code === "EPERM") unreadableExecutables += 1;
      }
    }
    if (unreadableExecutables === 0) return;
    const directory = await mkdtemp("/tmp/og-profile-unused-");
    const profileDirectory = join(directory, "profile");
    await mkdir(profileDirectory, { mode: 0o700 });
    try {
      await expect(assertManagedBrowserProfileUnused(profileDirectory)).resolves.toBeUndefined();
      const holder = Bun.spawn(
        [
          process.execPath,
          "-e",
          "setInterval(()=>{},60000)",
          `--user-data-dir=${profileDirectory}`,
        ],
        { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
      );
      try {
        // A process naming the exact profile still refuses.
        await expect(assertManagedBrowserProfileUnused(profileDirectory)).rejects.toMatchObject({
          code: "process_failed",
        });
      } finally {
        holder.kill();
        await holder.exited;
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("Linux directory relaunch requires complete absence of verified and unverified profile processes, judged by command lines", async () => {
  const directory = await mkdtemp("/tmp/og-inventory-proof-");
  const profileDirectory = join(directory, "profile");
  await mkdir(profileDirectory);
  const scriptPath = join(directory, "synthetic-inventory.ts");
  const script = `import { expect, mock } from "bun:test";
    import * as fs from "node:fs/promises";
    Object.defineProperty(process, "platform", { value: "linux" });
    const profileDirectory = ${JSON.stringify(profileDirectory)};
    const native = { readdir: fs.readdir, readFile: fs.readFile, readlink: fs.readlink, realpath: fs.realpath };
    let scenario = "absent";
    const missing = code => Object.assign(new Error("synthetic procfs observation"), { code });
    mock.module("node:fs/promises", () => ({
      ...fs,
      async readdir(path, options) {
        if (path === "/proc") return [{ name: "2002", isDirectory: () => true }];
        return await native.readdir(path, options);
      },
      async readFile(path, options) {
        if (path === "/proc/2001/stat") throw missing("ENOENT");
        if (path !== "/proc/2002/cmdline") return await native.readFile(path, options);
        if (scenario === "inaccessible") throw missing("EACCES");
        if (scenario === "forbidden") throw missing("EPERM");
        if (scenario === "exiting") throw missing("ENOENT");
        const profile = ["rewritten", "unknown-executable", "inaccessible-executable-naming-profile"].includes(scenario) ? profileDirectory : "/synthetic/other";
        return Buffer.from("/synthetic/chromium --user-data-dir=" + profile + "\\0");
      },
      async readlink(path) {
        if (path !== "/proc/2002/exe") return await native.readlink(path);
        if (["inaccessible-executable", "inaccessible-executable-naming-profile"].includes(scenario)) throw missing("EACCES");
        if (scenario === "forbidden-executable") throw missing("EPERM");
        return scenario === "unknown-executable" ? "/synthetic/unrecognized" : "/synthetic/chromium";
      },
      async realpath(path) { return path.startsWith("/synthetic/") ? path : await native.realpath(path); },
    }));
    const { ManagedBrowserRunner, inspectOwnedManagedBrowserProcess } = await import(${JSON.stringify(new URL("../src/runner.ts", import.meta.url).href)});
    const receipt = { pid: 2001, birth: "synthetic-birth", executablePath: "/synthetic/chromium", profileDirectory,
      cdpEndpoint: "ws://127.0.0.1:12345/devtools/browser/11111111-1111-4111-8111-111111111111" };
    const options = {
      headed: false, profileDirectory,
      browserExecutablePath: process.execPath,
      recoverOwnedProcess: receipt,
    };
    const results = [];
    const proven = ["absent", "exiting", "inaccessible-executable", "forbidden-executable"];
    for (scenario of ["absent", "rewritten", "unknown-executable", "inaccessible", "forbidden", "inaccessible-executable", "forbidden-executable", "inaccessible-executable-naming-profile", "exiting"]) {
      try { results.push({ scenario, result: await inspectOwnedManagedBrowserProcess(receipt) }); }
      catch (error) { results.push({ scenario, code: error.code, message: error.message }); }
      if (proven.includes(scenario)) {
        await expect(ManagedBrowserRunner.create(options)).rejects.toThrow("outcome is unknown");
        const permitted = await ManagedBrowserRunner.create({ ...options, allowOwnedProcessLaunch: true });
        expect(permitted.reattachedOwnedProcess).toBeNull();
      } else {
        // Explicit launch permission cannot bypass a successor or a denied
        // command line. An unrelated process's unreadable executable (any
        // root or other-user process) is not evidence about the profile.
        await expect(ManagedBrowserRunner.create({ ...options, allowOwnedProcessLaunch: true })).rejects.toThrow(results.at(-1).message);
      }
    }
    console.log(JSON.stringify(results));`;
  await writeFile(scriptPath, script, { mode: 0o600 });
  const child = Bun.spawn([process.execPath, "--no-env-file", scriptPath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(JSON.parse(stdout)).toEqual([
      { scenario: "absent", result: "exited" },
      {
        scenario: "rewritten",
        code: "process_failed",
        message: "exact directory launch absence is unproven",
      },
      {
        scenario: "unknown-executable",
        code: "process_failed",
        message: "exact directory launch absence is unproven",
      },
      {
        scenario: "inaccessible",
        code: "process_failed",
        message: "exact profile process inventory is incomplete",
      },
      {
        scenario: "forbidden",
        code: "process_failed",
        message: "exact profile process inventory is incomplete",
      },
      { scenario: "inaccessible-executable", result: "exited" },
      { scenario: "forbidden-executable", result: "exited" },
      {
        scenario: "inaccessible-executable-naming-profile",
        code: "process_failed",
        message: "exact directory launch absence is unproven",
      },
      { scenario: "exiting", result: "exited" },
    ]);
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
    await rm(directory, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
  "owned process attestation rejects identity mismatches and reattaches a proven browser",
  async () => {
    const directory = await mkdtemp("/tmp/og-owned-process-");
    const profileDirectory = join(directory, "profile");
    await mkdir(profileDirectory);
    const cdpEndpoint =
      "ws://127.0.0.1:12345/devtools/browser/11111111-1111-4111-8111-111111111111";
    const portPath = join(profileDirectory, "DevToolsActivePort");
    await writeFile(portPath, "12345\n/devtools/browser/11111111-1111-4111-8111-111111111111\n");
    const child = Bun.spawn(
      [process.execPath, "-e", "setInterval(()=>{},60000)", `--user-data-dir=${profileDirectory}`],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    await writeFile(join(directory, "browser.pid"), String(child.pid));
    const options = {
      profileDirectory,
      headed: false,
      browserExecutablePath: process.execPath,
    };
    try {
      const runner = await ManagedBrowserRunner.create(options);
      const receipt = await runner.ownedProcessIdentity(cdpEndpoint);
      expect(receipt !== null).toBe(true);
      expect(receipt?.pid === child.pid).toBe(true);
      expect(await inspectOwnedManagedBrowserProcess(receipt!)).toBe("live");
      for (const change of [
        { birth: "different-birth" },
        { executablePath: "/bin/sh" },
        {
          cdpEndpoint: "ws://127.0.0.1:12345/devtools/browser/22222222-2222-4222-8222-222222222222",
        },
      ])
        await expect(
          inspectOwnedManagedBrowserProcess({ ...receipt!, ...change }),
        ).rejects.toThrow();
      const differentProfile = join(directory, "different-profile");
      await mkdir(differentProfile);
      await expect(
        inspectOwnedManagedBrowserProcess({ ...receipt!, profileDirectory: differentProfile }),
      ).rejects.toThrow();
      // A replacement controller reattaches the proven browser itself; no
      // launcher process has to witness it.
      const reattached = await ManagedBrowserRunner.create({
        ...options,
        recoverOwnedProcess: receipt!,
      });
      expect(reattached.reattachedOwnedProcess).toEqual(receipt);
      expect(() => process.kill(child.pid, 0)).not.toThrow();
      const content = await readFile(portPath);
      await rm(portPath);
      await writeFile(join(directory, "port-copy"), content);
      await symlink(join(directory, "port-copy"), portPath);
      await expect(inspectOwnedManagedBrowserProcess(receipt!)).rejects.toThrow(
        "CDP identity is unavailable",
      );
      await rm(portPath);
      await writeFile(portPath, content);
      // Explicit bound cleanup targets only this generated Bun fixture PID.
      await runner.terminate();
      await child.exited;
      expect(() => process.kill(child.pid, 0)).toThrow();
      // Complete Linux absence/relaunch proof belongs to the isolated inventory
      // fixture above: a CI host may have unrelated, unreadable procfs entries.
      // On macOS one full process listing proves nothing runs the profile.
      if (process.platform === "darwin") {
        expect(await inspectOwnedManagedBrowserProcess(receipt!)).toBe("exited");
      }
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
  20_000,
);

test.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
  "agent-browser daemons whose browser is gone are found by the profile they serve and stopped",
  async () => {
    const directory = await mkdtemp("/tmp/og-orphaned-daemon-");
    // A daemon is recognized by its executable name and its own environment,
    // so the fixture runs this Bun under the agent-browser name.
    const executable = join(directory, "agent-browser");
    await link(process.execPath, executable).catch(
      async () => await copyFile(process.execPath, executable),
    );
    await chmod(executable, 0o700);
    const sessions = join(directory, "root", "sessions");
    const profile = (name: string) =>
      join(sessions, `00000000-0000-4000-8000-00000000000${name}`, "profile");
    const children: ReturnType<typeof Bun.spawn>[] = [];
    const daemon = (profileDirectory: string, script: string) => {
      const child = Bun.spawn([executable, "-e", script], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          AGENT_BROWSER_DAEMON: "1",
          AGENT_BROWSER_PROFILE: profileDirectory,
          AGENT_BROWSER_SOCKET_DIR: join(directory, "socket"),
        },
      });
      children.push(child);
      return child;
    };
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      for (const name of ["1", "2"]) await mkdir(profile(name), { recursive: true });
      const idle = "setInterval(() => {}, 60000)";
      const ended = daemon(profile("1"), idle);
      // A daemon whose browser still runs is never stopped.
      const serving = daemon(
        profile("2"),
        `const c = require("node:child_process").spawn("/bin/sh", ["-c", "exec sleep 60"], { stdio: "ignore" }); console.log(c.pid); ${idle}`,
      );
      const outside = daemon(join(directory, "elsewhere", "profile"), idle);
      const reader = serving.stdout!.getReader();
      const servingChild = Number(new TextDecoder().decode((await reader.read()).value).trim());
      reader.releaseLock();
      expect(servingChild).toBeGreaterThan(1);

      // Ending a session whose browser already exited stops its daemon too.
      await stopEndedManagedBrowserProcess(profile("1"), null);
      await ended.exited;
      expect(alive(serving.pid)).toBe(true);
      expect(alive(outside.pid)).toBe(true);

      // Startup reconciliation leaves a daemon with a running child and one
      // that serves a profile outside this controller's sessions.
      expect(await reapOrphanedAgentBrowserDaemons(join(directory, "root"), { minAgeMs: 0 })).toBe(
        0,
      );
      expect(alive(serving.pid)).toBe(true);
      process.kill(servingChild, "SIGKILL");
      for (let attempt = 0; attempt < 50 && alive(servingChild); attempt++) await Bun.sleep(20);
      // A daemon too young to have started its browser is left as well.
      expect(await reapOrphanedAgentBrowserDaemons(join(directory, "root"))).toBe(0);
      expect(await reapOrphanedAgentBrowserDaemons(join(directory, "root"), { minAgeMs: 0 })).toBe(
        1,
      );
      await serving.exited;
      expect(alive(outside.pid)).toBe(true);
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
      await Promise.all(children.map(async (child) => await child.exited));
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);

/** A shell stand-in for Chrome that records its command line and
 * environment next to the profile, then writes DevToolsActivePort the way
 * Chrome does for `--remote-debugging-port=0` and stays running. */
function fixtureBrowserScript(prelude = ""): string {
  return [
    "#!/bin/sh",
    'case "$1" in --version) echo "Fixture Browser"; exit 0;; esac',
    "profile=",
    'for argument; do case "$argument" in --user-data-dir=*) profile=${argument#--user-data-dir=};; esac; done',
    '[ -n "$profile" ] || exit 2',
    'root=$(dirname "$profile")',
    'echo $$ > "$root/fixture.pid"',
    ': > "$root/launch.argv"',
    'for argument; do printf \'%s\\0\' "$argument" >> "$root/launch.argv"; done',
    'env > "$root/launch.env"',
    prelude,
    'mkdir -p "$profile"',
    "printf '45678\\n/devtools/browser/11111111-1111-4111-8111-111111111111\\n' > \"$profile/.port\"",
    'mv "$profile/.port" "$profile/DevToolsActivePort"',
    "exec sleep 30",
    "",
  ].join("\n");
}

async function fixtureBrowserLaunch(
  root: string,
): Promise<{ argv: string[]; environment: Record<string, string> }> {
  const argv = (await readFile(join(root, "launch.argv"), "utf8")).split("\0").slice(0, -1);
  const environment: Record<string, string> = {};
  for (const line of (await readFile(join(root, "launch.env"), "utf8")).split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) environment[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return { argv, environment };
}

async function stopFixtureBrowser(root: string): Promise<void> {
  let pid: number;
  try {
    pid = Number((await readFile(join(root, "fixture.pid"), "utf8")).trim());
  } catch {
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await Bun.sleep(10);
  }
}
