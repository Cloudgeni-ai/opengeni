// Dictation on macOS with the system's own `osascript`: a watcher for
// shortcuts of modifier keys alone (Control and Fn, as Quedo has it), and
// Command-V into the app in front, which needs the Accessibility permission.

import { type ChildProcess, spawn } from "node:child_process";

import type {
  DesktopAppShotModifier,
  DesktopDictationModifier,
  DesktopDictationPermissionId,
} from "../../contract";
import { MAC_PERMISSIONS_SCRIPT } from "../app-shots/mac-script";
import { runProcess, type RunProcess } from "../app-shots/mac";
import { MAC_DICTATION_KEYS_SCRIPT, MAC_PASTE_SCRIPT } from "./mac-script";
import {
  DictationPasteError,
  type DictationModifierEvents,
  type DictationModifierWatch,
  type DictationPaste,
  type DictationPlatform,
} from "./platform";

const OSASCRIPT = "/usr/bin/osascript";
const ACCESSIBILITY_PANE =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
const PERMISSION_HELPER_TIMEOUT_MS = 10_000;
const PASTE_TIMEOUT_MS = 5_000;
const GRANT_WATCH_MS = 1_000;
const GRANT_WATCH_LIMIT_MS = 5 * 60_000;

/** Device-dependent flag bits of the left and right key of each modifier. */
const PAIR_MASKS: Record<DesktopAppShotModifier, readonly [number, number]> = {
  command: [0x8, 0x10],
  option: [0x20, 0x40],
  control: [0x1, 0x2000],
  shift: [0x2, 0x4],
};

/** Device-independent flag bit of each modifier. */
const CHORD_MASKS: Record<DesktopDictationModifier, number> = {
  shift: 0x20000,
  control: 0x40000,
  option: 0x80000,
  command: 0x100000,
  fn: 0x800000,
};

/** The watcher's argument for these shortcuts. */
export function macKeyWatchArgument(watches: readonly DictationModifierWatch[]): string {
  return JSON.stringify(
    watches.map((watch) =>
      watch.shortcut.kind === "modifierPair"
        ? { id: watch.id, pair: PAIR_MASKS[watch.shortcut.modifier] }
        : {
            id: watch.id,
            chord: watch.shortcut.modifiers.reduce((mask, key) => mask | CHORD_MASKS[key], 0),
          },
    ),
  );
}

/** One line from the watcher, or null for anything else. */
export function parseKeyLine(
  line: string,
):
  | { kind: "ready" }
  | { kind: "down"; id: string }
  | { kind: "up"; id: string; clean: boolean }
  | null {
  const trimmed = line.trim();
  if (trimmed === "ready") return { kind: "ready" };
  const down = /^down (\S+)$/u.exec(trimmed);
  if (down) return { kind: "down", id: down[1]! };
  const up = /^up (\S+) (clean|dirty)$/u.exec(trimmed);
  if (up) return { kind: "up", id: up[1]!, clean: up[2] === "clean" };
  return null;
}

export interface MacDictationDeps {
  run?: RunProcess;
  spawnProcess?: typeof spawn;
  openSystemSettings(url: string): void;
  /** Show the app's permission guide beside System Settings; null hides it. */
  guide(id: DesktopDictationPermissionId | null, granted?: boolean): void;
  /** Permissions already asked for once: the system prompt shows only the first time. */
  requested(): readonly DesktopDictationPermissionId[];
  markRequested(id: DesktopDictationPermissionId): void;
  /** Permissions changed while the person was allowing one. */
  onPermissionsChange(): void;
}

export class MacDictation implements DictationPlatform {
  readonly platform = "macos" as const;
  readonly modifierPairs: DesktopAppShotModifier[] = ["command", "option", "control", "shift"];
  readonly modifierChords = true;
  private readonly run: RunProcess;
  private readonly spawnProcess: typeof spawn;
  private grantWatch: NodeJS.Timeout | null = null;

  constructor(private readonly deps: MacDictationDeps) {
    this.run = deps.run ?? runProcess;
    this.spawnProcess = deps.spawnProcess ?? spawn;
  }

  async permissions(): Promise<{ id: DesktopDictationPermissionId; granted: boolean }[]> {
    return [{ id: "accessibility", granted: await this.accessibility("check") }];
  }

