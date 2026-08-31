import { posix as posixPath } from "node:path";
import { BROWSER_CONTROL_PORT } from "@opengeni/contracts";

export { BROWSER_CONTROL_PORT };

export const BROWSER_CONTROL_SERVER_TIMEOUT_MS = 60_000;
export const BROWSER_CONTROL_STATE_DIRECTORY = "/tmp/opengeni-browserd/state";
export const BROWSER_CONTROL_SERVER_BIN = "/usr/local/bin/opengeni-browserd-up";
export const BROWSER_CONTROL_SERVER_DOWN_BIN = "/usr/local/bin/opengeni-browserd-down";

export class BrowserControlServerError extends Error {
  readonly exitCode: number;
  readonly stage: "startup" | "port_conflict" | "engine_unavailable" | "unknown";

  constructor(exitCode: number, output: string) {
    const stage = classifyBrowserControlStage(exitCode, output);
    super(
      `browser control server failed at stage "${stage}" (exit ${exitCode})${output ? `:\n${output}` : ""}`,
    );
    this.name = "BrowserControlServerError";
    this.exitCode = exitCode;
    this.stage = stage;
  }
}

export class BrowserControlServerUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserControlServerUnsupportedError";
  }
}

type ExecResultLike = {
  output?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
};

type ExecCapableSession = {
  exec?: (args: {
    cmd: string;
    workdir?: string;
    yieldTimeMs?: number;
    maxOutputTokens?: number;
    timeoutMs?: number;
    deadlineAtMs?: number;
    signal?: AbortSignal;
  }) => Promise<ExecResultLike>;
  execCommand?: (args: {
    cmd: string;
    workdir?: string;
    yieldTimeMs?: number;
    maxOutputTokens?: number;
    timeoutMs?: number;
    deadlineAtMs?: number;
    signal?: AbortSignal;
  }) => Promise<string>;
};

// Image-backed controller commands use absolute private paths under /tmp, but
// managed sandbox exec confines `workdir` to the canonical workspace root.
// Keep the cwd stable without asking the provider to validate /tmp as a
// workspace path.
const PLACEMENT_CONTROLLER_WORKDIR = "/workspace";

export type EnsureBrowserControlServerOptions = {
  port?: number;
  timeoutMs?: number;
  adminTokenFile: string;
  allowedOrigins?: readonly string[];
  signal?: AbortSignal;
  deadlineAtMs?: number;
};

export type EnsureBrowserControlServerResult = {
  port: number;
  marker: string;
};

export function buildBrowserControlServerScript(
  options: Pick<EnsureBrowserControlServerOptions, "adminTokenFile"> &
    Partial<Pick<EnsureBrowserControlServerOptions, "port" | "allowedOrigins">>,
): string {
  const port = boundedPort(options.port ?? BROWSER_CONTROL_PORT);
  const tokenFile = absolutePath(options.adminTokenFile, "browser controller admin token file");
  const allowedOrigins = normalizeOrigins(options.allowedOrigins ?? []);
  return [
    "mkdir -p /tmp/opengeni-browserd &&",
    `if ! test -x ${BROWSER_CONTROL_SERVER_BIN}; then echo 'opengeni-browserd-up is not installed on this sandbox image' >&2; exit 16; fi &&`,
    "flock -w 30 --close /tmp/opengeni-browserd/up.outer.lock",
    `env OPENGENI_BROWSERD_PORT=${port}`,
    `OPENGENI_BROWSERD_ROOT=${shellQuote(BROWSER_CONTROL_STATE_DIRECTORY)}`,
    `OPENGENI_BROWSERD_ADMIN_TOKEN_FILE=${shellQuote(tokenFile)}`,
    `OPENGENI_BROWSERD_ALLOWED_ORIGINS=${shellQuote(allowedOrigins.join(","))}`,
    "OPENGENI_CODEMODE_TOKEN_FILE=/dev/null",
    BROWSER_CONTROL_SERVER_BIN,
  ].join(" ");
}

