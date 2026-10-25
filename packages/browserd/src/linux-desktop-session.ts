import { spawn } from "node:child_process";
import { z } from "zod";

/** The person's desktop on a Linux machine, as the native helper found it, or
 * why there is none in plain words. */
export type LinuxDesktopSession =
  | { display: string; xauthority: string | null }
  | { unavailable: string };

/** Looks up the desktop with the environment the ComputerSession will use. */
export type LinuxDesktopSessionFinder = (
  environment: NodeJS.ProcessEnv,
) => Promise<LinuxDesktopSession>;

const LOOKUP_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 16_384;

const Answer = z.union([
  z.object({
    display: z.string().min(1).max(256),
    xauthority: z.string().min(1).max(4_096).nullable(),
  }),
  z.object({ unavailable: z.string().min(1).max(2_048) }),
]);

/**
 * A per-user agent service can start before anyone signs in, so this
 * controller may have no `DISPLAY` or `XAUTHORITY`. The native helper finds
 * the session the same way the agent does (its own user's graphical login),
 * so each ComputerSession joins the desktop that is there when it opens.
 */
export function nativeLinuxDesktopSession(
  binaryPath: string,
  timeoutMs = LOOKUP_TIMEOUT_MS,
): LinuxDesktopSessionFinder {
  return async (environment) =>
    Answer.parse(JSON.parse(await runLookup(binaryPath, environment, timeoutMs)));
}

async function runLookup(
  binaryPath: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<string> {
  const child = spawn(binaryPath, ["desktop-session"], {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  let bytes = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes <= MAX_OUTPUT_BYTES) stdout.push(chunk);
  });
  child.stderr.resume();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("the desktop session lookup timed out"));
      }, timeoutMs);
    });
    if (code !== 0) throw new Error(`the desktop session lookup exited with ${code}`);
    if (bytes > MAX_OUTPUT_BYTES) throw new Error("the desktop session lookup answer is too large");
    return Buffer.concat(stdout).toString("utf8");
  } finally {
    clearTimeout(timer);
  }
}
