// A compute sandbox: a managed microVM from Opengeni's own sandbox fabric whose
// provider session is the Connected Machine agent running inside it.
//
// Lifecycle is a managed sandbox's (lease, group, workspace setup, persistence
// fallback), transport is the agent's (op-stream exec, files, Git, PTY,
// desktop frames, browser control, ports over the relay). The fabric sleeps an
// idle box on its own and keeps memory and disk, so before talking to an agent
// that may be asleep the session asks the fabric to wake the box and waits for
// the agent to answer. Opengeni never tears a compute box down for idleness;
// it is deleted (and its enrollment revoked) only when its group ends.

import { randomBytes, randomUUID } from "node:crypto";
import { posix } from "node:path";
import { signEnrollToken } from "@opengeni/contracts";
import {
  Manifest,
  Permissions,
  SandboxArchiveError,
  SandboxConfigurationError,
  SandboxProviderError,
  SandboxUnsupportedFeatureError,
  normalizeRelativePath,
  normalizeSandboxClientCreateArgs,
  resolveSandboxArchiveLimits,
  type Entry,
  type MaterializeEntryArgs,
  type SandboxArchiveLimits,
  type SandboxClientCreateArgs,
  type SandboxClientResumeOptions,
  type WorkspaceArchiveData,
  type WorkspaceArchiveOptions,
} from "@openai/agents/sandbox";
import {
  deserializeManifest,
  mergeManifestDelta,
  mergeManifestEntryDelta,
  mergeMaterializedEnvironment,
  rehydratePersistedEnvironmentForRuntime,
  serializeManifestRecord,
  serializeRuntimeEnvironmentForPersistence,
  shellQuote,
  toUint8Array,
} from "@openai/agents-core/sandbox/internal";
import { ErrorCode, type ControlRequest, type ControlResponse } from "@opengeni/agent-proto";
import { SandboxConfigError, SandboxExactResumeInstanceUnavailableError } from "../errors";
import { archiveRestoreScript } from "../providers/opensandbox-adapter";
import {
  NEVER_SENT_DETAIL_KEY,
  SelfhostedControlError,
  subjectFor,
  type ControlRpc,
} from "../selfhosted/control-rpc";
import { SELFHOSTED_FILE_CHUNK_BYTES } from "../selfhosted/file-transfer";
import {
  SelfhostedSession,
  type SelfhostedOperationAdmission,
  type SelfhostedRelayConfig,
  type SelfhostedSessionDeps,
} from "../selfhosted/session";
import { ComputeFabricClient, isComputeFabricNotFound, type ComputeCreateRequest } from "./fabric";
import type { ComputeAgentConnection, ComputeAgentPlane } from "./plane";

export const COMPUTE_WORKSPACE_ROOT = "/workspace";
export const COMPUTE_STATE_VERSION = 1;
const COMPUTE_PRIVATE_ROOT = "/tmp/opengeni-private";
/** The agent answered this recently, so the box is taken to be awake. A box
 * that slept inside the window costs one failed request: the control RPC then
 * wakes it and resends. */
const AGENT_FRESH_MS = 30_000;
const ENROLL_SANDBOX_TOKEN_TTL_SECONDS = 60 * 60;

/** Who a compute box belongs to. Required to create one: the enrollment the
 * box's agent exchanges its token for is bound to this lease. */
export interface ComputeCreateIdentity {
  accountId: string;
  workspaceId: string;
  sandboxGroupId: string;
}

/** The persisted provider state of one compute box. */
export interface ComputeSessionState {
  stateVersion: typeof COMPUTE_STATE_VERSION;
  sandboxId: string;
  enrollmentId: string;
  /** Workspace the enrollment (and agent subject) lives in. */
  workspaceId: string;
  accountId: string;
  sandboxGroupId: string;
  /** The fabric create request id (idempotency key and orphan GC tag). */
  requestId: string;
  image: string | null;
  manifest: Manifest;
  environment: Record<string, string>;
  workspacePersistence: "tar";
  workspaceReady: boolean;
}

/** The live `state` a compute session exposes: the agent session's slice
 * (agentId = enrollment id, instanceId = fabric sandbox id) plus the persisted
 * provider state the lease serializes. */
