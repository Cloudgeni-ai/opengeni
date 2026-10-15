import { createHash, randomBytes } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  createReadStream,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { VaultProviderError, type VaultProviderAuthority } from "./contract";
import {
  NOT_AUTHENTICATED,
  SESSION_INVALIDATED,
  isDefiniteMutationFailure,
  loginFailure,
  mapProtonFailure,
  outcomeUnknown,
} from "./errors";
import { type ProcessResult, type ProcessRunner, runProcess } from "./runner";
import { InfoOutput } from "./schema";

/** The only pass-cli release whose argv, JSON output and errors this adapter was built against. */
export const PROTON_PASS_CLI_VERSION = "2.4.2";
/** A PAT login session is treated as stale before Proton's 2 h session lifetime. */
export const PROTON_PASS_SESSION_MAX_AGE_MS = 105 * 60_000;
export const PROTON_PASS_IDLE_CLOSE_MS = 15 * 60_000;
export const PROTON_PASS_COMMAND_TIMEOUT_MS = 60_000;
export const PROTON_PASS_MAX_STDOUT_BYTES = 32 * 1024 * 1024;
/** pass/src/monitor MAX_REASON_LENGTH. */
export const PROTON_PASS_MAX_REASON_CHARS = 300;
/** pass-cli processes allowed at once across every Proton connection in this process. */
export const PROTON_PASS_MAX_PROCESSES = 4;

const MAX_STDERR_BYTES = 16 * 1024;
const SMALL_STDOUT_BYTES = 256 * 1024;
const PASSTHROUGH_ENV = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

export interface ProtonCliOptions {
  /** Absolute path to an operator-installed pass-cli; defaults to `pass-cli` on PATH. */
  binaryPath?: string;
  /** Exact `pass-cli --version` semver to accept (default 2.4.2). */
  expectedVersion?: string;
  /** Optional SHA-256 (hex) the binary must match. */
  expectedSha256?: string;
  /** Parent of per-connection state directories (default `<tmpdir>/opengeni-protonpass`). */
  stateRoot?: string;
  commandTimeoutMs?: number;
  maxStdoutBytes?: number;
  sessionMaxAgeMs?: number;
  idleCloseMs?: number;
  now?: () => number;
  /** Process runner (tests). Defaults to a no-shell, bounded `spawn`. */
  runner?: ProcessRunner;
  /** Process environment used only to resolve PATH and proxy settings (tests). */
  hostEnv?: Readonly<Record<string, string | undefined>>;
}

export interface ProtonCommand {
  args: readonly string[];
  stdin?: string;
  /** Short action name for errors and the agent reason, e.g. "list items". */
  subject: string;
  authority?: VaultProviderAuthority;
  signal?: AbortSignal;
  /** Set for writes: failures are definite only with this context and a server verdict. */
  mutationContext?: RegExp;
  /** Error code when stdout exceeds its bound (list: inventory incomplete). */
  overflowCode?: "provider_inventory_incomplete" | "provider_unavailable";
  maxStdoutBytes?: number;
}

export interface ProtonSessionInfo {
  tokenName: string | null;
  agent: boolean;
}

// --- process-wide bookkeeping ------------------------------------------------

export interface SlotSemaphore {
  /** Resolves with a release function once a slot is held; rejects if `signal` aborts first. */
  acquire(signal?: AbortSignal): Promise<() => void>;
  /** Slots held, including ones handed to a waiter that has not resumed yet. */
  active(): number;
  waiting(): number;
}

/**
 * A FIFO counting semaphore. A released slot is handed straight to the next
 * waiter (the count never drops in between), so a caller arriving while the
 * waiter resumes cannot take the same slot and exceed `limit`.
 */
export function createSlotSemaphore(limit: number): SlotSemaphore {
  let active = 0;
  const waiters: Array<() => void> = [];
  function releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = waiters.shift();
      if (next) next();
      else active -= 1;
    };
  }
  return {
    async acquire(signal) {
      if (active < limit) {
        active += 1;
        return releaser();
      }
      await new Promise<void>((resolveSlot, reject) => {
        if (signal?.aborted) {
          reject(signal.reason ?? new Error("aborted"));
          return;
        }
        const ready = () => {
          signal?.removeEventListener("abort", onAbort);
          resolveSlot();
        };
        const onAbort = () => {
          const index = waiters.indexOf(ready);
          if (index >= 0) waiters.splice(index, 1);
          reject(signal?.reason ?? new Error("aborted"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        waiters.push(ready);
      });
      // The releasing caller transferred its slot; `active` already counts it.
      return releaser();
    },
    active: () => active,
    waiting: () => waiters.length,
  };
}

const processSlots = createSlotSemaphore(PROTON_PASS_MAX_PROCESSES);
function acquireProcessSlot(signal?: AbortSignal): Promise<() => void> {
  return processSlots.acquire(signal);
}

const liveStateDirs = new Set<string>();
let exitHookInstalled = false;
function trackStateDir(dir: string) {
  liveStateDirs.add(dir);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const path of liveStateDirs) {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {
        // Best effort at exit.
      }
    }
  });
}

