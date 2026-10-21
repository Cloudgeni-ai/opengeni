import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DesktopAppShotResult, DesktopAppShotSettings } from "../src/contract";
import { AppShots } from "../src/main/app-shots";
import {
  APP_SHOT_TEXT_MAX_CHARS,
  MacAppShots,
  macBrowserKind,
  pageUrl,
  parseTextResult,
  parseWindowLine,
  screencaptureArguments,
  type RunProcess,
} from "../src/main/app-shots/mac";
import { AppShotError, type AppShotPlatform } from "../src/main/app-shots/platform";
import {
  AppShotSettingsStore,
  defaultAppShotSettings,
  mergeAppShotSettings,
  parseAppShotShortcut,
} from "../src/main/app-shots/settings";

describe("settings", () => {
  test("are off by default, with both Command keys on macOS", () => {
    expect(defaultAppShotSettings("darwin")).toEqual({
      enabled: false,
      shortcut: { kind: "modifierPair", modifier: "command" },
    });
    expect(defaultAppShotSettings("win32").shortcut.kind).toBe("accelerator");
  });

  test("accept known shortcuts and keep the current value for anything else", () => {
    expect(parseAppShotShortcut({ kind: "accelerator", accelerator: "Command+Shift+2" })).toEqual({
      kind: "accelerator",
      accelerator: "Command+Shift+2",
    });
    expect(parseAppShotShortcut({ kind: "modifierPair", modifier: "fn" })).toBeNull();
    expect(parseAppShotShortcut({ kind: "accelerator", accelerator: "A" })).toBeNull();
    const current = defaultAppShotSettings("darwin");
    expect(mergeAppShotSettings(current, { enabled: "yes", shortcut: { kind: "x" } })).toEqual(
      current,
    );
    expect(mergeAppShotSettings(current, { enabled: true }).enabled).toBe(true);
  });

  test("persist with the permissions already asked for", () => {
    const dir = mkdtempSync(join(tmpdir(), "app-shots-test-"));
    try {
      const store = new AppShotSettingsStore(dir, "darwin");
      expect(store.read()).toEqual(defaultAppShotSettings("darwin"));
      store.markRequested("screenRecording");
      store.write({ enabled: true, shortcut: { kind: "modifierPair", modifier: "option" } });
      const again = new AppShotSettingsStore(dir, "darwin");
      expect(again.read()).toEqual({
        enabled: true,
        shortcut: { kind: "modifierPair", modifier: "option" },
      });
      expect(again.requested()).toEqual(["screenRecording"]);
      expect(JSON.parse(readFileSync(join(dir, "app-shots.json"), "utf8")).requested).toEqual([
        "screenRecording",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("macOS helpers", () => {
  test("read the window report and ignore other lines", () => {
    expect(
      parseWindowLine(
        'window {"pid":42,"windowId":7,"app":"Safari","bundleId":"com.apple.Safari","title":"Docs"}',
      ),
    ).toEqual({ pid: 42, windowId: 7, app: "Safari", bundleId: "com.apple.Safari", title: "Docs" });
    expect(parseWindowLine("ready")).toBeNull();
    expect(parseWindowLine('window {"pid":"42"}')).toBeNull();
  });

  test("read the text result, capped, and the script's own errors", () => {
    expect(parseTextResult('{"text":"Hello","truncated":false}')).toEqual({
      kind: "text",
      text: "Hello",
      truncated: false,
    });
    const long = parseTextResult(
      JSON.stringify({ text: "x".repeat(APP_SHOT_TEXT_MAX_CHARS + 5), truncated: false }),
    );
    expect(long).toEqual({
      kind: "text",
      text: "x".repeat(APP_SHOT_TEXT_MAX_CHARS),
      truncated: true,
    });
    expect(parseTextResult('{"error":"no_window"}')).toEqual({ kind: "error", error: "no_window" });
    expect(parseTextResult("")).toEqual({ kind: "error", error: "unreadable" });
  });

  test("keep a web page's address only when it is http or https", () => {
    expect(
      parseTextResult('{"text":"Hi","truncated":false,"url":"https://example.com/a?b=1"}'),
    ).toEqual({
      kind: "text",
      text: "Hi",
      truncated: false,
      url: "https://example.com/a?b=1",
    });
    expect(pageUrl("http://example.com")).toBe("http://example.com/");
    expect(pageUrl("file:///Users/me/secret.txt")).toBeUndefined();
    expect(pageUrl("chrome://settings")).toBeUndefined();
    expect(pageUrl("not a url")).toBeUndefined();
    expect(pageUrl("")).toBeUndefined();
    expect(pageUrl(`https://example.com/${"x".repeat(5_000)}`)).toBeUndefined();
  });

  test("tell web browsers, and Chromium-based ones, by bundle id", () => {
    expect(macBrowserKind("com.google.Chrome")).toBe("chromium");
    expect(macBrowserKind("com.google.Chrome.canary")).toBe("chromium");
    expect(macBrowserKind("com.brave.Browser")).toBe("chromium");
    expect(macBrowserKind("com.microsoft.edgemac")).toBe("chromium");
    expect(macBrowserKind("company.thebrowser.Browser")).toBe("chromium");
    expect(macBrowserKind("com.apple.Safari")).toBe("other");
    expect(macBrowserKind("org.mozilla.firefox")).toBe("other");
    // Apps that embed web pages are not browsers.
    expect(macBrowserKind("com.tinyspeck.slackmacgap")).toBeNull();
    expect(macBrowserKind("com.google.Chrome.helper")).toBeNull();
    expect(macBrowserKind("")).toBeNull();
  });

  test("photograph exactly one window, silently, without its shadow", () => {
    expect(screencaptureArguments(91, "/tmp/w.png")).toEqual([
      "-l91",
      "-o",
      "-x",
      "-t",
      "png",
      "/tmp/w.png",
    ]);
  });

  const permissionsGranted: RunProcess = async (_file, args) =>
    args.includes("check") || args.includes("request-screen")
      ? { code: 0, stdout: '{"screenRecording":true,"accessibility":true}', stderr: "" }
      : { code: 1, stdout: "", stderr: "" };

  function mac(run: RunProcess) {
    return new MacAppShots({
      ownPid: 1,
      run,
      openSystemSettings: () => undefined,
      guide: () => undefined,
      requested: () => [],
      markRequested: () => undefined,
      onPermissionsChange: () => undefined,
    });
  }

  test("takes the picture while the text is read and returns both", async () => {
    const order: string[] = [];
    const run: RunProcess = async (file, args, options) => {
      if (args.includes("check")) return permissionsGranted(file, args, options);
      if (file === "/usr/sbin/screencapture") {
        order.push("picture");
        await Bun.write(args.at(-1)!, new Uint8Array([137, 80, 78, 71]));
        return { code: 0, stdout: "", stderr: "" };
      }
      options.onStderrLine?.(
        'window {"pid":42,"windowId":7,"app":"Terminal","bundleId":"com.apple.Terminal","title":"zsh"}',
      );
      order.push("text");
      return { code: 0, stdout: '{"text":"$ make\\nerror","truncated":true}', stderr: "" };
    };
    let pictured = false;
    const window = await mac(run).capture({ onPicture: () => (pictured = true) });
    expect(order).toEqual(["picture", "text"]);
    expect(pictured).toBe(true);
    expect(window).toEqual({
      image: new Uint8Array([137, 80, 78, 71]),
      app: "Terminal",
      bundleId: "com.apple.Terminal",
      title: "zsh",
      text: "$ make\nerror",
      textTruncated: true,
      window: { processId: 42, windowId: 7 },
    });
  });

  function browserCapture(bundleId: string, url: string): RunProcess {
    return async (file, args, options) => {
      if (args.includes("check")) return permissionsGranted(file, args, options);
      if (file === "/usr/sbin/screencapture") {
        await Bun.write(args.at(-1)!, new Uint8Array([137, 80, 78, 71]));
        return { code: 0, stdout: "", stderr: "" };
      }
      options.onStderrLine?.(
        `window {"pid":42,"windowId":7,"app":"Browser","bundleId":"${bundleId}","title":"Example"}`,
      );
      return {
        code: 0,
        stdout: JSON.stringify({ text: "Example Domain", truncated: false, url }),
        stderr: "",
      };
    };
  }

  test("keeps the page's address for a browser window, and says whether it is Chromium", async () => {
    const chrome = await mac(browserCapture("com.google.Chrome", "https://example.com/")).capture(
      {},
    );
    expect(chrome.browser).toEqual({ url: "https://example.com/", chromium: true });
    const safari = await mac(browserCapture("com.apple.Safari", "https://example.com/")).capture(
      {},
    );
    expect(safari.browser).toEqual({ url: "https://example.com/", chromium: false });
  });

  test("drops the address of a page embedded in an app that is not a browser", async () => {
    const app = await mac(
      browserCapture("com.tinyspeck.slackmacgap", "https://app.example.com/"),
    ).capture({});
    expect(app.browser).toBeUndefined();
    expect(app.text).toBe("Example Domain");
  });

  test("asks for Screen Recording before capturing anything", async () => {
    const denied: RunProcess = async () => ({
      code: 0,
      stdout: '{"screenRecording":false,"accessibility":true}',
      stderr: "",
    });
    await expect(mac(denied).capture({})).rejects.toMatchObject({
      code: "permission",
      permission: "screenRecording",
    });
  });

  test("says when no other app's window is on screen", async () => {
    const run: RunProcess = async (file, args, options) =>
      args.includes("check")
        ? permissionsGranted(file, args, options)
        : { code: 0, stdout: '{"error":"no_window"}', stderr: "" };
    await expect(mac(run).capture({})).rejects.toMatchObject({ code: "no_window" });
  });

  // The scripts are plain text to TypeScript; only the system's osascript can
  // tell whether each call they make is bridged.
  test.skipIf(process.platform !== "darwin")(
    "run under the system's osascript (macOS only)",
    async () => {
      const real = new MacAppShots({
        ownPid: process.pid,
        openSystemSettings: () => undefined,
        guide: () => undefined,
        requested: () => [],
        markRequested: () => undefined,
        onPermissionsChange: () => undefined,
      });
      const permissions = await real.permissions();
      expect(permissions.map((permission) => permission.id)).toEqual([
        "screenRecording",
        "accessibility",
      ]);
      for (const permission of permissions) expect(typeof permission.granted).toBe("boolean");
    },
  );
});

describe("the controller", () => {
  function controller(
    platform: AppShotPlatform | null,
    settings?: Partial<DesktopAppShotSettings>,
  ) {
    let saved: DesktopAppShotSettings = { ...defaultAppShotSettings("darwin"), ...settings };
    const registered = new Map<string, () => void>();
    const delivered: DesktopAppShotResult[] = [];
    const events: string[] = [];
    const shots = new AppShots({
      platform,
      store: { read: () => saved, write: (next) => (saved = next) },
      globalShortcut: {
        register: (accelerator, callback) => {
          if (accelerator === "Command+Taken") return false;
          registered.set(accelerator, callback);
          return true;
        },
        unregister: (accelerator) => void registered.delete(accelerator),
      },
      reveal: () => events.push("reveal"),
      deliver: (result) => {
        events.push("deliver");
        delivered.push(result);
      },
      onChange: () => undefined,
      now: () => new Date("2026-10-20T08:00:00.000Z"),
    });
    return { shots, registered, delivered, events, saved: () => saved };
  }

  function fakePlatform(overrides: Partial<AppShotPlatform> = {}) {
    const watching: Array<() => void> = [];
    const platform: AppShotPlatform = {
      platform: "macos",
      modifierPairs: ["command"],
      permissions: async () => [{ id: "screenRecording", granted: true }],
      requestPermission: async () => undefined,
      capture: async ({ onPicture }) => {
        onPicture?.();
        return { image: new Uint8Array([1]), app: "Safari", title: "Docs", text: "Hello" };
      },
      watchModifierPair: async (_modifier, onTrigger) => {
        watching.push(onTrigger);
        return () => void watching.splice(watching.indexOf(onTrigger), 1);
      },
      ...overrides,
    };
    return { platform, watching };
  }

  test("watches the key pair only while on", async () => {
    const { platform, watching } = fakePlatform();
    const { shots, saved } = controller(platform);
    shots.start();
    await Bun.sleep(0);
    expect(watching).toHaveLength(0);
    await shots.update({ enabled: true });
    expect(watching).toHaveLength(1);
    expect(saved().enabled).toBe(true);
    await shots.update({ enabled: false });
    expect(watching).toHaveLength(0);
  });

  test("moves between a key pair and a key combination", async () => {
    const { platform, watching } = fakePlatform();
    const { shots, registered } = controller(platform, { enabled: true });
    await shots.update({ shortcut: { kind: "accelerator", accelerator: "Command+Shift+2" } });
    expect(watching).toHaveLength(0);
    expect([...registered.keys()]).toEqual(["Command+Shift+2"]);
    const status = await shots.update({
      shortcut: { kind: "accelerator", accelerator: "Command+Taken" },
    });
    expect(registered.size).toBe(0);
    expect(status.shortcutError).toContain("taken");
  });

  test("delivers a capture after bringing the app forward", async () => {
    const { platform, watching } = fakePlatform();
    const { shots, delivered, events } = controller(platform);
    await shots.update({ enabled: true });
    watching[0]!();
    await Bun.sleep(0);
    expect(events).toEqual(["reveal", "deliver"]);
    expect(delivered[0]).toEqual({
      ok: true,
      shot: {
        image: new Uint8Array([1]),
        mimeType: "image/png",
        app: "Safari",
        title: "Docs",
        capturedAt: "2026-10-20T08:00:00.000Z",
        platform: "macos",
        text: "Hello",
      },
    });
  });

  test("reports a failed capture instead of attaching anything", async () => {
    const { platform } = fakePlatform({
      capture: async () => {
        throw new AppShotError("permission", "Allow Screen Recording.", "screenRecording");
      },
    });
    const { shots, delivered } = controller(platform, { enabled: true });
    await shots.trigger();
    expect(delivered).toEqual([
      {
        ok: false,
        code: "permission",
        message: "Allow Screen Recording.",
        permission: "screenRecording",
      },
    ]);
  });

  test("ignores the shortcut while a capture is in progress", async () => {
    let release: () => void = () => undefined;
    let captures = 0;
    const { platform } = fakePlatform({
      capture: async () => {
        captures += 1;
        await new Promise<void>((resolve) => (release = resolve));
        return { image: new Uint8Array([1]), app: "Safari", title: "" };
      },
    });
    const { shots } = controller(platform, { enabled: true });
    const first = shots.trigger();
    void shots.trigger();
    release();
    await first;
    expect(captures).toBe(1);
  });

  test("is unsupported without a platform", async () => {
    const { shots } = controller(null);
    expect(await shots.status()).toMatchObject({ supported: false, permissions: [] });
  });
});