export type ComputeLiveState = ComputeSessionState & {
  agentId: string;
  instanceId: string;
};

/** Per-turn deps a worker turn binds onto an established compute session so
 * its commands are journaled, adoptable, metered and fenced like any agent
 * session. */
export type ComputeTurnDeps = Pick<
  SelfhostedSessionDeps,
  | "epoch"
  | "terminalScopeId"
  | "adoptBackgroundCommand"
  | "settleBackgroundCommand"
  | "captureBackgroundCommandOutput"
  | "onOp"
  | "transientExecEnvironment"
> & {
  opJournal?: NonNullable<SelfhostedSessionDeps["opStream"]>["journal"];
};

function agentOfflineError(message: string): SelfhostedControlError {
  return new SelfhostedControlError({
    message,
    code: ErrorCode.ERROR_CODE_AGENT_OFFLINE,
    reason: "agent_offline",
    retryable: false,
    agentOffline: true,
  });
}

function isNoResponder(response: ControlResponse): boolean {
  return (
    response.error?.code === ErrorCode.ERROR_CODE_AGENT_OFFLINE &&
    response.error.detail?.[NEVER_SENT_DETAIL_KEY] === "1"
  );
}

function agentStoppedAnswering(response: ControlResponse): boolean {
  return (
    response.error?.code === ErrorCode.ERROR_CODE_AGENT_OFFLINE ||
    response.error?.code === ErrorCode.ERROR_CODE_TIMEOUT
  );
}

export interface ComputeWakeGateDeps {
  fabric: Pick<ComputeFabricClient, "wake">;
  sandboxId: string;
  enrollmentId: string;
  resolveConnection: () => Promise<ComputeAgentConnection | null>;
  /** One raw liveness probe against an exact connection. */
  probe: (connection: ComputeAgentConnection) => Promise<boolean>;
  readyTimeoutMs: number;
  freshMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Decides when a box may be asleep and, then, wakes it through the fabric and
 * waits until its agent answers. Single flight: concurrent operations share one
 * wake. A box whose agent answered within `freshMs` is used directly.
 */
export class ComputeWakeGate {
  private answeredAtMs = Number.NEGATIVE_INFINITY;
  private suspect = true;
  private inflight: Promise<ComputeAgentConnection> | null = null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly freshMs: number;

  constructor(private readonly deps: ComputeWakeGateDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.freshMs = deps.freshMs ?? AGENT_FRESH_MS;
  }

  markAnswered(): void {
    this.answeredAtMs = this.now();
    this.suspect = false;
  }

  markSuspect(): void {
    this.suspect = true;
  }

  /** The connection the next operation should use, waking the box first when
   * it may have slept since the agent last answered. */
  async admit(): Promise<ComputeAgentConnection> {
    if (!this.suspect && this.now() - this.answeredAtMs < this.freshMs) {
      const connection = await this.deps.resolveConnection();
      if (connection) return connection;
      this.suspect = true;
    }
    this.inflight ??= this.wakeAndWait().finally(() => {
      this.inflight = null;
    });
    return await this.inflight;
  }

  private async wakeAndWait(): Promise<ComputeAgentConnection> {
    const deadline = this.now() + this.deps.readyTimeoutMs;
    try {
      await this.deps.fabric.wake(this.deps.sandboxId);
    } catch (error) {
      if (isComputeFabricNotFound(error)) {
        throw new SandboxExactResumeInstanceUnavailableError("compute", this.deps.sandboxId);
      }
      throw error;
    }
    let delayMs = 100;
    for (;;) {
      const connection = await this.deps.resolveConnection();
      if (connection && (await this.deps.probe(connection).catch(() => false))) {
        this.markAnswered();
        return connection;
      }
      if (this.now() >= deadline) {
        throw agentOfflineError(
          `The compute sandbox ${this.deps.sandboxId} runs, but its agent did not answer within ${Math.round(this.deps.readyTimeoutMs / 1000)}s.`,
        );
      }
      await this.sleep(Math.min(delayMs, Math.max(0, deadline - this.now())));
      delayMs = Math.min(2_000, delayMs * 2);
    }
  }
}

/**
 * The control transport of one compute box. Every answer marks the agent as
 * live; a request nobody received (the box went to sleep since the agent last
 * answered) wakes the box and is resent unchanged, under the same request id
 * (its replay identity), until the agent answers or the ready deadline passes.
 * A wake that brings the agent back on a different connection returns the
 * original no-responder answer so the session re-admits the operation on the
 * new connection.
 */
export class ComputeWakingControlRpc implements ControlRpc {
  constructor(
    private readonly inner: ControlRpc,
    private readonly gate: ComputeWakeGate,
    private readonly enrollmentId: string,
  ) {}

