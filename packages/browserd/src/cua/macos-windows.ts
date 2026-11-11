import { spawn } from "node:child_process";
import { z } from "zod";

/** Why a window on the current Space is not on screen (see the computer-native
 * `window presence` command). */
export type MacWindowPresence = "minimized" | "application_hidden" | "not_shown" | "unknown";

export type MacWindowQuery = {
  processId: number;
  title: string;
  bounds: { x: number; y: number; width: number; height: number };
};

/** Whether this login session's windows are on the Mac's screen: not while
 * the screen is locked or shows the login window, nor while another user's
 * session is on it (see the computer-native `window console` command). */
export type MacConsoleState = "available" | "locked" | "other_user";

/** What CUA cannot do on macOS: say why a window is not on screen, and bring a
 * minimized window or a hidden app's window back behind the person's front
 * window without activating its app; and say whether this session's windows
 * are on screen at all. */
export interface MacWindows {
  presence(windows: readonly MacWindowQuery[]): Promise<MacWindowPresence[]>;
  /** Restores a minimized or hidden window; returns what it was before. */
  restore(window: MacWindowQuery): Promise<MacWindowPresence>;
  console(): Promise<MacConsoleState>;
}

const Presence = z.enum(["minimized", "application_hidden", "not_shown", "unknown"]);
const Console = z.enum(["available", "locked", "other_user"]);

/** The screen check runs before listing, every action and heartbeats, all
 * queued behind one another; a helper that hangs must not stall them. */
const CONSOLE_TIMEOUT_MS = 2_500;

/** The packaged computer-native helper, run once per command. */
export function computerNativeMacWindows(
  binaryPath: string,
  consoleTimeoutMs = CONSOLE_TIMEOUT_MS,
): MacWindows {
  return {
    async presence(windows) {
      if (windows.length === 0) return [];
      const { presences } = z
        .object({ presences: z.array(Presence).length(windows.length) })
        .parse(await run(binaryPath, "presence", { windows }));
      return presences;
    },
    async restore(window) {
      return z.object({ presence: Presence }).parse(await run(binaryPath, "restore", { window }))
        .presence;
    },
    async console() {
      return z
        .object({ console: Console })
        .parse(await run(binaryPath, "console", {}, consoleTimeoutMs)).console;
    },
  };
}

async function run(
  binaryPath: string,
  command: string,
  request: unknown,
  timeoutMs?: number,
): Promise<unknown> {
  const child = spawn(binaryPath, ["window", command], { stdio: ["pipe", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
    // Gives up when the timer fires, without waiting for the killed helper
    // to exit: one stuck in an uninterruptible call may never close.
    if (timeoutMs !== undefined)
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`computer-native window ${command} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
  });
  child.stdin.end(JSON.stringify(request));
  const code = await exited.finally(() => clearTimeout(timer));
  if (code !== 0)
    throw new Error(
      `computer-native window ${command} failed: ${Buffer.concat(stderr).toString("utf8").trim().slice(0, 2_000)}`,
    );
  return JSON.parse(Buffer.concat(stdout).toString("utf8"));
}
