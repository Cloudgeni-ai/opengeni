import {
  ConnectionConfig,
  Sandbox as ProviderSandbox,
  SandboxApiException,
  createDefaultAdapterFactory,
  type AdapterFactory,
  type ConnectionConfigOptions,
  type CreateSandboxRequest,
  type Endpoint,
  type Sandboxes,
} from "@alibaba-group/opensandbox";
import {
  Manifest,
  Permissions,
  SandboxArchiveError,
  SandboxConfigurationError,
  SandboxExposedPortUnavailableError,
  SandboxProviderError,
  SandboxUnsupportedFeatureError,
  normalizeRelativePath,
  normalizeSandboxClientCreateArgs,
  recordExposedPortEndpoint,
  resolveSandboxArchiveLimits,
  validateSandboxArchiveLimits,
  type Entry,
  type ExecCommandArgs,
  type ExposedPortEndpoint,
  type MaterializeEntryArgs,
  type SandboxArchiveLimits,
  type SandboxClientCreateArgs,
  type SandboxClientResumeOptions,
  type SandboxDirectoryEntry,
  type SandboxExecResult,
  type SandboxSessionState,
  type ViewImageArgs,
  type WorkspaceArchiveData,
  type WorkspaceArchiveOptions,
  type WriteStdinArgs,
} from "@openai/agents/sandbox";
import {
  deserializeManifest,
  elapsedSeconds,
  formatExecResponse,
  imageOutputFromBytes,
  mergeManifestDelta,
  mergeManifestEntryDelta,
  mergeMaterializedEnvironment,
  rehydratePersistedEnvironmentForRuntime,
  serializeManifestRecord,
  serializeRuntimeEnvironmentForPersistence,
  shellQuote,
  toUint8Array,
  truncateOutput,
} from "@openai/agents-core/sandbox/internal";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile as readLocalFile, readdir } from "node:fs/promises";
import { posix } from "node:path";
import { SandboxConfigError, SandboxExactResumeInstanceUnavailableError } from "../errors";
import { nextDurableOpId } from "../op-correlation";

const WORKSPACE_ROOT = "/workspace";
const PRIVATE_ROOT = "/tmp/opengeni-private";
const DEFAULT_EXEC_YIELD_TIME_MS = 10_000;
const DEFAULT_WRITE_STDIN_YIELD_TIME_MS = 250;
const OPENSANDBOX_STATE_VERSION = 1;

export type OpenSandboxApplyDiff = (
  input: string,
  diff: string,
  mode?: "default" | "create",
) => string;
let injectedApplyDiff: OpenSandboxApplyDiff | undefined;

export function setOpenSandboxApplyDiff(fn: OpenSandboxApplyDiff): void {
  injectedApplyDiff = fn;
}

export interface OpenSandboxEditor {
  createFile(
    operation: { path: string; diff: string },
    context?: unknown,
  ): Promise<{ output?: string } | void>;
  updateFile(
    operation: { path: string; diff: string; moveTo?: string },
    context?: unknown,
  ): Promise<{ output?: string } | void>;
  deleteFile(operation: { path: string }, context?: unknown): Promise<{ output?: string } | void>;
}

export type OpenSandboxClientOptions = {
  baseUrl: string;
  apiKey: string;
  image: string;
  ttlSeconds: number;
  useServerProxy: boolean;
  poolRef?: string;
  readyTimeoutSeconds: number;
  resourceLimits: Record<string, string>;
  resourceRequests: Record<string, string>;
  environment?: Record<string, string>;
  exposedPorts?: number[];
  adapterFactory?: AdapterFactory;
};

export interface OpenSandboxSessionState extends SandboxSessionState {
  stateVersion: typeof OPENSANDBOX_STATE_VERSION;
  sandboxId: string;
  manifest: Manifest;
  environment: Record<string, string>;
  image: string;
  poolRef: string | null;
  providerBindingHash: string;
  workspacePersistence: "tar";
  configuredExposedPorts: number[];
  workspaceReady: boolean;
  expiresAt: string | null;
}

type ProcessEvent = { stream: "stdout" | "stderr"; text: string };
type ProcessOutcome = {
  exitCode: number | null;
  error?: unknown;
  uncertain?: boolean;
};
type RetainedProcess = {
  opId: string;
  startedAt: number;
  events: ProcessEvent[];
  cursor: number;
  executionId: string | null;
  executionIdReady: Promise<string | null>;
  resolveExecutionId: (value: string | null) => void;
  completed: Promise<ProcessOutcome>;
  settled: boolean;
  transportUncertain: boolean;
};

function canonicalBaseUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.toString().replace(/\/$/u, "");
}

function providerBindingHash(baseUrl: string): string {
  return createHash("sha256").update(canonicalBaseUrl(baseUrl)).digest("hex");
}

function connectionOptions(input: OpenSandboxClientOptions): ConnectionConfigOptions {
  return {
    domain: canonicalBaseUrl(input.baseUrl),
    apiKey: input.apiKey,
    requestTimeoutSeconds: input.readyTimeoutSeconds,
    useServerProxy: input.useServerProxy,
    disableMetrics: true,
  };
}

async function withLifecycle<T>(
  options: OpenSandboxClientOptions,
  fn: (sandboxes: Sandboxes) => Promise<T>,
): Promise<T> {
  const connection = new ConnectionConfig(connectionOptions(options)).withTransportIfMissing();
  try {
    const factory = options.adapterFactory ?? createDefaultAdapterFactory();
    const stack = factory.createLifecycleStack({
      connectionConfig: connection,
      lifecycleBaseUrl: connection.getBaseUrl(),
    });
    return await fn(stack.sandboxes);
  } finally {
    await connection.closeTransport();
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof SandboxApiException && error.statusCode === 404;
}

function assertSupportedProviderState(
  info: { status?: { state?: unknown } },
  sandboxId: string,
): void {
  const state = info.status?.state;
  if (state !== "Running" && state !== "Creating") {
    throw new SandboxExactResumeInstanceUnavailableError("opensandbox", sandboxId);
  }
}

function normalizeConfiguredPorts(ports: readonly number[] | undefined): number[] {
  return [
    ...new Set(
      (ports ?? []).filter((port) => Number.isInteger(port) && port > 0 && port <= 65_535),
    ),
  ].sort((left, right) => left - right);
}

function assertNoSnapshot(args: ReturnType<typeof normalizeSandboxClientCreateArgs>): void {
  if (args.snapshot && (args.snapshot as { type?: unknown }).type !== "noop") {
    throw new SandboxUnsupportedFeatureError(
      "OpenSandbox v1 uses OpenGeni portable workspace archives and does not accept SDK snapshot specs.",
    );
  }
}

function createRequest(
  options: OpenSandboxClientOptions,
  environment: Record<string, string>,
): CreateSandboxRequest {
  const common = {
    timeout: options.ttlSeconds,
    env: environment,
    metadata: { opengeni: "true", backend: "opensandbox" },
  };
  if (options.poolRef) {
    return {
      ...common,
      extensions: { poolRef: options.poolRef },
    } as unknown as CreateSandboxRequest;
  }
  return {
    ...common,
    image: { uri: options.image },
    entrypoint: ["tail", "-f", "/dev/null"],
    resourceLimits: options.resourceLimits,
    resourceRequests: options.resourceRequests,
  };
}

function parseStateString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SandboxConfigError("opensandbox", `persisted OpenSandbox ${field} is invalid`);
  }
  return value;
}