  async request(
    subject: string,
    req: ControlRequest,
    opts: { timeoutMs: number },
  ): Promise<ControlResponse> {
    const response = await this.inner.request(subject, req, opts);
    if (!agentStoppedAnswering(response)) {
      this.gate.markAnswered();
      return response;
    }
    this.gate.markSuspect();
    if (!isNoResponder(response)) return response;
    // Never delivered: safe to resend the identical request once the box runs.
    const connection = await this.gate.admit();
    const current = subjectFor(
      connection.workspaceId,
      this.enrollmentId,
      connection.connectionInstanceId,
    );
    if (current !== subject) return response;
    const resent = await this.inner.request(subject, req, opts);
    if (agentStoppedAnswering(resent)) this.gate.markSuspect();
    else this.gate.markAnswered();
    return resent;
  }
}

export interface ComputeSessionDeps {
  state: ComputeLiveState;
  fabric: ComputeFabricClient;
  plane: ComputeAgentPlane;
  relay: SelfhostedRelayConfig;
  readyTimeoutMs: number;
  controlTimeoutMs?: number;
  execTimeoutMs?: number;
  /** Shared by every session bound to the same box in this process. */
  gate?: ComputeWakeGate;
  turn?: ComputeTurnDeps;
  archiveLimits?: SandboxArchiveLimits | null;
}

function pingRequest(): ControlRequest {
  return {
    requestId: randomUUID(),
    epoch: 0,
    resourcePolicy: undefined,
    op: {
      $case: "ping",
      ping: { nonce: String(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)) },
    },
  };
}

function workspacePath(path: string): string {
  const absolute = path.startsWith("/")
    ? posix.normalize(path)
    : posix.join(COMPUTE_WORKSPACE_ROOT, normalizeRelativePath(path));
  if (absolute !== COMPUTE_WORKSPACE_ROOT && !absolute.startsWith(`${COMPUTE_WORKSPACE_ROOT}/`)) {
    throw new SandboxConfigurationError(`compute manifest path escapes /workspace: ${path}`);
  }
  return absolute;
}

function assertRunAsUnsupported(runAs: string | undefined): void {
  if (runAs) {
    throw new SandboxUnsupportedFeatureError("Compute sandboxes do not support runAs yet.");
  }
}

function assertSupportedManifest(manifest: Manifest): void {
  if (manifest.root !== COMPUTE_WORKSPACE_ROOT) {
    throw new SandboxConfigurationError(`Compute manifest root must be ${COMPUTE_WORKSPACE_ROOT}.`);
  }
  if (
    manifest.users.length > 0 ||
    manifest.groups.length > 0 ||
    manifest.extraPathGrants.length > 0
  ) {
    throw new SandboxUnsupportedFeatureError(
      "Compute sandboxes do not support manifest users, groups, or host path grants.",
    );
  }
}

export class ComputeSandboxSession extends SelfhostedSession {
  override readonly backendId = "compute" as const;
  declare readonly state: SelfhostedSession["state"] & ComputeLiveState;
  private readonly computeDeps: ComputeSessionDeps;
  readonly gate: ComputeWakeGate;
  private readonly archiveLimits: SandboxArchiveLimits | null | undefined;

