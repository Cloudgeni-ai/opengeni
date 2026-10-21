// App-shots on macOS, with the system's own tools: `osascript` finds the
// window and reads its accessibility text, `screencapture` takes its picture.
// Both run as the app's children, so macOS asks for, and checks, the app's own
// Screen Recording and Accessibility permissions.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DesktopAppShotModifier, DesktopAppShotPermissionId } from "../../contract";
import { MAC_CAPTURE_SCRIPT, MAC_MODIFIER_PAIR_SCRIPT, MAC_PERMISSIONS_SCRIPT } from "./mac-script";
import { AppShotError, type AppShotPlatform, type CapturedWindow } from "./platform";

/** Most window text kept, as the server stores it. */
export const APP_SHOT_TEXT_MAX_CHARS = 32_000;
/** How long reading a window's text may take before what was read is kept. */
export const APP_SHOT_READ_BUDGET_MS = 3_000;
/** A capture whose helper never reports back is abandoned after this long. */
const CAPTURE_HELPER_TIMEOUT_MS = APP_SHOT_READ_BUDGET_MS + 7_000;
const PERMISSION_HELPER_TIMEOUT_MS = 10_000;

const OSASCRIPT = "/usr/bin/osascript";
const SCREENCAPTURE = "/usr/sbin/screencapture";
const AFPLAY = "/usr/bin/afplay";
/** The sound macOS makes for its own screenshots. */
const CAPTURE_SOUND =
  "/System/Library/Components/CoreAudio.component/Contents/SharedSupport/SystemSounds/system/Screen Capture.aif";

/** Device-dependent flag bits of the left and right key of each modifier. */
const MODIFIER_PAIR_MASKS: Record<DesktopAppShotModifier, readonly [number, number]> = {
  command: [0x8, 0x10],
  option: [0x20, 0x40],
  control: [0x1, 0x2000],
  shift: [0x2, 0x4],
};

const SETTINGS_PANES: Record<DesktopAppShotPermissionId, string> = {
  screenRecording: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
};

export interface MacWindowInfo {
  pid: number;
  windowId: number;
  app: string;
  bundleId: string;
  title: string;
}

/** The capture script's first report, `window {...}`, or null for any other line. */
export function parseWindowLine(line: string): MacWindowInfo | null {
  if (!line.startsWith("window ")) return null;
  try {
    const value = JSON.parse(line.slice("window ".length)) as Record<string, unknown>;
    if (
      typeof value.pid !== "number" ||
      typeof value.windowId !== "number" ||
      !Number.isSafeInteger(value.pid) ||
      !Number.isSafeInteger(value.windowId)
    ) {
      return null;
    }
    return {
      pid: value.pid,
      windowId: value.windowId,
      app: typeof value.app === "string" ? value.app : "",
      bundleId: typeof value.bundleId === "string" ? value.bundleId : "",
      title: typeof value.title === "string" ? value.title : "",
    };
  } catch {
    return null;
  }
}

export type MacTextResult =
  | { kind: "text"; text: string; truncated: boolean; url?: string }
  | { kind: "error"; error: "no_window" | "accessibility" | "unreadable" };

/** A web page's address worth keeping: http or https, within reason. */
export function pageUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 4_096) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** The capture script's final output on stdout. */
export function parseTextResult(stdout: string): MacTextResult {
  try {
    const value = JSON.parse(stdout.trim()) as Record<string, unknown>;
    if (value.error === "no_window" || value.error === "accessibility") {
      return { kind: "error", error: value.error };
    }
    if (typeof value.text === "string") {
      const url = pageUrl(value.url);
      return {
        kind: "text",
        text: value.text.slice(0, APP_SHOT_TEXT_MAX_CHARS),
        truncated: value.truncated === true || value.text.length > APP_SHOT_TEXT_MAX_CHARS,
        ...(url ? { url } : {}),
      };
    }
  } catch {
    // Fall through: a crashed or killed script.
  }
  return { kind: "error", error: "unreadable" };
}

// Web browsers by bundle id. Many apps embed web pages; only a browser's page
// is one the person can open again, so only a browser's address is kept.
// Chromium-based browsers can carry the Opengeni browser extension.
const CHROMIUM_BROWSERS =
  /^(com\.google\.Chrome(\.(beta|dev|canary))?|org\.chromium\.Chromium|com\.brave\.Browser(\.(beta|nightly))?|com\.microsoft\.edgemac(\.(Beta|Dev|Canary))?|com\.vivaldi\.Vivaldi|company\.thebrowser\.Browser|com\.operasoftware\.Opera)$/u;