function parseOptionalString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return parseStateString(value, field);
}

function assertStateMatchesOptions(
  state: OpenSandboxSessionState,
  options: OpenSandboxClientOptions,
): void {
  if (state.providerBindingHash !== providerBindingHash(options.baseUrl)) {
    throw new SandboxConfigError(
      "opensandbox",
      "persisted OpenSandbox provider binding does not match the configured base URL",
    );
  }
  if (state.image !== options.image) {
    throw new SandboxConfigError(
      "opensandbox",
      "persisted OpenSandbox image does not match OPENGENI_OPENSANDBOX_IMAGE",
    );
  }
  if (state.poolRef !== (options.poolRef ?? null)) {
    throw new SandboxConfigError(
      "opensandbox",
      "persisted OpenSandbox pool does not match OPENGENI_OPENSANDBOX_POOL_REF",
    );
  }
}

function workspacePath(path: string, options: { allowPrivate?: boolean } = {}): string {
  const raw = path.trim();
  if (raw.includes("\0") || raw.includes("\\")) {
    throw new SandboxConfigurationError(`Invalid OpenSandbox path: ${path}`);
  }
  const absolute = raw.startsWith("/") ? posix.normalize(raw) : posix.join(WORKSPACE_ROOT, raw);
  const allowed =
    absolute === WORKSPACE_ROOT ||
    absolute.startsWith(`${WORKSPACE_ROOT}/`) ||
    (options.allowPrivate === true &&
      (absolute === PRIVATE_ROOT || absolute.startsWith(`${PRIVATE_ROOT}/`)));
  if (!allowed) {
    throw new SandboxConfigurationError(
      `OpenSandbox path must stay within ${WORKSPACE_ROOT}${options.allowPrivate ? ` or ${PRIVATE_ROOT}` : ""}: ${path}`,
    );
  }
  return absolute;
}

function logicalWorkspacePath(path: string): string {
  const absolute = workspacePath(path);
  return absolute === WORKSPACE_ROOT ? "" : absolute.slice(WORKSPACE_ROOT.length + 1);
}

function assertRunAsUnsupported(runAs: string | undefined): void {
  if (runAs?.trim()) {
    throw new SandboxUnsupportedFeatureError(
      `OpenSandbox v1 cannot prove the uid/gid mapping for runAs="${runAs.trim()}"; the operation was not run.`,
    );
  }
}