  constructor(deps: ComputeSessionDeps) {
    const { state, plane, fabric } = deps;
    const rawRpc = plane.controlRpc();
    const resolveConnection = () =>
      plane.resolveConnection({ workspaceId: state.workspaceId, enrollmentId: state.enrollmentId });
    const gate =
      deps.gate ??
      new ComputeWakeGate({
        fabric,
        sandboxId: state.sandboxId,
        enrollmentId: state.enrollmentId,
        resolveConnection,
        probe: async (connection) => {
          const res = await rawRpc.request(
            subjectFor(connection.workspaceId, state.enrollmentId, connection.connectionInstanceId),
            pingRequest(),
            { timeoutMs: 5_000 },
          );
          return !res.error && res.result?.$case === "ping";
        },
        readyTimeoutMs: deps.readyTimeoutMs,
      });
    const transport = plane.opStreamTransport();
    const turn = deps.turn ?? {};
    const resolveOperationAdmission = async (): Promise<SelfhostedOperationAdmission> => {
      const connection = await gate.admit();
      return {
        workspaceId: connection.workspaceId,
        connectionInstanceId: connection.connectionInstanceId,
        workspaceRoot: connection.workspaceRoot ?? COMPUTE_WORKSPACE_ROOT,
        ...(connection.opStream && transport
          ? {
              opStream: {
                transport,
                ...(turn.opJournal !== undefined ? { journal: turn.opJournal } : {}),
              },
            }
          : {}),
        operationResourcePolicy: {
          memoryMaxBytes: null,
          memoryHighBytes: null,
          cpuMaxMillicores: null,
          revision: 0,
        },
        operationResourcePolicySupported: false,
        operationCpuQuotaSupported: false,
        transactionalFsWriteSupported: connection.transactionalFsWriteSupported,
        browserControlHttpSupported: connection.browserControlHttpSupported,
      };
    };
    super({
      workspaceId: state.workspaceId,
      agentId: state.enrollmentId,
      // Every operation re-resolves the live connection (resolveOperationAdmission);
      // this placeholder only satisfies the static subject shape.
      connectionInstanceId: "unresolved",
      controlRpc: new ComputeWakingControlRpc(rawRpc, gate, state.enrollmentId),
      relay: deps.relay,
      workspaceRoot: COMPUTE_WORKSPACE_ROOT,
      environment: state.environment,
      resolveOperationAdmission,
      ...(deps.controlTimeoutMs !== undefined ? { timeoutMs: deps.controlTimeoutMs } : {}),
      ...(deps.execTimeoutMs !== undefined ? { execTimeoutMs: deps.execTimeoutMs } : {}),
      ...(turn.epoch !== undefined ? { epoch: turn.epoch } : {}),
      ...(turn.terminalScopeId !== undefined ? { terminalScopeId: turn.terminalScopeId } : {}),
      ...(turn.adoptBackgroundCommand
        ? { adoptBackgroundCommand: turn.adoptBackgroundCommand }
        : {}),
      ...(turn.settleBackgroundCommand
        ? { settleBackgroundCommand: turn.settleBackgroundCommand }
        : {}),
      ...(turn.captureBackgroundCommandOutput
        ? { captureBackgroundCommandOutput: turn.captureBackgroundCommandOutput }
        : {}),
      ...(turn.onOp ? { onOp: turn.onOp } : {}),
      ...(turn.transientExecEnvironment
        ? { transientExecEnvironment: turn.transientExecEnvironment }
        : {}),
    });
    // The SDK reads and writes `state` by reference; every session bound to
    // this box shares the one live state object.
    (this as unknown as { state: ComputeLiveState }).state = state;
    this.computeDeps = deps;
    this.gate = gate;
    this.archiveLimits = deps.archiveLimits;
  }

  get sandboxId(): string {
    return this.state.sandboxId;
  }

  /** The same box, bound with one turn's journal, adoption, metering and fence. */
  bindTurn(turn: ComputeTurnDeps): ComputeSandboxSession {
    return new ComputeSandboxSession({ ...this.computeDeps, gate: this.gate, turn });
  }

  /** Wake the box if needed and wait until its agent answers. */
  async waitForAgent(): Promise<void> {
    await this.gate.admit();
  }

  async start(): Promise<void> {
    await this.waitForAgent();
  }

  async running(): Promise<boolean> {
    try {
      await this.computeDeps.fabric.get(this.state.sandboxId);
      return true;
    } catch (error) {
      if (isComputeFabricNotFound(error)) return false;
      throw error;
    }
  }

  /** Delete the box and revoke its enrollment. Only the end of the box's group
   * calls this; idleness never does. */
  async delete(): Promise<void> {
    await deleteComputeBox(this.computeDeps.fabric, this.computeDeps.plane, this.state);
  }