export async function ensureBrowserControlServer(
  session: unknown,
  options: EnsureBrowserControlServerOptions,
): Promise<EnsureBrowserControlServerResult> {
  options.signal?.throwIfAborted();
  const target = session as ExecCapableSession;
  if (typeof target?.exec !== "function" && typeof target?.execCommand !== "function") {
    throw new BrowserControlServerUnsupportedError(
      "provider session cannot run commands (no exec/execCommand) — browser control unavailable",
    );
  }
  const port = boundedPort(options.port ?? BROWSER_CONTROL_PORT);
  const timeoutMs = boundedTimeout(options.timeoutMs ?? BROWSER_CONTROL_SERVER_TIMEOUT_MS);
  const cmd = buildBrowserControlServerScript({
    port,
    adminTokenFile: options.adminTokenFile,
    ...(options.allowedOrigins ? { allowedOrigins: options.allowedOrigins } : {}),
  });
  const result = target.exec
    ? await target.exec({
        cmd,
        workdir: PLACEMENT_CONTROLLER_WORKDIR,
        yieldTimeMs: timeoutMs,
        maxOutputTokens: 4_000,
        timeoutMs,
        ...(options.deadlineAtMs === undefined ? {} : { deadlineAtMs: options.deadlineAtMs }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
    : await target.execCommand!({
        cmd,
        workdir: PLACEMENT_CONTROLLER_WORKDIR,
        yieldTimeMs: timeoutMs,
        maxOutputTokens: 4_000,
        timeoutMs,
        ...(options.deadlineAtMs === undefined ? {} : { deadlineAtMs: options.deadlineAtMs }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
  const output = outputOf(result);
  options.signal?.throwIfAborted();
  const exitCode = exitCodeOf(result) ?? inferExitCode(output);
  if (exitCode !== 0) throw new BrowserControlServerError(exitCode, output);
  const marker = (output.match(/OPENGENI_BROWSERD_UP[^\n]*/) ?? [""])[0];
  if (!marker) {
    throw new BrowserControlServerError(
      14,
      output || "browser controller did not emit its readiness marker",
    );
  }
  return { port, marker };
}

export async function tearDownBrowserControlServer(
  session: unknown,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<void> {
  options.signal?.throwIfAborted();
  const target = session as ExecCapableSession;
  const timeoutMs = boundedTimeout(options.timeoutMs ?? 15_000);
  if (target?.exec) {
    await target.exec({
      cmd: BROWSER_CONTROL_SERVER_DOWN_BIN,
      workdir: PLACEMENT_CONTROLLER_WORKDIR,
      yieldTimeMs: timeoutMs,
      maxOutputTokens: 4_000,
    });
  } else if (target?.execCommand) {
    await target.execCommand({
      cmd: BROWSER_CONTROL_SERVER_DOWN_BIN,
      workdir: PLACEMENT_CONTROLLER_WORKDIR,
      yieldTimeMs: timeoutMs,
      maxOutputTokens: 4_000,
    });
  }
  options.signal?.throwIfAborted();
}

function outputOf(result: ExecResultLike | string): string {
  if (typeof result === "string") return result;
  return [result.output, result.stderr, result.stdout]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");
}

function exitCodeOf(result: ExecResultLike | string): number | null {
  return typeof result === "string" || typeof result.exitCode !== "number" ? null : result.exitCode;
}

function classifyBrowserControlStage(
  exitCode: number,
  output: string,
): BrowserControlServerError["stage"] {
  if (exitCode === 14) return "startup";
  if (exitCode === 15) return "port_conflict";
  if (exitCode === 16 || isMissingBrowserControlServer(exitCode, output)) {
    return "engine_unavailable";
  }
  return "unknown";
}

function isMissingBrowserControlServer(exitCode: number, output: string): boolean {
  if (exitCode === 127) return true;
  return /opengeni-browserd-up[^\n]*No such file or directory|opengeni-browserd-up is not installed on this sandbox image/u.test(
    output,
  );
}

function inferExitCode(output: string): number {
  if (/OPENGENI_BROWSERD_UP\b/u.test(output)) return 0;
  if (/occupied by an unmanaged process/u.test(output)) return 15;
  if (/no supported Chromium engine/u.test(output) || isMissingBrowserControlServer(-1, output)) {
    return 16;
  }
  if (/exited during startup|failed to become ready/u.test(output)) return 14;
  return -1;
}

function boundedPort(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new RangeError("browser controller port is invalid");
  }
  return value;
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10 * 60_000) {
    throw new RangeError("browser controller timeout is invalid");
  }
  return value;
}

function absolutePath(value: string, label: string): string {
  if (!value || value.includes("\0") || !posixPath.isAbsolute(value)) {
    throw new Error(`${label} must be absolute`);
  }
  return posixPath.normalize(value);
}

function normalizeOrigins(values: readonly string[]): string[] {
  if (values.length > 64) throw new Error("too many browser controller origins");
  return values.map((value) => {
    const url = new URL(value);
    if (url.origin === "null" || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("browser controller origin must be an absolute origin");
    }
    return url.origin;
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