function commandForArgs(args: ExecCommandArgs): string {
  const requestedShell = args.shell?.trim();
  if (!requestedShell) return args.cmd;
  return `${shellQuote(requestedShell)}${args.login === false ? "" : " -l"} -c ${shellQuote(args.cmd)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function consumeProcessOutput(process: RetainedProcess): {
  output: string;
  stdout: string;
  stderr: string;
} {
  const events = process.events.slice(process.cursor);
  process.cursor = process.events.length;
  return {
    output: events.map((entry) => entry.text).join(""),
    stdout: events
      .filter((entry) => entry.stream === "stdout")
      .map((entry) => entry.text)
      .join(""),
    stderr: events
      .filter((entry) => entry.stream === "stderr")
      .map((entry) => entry.text)
      .join(""),
  };
}

function archiveLimitArg(value: number | null): string {
  return value === null ? "-1" : String(value);
}

export function archiveRestoreScript(): string {
  return String.raw`
import os, shutil, sys, tarfile
archive, root, staging, backup, max_members, max_bytes, excluded_raw = sys.argv[1:]
max_members = int(max_members)
max_bytes = int(max_bytes)
excluded = [p for p in excluded_raw.split("\n") if p]
reserved_prefixes = (".opengeni-restore-", ".opengeni-old-")

def logical(name):
    name = name.replace("\\", "/")
    while name.startswith("./"):
        name = name[2:]
    if name in ("", "."):
        return ""
    if name.startswith("/"):
        raise ValueError("absolute archive member")
    normalized = os.path.normpath(name).replace("\\", "/")
    if normalized == ".." or normalized.startswith("../"):
        raise ValueError("escaping archive member")
    return normalized

def protected(name):
    return any(name == p or name.startswith(p + "/") for p in excluded)

def reserved(name):
    first = name.split("/", 1)[0]
    return any(first.startswith(prefix) for prefix in reserved_prefixes)

def workspace_child(path, prefix):
    root_abs = os.path.abspath(root)
    path_abs = os.path.abspath(path)
    if os.path.dirname(path_abs) != root_abs:
        raise ValueError("restore workspace path escaped root")
    if not os.path.basename(path_abs).startswith(prefix):
        raise ValueError("restore workspace path has an invalid prefix")
    return path_abs

def exists(path):
    return os.path.lexists(path)

with tarfile.open(archive, "r:*") as tf:
    members = tf.getmembers()
    if max_members >= 0 and len(members) > max_members:
        raise ValueError("archive member limit exceeded")
    total = 0
    checked = []
    for member in members:
        name = logical(member.name)
        if protected(name):
            raise ValueError("archive contains an ephemeral path")
        if reserved(name):
            raise ValueError("archive contains a reserved restore path")
        if not (member.isdir() or member.isreg()):
            raise ValueError("archive contains a non-file member")
        if member.isreg():
            total += member.size
            if max_bytes >= 0 and total > max_bytes:
                raise ValueError("archive extracted-byte limit exceeded")
        checked.append((member, name))
    shutil.rmtree(staging, ignore_errors=True)
    os.makedirs(staging, mode=0o700, exist_ok=False)
    for member, name in checked:
        target = os.path.join(staging, name)
        if member.isdir():
            os.makedirs(target, exist_ok=True)
            os.chmod(target, member.mode & 0o777)
            continue
        os.makedirs(os.path.dirname(target), exist_ok=True)
        source = tf.extractfile(member)
        if source is None:
            raise ValueError("archive file has no content")
        with source, open(target, "wb") as dest:
            shutil.copyfileobj(source, dest)
        os.chmod(target, member.mode & 0o777)

if not os.path.isdir(root):
    raise ValueError("workspace root does not exist")
staging = workspace_child(staging, ".opengeni-restore-")
backup = workspace_child(backup, ".opengeni-old-")
shutil.rmtree(backup, ignore_errors=True)
os.makedirs(backup, mode=0o700, exist_ok=False)
moved_old = []
moved_new = []
try:
    for name in sorted(os.listdir(root)):
        if name in (os.path.basename(staging), os.path.basename(backup)):
            continue
        os.replace(os.path.join(root, name), os.path.join(backup, name))
        moved_old.append(name)
    for name in sorted(os.listdir(staging)):
        os.replace(os.path.join(staging, name), os.path.join(root, name))
        moved_new.append(name)
except Exception as swap_error:
    rollback_errors = []
    for name in reversed(moved_new):
        current = os.path.join(root, name)
        restored = os.path.join(staging, name)
        try:
            if exists(current):
                os.replace(current, restored)
        except Exception as error:
            rollback_errors.append(str(error))
    for name in reversed(moved_old):
        saved = os.path.join(backup, name)
        current = os.path.join(root, name)
        try:
            if exists(saved):
                os.replace(saved, current)
        except Exception as error:
            rollback_errors.append(str(error))
    if rollback_errors:
        raise RuntimeError("workspace restore rollback failed: " + "; ".join(rollback_errors)) from swap_error
    raise
shutil.rmtree(backup)
shutil.rmtree(staging)
`;
}

export class OpenSandboxSession {
  readonly backendId = "opensandbox" as const;
  readonly state: OpenSandboxSessionState;
  private readonly options: OpenSandboxClientOptions;
  private provider: ProviderSandbox | null = null;
  private startPromise: Promise<ProviderSandbox> | null = null;
  private archiveLimits: SandboxArchiveLimits | null | undefined;
  private nextSessionId = 1;
  private readonly processesBySession = new Map<number, RetainedProcess>();
  private readonly processesByOpId = new Map<string, RetainedProcess>();

  constructor(args: {
    state: OpenSandboxSessionState;
    options: OpenSandboxClientOptions;
    archiveLimits?: SandboxArchiveLimits | null;
  }) {
    this.state = args.state;
    this.options = args.options;
    this.setArchiveLimits(args.archiveLimits);
  }

  setArchiveLimits(limits?: SandboxArchiveLimits | null): void {
    validateSandboxArchiveLimits(limits);
    this.archiveLimits = limits;
  }

  private async ensureStarted(): Promise<ProviderSandbox> {
    if (this.provider) return this.provider;
    if (!this.startPromise) {
      this.startPromise = ProviderSandbox.connect({
        connectionConfig: connectionOptions(this.options),
        sandboxId: this.state.sandboxId,
        readyTimeoutSeconds: this.options.readyTimeoutSeconds,
        ...(this.options.adapterFactory ? { adapterFactory: this.options.adapterFactory } : {}),
      })
        .then(async (provider) => {
          const info = await provider.getInfo();
          assertSupportedProviderState(info, this.state.sandboxId);
          if (info.id !== this.state.sandboxId) {
            await provider.close().catch(() => undefined);
            throw new SandboxProviderError("OpenSandbox connected to an unexpected sandbox ID", {
              expectedSandboxId: this.state.sandboxId,
              actualSandboxId: info.id,
            });
          }
          const image = info.image?.uri;
          // Pool-backed BatchSandbox GET responses use "unknown" because the CR records a
          // poolRef instead of an inline Pod template. Keep direct-image verification strict.
          const providerReportedImage =
            image && (this.state.poolRef === null || image !== "unknown") ? image : null;
          if (providerReportedImage && providerReportedImage !== this.state.image) {
            await provider.close().catch(() => undefined);
            throw new SandboxProviderError("OpenSandbox image changed for the persisted sandbox", {
              sandboxId: this.state.sandboxId,
            });
          }
          const poolRef =
            info.extensions && typeof info.extensions.poolRef === "string"
              ? info.extensions.poolRef
              : null;
          if (poolRef !== null && poolRef !== this.state.poolRef) {
            await provider.close().catch(() => undefined);
            throw new SandboxProviderError("OpenSandbox pool changed for the persisted sandbox", {
              sandboxId: this.state.sandboxId,
            });
          }
          this.provider = provider;
          this.state.expiresAt = info.expiresAt?.toISOString() ?? this.state.expiresAt;
          return provider;
        })
        .catch((error) => {
          this.startPromise = null;
          if (isNotFound(error)) {
            throw new SandboxExactResumeInstanceUnavailableError(
              "opensandbox",
              this.state.sandboxId,
            );
          }
          throw error;
        });
    }
    return await this.startPromise;
  }

  async start(): Promise<void> {
    await this.ensureInitialManifestMaterialized();
  }

  async running(): Promise<boolean> {
    try {
      return await withLifecycle(this.options, async (sandboxes) => {
        const info = await sandboxes.getSandbox(this.state.sandboxId);
        return this.state.workspaceReady && info.status.state === "Running";
      });
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async renewExpiration(): Promise<string | null> {
    const expiresAt = new Date(Date.now() + this.options.ttlSeconds * 1000).toISOString();
    const response = await withLifecycle(
      this.options,
      async (sandboxes) =>
        await sandboxes.renewSandboxExpiration(this.state.sandboxId, {
          expiresAt,
        }),
    );
    this.state.expiresAt = response.expiresAt?.toISOString() ?? expiresAt;
    return this.state.expiresAt;
  }

  async delete(): Promise<void> {
    try {
      await withLifecycle(this.options, async (sandboxes) => {
        await sandboxes.deleteSandbox(this.state.sandboxId);
      });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    } finally {
      await this.close();
    }
  }

  async close(): Promise<void> {
    const provider = this.provider;
    this.provider = null;
    this.startPromise = null;
    if (provider) await provider.close();
  }

  supportsPty(): boolean {
    return false;
  }

  async commandCancellationTransport(): Promise<"remote_operation"> {
    return "remote_operation";
  }

  private async ensureInitialManifestMaterialized(): Promise<void> {
    const provider = await this.ensureStarted();
    if (this.state.workspaceReady) return;
    await provider.files.createDirectories([{ path: WORKSPACE_ROOT }]);
    for (const [path, entry] of Object.entries(this.state.manifest.entries)) {
      await this.materialize(path, entry);
    }
    this.state.workspaceReady = true;
  }
  private beginCommand(args: ExecCommandArgs): RetainedProcess {
    const opId = nextDurableOpId() ?? `anon_${randomUUID()}`;
    let resolveExecutionId!: (value: string | null) => void;
    const executionIdReady = new Promise<string | null>((resolve) => {
      resolveExecutionId = resolve;
    });
    const process: RetainedProcess = {
      opId,
      startedAt: Date.now(),
      events: [],
      cursor: 0,
      executionId: null,
      executionIdReady,
      resolveExecutionId,
      completed: Promise.resolve({ exitCode: 1 }),
      settled: false,
      transportUncertain: false,
    };
    this.processesByOpId.set(opId, process);
    process.completed = this.ensureStarted()
      .then(async (provider) => {
        const execution = await provider.commands.run(
          commandForArgs(args),
          {
            workingDirectory: args.workdir ? workspacePath(args.workdir) : WORKSPACE_ROOT,
            envs: this.state.environment,
          },
          {
            onInit: (init) => {
              process.executionId = init.id;
              process.resolveExecutionId(init.id);
            },
            onStdout: (message) => {
              process.events.push({ stream: "stdout", text: message.text });
            },
            onStderr: (message) => {
              process.events.push({ stream: "stderr", text: message.text });
            },
          },
        );
        if (!process.executionId) {
          process.executionId = execution.id ?? null;
          process.resolveExecutionId(process.executionId);
        }
        const exitCode =
          typeof execution.exitCode === "number" ? execution.exitCode : execution.error ? 1 : 0;
        return {
          exitCode,
          ...(execution.error ? { error: execution.error } : {}),
        };
      })
      .catch((error) => {
        process.events.push({
          stream: "stderr",
          text: `${error instanceof Error ? error.message : String(error)}\n`,
        });
        if (process.executionId) {
          process.transportUncertain = true;
          return { exitCode: null, error, uncertain: true };
        }
        process.resolveExecutionId(null);
        return { exitCode: 1, error };
      })
      .finally(() => {
        if (!process.transportUncertain) {
          process.settled = true;
          this.processesByOpId.delete(opId);
        }
      });
    return process;
  }

  async exec(args: ExecCommandArgs): Promise<SandboxExecResult> {
    if (args.tty) {
      throw new SandboxUnsupportedFeatureError(
        "OpenSandbox v1 does not expose a bidirectional PTY; run the command with tty=false.",
      );
    }
    assertRunAsUnsupported(args.runAs);
    if (args.workdir) workspacePath(args.workdir);
    const process = this.beginCommand(args);
    const yieldTimeMs = args.yieldTimeMs ?? DEFAULT_EXEC_YIELD_TIME_MS;
    const outcome = await Promise.race([
      process.completed.then((value) => ({ done: true as const, value })),
      delay(yieldTimeMs).then(() => ({ done: false as const })),
    ]);
    const consumed = consumeProcessOutput(process);
    const output = truncateOutput(consumed.output, args.maxOutputTokens);
    if (outcome.done) {
      if (outcome.value.uncertain) {
        const sessionId = this.nextSessionId++;
        this.processesBySession.set(sessionId, process);
        return {
          output: output.text,
          stdout: consumed.stdout,
          stderr: consumed.stderr,
          wallTimeSeconds: elapsedSeconds(process.startedAt),
          sessionId,
          ...(output.originalTokenCount !== undefined
            ? { originalTokenCount: output.originalTokenCount }
            : {}),
        };
      }
      if (outcome.value.error && !process.executionId) throw outcome.value.error;
      return {
        output: output.text,
        stdout: consumed.stdout,
        stderr: consumed.stderr,
        wallTimeSeconds: elapsedSeconds(process.startedAt),
        exitCode: outcome.value.exitCode,
        ...(output.originalTokenCount !== undefined
          ? { originalTokenCount: output.originalTokenCount }
          : {}),
      };
    }
    const sessionId = this.nextSessionId++;
    this.processesBySession.set(sessionId, process);
    return {
      output: output.text,
      stdout: consumed.stdout,
      stderr: consumed.stderr,
      wallTimeSeconds: elapsedSeconds(process.startedAt),
      sessionId,
      ...(output.originalTokenCount !== undefined
        ? { originalTokenCount: output.originalTokenCount }
        : {}),
    };
  }

  async execCommand(args: ExecCommandArgs): Promise<string> {
    return formatExecResponse(await this.exec(args));
  }

  hasRetainedProcess(providerSessionId: number): boolean {
    return this.processesBySession.has(providerSessionId);
  }

  async cancelExecCommand(opId: string): Promise<boolean> {
    const process = this.processesByOpId.get(opId);
    if (!process) return false;
    const executionId = process.executionId ?? (await process.executionIdReady);
    if (!executionId) return process.settled;
    const provider = await this.ensureStarted();
    await provider.commands.interrupt(executionId);
    return true;
  }

  async writeStdin(args: WriteStdinArgs): Promise<string> {
    const process = this.processesBySession.get(args.sessionId);
    if (!process) {
      return formatExecResponse({
        output: `write_stdin failed: session not found: ${args.sessionId}`,
        wallTimeSeconds: 0,
        exitCode: 1,
      });
    }
    const chars = args.chars ?? "";
    const unsupportedChars = chars.replaceAll("\u0003", "");
    if (unsupportedChars.length > 0) {
      throw new SandboxUnsupportedFeatureError(
        "OpenSandbox v1 retained commands support polling and Ctrl-C interrupt, not arbitrary stdin.",
      );
    }
    const startedAt = Date.now();
    if (chars.includes("\u0003")) {
      const executionId = process.executionId ?? (await process.executionIdReady);
      if (executionId) {
        const provider = await this.ensureStarted();
        await provider.commands.interrupt(executionId);
      }
    }
    if (process.transportUncertain) {
      const executionId = process.executionId;
      if (!executionId) {
        throw new SandboxProviderError(
          "OpenSandbox retained command lost its provider execution identity",
        );
      }
      const provider = await this.ensureStarted();
      const status = await provider.commands.getCommandStatus(executionId);
      if (status.error) {
        process.events.push({ stream: "stderr", text: `${status.error}\n` });
      }
      const consumed = consumeProcessOutput(process);
      const output = truncateOutput(consumed.output, args.maxOutputTokens);
      if (status.running !== false) {
        return formatExecResponse({
          output: output.text,
          wallTimeSeconds: elapsedSeconds(startedAt),
          sessionId: args.sessionId,
          ...(output.originalTokenCount !== undefined
            ? { originalTokenCount: output.originalTokenCount }
            : {}),
        });
      }
      process.settled = true;
      this.processesBySession.delete(args.sessionId);
      this.processesByOpId.delete(process.opId);
      return formatExecResponse({
        output: output.text,
        wallTimeSeconds: elapsedSeconds(startedAt),
        exitCode: status.exitCode ?? 1,
        ...(output.originalTokenCount !== undefined
          ? { originalTokenCount: output.originalTokenCount }
          : {}),
      });
    }
    const outcome = await Promise.race([
      process.completed.then((value) => ({ done: true as const, value })),
      delay(args.yieldTimeMs ?? DEFAULT_WRITE_STDIN_YIELD_TIME_MS).then(() => ({
        done: false as const,
      })),
    ]);
    const consumed = consumeProcessOutput(process);
    const output = truncateOutput(consumed.output, args.maxOutputTokens);
    if (outcome.done) {
      this.processesBySession.delete(args.sessionId);
      return formatExecResponse({
        output: output.text,
        wallTimeSeconds: elapsedSeconds(startedAt),
        exitCode: outcome.value.exitCode,
        ...(output.originalTokenCount !== undefined
          ? { originalTokenCount: output.originalTokenCount }
          : {}),
      });
    }
    return formatExecResponse({
      output: output.text,
      wallTimeSeconds: elapsedSeconds(startedAt),
      sessionId: args.sessionId,
      ...(output.originalTokenCount !== undefined
        ? { originalTokenCount: output.originalTokenCount }
        : {}),
    });
  }

  async writeStdinForProcessControl(args: WriteStdinArgs): Promise<string> {
    return await this.writeStdin(args);
  }

  async readFile(args: { path: string; runAs?: string; maxBytes?: number }): Promise<Uint8Array> {
    assertRunAsUnsupported(args.runAs);
    const provider = await this.ensureStarted();
    return await provider.files.readBytes(workspacePath(args.path, { allowPrivate: true }), {
      ...(args.maxBytes !== undefined ? { limit: args.maxBytes } : {}),
    });
  }

  async writeFile(args: {
    path: string;
    content: string | Uint8Array;
    createParents?: boolean;
    append?: boolean;
  }): Promise<number> {
    if (args.append) {
      throw new SandboxUnsupportedFeatureError(
        "OpenSandbox v1 raw file writes do not support append; use a shell command for append semantics.",
      );
    }
    const provider = await this.ensureStarted();
    const target = workspacePath(args.path, { allowPrivate: true });
    if (args.createParents ?? true) {
      await provider.files.createDirectories([{ path: posix.dirname(target) }]);
    }
    await provider.files.writeFiles([{ path: target, data: args.content }]);
    return typeof args.content === "string"
      ? new TextEncoder().encode(args.content).byteLength
      : args.content.byteLength;
  }

  async pathExists(path: string, runAs?: string): Promise<boolean> {
    assertRunAsUnsupported(runAs);
    const provider = await this.ensureStarted();
    const target = workspacePath(path, { allowPrivate: true });
    try {
      const info = await provider.files.getFileInfo([target]);
      return Boolean(info[target]);
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async listDir(args: { path: string; runAs?: string }): Promise<SandboxDirectoryEntry[]> {
    assertRunAsUnsupported(args.runAs);
    const provider = await this.ensureStarted();
    const absolute = workspacePath(args.path);
    const absoluteOutput = args.path.trim().startsWith("/");
    const entries = await provider.files.listDirectory({
      path: absolute,
      depth: 1,
    });
    return entries.map((entry) => {
      const entryPath = workspacePath(entry.path);
      return {
        name: posix.basename(entryPath),
        path: absoluteOutput
          ? entryPath
          : entryPath === WORKSPACE_ROOT
            ? ""
            : entryPath.slice(WORKSPACE_ROOT.length + 1),
        type: entry.type === "directory" ? "dir" : entry.type === "file" ? "file" : "other",
      };
    });
  }

  async viewImage(args: ViewImageArgs) {
    assertRunAsUnsupported(args.runAs);
    const bytes = await this.readFile({ path: args.path });
    return imageOutputFromBytes(args.path, bytes);
  }

  private async deletePath(path: string): Promise<void> {
    const provider = await this.ensureStarted();
    const target = workspacePath(path, { allowPrivate: true });
    const info = await provider.files.getFileInfo([target]);
    const entry = info[target];
    if (!entry) return;
    if (entry.type === "directory") await provider.files.deleteDirectories([target]);
    else await provider.files.deleteFiles([target]);
  }

  createEditor(runAs?: string): OpenSandboxEditor {
    assertRunAsUnsupported(runAs);
    const applyDiff = injectedApplyDiff;
    if (!applyDiff) {
      throw new Error(
        "opensandbox createEditor: applyDiff not injected (the runtime barrel must call setOpenSandboxApplyDiff before an agent turn binds the filesystem capability)",
      );
    }
    const readText = async (path: string): Promise<string> =>
      new TextDecoder().decode(await this.readFile({ path }));
    return {
      createFile: async (operation) => {
        if (await this.pathExists(operation.path)) {
          throw new Error(`opensandbox createFile: file already exists: ${operation.path}`);
        }
        await this.writeFile({
          path: operation.path,
          content: applyDiff("", operation.diff, "create"),
          createParents: true,
        });
        return {};
      },
      updateFile: async (operation) => {
        const next = applyDiff(await readText(operation.path), operation.diff);
        const destination = operation.moveTo ?? operation.path;
        await this.writeFile({
          path: destination,
          content: next,
          createParents: true,
        });
        if (operation.moveTo && operation.moveTo !== operation.path) {
          await this.deletePath(operation.path);
        }
        return {};
      },
      deleteFile: async (operation) => {
        await this.deletePath(operation.path);
        return {};
      },
    };
  }

  private async applyPermissions(path: string, entry: Entry): Promise<void> {
    if (entry.group !== undefined) {
      throw new SandboxUnsupportedFeatureError(
        "OpenSandbox v1 does not materialize named manifest groups.",
      );
    }
    if (entry.permissions === undefined) return;
    const provider = await this.ensureStarted();
    await provider.files.setPermissions([
      { path, mode: new Permissions(entry.permissions).toMode() & 0o777 },
    ]);
  }

  private async copyLocalDirectory(source: string, destination: string): Promise<void> {
    const stats = await lstat(source);
    if (stats.isSymbolicLink()) {
      throw new SandboxUnsupportedFeatureError(
        `OpenSandbox local_dir source contains a symbolic link: ${source}`,
      );
    }
    if (!stats.isDirectory()) {
      throw new SandboxConfigurationError(
        `OpenSandbox local_dir source is not a directory: ${source}`,
      );
    }
    const provider = await this.ensureStarted();
    await provider.files.createDirectories([{ path: destination }]);
    const entries = await readdir(source, { withFileTypes: true });
    for (const entry of entries) {
      const sourcePath = `${source.replace(/\/$/u, "")}/${entry.name}`;
      const destinationPath = posix.join(destination, entry.name);
      if (entry.isSymbolicLink()) {
        throw new SandboxUnsupportedFeatureError(
          `OpenSandbox local_dir source contains a symbolic link: ${sourcePath}`,
        );
      }
      if (entry.isDirectory()) {
        await this.copyLocalDirectory(sourcePath, destinationPath);
      } else if (entry.isFile()) {
        await provider.files.writeFiles([
          {
            path: destinationPath,
            data: new Uint8Array(await readLocalFile(sourcePath)),
          },
        ]);
      } else {
        throw new SandboxUnsupportedFeatureError(
          `OpenSandbox local_dir source contains an unsupported file type: ${sourcePath}`,
        );
      }
    }
  }

  private async materialize(path: string, entry: Entry): Promise<void> {
    const target = workspacePath(path);
    const provider = await this.ensureStarted();
    if (entry.type === "dir") {
      await provider.files.createDirectories([{ path: target }]);
      for (const [childPath, child] of Object.entries(entry.children ?? {})) {
        await this.materialize(posix.join(path, childPath), child);
      }
      await this.applyPermissions(target, entry);
      return;
    }
    if (entry.type === "file") {
      await provider.files.createDirectories([{ path: posix.dirname(target) }]);
      await provider.files.writeFiles([{ path: target, data: entry.content }]);
      await this.applyPermissions(target, entry);
      return;
    }
    if (entry.type === "local_file") {
      const stats = await lstat(entry.src);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new SandboxUnsupportedFeatureError(
          `OpenSandbox local_file source must be a regular non-symlink file: ${entry.src}`,
        );
      }
      await provider.files.createDirectories([{ path: posix.dirname(target) }]);
      await provider.files.writeFiles([
        { path: target, data: new Uint8Array(await readLocalFile(entry.src)) },
      ]);
      await this.applyPermissions(target, entry);
      return;
    }
    if (entry.type === "local_dir") {
      await this.copyLocalDirectory(entry.src, target);
      await this.applyPermissions(target, entry);
      return;
    }
    if (entry.type === "git_repo") {
      const temp = `/tmp/opengeni-git-${randomUUID()}`;
      const subpath = entry.subpath ? normalizeRelativePath(entry.subpath) : null;
      const script = [
        "set -eu",
        `rm -rf -- ${shellQuote(temp)} ${shellQuote(target)}`,
        `git clone --no-checkout --depth=1 ${shellQuote(entry.repo)} ${shellQuote(temp)}`,
        ...(entry.ref
          ? [
              `git -C ${shellQuote(temp)} fetch --depth=1 origin ${shellQuote(entry.ref)}`,
              `git -C ${shellQuote(temp)} checkout --detach FETCH_HEAD`,
            ]
          : [`git -C ${shellQuote(temp)} checkout --detach HEAD`]),
        subpath
          ? `mkdir -p -- ${shellQuote(target)} && cp -a -- ${shellQuote(`${temp}/${subpath}/.`)} ${shellQuote(target)}`
          : `mv -- ${shellQuote(temp)} ${shellQuote(target)}`,
        subpath ? `rm -rf -- ${shellQuote(temp)}` : ":",
      ].join("\n");
      const result = await this.exec({
        cmd: script,
        yieldTimeMs: 120_000,
        maxOutputTokens: 2_000,
      });
      if (typeof result.exitCode !== "number" || result.exitCode !== 0) {
        throw new SandboxProviderError("OpenSandbox git repository materialization failed", {
          path,
          exitCode: result.exitCode ?? null,
        });
      }
      await this.applyPermissions(target, entry);
      return;
    }
    throw new SandboxUnsupportedFeatureError(
      `OpenSandbox v1 does not support manifest mount entry type "${entry.type}".`,
    );
  }

  async materializeEntry(args: MaterializeEntryArgs): Promise<void> {
    assertRunAsUnsupported(args.runAs);
    const logicalPath = logicalWorkspacePath(args.path);
    await this.materialize(logicalPath, args.entry);
    this.state.manifest = mergeManifestEntryDelta(this.state.manifest, logicalPath, args.entry);
  }

  async applyManifest(manifest: Manifest, runAs?: string): Promise<void> {
    assertRunAsUnsupported(runAs);
    await this.ensureInitialManifestMaterialized();
    if (manifest.root !== this.state.manifest.root) {
      throw new SandboxConfigurationError(
        `OpenSandbox manifest root must remain ${this.state.manifest.root}.`,
      );
    }
    if (
      manifest.users.length > 0 ||
      manifest.groups.length > 0 ||
      manifest.extraPathGrants.length > 0
    ) {
      throw new SandboxUnsupportedFeatureError(
        "OpenSandbox v1 does not support manifest users, groups, or host path grants.",
      );
    }
    for (const [path, entry] of Object.entries(manifest.entries)) {
      await this.materialize(path, entry);
    }
    const nextManifest = mergeManifestDelta(this.state.manifest, manifest);
    this.state.environment = await mergeMaterializedEnvironment(
      this.state.manifest,
      nextManifest,
      this.state.environment,
    );
    this.state.manifest = nextManifest;
  }

  private resolvedArchiveLimits(options?: WorkspaceArchiveOptions) {
    return resolveSandboxArchiveLimits(
      options?.archiveLimits === undefined ? this.archiveLimits : options.archiveLimits,
    );
  }

  async persistWorkspaceTar(): Promise<Uint8Array> {
    const archivePath = `${PRIVATE_ROOT}/capture-${randomUUID()}.tar`;
    const excludes = [
      ...this.state.manifest.ephemeralPersistencePaths(),
      ".opengeni-old-*",
      ".opengeni-restore-*",
    ].sort();
    const excludeArgs = excludes.flatMap((path) => [
      shellQuote(`--exclude=${path}`),
      shellQuote(`--exclude=./${path}`),
    ]);
    const script = String.raw`set -eu
mkdir -p ${shellQuote(PRIVATE_ROOT)}
cd ${shellQuote(WORKSPACE_ROOT)}
if find . -xdev -mindepth 1 ! -type f ! -type d -print -quit | grep -q .; then
  printf 'workspace contains a non-file entry\n' >&2
  exit 65
fi
tar ${excludeArgs.join(" ")} --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner --hard-dereference --format=gnu -cf ${shellQuote(archivePath)} .`;
    try {
      const result = await this.exec({
        cmd: script,
        yieldTimeMs: 120_000,
        maxOutputTokens: 1_000,
      });
      if (result.exitCode !== 0) {
        throw new SandboxArchiveError("OpenSandbox workspace archive capture failed", {
          sandboxId: this.state.sandboxId,
          exitCode: result.exitCode ?? null,
        });
      }
      const bytes = await this.readFile({ path: archivePath });
      const limits = this.resolvedArchiveLimits();
      if (limits && limits.maxInputBytes !== null && bytes.byteLength > limits.maxInputBytes) {
        throw new SandboxArchiveError("OpenSandbox workspace archive exceeds maxInputBytes", {
          archiveBytes: bytes.byteLength,
          maxInputBytes: limits.maxInputBytes,
        });
      }
      return bytes;
    } finally {
      await this.deletePath(archivePath).catch(() => undefined);
    }
  }

  async persistWorkspace(): Promise<Uint8Array> {
    return await this.persistWorkspaceTar();
  }

  async hydrateWorkspace(
    data: WorkspaceArchiveData,
    options: WorkspaceArchiveOptions = {},
  ): Promise<void> {
    const bytes = await toUint8Array(data);
    const limits = this.resolvedArchiveLimits(options);
    if (limits && limits.maxInputBytes !== null && bytes.byteLength > limits.maxInputBytes) {
      throw new SandboxArchiveError("OpenSandbox workspace archive exceeds maxInputBytes", {
        archiveBytes: bytes.byteLength,
        maxInputBytes: limits.maxInputBytes,
      });
    }
    const archivePath = `${PRIVATE_ROOT}/restore-${randomUUID()}.tar`;
    const stagingPath = `${WORKSPACE_ROOT}/.opengeni-restore-${randomUUID()}`;
    const backupPath = `${WORKSPACE_ROOT}/.opengeni-old-${randomUUID()}`;
    await this.writeFile({
      path: archivePath,
      content: bytes,
      createParents: true,
    });
    const excluded = [...this.state.manifest.ephemeralPersistencePaths()].sort().join("\n");
    const command = [
      "python3",
      "-c",
      shellQuote(archiveRestoreScript()),
      shellQuote(archivePath),
      shellQuote(WORKSPACE_ROOT),
      shellQuote(stagingPath),
      shellQuote(backupPath),
      shellQuote(archiveLimitArg(limits?.maxMembers ?? null)),
      shellQuote(archiveLimitArg(limits?.maxExtractedBytes ?? null)),
      shellQuote(excluded),
    ].join(" ");
    try {
      const result = await this.exec({
        cmd: command,
        yieldTimeMs: 120_000,
        maxOutputTokens: 2_000,
      });
      if (result.exitCode !== 0) {
        throw new SandboxArchiveError("OpenSandbox workspace archive restore failed", {
          sandboxId: this.state.sandboxId,
          exitCode: result.exitCode ?? null,
          stderr: result.stderr.slice(-1_000),
        });
      }
      this.state.workspaceReady = true;
    } finally {
      await this.deletePath(archivePath).catch(() => undefined);
      await this.deletePath(stagingPath).catch(() => undefined);
      await this.deletePath(backupPath).catch(() => undefined);
    }
  }

  async resolveExposedPort(port: number): Promise<ExposedPortEndpoint> {
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      throw new SandboxExposedPortUnavailableError(`Invalid OpenSandbox port: ${port}`);
    }
    const endpoint = await withLifecycle(
      this.options,
      async (sandboxes) =>
        await sandboxes.getSandboxEndpoint(this.state.sandboxId, port, this.options.useServerProxy),
    );
    return recordExposedPortEndpoint(
      this.state,
      endpointToExposedPort(endpoint, this.options.baseUrl),
      port,
    );
  }
}

function endpointToExposedPort(endpoint: Endpoint, baseUrl: string): ExposedPortEndpoint {
  const base = new URL(baseUrl);
  const url = new URL(`${base.protocol}//${endpoint.endpoint}`);
  const tls = url.protocol === "https:" || url.protocol === "wss:";
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : tls ? 443 : 80,
    tls,
    ...(url.pathname && url.pathname !== "/" ? { path: url.pathname } : {}),
    ...(url.search.length > 1 ? { query: url.search.slice(1) } : {}),
    protocol: url.protocol.replace(/:$/u, ""),
    url: url.toString(),
    ...(endpoint.headers ? { headers: { ...endpoint.headers } } : {}),
  };
}