const OTHER_BROWSERS =
  /^(com\.apple\.Safari|com\.apple\.SafariTechnologyPreview|org\.mozilla\.firefox)$/u;

/** What kind of web browser an app is, by its bundle id; null for any other app. */
export function macBrowserKind(bundleId: string): "chromium" | "other" | null {
  if (CHROMIUM_BROWSERS.test(bundleId)) return "chromium";
  if (OTHER_BROWSERS.test(bundleId)) return "other";
  return null;
}

export function screencaptureArguments(windowId: number, path: string): string[] {
  // -l one window, -o without its shadow, -x silently, PNG.
  return [`-l${windowId}`, "-o", "-x", "-t", "png", path];
}

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type RunProcess = (
  file: string,
  args: readonly string[],
  options: { timeoutMs: number; onStderrLine?: (line: string) => void },
) => Promise<ProcessResult>;

/** Runs a helper to its end, reporting its stderr line by line as it goes. */
export const runProcess: RunProcess = (file, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let partial = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      partial += text;
      const lines = partial.split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) options.onStderrLine?.(line);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (partial) options.onStderrLine?.(partial);
      resolve({ code, stdout, stderr });
    });
  });

export interface MacAppShotDeps {
  /** The app's own process, whose windows are never captured. */
  ownPid: number;
  run?: RunProcess;
  openSystemSettings(url: string): void;
  /** Show the app's permission guide beside System Settings; null hides it. */
  guide(id: DesktopAppShotPermissionId | null, granted?: boolean): void;
  /** Permissions already asked for once: the system prompt shows only the first time. */
  requested(): readonly DesktopAppShotPermissionId[];
  markRequested(id: DesktopAppShotPermissionId): void;
  /** Permissions changed while the person was allowing one. */
  onPermissionsChange(): void;
}

const GRANT_WATCH_MS = 1_000;
const GRANT_WATCH_LIMIT_MS = 5 * 60_000;

export class MacAppShots implements AppShotPlatform {
  readonly platform = "macos" as const;
  readonly modifierPairs: DesktopAppShotModifier[] = ["command", "option", "control", "shift"];
  private readonly run: RunProcess;
  private grantWatch: { timer: NodeJS.Timeout; id: DesktopAppShotPermissionId } | null = null;

  constructor(private readonly deps: MacAppShotDeps) {
    this.run = deps.run ?? runProcess;
  }

  async permissions(): Promise<{ id: DesktopAppShotPermissionId; granted: boolean }[]> {
    return await this.permissionScript("check");
  }

  async requestPermission(id: DesktopAppShotPermissionId): Promise<void> {
    const askedBefore = this.deps.requested().includes(id);
    this.deps.markRequested(id);
    const now = await this.permissionScript(
      id === "screenRecording" ? "request-screen" : "request-accessibility",
    ).catch(() => null);
    if (now?.find((permission) => permission.id === id)?.granted) return;
    // The system asks only the first time; after that the switch is in System Settings.
    if (askedBefore || !now) this.deps.openSystemSettings(SETTINGS_PANES[id]);
    this.deps.guide(id);
    this.watchForGrant(id);
  }

