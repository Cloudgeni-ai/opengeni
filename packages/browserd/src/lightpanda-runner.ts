import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import type { AgentBrowserJsonCommand, AgentBrowserRunOptions } from "./runner";
import type { ResolvedLightpandaBinary } from "./lightpanda-binary";

const START_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 3_000;
const MAX_START_OUTPUT_BYTES = 256 * 1024;
const LISTEN_PATTERN = /\baddress=127\.0\.0\.1:([1-9][0-9]{0,4})\b/u;

export type LightpandaRunnerOptions = {
  binary: ResolvedLightpandaBinary;
  sessionDirectory: string;
};

type LightpandaProcess = ChildProcessByStdio<null, Readable, Readable>;

/** Private lifecycle wrapper for Lightpanda's CDP server. Page targets remain
 * controller-owned and are created on AgentBrowserDriver's exact connection. */
export class LightpandaRunner {
  readonly run: AgentBrowserJsonCommand;
  private readonly binary: ResolvedLightpandaBinary;
  private readonly sessionDirectory: string;
  private child: LightpandaProcess | null = null;
  private endpoint: string | null = null;
  private starting: Promise<string> | null = null;

  private constructor(options: LightpandaRunnerOptions) {
    this.binary = options.binary;
    this.sessionDirectory = resolve(options.sessionDirectory);
    this.run = async <T>(args: readonly string[], runOptions?: AgentBrowserRunOptions) =>
      (await this.command(args, runOptions)) as T;
  }

  static async create(options: LightpandaRunnerOptions): Promise<LightpandaRunner> {
    await mkdir(resolve(options.sessionDirectory), { recursive: true, mode: 0o700 });
    return new LightpandaRunner(options);
  }

  async terminate(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.endpoint = null;
    this.starting = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    if (await waitForExit(child, STOP_TIMEOUT_MS)) return;
    child.kill("SIGKILL");
    if (!(await waitForExit(child, STOP_TIMEOUT_MS))) {
      throw new Error("Lightpanda process did not terminate");
    }
  }

  private async command(
    args: readonly string[],
    options: AgentBrowserRunOptions = {},
  ): Promise<unknown> {
    if (options.signal?.aborted) throw abortError();
    if (args.length === 2 && args[0] === "get" && args[1] === "cdp-url") {
      return { cdpUrl: await this.ensureStarted(options.signal) };
    }
    throw new Error(`Lightpanda lifecycle command is unsupported: ${args.join(" ")}`);
  }

  private async ensureStarted(signal?: AbortSignal): Promise<string> {
    if (
      this.endpoint &&
      this.child &&
      this.child.exitCode === null &&
      this.child.signalCode === null
    ) {
      return this.endpoint;
    }
    if (this.starting) return await abortable(this.starting, signal);
    const starting = this.startProcess();
    this.starting = starting;
    void starting.then(
      () => {
        if (this.starting === starting) this.starting = null;
      },
      () => {
        if (this.starting === starting) this.starting = null;
      },
    );
    // A caller abort does not cancel the shared physical startup. Another
    // caller may safely join it; explicit terminate remains the sole owner of
    // process cancellation.
    return await abortable(starting, signal);
  }

  private async startProcess(): Promise<string> {
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
      throw new Error("Lightpanda process exists without a usable endpoint");
    }
    const storagePath = join(this.sessionDirectory, "storage.sqlite");
    const child = spawn(
      this.binary.path,
      [
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        "0",
        "--log-level",
        "warn",
        "--storage-engine",
        "sqlite",
        "--storage-sqlite-path",
        storagePath,
      ],
      {
        cwd: this.sessionDirectory,
        env: isolatedEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: false,
      },
    );
    this.child = child;
    try {
      const endpoint = await waitForEndpoint(child);
      if (this.child !== child) throw new Error("Lightpanda lifecycle changed during startup");
      this.endpoint = endpoint;
      child.once("exit", () => {
        if (this.child !== child) return;
        this.child = null;
        this.endpoint = null;
      });
      return endpoint;
    } catch (error) {
      if (this.child === child) this.child = null;
      this.endpoint = null;
      child.kill("SIGKILL");
      await waitForExit(child, STOP_TIMEOUT_MS).catch(() => false);
      throw error;
    }
  }
}

function isolatedEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    LIGHTPANDA_DISABLE_TELEMETRY: "true",
    HOME: process.env.HOME,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    SSL_CERT_FILE: process.env.SSL_CERT_FILE,
    SSL_CERT_DIR: process.env.SSL_CERT_DIR,
  };
  for (const key of Object.keys(environment)) {
    if (environment[key] === undefined) delete environment[key];
  }
  return environment;
}

async function waitForEndpoint(child: LightpandaProcess): Promise<string> {
  return await new Promise<string>((resolveEndpoint, rejectEndpoint) => {
    let settled = false;
    let bytes = 0;
    let buffered = "";
    const settle = (result: { endpoint?: string; error?: Error }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Keep the output listeners attached after readiness. Their settled fast
      // path discards later output, continuously draining both pipes without
      // retaining page-controlled log text or allowing the child to block.
      child.off("error", onError);
      child.off("exit", onExit);
      if (result.endpoint) resolveEndpoint(result.endpoint);
      else rejectEndpoint(result.error ?? new Error("Lightpanda failed to start"));
    };
    const onData = (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.byteLength;
      if (bytes > MAX_START_OUTPUT_BYTES) {
        settle({ error: new Error("Lightpanda startup output exceeded its envelope") });
        return;
      }
      buffered = `${buffered}${chunk.toString("utf8")}`.slice(-16 * 1024);
      const match = buffered.match(LISTEN_PATTERN);
      if (!match) return;
      const port = Number(match[1]);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        settle({ error: new Error("Lightpanda reported an invalid listening port") });
        return;
      }
      settle({ endpoint: `ws://127.0.0.1:${port}/` });
    };
    const onError = () => settle({ error: new Error("Lightpanda process could not start") });
    const onExit = () => settle({ error: new Error("Lightpanda exited before becoming ready") });
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    const timer = setTimeout(
      () => settle({ error: new Error("Lightpanda startup timed out") }),
      START_TIMEOUT_MS,
    );
    timer.unref?.();
  });
}

async function waitForExit(child: LightpandaProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise<boolean>((resolveExit) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolveExit(false);
    }, timeoutMs);
    timer.unref?.();
    const onExit = () => {
      clearTimeout(timer);
      resolveExit(true);
    };
    child.once("exit", onExit);
  });
}

async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return await promise;
  if (signal.aborted) throw abortError();
  let rejectAbort: ((error: Error) => void) | null = null;
  const onAbort = () => rejectAbort?.(abortError());
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
    rejectAbort = null;
  }
}

function abortError(): Error {
  return Object.assign(new Error("Lightpanda startup was aborted"), { name: "AbortError" });
}