export class OpenSandboxClient {
  readonly backendId = "opensandbox" as const;
  readonly supportsDefaultOptions = false;
  private readonly options: OpenSandboxClientOptions;

  constructor(options: OpenSandboxClientOptions) {
    this.options = {
      ...options,
      baseUrl: canonicalBaseUrl(options.baseUrl),
      environment: { ...(options.environment ?? {}) },
      exposedPorts: normalizeConfiguredPorts(options.exposedPorts),
      resourceLimits: { ...options.resourceLimits },
      resourceRequests: { ...options.resourceRequests },
    };
  }

  async create(
    args?: SandboxClientCreateArgs,
    manifestOptions?: Record<string, unknown>,
  ): Promise<OpenSandboxSession> {
    const normalized = normalizeSandboxClientCreateArgs(args as never, manifestOptions);
    assertNoSnapshot(normalized);
    const manifest = normalized.manifest;
    if (manifest.root !== WORKSPACE_ROOT) {
      throw new SandboxConfigurationError(`OpenSandbox manifest root must be ${WORKSPACE_ROOT}.`);
    }
    if (
      manifest.users.length > 0 ||
      manifest.groups.length > 0 ||
      manifest.extraPathGrants.length > 0
    ) {
      throw new SandboxUnsupportedFeatureError(
        "OpenSandbox v1 does not support manifest users, groups, or host path grants.",
      );
    }
    const environment = {
      ...(this.options.environment ?? {}),
      ...(await manifest.resolveEnvironment()),
    };
    const created = await withLifecycle(
      this.options,
      async (sandboxes) => await sandboxes.createSandbox(createRequest(this.options, environment)),
    );
    const state: OpenSandboxSessionState = {
      stateVersion: OPENSANDBOX_STATE_VERSION,
      sandboxId: created.id,
      manifest,
      environment,
      image: this.options.image,
      poolRef: this.options.poolRef ?? null,
      providerBindingHash: providerBindingHash(this.options.baseUrl),
      workspacePersistence: "tar",
      configuredExposedPorts: normalizeConfiguredPorts(this.options.exposedPorts),
      workspaceReady: false,
      expiresAt: created.expiresAt?.toISOString() ?? null,
    };
    return new OpenSandboxSession({
      state,
      options: this.options,
      ...(normalized.archiveLimits !== undefined
        ? { archiveLimits: normalized.archiveLimits }
        : {}),
    });
  }