  async capture(options: { onPicture?: () => void }): Promise<CapturedWindow> {
    const permissions = await this.permissions();
    if (!permissions.find((permission) => permission.id === "screenRecording")?.granted) {
      throw new AppShotError(
        "permission",
        "Allow Screen Recording to send app-shots.",
        "screenRecording",
      );
    }
    const directory = await mkdtemp(join(tmpdir(), "app-shot-"));
    const imagePath = join(directory, "window.png");
    try {
      let window: MacWindowInfo | null = null;
      let picture: Promise<ProcessResult> | null = null;
      const script = await this.run(
        OSASCRIPT,
        [
          "-l",
          "JavaScript",
          "-e",
          MAC_CAPTURE_SCRIPT,
          String(this.deps.ownPid),
          String(APP_SHOT_TEXT_MAX_CHARS),
          String(APP_SHOT_READ_BUDGET_MS),
        ],
        {
          timeoutMs: CAPTURE_HELPER_TIMEOUT_MS,
          onStderrLine: (line) => {
            const found = window ? null : parseWindowLine(line);
            if (!found) return;
            window = found;
            // The picture is taken while the text is read.
            picture = this.run(SCREENCAPTURE, screencaptureArguments(found.windowId, imagePath), {
              timeoutMs: CAPTURE_HELPER_TIMEOUT_MS,
            }).then((result) => {
              if (result.code === 0) {
                this.playCaptureSound();
                options.onPicture?.();
              }
              return result;
            });
          },
        },
      );
      const text = parseTextResult(script.stdout);
      const found = window as MacWindowInfo | null;
      if (!found || !picture) {
        if (text.kind === "error" && text.error === "no_window") {
          throw new AppShotError("no_window", "No other app's window is on screen.");
        }
        throw new AppShotError("failed", "Couldn't find the window in front.");
      }
      const shot = await (picture as Promise<ProcessResult>);
      const image = shot.code === 0 ? await readFile(imagePath).catch(() => null) : null;
      if (!image || image.byteLength === 0) {
        throw new AppShotError("failed", "Couldn't take a picture of the window.");
      }
      const browserKind = macBrowserKind(found.bundleId);
      const url = text.kind === "text" && browserKind ? text.url : undefined;
      return {
        image: new Uint8Array(image),
        app: found.app || found.bundleId || "App",
        ...(found.bundleId ? { bundleId: found.bundleId } : {}),
        title: found.title,
        ...(text.kind === "text" && text.text.trim()
          ? { text: text.text, ...(text.truncated ? { textTruncated: true } : {}) }
          : {}),
        window: { processId: found.pid, windowId: found.windowId },
        ...(url && browserKind ? { browser: { url, chromium: browserKind === "chromium" } } : {}),
      };
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  watchModifierPair(
    modifier: DesktopAppShotModifier,
    onTrigger: () => void,
    onFailure: (error: Error) => void,
  ): Promise<() => void> {
    const [left, right] = MODIFIER_PAIR_MASKS[modifier];
    const child = spawn(
      OSASCRIPT,
      ["-l", "JavaScript", "-e", MAC_MODIFIER_PAIR_SCRIPT, String(left), String(right)],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    return new Promise((resolve, reject) => {
      let ready = false;
      let stopped = false;
      let partial = "";
      const stop = () => {
        if (stopped) return;
        stopped = true;
        child.kill();
      };
      const fail = (error: Error) => {
        if (stopped) return;
        stop();
        if (ready) onFailure(error);
        else reject(error);
      };
      child.stderr.on("data", (chunk: Buffer) => {
        partial += chunk.toString("utf8");
        const lines = partial.split("\n");
        partial = lines.pop() ?? "";
        for (const line of lines.map((entry) => entry.trim())) {
          if (line === "ready" && !ready) {
            ready = true;
            resolve(stop);
          } else if (line === "trigger" && ready && !stopped) {
            onTrigger();
          }
        }
      });
      child.once("error", fail);
      child.once("exit", (code) => fail(new Error(`The shortcut helper stopped (${code}).`)));
    });
  }

  private async permissionScript(
    action: "check" | "request-screen" | "request-accessibility",
  ): Promise<{ id: DesktopAppShotPermissionId; granted: boolean }[]> {
    const result = await this.run(
      OSASCRIPT,
      ["-l", "JavaScript", "-e", MAC_PERMISSIONS_SCRIPT, action],
      {
        timeoutMs: PERMISSION_HELPER_TIMEOUT_MS,
      },
    );
    const value = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    return [
      { id: "screenRecording", granted: value.screenRecording === true },
      { id: "accessibility", granted: value.accessibility === true },
    ];
  }

  /** While the person is in System Settings: confirm the grant once it lands. */
  private watchForGrant(id: DesktopAppShotPermissionId): void {
    if (this.grantWatch) clearTimeout(this.grantWatch.timer);
    const until = Date.now() + GRANT_WATCH_LIMIT_MS;
    const tick = async () => {
      const granted = await this.permissions()
        .then((list) => list.find((permission) => permission.id === id)?.granted === true)
        .catch(() => false);
      if (granted) {
        this.grantWatch = null;
        this.deps.guide(id, true);
        this.deps.onPermissionsChange();
        return;
      }
      if (Date.now() > until) {
        this.grantWatch = null;
        this.deps.guide(null);
        return;
      }
      this.grantWatch = { id, timer: setTimeout(() => void tick(), GRANT_WATCH_MS) };
    };
    this.grantWatch = { id, timer: setTimeout(() => void tick(), GRANT_WATCH_MS) };
  }

  private playCaptureSound(): void {
    if (!existsSync(CAPTURE_SOUND)) return;
    const player = spawn(AFPLAY, [CAPTURE_SOUND], { stdio: "ignore" });
    player.once("error", () => undefined);
    player.unref();
  }
}