// --- helpers -------------------------------------------------------------------

function unavailable(message: string): VaultProviderError {
  return new VaultProviderError("provider_unavailable", message);
}

function findOnPath(command: string, pathValue: string | undefined): string | null {
  for (const dir of (pathValue ?? "").split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, command);
    try {
      accessSync(candidate, fsConstants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not here.
    }
  }
  return null;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Creates (or checks) a private directory owned by this process's user. */
export function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw unavailable("The Proton Pass state directory is not a private directory");
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw unavailable("The Proton Pass state directory is owned by another user");
  }
  if ((stat.mode & 0o077) !== 0) chmodSync(path, 0o700);
}

/** A reason for Proton's agent audit log, built only from trusted identifiers. */
export function agentReason(subject: string, authority?: VaultProviderAuthority): string {
  const clean = (value: string) => value.replace(/[^A-Za-z0-9:._-]/g, "").slice(0, 64);
  const parts = [`Opengeni ${subject.replace(/[^A-Za-z0-9 ._-]/g, "")}`];
  if (authority) {
    parts.push(`workspace ${clean(authority.workspaceId)}`);
    if (authority.sessionId) parts.push(`session ${clean(authority.sessionId)}`);
    if (authority.turnId) parts.push(`turn ${clean(authority.turnId)}`);
    if (authority.subjectId) parts.push(`subject ${clean(authority.subjectId)}`);
  }
  return parts.join("; ").slice(0, PROTON_PASS_MAX_REASON_CHARS);
}

function succeeded(result: ProcessResult): boolean {
  return (
    result.exitCode === 0 &&
    result.signal === null &&
    !result.timedOut &&
    !result.aborted &&
    !result.stdoutOverflow &&
    result.spawnError === null
  );
}

/**
 * One logged-in pass-cli state for one personal access token. Every call is
 * serialized (pass-cli keeps a single SQLite session store per directory), the
 * session is renewed before Proton's 2 h limit, and the directory with its
 * encrypted session is wiped after idling or on close.
 */
export class ProtonCliSession {
  private readonly runner: ProcessRunner;
  private readonly now: () => number;
  private readonly hostEnv: Readonly<Record<string, string | undefined>>;
  private readonly encryptionKey = randomBytes(32).toString("hex");
  private binary: Promise<string> | null = null;
  private dir: string | null = null;
  private loggedInAt: number | null = null;
  private info: ProtonSessionInfo | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(
    private readonly token: string,
    private readonly options: ProtonCliOptions = {},
  ) {
    this.runner = options.runner ?? runProcess;
    this.now = options.now ?? Date.now;
    this.hostEnv = options.hostEnv ?? process.env;
  }

  /** The state directory while a session is open (tests and diagnostics). */
  get stateDirectory(): string | null {
    return this.dir;
  }

  get sessionInfo(): ProtonSessionInfo | null {
    return this.info;
  }

  /** Runs one pass-cli command after ensuring a fresh login; returns stdout. */
  run(command: ProtonCommand): Promise<string> {
    return this.serialize(async () => (await this.execute(command)).stdout);
  }

  /** Login state for `validate`: logs in when needed and returns the token identity. */
  ensureSession(signal?: AbortSignal): Promise<ProtonSessionInfo> {
    return this.serialize(async () => {
      await this.ensureLogin(signal);
      return this.info!;
    });
  }

  /** Allocates a private directory inside the session state for one download. */
  privateScratchDir(): string {
    const dir = this.requireDir();
    return mkdtempSync(join(dir, "dl-"));
  }