  async resume(
    state: OpenSandboxSessionState,
    options: SandboxClientResumeOptions = {},
  ): Promise<OpenSandboxSession> {
    return await this.resumeExact(state, options);
  }

  async resumeExact(
    state: OpenSandboxSessionState,
    options: SandboxClientResumeOptions = {},
  ): Promise<OpenSandboxSession> {
    assertStateMatchesOptions(state, this.options);
    try {
      await withLifecycle(this.options, async (sandboxes) => {
        const info = await sandboxes.getSandbox(state.sandboxId);
        assertSupportedProviderState(info, state.sandboxId);
      });
    } catch (error) {
      if (error instanceof SandboxExactResumeInstanceUnavailableError || isNotFound(error)) {
        throw new SandboxExactResumeInstanceUnavailableError("opensandbox", state.sandboxId);
      }
      throw error;
    }
    return new OpenSandboxSession({
      state,
      options: this.options,
      ...(options.archiveLimits !== undefined ? { archiveLimits: options.archiveLimits } : {}),
    });
  }

  async delete(state: OpenSandboxSessionState): Promise<void> {
    assertStateMatchesOptions(state, this.options);
    try {
      await withLifecycle(this.options, async (sandboxes) => {
        await sandboxes.deleteSandbox(state.sandboxId);
      });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  async renewExpiration(sandboxId: string): Promise<string> {
    const expiresAt = new Date(Date.now() + this.options.ttlSeconds * 1000).toISOString();
    const response = await withLifecycle(
      this.options,
      async (sandboxes) => await sandboxes.renewSandboxExpiration(sandboxId, { expiresAt }),
    );
    return response.expiresAt?.toISOString() ?? expiresAt;
  }

  async canPersistOwnedSessionState(): Promise<boolean> {
    return true;
  }

  async canReusePreservedOwnedSession(): Promise<boolean> {
    return false;
  }

  async serializeSessionState(state: OpenSandboxSessionState): Promise<Record<string, unknown>> {
    assertStateMatchesOptions(state, this.options);
    return {
      stateVersion: OPENSANDBOX_STATE_VERSION,
      sandboxId: state.sandboxId,
      manifest: serializeManifestRecord(state.manifest),
      environment: serializeRuntimeEnvironmentForPersistence(state.manifest, state.environment),
      image: state.image,
      poolRef: state.poolRef,
      providerBindingHash: state.providerBindingHash,
      workspacePersistence: "tar",
      configuredExposedPorts: [...state.configuredExposedPorts],
      workspaceReady: state.workspaceReady,
      expiresAt: state.expiresAt,
      ...(state.exposedPorts ? { exposedPorts: structuredClone(state.exposedPorts) } : {}),
    };
  }

  async deserializeSessionState(value: Record<string, unknown>): Promise<OpenSandboxSessionState> {
    if (value.stateVersion !== OPENSANDBOX_STATE_VERSION) {
      throw new SandboxConfigError(
        "opensandbox",
        `unsupported persisted OpenSandbox state version: ${String(value.stateVersion)}`,
      );
    }
    const manifest = deserializeManifest(
      value.manifest && typeof value.manifest === "object" && !Array.isArray(value.manifest)
        ? (value.manifest as Record<string, unknown>)
        : undefined,
    );
    if (manifest.root !== WORKSPACE_ROOT) {
      throw new SandboxConfigError(
        "opensandbox",
        `persisted manifest root must be ${WORKSPACE_ROOT}`,
      );
    }
    const state: OpenSandboxSessionState = {
      stateVersion: OPENSANDBOX_STATE_VERSION,
      sandboxId: parseStateString(value.sandboxId, "sandboxId"),
      manifest,
      environment: await rehydratePersistedEnvironmentForRuntime(
        manifest,
        value.environment &&
          typeof value.environment === "object" &&
          !Array.isArray(value.environment)
          ? (value.environment as Record<string, string>)
          : undefined,
        this.options.environment,
      ),
      image: parseStateString(value.image, "image"),
      poolRef: parseOptionalString(value.poolRef, "poolRef"),
      providerBindingHash: parseStateString(value.providerBindingHash, "providerBindingHash"),
      workspacePersistence: "tar",
      configuredExposedPorts: Array.isArray(value.configuredExposedPorts)
        ? normalizeConfiguredPorts(
            value.configuredExposedPorts.filter(
              (entry): entry is number => typeof entry === "number",
            ),
          )
        : [],
      workspaceReady: value.workspaceReady === true,
      expiresAt: parseOptionalString(value.expiresAt, "expiresAt"),
      ...(value.exposedPorts &&
      typeof value.exposedPorts === "object" &&
      !Array.isArray(value.exposedPorts)
        ? {
            exposedPorts: structuredClone(
              value.exposedPorts as Record<string, ExposedPortEndpoint>,
            ),
          }
        : {}),
    };
    assertStateMatchesOptions(state, this.options);
    return state;
  }
}