  /** The box keeps running (and sleeping) after a session is dropped. */
  async close(): Promise<void> {}

  private async run(cmd: string, label: string, sandboxId = this.state.sandboxId) {
    const result = await this.exec({ cmd, maxOutputTokens: 2_000 });
    if (result.exitCode !== 0) {
      throw new SandboxProviderError(`Compute ${label} failed`, {
        sandboxId,
        exitCode: result.exitCode ?? null,
        stderr: result.stderr.slice(-1_000),
      });
    }
    return result;
  }

  private async writeChunked(path: string, bytes: Uint8Array): Promise<void> {
    await this.writeFile({ path, content: bytes.subarray(0, SELFHOSTED_FILE_CHUNK_BYTES) });
    for (
      let offset = SELFHOSTED_FILE_CHUNK_BYTES;
      offset < bytes.byteLength;
      offset += SELFHOSTED_FILE_CHUNK_BYTES
    ) {
      await this.writeFile({
        path,
        content: bytes.subarray(offset, offset + SELFHOSTED_FILE_CHUNK_BYTES),
        append: true,
      });
    }
  }

  private async applyPermissions(target: string, entry: Entry): Promise<void> {
    if (entry.group !== undefined) {
      throw new SandboxUnsupportedFeatureError(
        "Compute sandboxes do not materialize named manifest groups.",
      );
    }
    if (entry.permissions === undefined) return;
    const mode = (new Permissions(entry.permissions).toMode() & 0o777).toString(8);
    await this.run(`chmod ${mode} -- ${shellQuote(target)}`, "permission change");
  }