  /** Logs out (best effort) and wipes the state directory. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    await this.queue.catch(() => {});
    await this.teardown();
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(unavailable("The Proton Pass connection is closed"));
    this.pending += 1;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const run = this.queue.then(work, work);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run.finally(() => {
      this.pending -= 1;
      if (this.pending === 0 && !this.closed) this.armIdleClose();
    });
  }

  private armIdleClose() {
    if (this.dir === null) return;
    const idleMs = this.options.idleCloseMs ?? PROTON_PASS_IDLE_CLOSE_MS;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.pending > 0 || this.closed) return;
      void this.serialize(() => this.teardown()).catch(() => {});
    }, idleMs);
    this.idleTimer.unref?.();
  }

  private async teardown(): Promise<void> {
    const dir = this.dir;
    if (!dir) return;
    if (this.loggedInAt !== null) {
      try {
        await this.spawn({ args: ["logout"], subject: "sign out" }, false, 10_000);
      } catch {
        // The directory wipe below removes the session either way.
      }
    }
    this.loggedInAt = null;
    this.info = null;
    this.dir = null;
    liveStateDirs.delete(dir);
    rmSync(dir, { recursive: true, force: true });
  }

  private requireDir(): string {
    if (this.dir) return this.dir;
    const root = resolve(this.options.stateRoot ?? join(tmpdir(), "opengeni-protonpass"));
    ensurePrivateDirectory(root);
    const dir = mkdtempSync(join(root, "pp-"));
    ensurePrivateDirectory(dir);
    trackStateDir(dir);
    this.dir = dir;
    return dir;
  }

  private sessionDir(): string {
    return join(this.requireDir(), "session");
  }

  private baseEnv(): Record<string, string> {
    const dir = this.requireDir();
    const env: Record<string, string> = {
      HOME: dir,
      TZ: "UTC",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      PATH: "/usr/bin:/bin",
      PROTON_PASS_SESSION_DIR: this.sessionDir(),
      PROTON_PASS_KEY_PROVIDER: "env",
      PROTON_PASS_ENCRYPTION_KEY: this.encryptionKey,
      PROTON_PASS_DISABLE_TELEMETRY: "1",
      PROTON_PASS_NO_UPDATE_CHECK: "1",
      PASS_LOG_LEVEL: "off",
    };
    for (const name of PASSTHROUGH_ENV) {
      const value = this.hostEnv[name];
      if (value) env[name] = value;
    }
    return env;
  }

  private async resolveBinary(): Promise<string> {
    this.binary ??= (async () => {
      const configured = this.options.binaryPath;
      if (configured !== undefined && !isAbsolute(configured)) {
        throw unavailable("The pass-cli path must be absolute");
      }
      const found = configured ?? findOnPath("pass-cli", this.hostEnv.PATH);
      if (!found) throw unavailable("pass-cli is not installed on this Opengeni server");
      let path: string;
      try {
        path = realpathSync(found);
        const stat = statSync(path);
        if (!stat.isFile()) throw new Error("not a file");
        if ((stat.mode & 0o002) !== 0) {
          throw unavailable("pass-cli is world-writable; refusing to run it");
        }
        accessSync(path, fsConstants.X_OK);
      } catch (error) {
        if (error instanceof VaultProviderError) throw error;
        throw unavailable("pass-cli is not an executable file");
      }
      const expectedSha = this.options.expectedSha256?.toLowerCase();
      if (expectedSha && (await sha256File(path)) !== expectedSha) {
        throw unavailable("pass-cli does not match the configured SHA-256");
      }
      const expected = this.options.expectedVersion ?? PROTON_PASS_CLI_VERSION;
      const result = await this.runner({
        file: path,
        args: ["--version"],
        env: { HOME: this.requireDir(), PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
        cwd: this.requireDir(),
        timeoutMs: 10_000,
        maxStdoutBytes: 4096,
        maxStderrBytes: 4096,
      });
      const version = /\b(\d+\.\d+\.\d+)\b/.exec(result.stdout)?.[1];
      if (!succeeded(result) || !version) {
        throw unavailable("pass-cli --version failed");
      }
      if (version !== expected) {
        throw unavailable(
          `pass-cli ${version} is not supported; install pass-cli ${expected} for this Opengeni release`,
        );
      }
      return path;
    })();
    this.binary.catch(() => {
      this.binary = null;
    });
    return this.binary;
  }

  private async spawn(
    command: Pick<
      ProtonCommand,
      "args" | "stdin" | "subject" | "authority" | "signal" | "maxStdoutBytes"
    >,
    withToken: boolean,
    timeoutMs?: number,
  ): Promise<ProcessResult> {
    const file = await this.resolveBinary();
    const env = this.baseEnv();
    if (withToken) env.PROTON_PASS_PERSONAL_ACCESS_TOKEN = this.token;
    else env.PROTON_PASS_AGENT_REASON = agentReason(command.subject, command.authority);
    const release = await acquireProcessSlot(command.signal);
    try {
      return await this.runner({
        file,
        args: command.args,
        env,
        cwd: this.requireDir(),
        ...(command.stdin !== undefined ? { stdin: command.stdin } : {}),
        timeoutMs: timeoutMs ?? this.options.commandTimeoutMs ?? PROTON_PASS_COMMAND_TIMEOUT_MS,
        maxStdoutBytes:
          command.maxStdoutBytes ?? this.options.maxStdoutBytes ?? PROTON_PASS_MAX_STDOUT_BYTES,
        maxStderrBytes: MAX_STDERR_BYTES,
        ...(command.signal ? { signal: command.signal } : {}),
      });
    } finally {
      release();
    }
  }

  private sessionFresh(): boolean {
    if (this.loggedInAt === null || this.info === null) return false;
    const maxAge = this.options.sessionMaxAgeMs ?? PROTON_PASS_SESSION_MAX_AGE_MS;
    return this.now() - this.loggedInAt < maxAge;
  }

  private async ensureLogin(signal?: AbortSignal): Promise<void> {
    if (this.sessionFresh()) return;
    await this.login(signal);
  }

  private async login(signal?: AbortSignal): Promise<void> {
    this.loggedInAt = null;
    this.info = null;
    // A fresh login replaces any earlier session state in this directory.
    const sessionDir = this.sessionDir();
    rmSync(sessionDir, { recursive: true, force: true });
    mkdirSync(sessionDir, { mode: 0o700 });
    const result = await this.spawn(
      {
        args: ["login"],
        subject: "sign in",
        maxStdoutBytes: SMALL_STDOUT_BYTES,
        ...(signal ? { signal } : {}),
      },
      true,
    );
    if (!succeeded(result)) {
      signal?.throwIfAborted();
      throw loginFailure(result);
    }
    this.loggedInAt = this.now();
    const infoResult = await this.spawn(
      {
        args: ["info", "--output", "json"],
        subject: "read session info",
        maxStdoutBytes: SMALL_STDOUT_BYTES,
        ...(signal ? { signal } : {}),
      },
      false,
    );
    if (!succeeded(infoResult)) {
      this.loggedInAt = null;
      signal?.throwIfAborted();
      throw mapProtonFailure(infoResult, "read session info");
    }
    const parsed = InfoOutput.safeParse(parseJson(infoResult.stdout));
    if (!parsed.success) {
      this.loggedInAt = null;
      throw unavailable("pass-cli returned unexpected session info");
    }
    if (parsed.data.username !== undefined) {
      // A personal access token login never reports a user name.
      this.loggedInAt = null;
      throw new VaultProviderError(
        "provider_auth_invalid",
        "The Proton Pass session is not a personal access token session",
      );
    }
    const tokenName = parsed.data.personal_access_token_name ?? null;
    this.info = {
      tokenName: tokenName?.replace(/^\[Agent\] /, "") ?? null,
      agent: tokenName?.startsWith("[Agent] ") ?? false,
    };
  }

  private async execute(command: ProtonCommand): Promise<ProcessResult> {
    command.signal?.throwIfAborted();
    await this.ensureLogin(command.signal);
    let result = await this.spawn(command, false);
    if (!succeeded(result) && !result.timedOut && !result.aborted) {
      if (NOT_AUTHENTICATED.test(result.stderr)) {
        // Pre-flight: nothing reached Proton, so one relogin and retry is safe for writes too.
        await this.login(command.signal);
        result = await this.spawn(command, false);
      } else if (SESSION_INVALIDATED.test(result.stderr)) {
        this.loggedInAt = null;
        this.info = null;
        if (command.mutationContext) throw outcomeUnknown(command.subject);
        await this.login(command.signal);
        result = await this.spawn(command, false);
      }
    }
    if (succeeded(result)) return result;
    if (SESSION_INVALIDATED.test(result.stderr) || NOT_AUTHENTICATED.test(result.stderr)) {
      this.loggedInAt = null;
      this.info = null;
    }
    if (command.mutationContext) {
      if (!isDefiniteMutationFailure(result, command.mutationContext)) {
        throw outcomeUnknown(command.subject);
      }
      throw mapProtonFailure(result, command.subject);
    }
    if (result.aborted) command.signal?.throwIfAborted();
    if (result.stdoutOverflow) {
      throw new VaultProviderError(
        command.overflowCode ?? "provider_unavailable",
        `Proton Pass returned more data than Opengeni reads at once (${command.subject})`,
      );
    }
    throw mapProtonFailure(result, command.subject);
  }
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