  async requestPermission(id: DesktopDictationPermissionId): Promise<void> {
    const askedBefore = this.deps.requested().includes(id);
    this.deps.markRequested(id);
    const granted = await this.accessibility("request-accessibility").catch(() => null);
    if (granted) return;
    // The system asks only the first time; after that the switch is in System Settings.
    if (askedBefore || granted === null) this.deps.openSystemSettings(ACCESSIBILITY_PANE);
    this.deps.guide(id);
    this.watchForGrant(id);
  }

  async pasteSupport(): Promise<{ available: boolean; reason: string | null }> {
    const granted = await this.accessibility("check").catch(() => false);
    return granted
      ? { available: true, reason: null }
      : {
          available: false,
          reason: "Allow Accessibility so dictation can type into other apps.",
        };
  }

  preparePaste(): DictationPaste {
    const child = this.spawnProcess(OSASCRIPT, ["-l", "JavaScript", "-e", MAC_PASTE_SCRIPT], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    return helperPaste(child, (stdout) => {
      if (stdout.includes('"accessibility"')) {
        throw new DictationPasteError(
          "Allow Accessibility so dictation can type into other apps.",
          "accessibility",
        );
      }
      if (!stdout.includes('"ok":true')) throw new DictationPasteError("Couldn't paste the text.");
    });
  }

  watchModifiers(
    watches: readonly DictationModifierWatch[],
    events: DictationModifierEvents,
    onFailure: (error: Error) => void,
  ): Promise<() => void> {
    const child = this.spawnProcess(
      OSASCRIPT,
      ["-l", "JavaScript", "-e", MAC_DICTATION_KEYS_SCRIPT, macKeyWatchArgument(watches)],
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
      child.stderr?.on("data", (chunk: Buffer) => {
        partial += chunk.toString("utf8");
        const lines = partial.split("\n");
        partial = lines.pop() ?? "";
        for (const line of lines) {
          const event = parseKeyLine(line);
          if (!event || stopped) continue;
          if (event.kind === "ready" && !ready) {
            ready = true;
            resolve(stop);
          } else if (event.kind === "down" && ready) {
            events.onDown(event.id);
          } else if (event.kind === "up" && ready) {
            events.onUp(event.id, event.clean);
          }
        }
      });
      child.once("error", fail);
      child.once("exit", (code) => fail(new Error(`The shortcut helper stopped (${code}).`)));
    });
  }

  private async accessibility(action: "check" | "request-accessibility"): Promise<boolean> {
    const result = await this.run(
      OSASCRIPT,
      ["-l", "JavaScript", "-e", MAC_PERMISSIONS_SCRIPT, action],
      {
        timeoutMs: PERMISSION_HELPER_TIMEOUT_MS,
      },
    );
    const value = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    return value.accessibility === true;
  }

  /** While the person is in System Settings: confirm the grant once it lands. */
  private watchForGrant(id: DesktopDictationPermissionId): void {
    if (this.grantWatch) clearTimeout(this.grantWatch);
    const until = Date.now() + GRANT_WATCH_LIMIT_MS;
    const tick = async () => {
      const granted = await this.accessibility("check").catch(() => false);
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
      this.grantWatch = setTimeout(() => void tick(), GRANT_WATCH_MS);
    };
    this.grantWatch = setTimeout(() => void tick(), GRANT_WATCH_MS);
  }
}

/**
 * A helper started ahead of the paste, which pastes when a line arrives on
 * its stdin and reports on stdout; closing stdin lets it go without pasting.
 */
export function helperPaste(
  child: ChildProcess,
  check: (stdout: string) => void,
  timeoutMs = PASTE_TIMEOUT_MS,
): DictationPaste {
  let stdout = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  // A helper that already gave up (no permission) closes its stdin early.
  child.stdin?.on("error", () => undefined);
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
  // A helper that couldn't start is reported by `paste`, not as an unhandled rejection.
  exited.catch(() => undefined);
  let used = false;
  return {
    paste: async () => {
      if (used) throw new DictationPasteError("Couldn't paste the text.");
      used = true;
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      try {
        child.stdin?.end("paste\n");
        await exited;
      } catch {
        throw new DictationPasteError("Couldn't paste the text.");
      } finally {
        clearTimeout(timer);
      }
      check(stdout);
    },
    cancel: () => {
      if (used) return;
      used = true;
      child.stdin?.end();
      setTimeout(() => child.kill(), 1_000).unref?.();
    },
  };
}