  private async materialize(path: string, entry: Entry): Promise<void> {
    const target = workspacePath(path);
    if (entry.type === "dir") {
      await this.run(`mkdir -p -- ${shellQuote(target)}`, "directory materialization");
      for (const [childPath, child] of Object.entries(entry.children ?? {})) {
        await this.materialize(posix.join(path, childPath), child);
      }
      await this.applyPermissions(target, entry);
      return;
    }
    if (entry.type === "file") {
      const content =
        typeof entry.content === "string" ? new TextEncoder().encode(entry.content) : entry.content;
      await this.writeChunked(target, content);
      await this.applyPermissions(target, entry);
      return;
    }
    if (entry.type === "git_repo") {
      const temp = `/tmp/opengeni-git-${randomUUID()}`;
      const subpath = entry.subpath ? normalizeRelativePath(entry.subpath) : null;
      const script = [
        "set -eu",
        `rm -rf -- ${shellQuote(temp)} ${shellQuote(target)}`,
        `mkdir -p -- ${shellQuote(posix.dirname(target))}`,
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
      await this.run(script, "git repository materialization");
      await this.applyPermissions(target, entry);
      return;
    }
    // Host-local sources (local_file, local_dir) and mounts would read the
    // Opengeni server's own filesystem; a remote box never receives them.
    throw new SandboxUnsupportedFeatureError(
      `Compute sandboxes do not support manifest entry type "${entry.type}".`,
    );
  }

  override async materializeEntry(args: MaterializeEntryArgs): Promise<void> {
    assertRunAsUnsupported(args.runAs);
    await this.materialize(args.path, args.entry);
    this.state.manifest = mergeManifestEntryDelta(this.state.manifest, args.path, args.entry);
  }

  async applyManifest(manifest: Manifest, runAs?: string): Promise<void> {
    assertRunAsUnsupported(runAs);
    assertSupportedManifest(manifest);
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

  /** A portable tar of /workspace. The fabric persists the box itself; this
   * exists only to move a workspace to another backend. */
  async persistWorkspaceTar(): Promise<Uint8Array> {
    const archivePath = `${COMPUTE_PRIVATE_ROOT}/capture-${randomUUID()}.tar`;
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
mkdir -p ${shellQuote(COMPUTE_PRIVATE_ROOT)}
cd ${shellQuote(COMPUTE_WORKSPACE_ROOT)}
if find . -xdev -mindepth 1 \( -type p -o -type b -o -type c \) -print -quit | grep -q .; then
  printf 'workspace contains a non-portable fifo or device\n' >&2
  exit 65
fi
tar ${excludeArgs.join(" ")} --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner --hard-dereference --format=gnu -cf ${shellQuote(archivePath)} .`;
    try {
      const result = await this.exec({ cmd: script, maxOutputTokens: 1_000 });
      if (result.exitCode !== 0) {
        throw new SandboxArchiveError("Compute workspace archive capture failed", {
          sandboxId: this.state.sandboxId,
          exitCode: result.exitCode ?? null,
        });
      }
      const bytes = await this.readFile({ path: archivePath });
      const limits = this.resolvedArchiveLimits();
      if (limits && limits.maxInputBytes !== null && bytes.byteLength > limits.maxInputBytes) {
        throw new SandboxArchiveError("Compute workspace archive exceeds maxInputBytes", {
          archiveBytes: bytes.byteLength,
          maxInputBytes: limits.maxInputBytes,
        });
      }
      return bytes;
    } finally {
      await this.exec({ cmd: `rm -f -- ${shellQuote(archivePath)}` }).catch(() => undefined);
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
      throw new SandboxArchiveError("Compute workspace archive exceeds maxInputBytes", {
        archiveBytes: bytes.byteLength,
        maxInputBytes: limits.maxInputBytes,
      });
    }
    const archivePath = `${COMPUTE_PRIVATE_ROOT}/restore-${randomUUID()}.tar`;
    const stagingPath = `${COMPUTE_WORKSPACE_ROOT}/.opengeni-restore-${randomUUID()}`;
    const backupPath = `${COMPUTE_WORKSPACE_ROOT}/.opengeni-old-${randomUUID()}`;
    await this.run(`mkdir -p -- ${shellQuote(COMPUTE_PRIVATE_ROOT)}`, "archive staging");
    await this.writeChunked(archivePath, bytes);
    const excluded = [...this.state.manifest.ephemeralPersistencePaths()].sort().join("\n");
    const limitArg = (value: number | null | undefined) =>
      value === null || value === undefined ? "-1" : String(value);
    const command = [
      "python3",
      "-c",
      shellQuote(archiveRestoreScript()),
      shellQuote(archivePath),
      shellQuote(COMPUTE_WORKSPACE_ROOT),
      shellQuote(stagingPath),
      shellQuote(backupPath),
      shellQuote(limitArg(limits?.maxMembers)),
      shellQuote(limitArg(limits?.maxExtractedBytes)),
      shellQuote(excluded),
    ].join(" ");
    try {
      const result = await this.exec({ cmd: command, maxOutputTokens: 2_000 });
      if (result.exitCode !== 0) {
        throw new SandboxArchiveError("Compute workspace archive restore failed", {
          sandboxId: this.state.sandboxId,
          exitCode: result.exitCode ?? null,
          stderr: result.stderr.slice(-1_000),
        });
      }
      this.state.workspaceReady = true;
    } finally {
      await this.exec({
        cmd: `rm -rf -- ${shellQuote(archivePath)} ${shellQuote(stagingPath)} ${shellQuote(backupPath)}`,
      }).catch(() => undefined);
    }
  }

  override async serializeSessionState(): Promise<never> {
    throw new Error(
      "compute sessions serialize through ComputeSandboxClient.serializeSessionState",
    );
  }
}

export async function deleteComputeBox(
  fabric: Pick<ComputeFabricClient, "delete">,
  plane: Pick<ComputeAgentPlane, "revokeEnrollment">,
  state: Pick<ComputeSessionState, "sandboxId" | "workspaceId" | "enrollmentId">,
): Promise<void> {
  await fabric.delete(state.sandboxId);
  await plane.revokeEnrollment({
    workspaceId: state.workspaceId,
    enrollmentId: state.enrollmentId,
  });
}

export interface ComputeSandboxClientOptions {
  fabric: ComputeFabricClient;
  /** Resolved lazily: the registry builds clients before the host installs it. */
  plane: () => ComputeAgentPlane;
  relay: SelfhostedRelayConfig;
  image: string | null;
  vcpus: number;
  memoryMib: number;
  memoryRequestMib?: number;
  cpuRequestMillis?: number;
  agentApiUrl: string;
  enrollmentSigningSecret: string;
  readyTimeoutMs: number;
  controlTimeoutMs?: number;
  execTimeoutMs?: number;
  environment?: Record<string, string>;
}

function parseStateString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new SandboxConfigError("compute", `persisted compute state has no ${field}`);
  }
  return value;
}

export class ComputeSandboxClient {
  readonly backendId = "compute" as const;
  readonly supportsDefaultOptions = false;
  private readonly options: ComputeSandboxClientOptions;

  constructor(options: ComputeSandboxClientOptions) {
    this.options = { ...options, environment: { ...(options.environment ?? {}) } };
  }

  private session(state: ComputeLiveState, archiveLimits?: SandboxArchiveLimits | null) {
    return new ComputeSandboxSession({
      state,
      fabric: this.options.fabric,
      plane: this.options.plane(),
      relay: this.options.relay,
      readyTimeoutMs: this.options.readyTimeoutMs,
      ...(this.options.controlTimeoutMs !== undefined
        ? { controlTimeoutMs: this.options.controlTimeoutMs }
        : {}),
      ...(this.options.execTimeoutMs !== undefined
        ? { execTimeoutMs: this.options.execTimeoutMs }
        : {}),
      ...(archiveLimits !== undefined ? { archiveLimits } : {}),
    });
  }

  /**
   * Create one box: mint its single-use sandbox enrollment token, ask the
   * fabric for the box (idempotent by request id, retried with the same id),
   * then wait until its agent has enrolled and answers. The lease identity
   * arrives as `opengeniCreateIdentity` in the second argument.
   */
  async create(
    args?: SandboxClientCreateArgs,
    options?: Record<string, unknown> & { opengeniCreateIdentity?: ComputeCreateIdentity },
  ): Promise<ComputeSandboxSession> {
    const identity = options?.opengeniCreateIdentity;
    if (!identity) {
      throw new SandboxConfigError(
        "compute",
        "creating a compute sandbox needs its lease identity (account, workspace, sandbox group)",
      );
    }
    const { opengeniCreateIdentity: _identity, ...manifestOptions } = options;
    const normalized = normalizeSandboxClientCreateArgs(args as never, manifestOptions);
    if (normalized.snapshot) {
      throw new SandboxUnsupportedFeatureError(
        "Compute sandboxes restore workspaces from portable archives only.",
      );
    }
    const manifest = normalized.manifest;
    assertSupportedManifest(manifest);
    const environment = {
      ...(this.options.environment ?? {}),
      ...(await manifest.resolveEnvironment()),
    };
    const plane = this.options.plane();
    const enrollmentId = randomUUID();
    const requestId = randomUUID();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const enrollToken = await signEnrollToken(this.options.enrollmentSigningSecret, {
      typ: "enroll_sandbox",
      workspaceId: identity.workspaceId,
      accountId: identity.accountId,
      // Screen control of a box Opengeni owns needs no human consent.
      allowScreenControl: true,
      iat: nowSeconds,
      exp: nowSeconds + ENROLL_SANDBOX_TOKEN_TTL_SECONDS,
      jti: randomBytes(18).toString("base64url"),
      enrollmentId,
      sandboxGroupId: identity.sandboxGroupId,
      requestId,
    });
    const body: ComputeCreateRequest = {
      request_id: requestId,
      ...(this.options.image ? { image: this.options.image } : {}),
      vcpus: this.options.vcpus,
      memory_mib: this.options.memoryMib,
      ...(this.options.memoryRequestMib !== undefined
        ? { memory_request_mib: this.options.memoryRequestMib }
        : {}),
      ...(this.options.cpuRequestMillis !== undefined
        ? { cpu_request_millis: this.options.cpuRequestMillis }
        : {}),
      metadata: {
        opengeni_workspace_id: identity.workspaceId,
        opengeni_sandbox_group_id: identity.sandboxGroupId,
        opengeni_enrollment_id: enrollmentId,
        opengeni_request_id: requestId,
      },
      init: {
        env_vars: environment,
        default_user: "root",
        default_workdir: COMPUTE_WORKSPACE_ROOT,
        agent: {
          api_url: this.options.agentApiUrl,
          enroll_token: enrollToken,
          workspace_root: COMPUTE_WORKSPACE_ROOT,
        },
      },
    };
    const view = await this.options.fabric.create(body);
    const state: ComputeLiveState = {
      stateVersion: COMPUTE_STATE_VERSION,
      sandboxId: view.id,
      enrollmentId,
      workspaceId: identity.workspaceId,
      accountId: identity.accountId,
      sandboxGroupId: identity.sandboxGroupId,
      requestId,
      image: view.image || this.options.image,
      manifest,
      environment,
      workspacePersistence: "tar",
      workspaceReady: false,
      agentId: enrollmentId,
      instanceId: view.id,
    };
    const session = this.session(state, normalized.archiveLimits);
    try {
      await session.waitForAgent();
      if (Object.keys(manifest.entries).length > 0) {
        for (const [path, entry] of Object.entries(manifest.entries)) {
          await session.materializeEntry({ path, entry });
        }
      }
    } catch (error) {
      // Nothing durable names this box yet: do not leave it behind.
      await deleteComputeBox(this.options.fabric, plane, state).catch(() => undefined);
      throw error;
    }
    return session;
  }

  async resume(
    state: ComputeSessionState,
    options: SandboxClientResumeOptions = {},
  ): Promise<ComputeSandboxSession> {
    return await this.resumeExact(state, options);
  }

  /** Re-address the same box. It may be asleep: the first operation wakes it. */
  async resumeExact(
    state: ComputeSessionState,
    options: SandboxClientResumeOptions = {},
  ): Promise<ComputeSandboxSession> {
    try {
      await this.options.fabric.get(state.sandboxId);
    } catch (error) {
      if (isComputeFabricNotFound(error)) {
        throw new SandboxExactResumeInstanceUnavailableError("compute", state.sandboxId);
      }
      throw error;
    }
    const live: ComputeLiveState = {
      ...state,
      agentId: state.enrollmentId,
      instanceId: state.sandboxId,
    };
    return this.session(live, options.archiveLimits);
  }

  async delete(state: ComputeSessionState): Promise<void> {
    await deleteComputeBox(this.options.fabric, this.options.plane(), state);
  }

  async canPersistOwnedSessionState(): Promise<boolean> {
    return true;
  }

  async canReusePreservedOwnedSession(): Promise<boolean> {
    return false;
  }

  async serializeSessionState(state: ComputeSessionState): Promise<Record<string, unknown>> {
    return {
      stateVersion: COMPUTE_STATE_VERSION,
      sandboxId: state.sandboxId,
      enrollmentId: state.enrollmentId,
      workspaceId: state.workspaceId,
      accountId: state.accountId,
      sandboxGroupId: state.sandboxGroupId,
      requestId: state.requestId,
      image: state.image,
      manifest: serializeManifestRecord(state.manifest),
      environment: serializeRuntimeEnvironmentForPersistence(state.manifest, state.environment),
      workspacePersistence: "tar",
      workspaceReady: state.workspaceReady,
    };
  }

  async deserializeSessionState(value: Record<string, unknown>): Promise<ComputeSessionState> {
    if (value.stateVersion !== COMPUTE_STATE_VERSION) {
      throw new SandboxConfigError(
        "compute",
        `unsupported persisted compute state version: ${String(value.stateVersion)}`,
      );
    }
    const manifest = deserializeManifest(
      value.manifest && typeof value.manifest === "object" && !Array.isArray(value.manifest)
        ? (value.manifest as Record<string, unknown>)
        : undefined,
    );
    if (manifest.root !== COMPUTE_WORKSPACE_ROOT) {
      throw new SandboxConfigError(
        "compute",
        `persisted manifest root must be ${COMPUTE_WORKSPACE_ROOT}`,
      );
    }
    return {
      stateVersion: COMPUTE_STATE_VERSION,
      sandboxId: parseStateString(value.sandboxId, "sandboxId"),
      enrollmentId: parseStateString(value.enrollmentId, "enrollmentId"),
      workspaceId: parseStateString(value.workspaceId, "workspaceId"),
      accountId: parseStateString(value.accountId, "accountId"),
      sandboxGroupId: parseStateString(value.sandboxGroupId, "sandboxGroupId"),
      requestId: parseStateString(value.requestId, "requestId"),
      image: typeof value.image === "string" ? value.image : null,
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
      workspacePersistence: "tar",
      workspaceReady: value.workspaceReady === true,
    };
  }
}
