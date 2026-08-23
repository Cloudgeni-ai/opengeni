// `SelfhostedSession` + `SelfhostedSandboxClient` — the NATS-backed structural
// sandbox surface for the `selfhosted` backend (bring-your-own-compute).
//
// The insight: every existing seam (Channel-A exec/fs/git, the
// viewer's `resolveExposedPort`, computer-use) consumes a provider session
// STRUCTURALLY — `session.exec ?? session.execCommand`, `session.readFile`,
// `session.resolveExposedPort`, `session.serializeSessionState`. If the
// selfhosted client's `create()`/`resume()` return a session presenting that
// EXACT surface — but backed by `ControlRpc` (request/reply to the agent over
// the exact claimed process subject, encoded via `@opengeni/agent-proto`) instead of a
// provider SDK — then those seams work UNCHANGED. The agent IS the box.
//
// The session depends ONLY on `ControlRpc` + `{workspaceId, agentId}` (+ the
// relay config for the stream-URL SHAPE). It knows nothing about NATS directly
// (the M3/M4 seam). `serializeSessionState`/`deserializeSessionState` round-trip
// `{agentId}` ONLY — resume = re-address the live subject, NO provider state.

import {
  ControlRequest,
  ControlResponse,
  ErrorCode,
  FsEntryKind,
  StreamKind,
  type DesktopInputRequest,
  type BrowserControlEnsureRequest,
  type BrowserControlEnsureResponse,
  type BrowserFramesOpenRequest,
  type ComputerFramesOpenRequest,
  type ExecRequest,
  type ExecResponse,
  type OperationResourcePolicy,
  type StreamChannel,
} from "@opengeni/agent-proto";
import { DESKTOP_STREAM_PORT } from "@opengeni/contracts";
// `Manifest` from the ALLOWED sandbox-leaf entrypoint (`@openai/agents/sandbox`
// re-exports `@openai/agents-core/sandbox`, which exports the Manifest class) —
// NOT the agent-loop `@openai/agents` root the sandbox leaf forbids. The live
// `state.manifest` slice the @openai/agents SDK reads per turn must be a real
// Manifest (see the `state` field below); selfhosted exec routes over NATS and
// does not use the manifest, but the SDK requires it present + well-formed.
import { Manifest } from "@openai/agents/sandbox";
import { formatExecResponse } from "@openai/agents-core/sandbox/internal";
import type { ExposedPortEndpoint } from "../stream-port";
import {
  agentErrorToControlError,
  drainingExhaustedError,
  execDeadlineHint,
  SelfhostedControlError,
  subjectFor,
  type ControlRpc,
} from "./control-rpc";
import {
  decideSelfhostedRetry,
  defaultSelfhostedRetryClock,
  type SelfhostedRetryClock,
} from "./retry-policy";
import type { SelfhostedOpObservation, SelfhostedOpObserver } from "./op-observer";
import { selfhostedFaultClass } from "./fault-rendering";
import { nextDurableOpId } from "../op-correlation";
import { OpStreamExecClient, type OpStreamJournal } from "./op-stream";
import { OpStreamUnavailableError, type OpStreamTransport } from "./op-transport";

const decoder = new TextDecoder();
const encoder = new TextEncoder();
// Keep one RPC reply comfortably below the agent's negotiated 1 MiB payload
// ceiling. `fsRead` is ranged, so larger logical reads are assembled here.
const SELFHOSTED_FS_READ_CHUNK_BYTES = 512 * 1024;
const SELFHOSTED_PLACEMENT_PRIVATE_PREFIX = "/tmp/opengeni-private/";
const SELFHOSTED_PLACEMENT_PRIVATE_MAX_BYTES = 128 * 1024;

/**
 * The SDK's VIRTUAL sandbox root. The `@openai/agents` agent loop presents the
 * sandbox to the model rooted at this path — it equals `state.manifest.root`,
 * which is held at "/workspace" to match the Modal createManifest root for the
 * provided-session root-delta guard (`validateProvidedSessionManifestUpdate`).
 *
 * On a bring-your-own machine this path DOES NOT EXIST: the machine's real root
 * is the agent's `workspace_root` (reported in Hello, e.g. "/home/user/repo").
 * The Rust agent's `resolve_cwd` maps an EMPTY cwd / a RELATIVE path onto its
 * `workspace_root`, but takes an ABSOLUTE path AS-IS. So a virtual-root-anchored
 * path the SDK hands us ("/workspace" or "/workspace/sub", e.g. an exec workdir
 * or a model-relative file the SDK resolved against the manifest root) would hit
 * the machine as a literal absolute "/workspace/…" → `current_dir`/open ENOENT
 * (the live-swap exec crash: `spawn hostname: No such file or directory`).
 *
 * `toMachinePath` rewrites the virtual frame onto the machine's: the root itself
 * → the session `workingDir` (empty by default ⇒ "", so the agent substitutes its
 * workspace_root); a child → `workingDir`-rooted remainder (the agent joins it onto
 * workspace_root). A genuine machine-ABSOLUTE path the model/agent chose ("/tmp/x"),
 * or a real path echoed back by `listDir`, passes through UNTOUCHED. This is the
 * SOLE adapter rule between the SDK's virtual space and the machine's real
 * filesystem; it is applied at every NATS path/cwd boundary below (exec cwd, fs
 * read/write/list/stat, the editor's delete, the terminal's pty cwd). The
 * per-session `workingDir` (default "" ⇒ a byte-identical no-op) is the base.
 */
const SELFHOSTED_VIRTUAL_ROOT = "/workspace";

/**
 * `workingDir` is the session's per-session working directory — the frame's BASE.
 * It is the launch-workspace_root-relative subdir (or an absolute machine path)
 * the agent/terminal/dock operate under. An EMPTY `workingDir` (the default) makes
 * this byte-identical to before: `base === ""`, so every branch returns the
 * original value (empty/virtual → "", virtual-child → its remainder, a relative or
 * absolute path → itself). A trailing slash on `workingDir` is stripped so a join
 * never doubles; relative stays relative and absolute stays absolute otherwise.
 */
function toMachinePath(p: string | undefined, workingDir: string): string {
  const base = workingDir.replace(/\/$/, "");
  if (!p || p === SELFHOSTED_VIRTUAL_ROOT) return base;
  if (p.startsWith(`${SELFHOSTED_VIRTUAL_ROOT}/`)) {
    const rel = p.slice(SELFHOSTED_VIRTUAL_ROOT.length + 1);
    return base ? `${base}/${rel}` : rel;
  }
  // An ABSOLUTE machine path — a genuine path the model/agent chose ("/tmp/x") or
  // a real path echoed back by `listDir` — points anywhere and passes through
  // UNTOUCHED (the agent's `resolve_cwd` takes an absolute path as-is).
  if (p.startsWith("/")) return p;
  // A BARE-RELATIVE path is the structural Channel-A surface's frame: the file dock
  // joins fs read/list/git sub-paths under an EMPTY workspaceRoot (yielding a bare
  // relative), and a model-supplied relative exec workdir is bare too. Root it under
  // the session working dir so those reads/stats stay in the SAME frame as the dock's
  // working-dir-rooted listing/exec (which run with cwd = workingDir). The SDK agent
  // loop never emits a bare-relative path — it anchors everything at the manifest
  // root ("/workspace/…") — so this only re-homes the structural surface. With an
  // empty workingDir it is a no-op (base === "" ⇒ returns the path unchanged).
  return base ? `${base}/${p}` : p;
}

/**
 * Builds the exact argv for an explicitly selected shell.
 *
 * The self-hosted wire already supports direct argv (`ExecRequest.shell=false`),
 * which is the compatibility-safe way to honor the SDK shell tool's `shell` and
 * `login` arguments: every enrolled agent version understands this shape. Sending
 * `{ command: [cmd], shell: true }` instead delegates shell selection to the
 * machine's ambient `$SHELL`/`ComSpec` and silently discards the caller's choice.
 *
 * `login` maps to profile/login semantics where the shell family exposes them.
 * Windows `cmd.exe` has no login-shell mode. PowerShell profile loading is the
 * closest equivalent, so non-login calls use `-NoProfile` while login calls do
 * not. Other shells use the common POSIX `-l -c` / `-c` contract.
 */
function explicitShellArgv(shell: string, command: string, login: boolean): string[] {
  const leaf = shell.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
  if (leaf === "cmd" || leaf === "cmd.exe") {
    return [shell, "/D", "/S", "/C", command];
  }
  if (
    leaf === "powershell" ||
    leaf === "powershell.exe" ||
    leaf === "pwsh" ||
    leaf === "pwsh.exe"
  ) {
    return [
      shell,
      "-NoLogo",
      ...(!login ? ["-NoProfile"] : []),
      "-NonInteractive",
      "-Command",
      command,
    ];
  }
  return [shell, ...(login ? ["-l"] : []), "-c", command];
}

// ── The agent-turn provided-session contract (@openai/agents-core) ──────────
// When the routing proxy resolves a selfhosted ACTIVE backend, the @openai/agents
// agent loop binds its filesystem/shell/skills capabilities to THIS session and
// calls a richer method set than the Channel-A structural surface: `createEditor`
// + `viewImage` (filesystem), `execCommand` + `supportsPty` (shell), `pathExists`
// + `listDir` + `materializeEntry` + `readFile` (skills). The session must present
// all of them or the turn crashes (e.g. "Filesystem sandbox sessions must provide
// createEditor()"). These run over the SAME NATS exec/fs primitives; the machine
// owns its filesystem so source materialization is a no-op.

/** The V4A-diff applier the SDK's apply_patch editor uses. The leaf cannot import
 *  `@openai/agents`'s `applyDiff` (the agent-loop root the leaf forbids), so the
 *  runtime barrel (`packages/runtime/src/index.ts`, which DOES import that root)
 *  injects it via `setSelfhostedApplyDiff` at module load. Until injected,
 *  `createEditor()` surfaces a clear error rather than a silent wrong-edit. */
export type SelfhostedApplyDiff = (
  input: string,
  diff: string,
  mode?: "default" | "create",
) => string;
let injectedApplyDiff: SelfhostedApplyDiff | undefined;

/** Register the SDK's `applyDiff` so `SelfhostedSession.createEditor()` can apply
 *  V4A diffs over the NATS fs ops. Called once by the runtime barrel. */
export function setSelfhostedApplyDiff(fn: SelfhostedApplyDiff): void {
  injectedApplyDiff = fn;
}

/** The structural Editor surface the SDK's filesystem capability consumes (the
 *  three apply_patch operations). Mirrors `@openai/agents-core`'s `Editor`. */
export interface SelfhostedEditor {
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

/** The image tool-output shape the SDK's view_image tool expects (mirror of
 *  `ToolOutputImage` — not re-exported by `@openai/agents/sandbox`, so structural). */
export interface SelfhostedImageOutput {
  type: "image";
  image: { data: Uint8Array; mediaType: string };
}

/** Default control-op timeout. A transient miss surfaces as `agent_reconnecting`
 *  (the turn pauses + retries); it is NOT a hard failure. */
export const SELFHOSTED_DEFAULT_TIMEOUT_MS = 30_000;
/** Reply grace after an agent-side exec deadline. The child is terminated at
 *  `ExecRequest.timeoutMs`; this outer window lets the typed `timedOut` response
 *  cross NATS before request/reply gives up. */
const SELFHOSTED_EXEC_REPLY_GRACE_MS = 5_000;
/** nats.js ultimately schedules a JS timer; stay inside the signed 32-bit timer
 *  range while also fitting the reply grace. */
const SELFHOSTED_MAX_EXEC_TIMEOUT_MS = 2_147_483_647 - SELFHOSTED_EXEC_REPLY_GRACE_MS;

function normalizeOperationResourcePolicy(
  policy: SelfhostedOperationResourcePolicy | undefined,
): OperationResourcePolicy | undefined {
  const memoryMaxBytes = policy?.memoryMaxBytes ?? null;
  const memoryHighBytes = policy?.memoryHighBytes ?? null;
  const cpuMaxMillicores = policy?.cpuMaxMillicores ?? null;
  for (const [name, value] of [
    ["memoryMaxBytes", memoryMaxBytes],
    ["memoryHighBytes", memoryHighBytes],
  ] as const) {
    if (value !== null && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new Error(`${name} must be a positive safe-integer byte count or null`);
    }
  }
  if (memoryMaxBytes !== null && memoryHighBytes !== null && memoryHighBytes > memoryMaxBytes) {
    throw new Error("memoryHighBytes cannot exceed memoryMaxBytes");
  }
  if (
    cpuMaxMillicores !== null &&
    (!Number.isInteger(cpuMaxMillicores) || cpuMaxMillicores <= 0 || cpuMaxMillicores > 0xffff_ffff)
  ) {
    throw new Error("cpuMaxMillicores must be a positive uint32 value or null");
  }
  if (memoryMaxBytes === null && memoryHighBytes === null && cpuMaxMillicores === null) {
    return undefined;
  }
  return {
    ...(memoryMaxBytes !== null ? { memoryMaxBytes: String(memoryMaxBytes) } : {}),
    ...(memoryHighBytes !== null ? { memoryHighBytes: String(memoryHighBytes) } : {}),
    ...(cpuMaxMillicores !== null ? { cpuMaxMillicores } : {}),
  };
}

/** The relay-URL shape config the session needs to build a stream endpoint. M8b
 *  wires the real relay deployment behind THIS seam so `buildStreamUrl` works
 *  unchanged behind `resolveExposedPort`. */
export interface SelfhostedRelayConfig {
  /** The relay edge host (no scheme), e.g. "relay.opengeni.ai". */
  host: string;
  /** The relay port. Defaults to 443 (the relay terminates TLS). */
  port?: number;
  /** Whether the relay endpoint is TLS (wss/https). Defaults true. */
  tls?: boolean;
  /** The relay's stream-dial path (the `opengeni-relay` wss route). Defaults to
   *  "/stream" — the route the relay listens on (M8b). */
  path?: string;
}

/** The relay's default wss dial path (the `opengeni-relay` server route). */
export const SELFHOSTED_RELAY_STREAM_PATH = "/stream";

/**
 * The op-stream injection (op-stream protocol v1.1 — see op-stream.ts). PRESENT
 * = the streaming exec transport is enabled for this session (the worker
 * injects it only when the runner advertised `Capabilities.op_stream` AND the
 * server flag is on — the leaf carries no flag logic). ABSENT = the legacy
 * monolithic exec, byte-identical to before. The timing knobs exist for tests.
 */
export interface SelfhostedOpStreamDeps {
  transport: OpStreamTransport;
  /** The durable-resume journal (attach generation + settled-frontier persist).
   *  Absent (tests, non-activity callers) ⇒ generation "1", no persistence. */
  journal?: OpStreamJournal;
  windowBytes?: number;
  ackIntervalMs?: number;
  silenceTimeoutMs?: number;
  reconnectHoldMs?: number;
}

export interface SelfhostedOperationResourcePolicy {
  memoryMaxBytes?: number | null;
  memoryHighBytes?: number | null;
  cpuMaxMillicores?: number | null;
}

/** Exact command-admission snapshot. A worker resolves this immediately before
 * every exec/Git admission; retries and already-started operations retain it. */
export interface SelfhostedOperationAdmission {
  /** Workspace segment of the physical agent/relay route. Personal machines may
   * originate in a different same-organization workspace than the session. */
  workspaceId?: string;
  connectionInstanceId: string;
  opStream?: SelfhostedOpStreamDeps;
  operationResourcePolicy: {
    memoryMaxBytes: number | null;
    memoryHighBytes: number | null;
    cpuMaxMillicores: number | null;
    /** Optimistic-control revision identifies the coherent admission truth; it
     * is not itself an enforcement setting. */
    revision: number;
  };
  operationResourcePolicySupported: boolean;
  operationCpuQuotaSupported: boolean;
}

export interface SelfhostedSessionDeps {
  /** Authorization/session workspace. */
  workspaceId: string;
  /** Physical control-plane workspace. Defaults to workspaceId for legacy and
   * workspace-owned routes. */
  controlWorkspaceId?: string;
  agentId: string;
  /** Exact live daemon process claimed for this enrollment. Production builders
   *  require it; direct transport tests may omit it for the legacy subject shape. */
  connectionInstanceId?: string;
  controlRpc: ControlRpc;
  relay: SelfhostedRelayConfig;
  /** Stable identity for the session's interactive terminal. Repeated stream
   *  capability mints carrying this value reattach the existing PTY/channel
   *  instead of spawning a replacement shell. Omitted preserves explicit
   *  create-new semantics for non-viewer callers. */
  terminalScopeId?: string;
  /** Op-stream exec transport (present = enabled; see SelfhostedOpStreamDeps). */
  opStream?: SelfhostedOpStreamDeps;
  /** The lease/active epoch this session is fenced under (echoed on every
   *  ControlRequest so the agent can reject a stale op with ERROR_CODE_FENCED).
   *  Defaults to 0 (no fence) for the negotiation-only / test path. */
  epoch?: number;
  /** The CONTROL-op timeout (ping/fs/desktop/pty and op-stream control RPCs). The
   *  agent's own control liveness must stay responsive, so this is short (the 30s
   *  default). Override for tests or per-deployment tuning. */
  timeoutMs?: number;
  /**
   * The EXEC process deadline — distinct from `timeoutMs`. A real command
   * (compile, test run, install) routinely outlives the short control timeout, so
   * a positive value asks the agent to kill the child at that wall; 0 means no
   * duration deadline over op-stream. Omitted preserves the `timeoutMs` value
   * fallback for older embedding callers; production settings always thread this
   * field explicitly.
   */
  execTimeoutMs?: number;
  /** Optional per-connection command memory policy. Missing/null values are
   * unrestricted. The runner's local and ancestor policy may only tighten it. */
  operationResourcePolicy?: SelfhostedOperationResourcePolicy;
  /** Exact live Hello capability paired with this connection snapshot. */
  operationResourcePolicySupported?: boolean;
  /** Exact live CPU enforcement capability paired with the same snapshot. */
  operationCpuQuotaSupported?: boolean;
  /** Re-read immediately before every provider operation. It must return
   * connection identity, policy revision, capabilities, op-stream state, and
   * any caller-owned live authority from one authoritative snapshot. */
  resolveOperationAdmission?: () => Promise<SelfhostedOperationAdmission | null>;
  /** The clock the bounded control-op retry loop drives (sleep + jitter). Injected
   *  so tests are deterministic; defaults to a real timer + `Math.random()`. */
  retryClock?: SelfhostedRetryClock;
  /** A fire-and-forget observer invoked once per completed control op (out-of-band
   *  telemetry — metrics + `machine.*` events). The worker/api wire it to the sinks;
   *  the leaf only invokes it (guarded so it can never break an op). Omitted ⇒ no-op. */
  onOp?: SelfhostedOpObserver;
  /**
   * The run's declared sandbox environment — the SAME `Record<string,string>` the
   * worker turn passes to `runtime.buildAgent`'s `sandboxEnvironment` (and that the
   * agent's TARGET manifest, `buildManifest`, carries). The SDK injects this
   * selfhosted session NON-OWNED and applies the agent's manifest as a provided-
   * session delta; `validateNoEnvironmentDelta` throws "Live sandbox sessions cannot
   * change manifest environment variables" on ANY env mismatch. So `state.manifest`'s
   * `environment` MUST EQUAL the turn's environment for the delta to be empty. The
   * selfhosted exec routes over NATS and does NOT consume this env (the machine
   * owns its own shell and credentials). The manifest carries the full env only
   * for provided-session parity. Omitted → `{}` (the negotiation-only
   * / test path, which never applies a turn manifest, so there is no delta).
   */
  environment?: Record<string, string>;
  /**
   * Attempt-local values projected onto each newly launched child process.
   * They are deliberately absent from `state`, the manifest, serialized session
   * envelopes, argv, and the machine filesystem. The callback is reread for
   * every exec so worker-side bearer renewal is visible without reconnecting.
   */
  transientExecEnvironment?: () => Readonly<Record<string, string>>;
  /**
   * The session's working directory — the BASE every path/cwd is rooted under (see
   * `toMachinePath` / SELFHOSTED_VIRTUAL_ROOT). A launch-workspace_root-relative
   * subdir (resolved under workspace_root by the agent's `resolve_cwd`) or an
   * absolute machine path. Omitted/empty (the default) ⇒ "" ⇒ today's behavior
   * exactly (an empty cwd lets the agent substitute its workspace_root).
   */
  workingDir?: string;
}

/** The Channel-A `exec` result shape (a structural superset of the SDK's). */
export interface SelfhostedExecResult {
  output: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** True when the agent killed the child at the exec deadline. Additive to the
   *  Channel-A superset (consumers that don't read it are unaffected); `exec()`
   *  places the deadline hint on stderr so Channel-A stdout stays byte-exact. */
  timedOut?: boolean;
}

/** The `exec` args the structural surface accepts (mirrors ChannelAExecArgs). */
export interface SelfhostedExecArgs {
  cmd: string;
  workdir?: string | undefined;
  shell?: string | undefined;
  login?: boolean | undefined;
  tty?: boolean | undefined;
  runAs?: string | undefined;
}

/**
 * The persistable session state. For selfhosted this is `{agentId}` ONLY — there
 * is NO provider box id, no snapshot, no manifest. Resume re-addresses the live
 * subject; the machine itself is the persistence (`persistable:false`).
 */
export interface SelfhostedSessionState {
  agentId: string;
}

/**
 * A live selfhosted session — the structural `SandboxSessionLike` surface over a
 * `ControlRpc`. Mirrors Modal's session shape so Channel-A/viewer/computer-use
 * consume it unchanged.
 */
export class SelfhostedSession {
  readonly backendId = "selfhosted" as const;
  readonly workspaceId: string;
  readonly controlWorkspaceId: string;
  readonly agentId: string;
  private readonly controlRpc: ControlRpc;
  private readonly relay: SelfhostedRelayConfig;
  private readonly terminalScopeId: string;
  private readonly epoch: number;
  private readonly timeoutMs: number;
  /** The exec process deadline (0 = none; omission is legacy embedding behavior). */
  private readonly execTimeoutMs: number | undefined;
  private readonly retryClock: SelfhostedRetryClock;
  private readonly onOp: SelfhostedOpObserver | undefined;
  private readonly subject: string;
  /** Command clients are admission-snapshot-bound. Keep them through the turn-end
   * durability hook; never retarget an already-admitted operation on reconnect. */
  private readonly opStreamClients = new Map<string, OpStreamExecClient>();
  private readonly inFlightOpStreamClients = new Map<string, OpStreamExecClient>();
  private readonly defaultOpStreamClient: OpStreamExecClient | undefined;
  /** The session working directory — the path/cwd base every op is rooted under
   *  (see `toMachinePath`). "" by default ⇒ today's workspace_root behavior. */
  private readonly workingDir: string;
  private readonly transientExecEnvironment: (() => Readonly<Record<string, string>>) | undefined;
  private readonly resourcePolicy: OperationResourcePolicy | undefined;
  private readonly resourcePolicySupported: boolean;
  private readonly operationCpuQuotaSupported: boolean;
  private readonly defaultOpStream: SelfhostedOpStreamDeps | undefined;
  private readonly connectionInstanceId: string | undefined;
  private readonly resolveOperationAdmission:
    | (() => Promise<SelfhostedOperationAdmission | null>)
    | undefined;

  /**
   * The structural `state` slice consumers read. `agentId`/`instanceId` serve the
   * channel-a `readInstanceId` + docker-network decoration (the agentId IS the
   * identity). `manifest` is the slice the @openai/agents SDK reads AND writes per
   * turn (serializeManifestEnvironment / validateProvidedSessionManifestUpdate read
   * `manifest.root` + iterate `manifest.environment`; providedSessionManifest WRITES
   * `state.manifest = next`). It must be a real, MUTABLE Manifest field — when the
   * RoutingSandboxSession proxy resolves THIS as the active backend it returns
   * `session.state` BY REFERENCE, so the SDK's read and write must both land on a
   * well-formed Manifest here (defined `root`, object `environment`). Without it the
   * SDK crashes with `undefined is not an object (evaluating 'current.root')`.
   *
   * `manifest` is intentionally a plain mutable field (not `readonly`) so the SDK's
   * `state.manifest = next` write succeeds. It is NOT part of the persistable state
   * (`serializeSessionState` round-trips `{agentId}` only).
   *
   * `environment` is the SDK `SandboxSessionState.environment` (a `Record<string,
   * string>`). It MUST be present because the GROUP box's client serializes THIS
   * (the active backend's) state at end-of-turn — the non-owned injected session is
   * serialized via the CONFIGURED client (modal in prod), NOT the selfhosted client.
   * Modal's `serializeRemoteSandboxSessionState` does `Object.entries(state.environment)`;
   * an absent field crashes the post-turn RunState serialize with "Object.entries
   * requires that input parameter not be null or undefined". It carries the run's
   * threaded environment (or `{}`). The resulting modal-tagged envelope is inert for
   * selfhosted (resume re-addresses the machine by agentId via the lease pointer,
   * never from this SDK envelope), so its only job is to not crash the serialize.
   */
  readonly state: {
    agentId: string;
    instanceId: string;
    manifest: Manifest;
    environment: Record<string, string>;
  };

  constructor(deps: SelfhostedSessionDeps) {
    this.workspaceId = deps.workspaceId;
    this.controlWorkspaceId = deps.controlWorkspaceId ?? deps.workspaceId;
    this.agentId = deps.agentId;
    this.controlRpc = deps.controlRpc;
    this.relay = deps.relay;
    this.terminalScopeId = deps.terminalScopeId ?? "";
    this.epoch = deps.epoch ?? 0;
    this.timeoutMs = deps.timeoutMs ?? SELFHOSTED_DEFAULT_TIMEOUT_MS;
    this.execTimeoutMs = deps.execTimeoutMs;
    this.retryClock = deps.retryClock ?? defaultSelfhostedRetryClock;
    this.onOp = deps.onOp;
    this.subject = subjectFor(this.controlWorkspaceId, deps.agentId, deps.connectionInstanceId);
    this.workingDir = deps.workingDir ?? "";
    this.transientExecEnvironment = deps.transientExecEnvironment;
    this.resourcePolicy = normalizeOperationResourcePolicy(deps.operationResourcePolicy);
    this.resourcePolicySupported = deps.operationResourcePolicySupported === true;
    this.operationCpuQuotaSupported = deps.operationCpuQuotaSupported === true;
    this.defaultOpStream = deps.opStream;
    this.connectionInstanceId = deps.connectionInstanceId;
    this.resolveOperationAdmission = deps.resolveOperationAdmission;
    // A pre-admission tombstone is safe only for a static connection. Dynamic
    // sessions must never route an unknown op id through their constructor's
    // potentially stale connection after a reconnect.
    this.defaultOpStreamClient =
      deps.opStream && !deps.resolveOperationAdmission
        ? this.opStreamClientFor({
            connectionInstanceId: deps.connectionInstanceId,
            subject: this.subject,
            resourcePolicy: this.resourcePolicy,
            opStream: deps.opStream,
          })
        : undefined;
    // A valid Manifest mirroring the Modal create-manifest shape (sandbox/index.ts
    // `createManifest`: `new Manifest({ root: "/workspace", environment })`). `root`
    // is "/workspace" to match `buildManifest`'s declared root (the root-delta guard
    // in validateProvidedSessionManifestUpdate). This is the VIRTUAL root the SDK
    // presents to the model; `toMachinePath` (see SELFHOSTED_VIRTUAL_ROOT) rewrites
    // it onto the machine's real `workspace_root` at every exec/fs NATS boundary,
    // so the manifest never needs to carry the machine's true root. `environment`
    // is the run's declared
    // sandbox environment — the SAME object the worker turn threads into the agent's
    // TARGET manifest — so the SDK's per-turn provided-session delta
    // (validateNoEnvironmentDelta) finds NO mismatch. `entries: {}` because the
    // selfhosted machine already owns its filesystem (no SDK materialization; exec
    // routes over NATS). Omitted env (the negotiation-only / test path) defaults to
    // `{}` — no turn manifest is applied there, so there is no delta to validate.
    this.state = {
      agentId: deps.agentId,
      instanceId: deps.agentId,
      manifest: new Manifest({
        root: "/workspace",
        entries: {},
        environment: deps.environment ?? {},
      }),
      // The SDK `SandboxSessionState.environment` — the run's threaded env (or `{}`).
      // The group client's end-of-turn serialize reads `state.environment` directly
      // (Object.entries), so it must be a defined object, not absent.
      environment: deps.environment ?? {},
    };
  }

  /** Invoke the injected per-op observer, guarded: a telemetry tap must NEVER break
   *  an op (a throwing sink is swallowed). No-op when no observer is wired. */
  private emitOp(observation: SelfhostedOpObservation): void {
    if (!this.onOp) {
      return;
    }
    try {
      this.onOp(observation);
    } catch {
      // A telemetry sink must never surface into the op path.
    }
  }

  private assertResourcePolicySupported(
    policy: OperationResourcePolicy | undefined,
    memorySupported: boolean,
    cpuSupported: boolean,
  ): void {
    const memoryConfigured =
      policy?.memoryMaxBytes !== undefined || policy?.memoryHighBytes !== undefined;
    if (memoryConfigured && !memorySupported) {
      throw new SelfhostedControlError({
        message:
          "This Connected Machine has an operation memory policy, but its current runner, OS, or service configuration cannot enforce it. Update or reconfigure the installation, or clear the memory policy before executing commands.",
        code: ErrorCode.ERROR_CODE_UNSUPPORTED,
        reason: null,
        retryable: false,
      });
    }
    if (policy?.cpuMaxMillicores !== undefined && (!memorySupported || !cpuSupported)) {
      throw new SelfhostedControlError({
        message:
          "This Connected Machine has an operation CPU policy, but its current runner, OS, or service configuration cannot enforce CPU quotas. Update or reconfigure the installation, or clear the CPU policy before executing commands.",
        code: ErrorCode.ERROR_CODE_UNSUPPORTED,
        reason: null,
        retryable: false,
      });
    }
  }

  private async admitOperation(commandPolicy: boolean): Promise<{
    connectionInstanceId: string | undefined;
    subject: string;
    resourcePolicy: OperationResourcePolicy | undefined;
    opStream: SelfhostedOpStreamDeps | undefined;
  }> {
    if (!this.resolveOperationAdmission) {
      if (commandPolicy) {
        this.assertResourcePolicySupported(
          this.resourcePolicy,
          this.resourcePolicySupported,
          this.operationCpuQuotaSupported,
        );
      }
      return {
        connectionInstanceId: this.connectionInstanceId,
        subject: this.subject,
        resourcePolicy: commandPolicy ? this.resourcePolicy : undefined,
        opStream: this.defaultOpStream,
      };
    }

    const resolved = await this.resolveOperationAdmission();
    if (!resolved) {
      throw new SelfhostedControlError({
        message: "The Connected Machine has no authoritative live runner connection.",
        code: ErrorCode.ERROR_CODE_AGENT_OFFLINE,
        reason: "agent_offline",
        retryable: false,
        agentOffline: true,
      });
    }
    const resourcePolicy = normalizeOperationResourcePolicy(resolved.operationResourcePolicy);
    if (commandPolicy) {
      this.assertResourcePolicySupported(
        resourcePolicy,
        resolved.operationResourcePolicySupported,
        resolved.operationCpuQuotaSupported,
      );
    }
    return {
      connectionInstanceId: resolved.connectionInstanceId,
      subject: subjectFor(
        resolved.workspaceId ?? this.controlWorkspaceId,
        this.agentId,
        resolved.connectionInstanceId,
      ),
      resourcePolicy: commandPolicy ? resourcePolicy : undefined,
      opStream: resolved.opStream,
    };
  }

  private async admitCommand(): Promise<Awaited<ReturnType<SelfhostedSession["admitOperation"]>>> {
    return await this.admitOperation(true);
  }

  /** A proven-unstarted op-stream retry may reuse its stable op id, but it must
   * not reuse mutable authorization or silently retarget the command. Require a
   * fresh admission for the exact same physical route and effective policy;
   * callers can start a later operation against a newly resolved route. */
  private async revalidateCommandAdmission(
    expected: Awaited<ReturnType<SelfhostedSession["admitCommand"]>>,
  ): Promise<void> {
    const current = await this.admitCommand();
    const samePolicy =
      current.resourcePolicy?.memoryMaxBytes === expected.resourcePolicy?.memoryMaxBytes &&
      current.resourcePolicy?.memoryHighBytes === expected.resourcePolicy?.memoryHighBytes &&
      current.resourcePolicy?.cpuMaxMillicores === expected.resourcePolicy?.cpuMaxMillicores;
    if (
      current.subject !== expected.subject ||
      current.connectionInstanceId !== expected.connectionInstanceId ||
      Boolean(current.opStream) !== Boolean(expected.opStream) ||
      !samePolicy
    ) {
      throw new SelfhostedControlError({
        message: "The Connected Machine route or operation policy changed before dispatch.",
        code: ErrorCode.ERROR_CODE_FENCED,
        reason: null,
        retryable: true,
        fenced: true,
      });
    }
  }

  private opStreamClientFor(
    admission: Awaited<ReturnType<SelfhostedSession["admitCommand"]>>,
  ): OpStreamExecClient | undefined {
    const stream = admission.opStream;
    if (!stream) return undefined;
    const key = JSON.stringify([
      admission.connectionInstanceId ?? null,
      admission.resourcePolicy?.memoryMaxBytes ?? null,
      admission.resourcePolicy?.memoryHighBytes ?? null,
      admission.resourcePolicy?.cpuMaxMillicores ?? null,
    ]);
    const existing = this.opStreamClients.get(key);
    if (existing) return existing;
    const client = new OpStreamExecClient({
      workspaceId: this.workspaceId,
      agentId: this.agentId,
      ...(admission.connectionInstanceId !== undefined
        ? { connectionInstanceId: admission.connectionInstanceId }
        : {}),
      epoch: this.epoch,
      controlRpc: this.controlRpc,
      rpcSubject: admission.subject,
      transport: stream.transport,
      controlTimeoutMs: this.timeoutMs,
      retryClock: this.retryClock,
      ...(admission.resourcePolicy !== undefined
        ? { resourcePolicy: admission.resourcePolicy }
        : {}),
      ...(this.resolveOperationAdmission !== undefined
        ? {
            revalidateBeforeStartRetry: async () =>
              await this.revalidateCommandAdmission(admission),
          }
        : {}),
      ...(stream.journal !== undefined ? { journal: stream.journal } : {}),
      ...(stream.windowBytes !== undefined ? { windowBytes: stream.windowBytes } : {}),
      ...(stream.ackIntervalMs !== undefined ? { ackIntervalMs: stream.ackIntervalMs } : {}),
      ...(stream.silenceTimeoutMs !== undefined
        ? { silenceTimeoutMs: stream.silenceTimeoutMs }
        : {}),
      ...(stream.reconnectHoldMs !== undefined ? { reconnectHoldMs: stream.reconnectHoldMs } : {}),
    });
    this.opStreamClients.set(key, client);
    return client;
  }

  /**
   * Issue a control op, decoding the agent's reply or throwing the mapped
   * `SelfhostedControlError` on an AgentError (incl. a synthesized offline /
   * timeout error from the transport).
   *
   * Two failure modes are retried in-place (the decision is the pure
   * `decideSelfhostedRetry` policy):
   *   - DRAINING — a pre-admission host-work backpressure rejection; the op never
   *     started, so it is safe to re-issue for ANY op kind (bounded).
   *   - a TIMEOUT / `agent_reconnecting` blip — re-issued ONCE, and ONLY for a
   *     read-only idempotent-safe op. A timed-out MUTATION is NEVER re-issued: it
   *     may already have executed on the machine (at-least-once), which would
   *     duplicate the write/command. FENCED is intentionally NOT retried here — the
   *     routing proxy retries it against a re-resolved backend under a fresh epoch.
   * Each attempt carries a FRESH `requestId` (a retry is a distinct request).
   */
  private async call(
    op: NonNullable<ControlRequest["op"]>,
    timeoutMs = this.timeoutMs,
    admittedCommand?: Awaited<ReturnType<SelfhostedSession["admitCommand"]>>,
  ): Promise<NonNullable<ControlResponse["result"]>> {
    const opKind = op.$case;
    // This is the last shared boundary before every request/reply provider
    // operation. Even a cached routed or pinned session must re-resolve its live
    // authority here; an already-admitted Git operation threads its exact
    // snapshot. Exec uses the op-stream client and never enters this helper.
    const commandOperation = opKind === "git";
    let operationAdmission = admittedCommand ?? (await this.admitOperation(commandOperation));
    const startedAt = Date.now();
    let drainingRetries = 0;
    let timeoutRetries = 0;
    let neverSentRetries = 0;
    for (;;) {
      const commandAdmission = opKind === "git" ? operationAdmission : undefined;
      const resourcePolicy = commandAdmission?.resourcePolicy;
      const req: ControlRequest = {
        requestId: crypto.randomUUID(),
        epoch: this.epoch,
        resourcePolicy,
        op,
      };
      const res = await this.controlRpc.request(operationAdmission.subject, req, {
        timeoutMs,
      });
      if (!res.error && res.result) {
        const retries = drainingRetries + timeoutRetries + neverSentRetries;
        this.emitOp({
          op: opKind,
          outcome: "ok",
          healed: retries > 0,
          retries,
          durationMs: Date.now() - startedAt,
          machineId: this.agentId,
          // A healed op's class is whichever retry budget it recovered from.
          ...(retries > 0
            ? {
                faultClass:
                  neverSentRetries > 0
                    ? "offline"
                    : drainingRetries > 0
                      ? "draining"
                      : "reconnecting",
              }
            : {}),
        });
        return res.result;
      }
      const error = res.error
        ? agentErrorToControlError(res.error, req.requestId)
        : agentErrorToControlError(
            {
              code: 7, // ERROR_CODE_PROTOCOL — an empty result is a protocol violation
              message: "agent returned an empty control response",
              retryable: false,
              detail: {},
            },
            req.requestId,
          );
      const decision = decideSelfhostedRetry({
        opKind,
        error,
        drainingRetries,
        timeoutRetries,
        neverSentRetries,
        jitter: this.retryClock.jitter(),
      });
      if (decision.action === "fail") {
        const retries = drainingRetries + timeoutRetries + neverSentRetries;
        const encoded = Number(error.detail.encoded_bytes);
        this.emitOp({
          op: opKind,
          outcome: "failed",
          healed: false,
          retries,
          durationMs: Date.now() - startedAt,
          code: error.code,
          reason: error.reason,
          neverSent: error.neverSent,
          machineId: this.agentId,
          faultClass: selfhostedFaultClass(error),
          // Known only on a PAYLOAD_TOO_LARGE fault (the agent's encoded_bytes detail).
          ...(Number.isFinite(encoded) ? { replyBytes: encoded } : {}),
        });
        // Fold the retry count into the DRAINING copy when we actually retried, so
        // the surfaced message reads "…retried N times first…".
        if (error.draining && drainingRetries > 0) {
          throw drainingExhaustedError(error, drainingRetries);
        }
        throw error;
      }
      await this.retryClock.sleep(decision.delayMs);
      // Every physical retry is a new provider dispatch. The retry policy has
      // already proven it safe (never-sent/draining, or read-only timeout), so
      // revalidate live authority without ever replaying an ambiguous mutation.
      operationAdmission = await this.admitOperation(commandOperation);
      // Advance the counter for the class that was retried (separate budgets).
      if (error.neverSent) {
        neverSentRetries += 1;
      } else if (error.draining) {
        drainingRetries += 1;
      } else {
        timeoutRetries += 1;
      }
    }
  }

  /** The effective clamped exec process deadline (ms). 0 means no process
   *  deadline; positive configured values are clamped to the wire-safe range.
   *  Public so adapters that project a
   *  structured command receipt can report the exact deadline the agent enforces
   *  instead of repeating (and potentially drifting from) this normalization. */
  get effectiveExecDeadlineMs(): number {
    // Production always threads the setting explicitly (default 0). Preserve the
    // short control timeout only for structural/test callers that omit the newer
    // exec field entirely, so old embedding code keeps a safe bounded legacy path.
    const configured = Math.trunc(this.execTimeoutMs ?? this.timeoutMs);
    if (configured <= 0) return 0;
    return Math.min(configured, SELFHOSTED_MAX_EXEC_TIMEOUT_MS);
  }

  /** Channel-A `exec`: run a command on the machine and return its output. */
  async exec(args: SelfhostedExecArgs): Promise<SelfhostedExecResult> {
    // Admission is the only mutable-policy read. Everything below retains this
    // exact connection/capability/policy-revision snapshot through completion.
    const admission = await this.admitCommand();
    // 0 deliberately means no process deadline. That contract is safe only over
    // op-stream: its liveness probes, replay, and cancellation do not depend on a
    // request/reply timer or a monolithic response.
    const executionTimeoutMs = this.effectiveExecDeadlineMs;
    const requestedShell = args.shell?.trim();
    const execReq: ExecRequest = {
      // An explicit shell is encoded as direct argv so every agent version honors
      // it. With no explicit shell, preserve the existing machine-owned default
      // shell behavior byte-for-byte.
      command: requestedShell
        ? explicitShellArgv(requestedShell, args.cmd, args.login === true)
        : [args.cmd],
      shell: !requestedShell,
      // Rewrite a virtual-root cwd ("/workspace[/…]") onto the machine's frame —
      // an absolute "/workspace" would ENOENT on a real machine (see
      // SELFHOSTED_VIRTUAL_ROOT). Empty → the session workingDir (itself "" by
      // default ⇒ the agent runs in its workspace_root).
      cwd: toMachinePath(args.workdir, this.workingDir),
      // The machine owns its ambient shell environment and ordinary credentials.
      // Only attempt-local values explicitly supplied by the worker cross here;
      // snapshot now so a later renewal cannot mutate an in-flight request.
      env: { ...(this.transientExecEnvironment?.() ?? {}) },
      stdin: new Uint8Array(0),
      timeoutMs: executionTimeoutMs,
    };
    const opStreamClient = this.opStreamClientFor(admission);
    if (!opStreamClient) {
      throw execRequiresOpStream();
    }
    try {
      return await this.execViaOpStream(opStreamClient, execReq, executionTimeoutMs);
    } catch (error) {
      if (error instanceof OpStreamUnavailableError) {
        throw execRequiresOpStream(error);
      }
      throw error;
    }
  }

  /**
   * The op-stream exec path: the SAME `ExecRequest`, streamed (see
   * op-stream.ts). The durable op id comes from the tool-call correlation
   * context (`{callId}:{ordinal}` — B1) when this exec runs inside an SDK tool
   * invocation; a non-tool caller falls back to a random unique id (never
   * collides, merely not stable across a turn re-dispatch). Emits the SAME
   * per-op observation the legacy path does, with `replyBytes` filled from the
   * reassembled stream (the field the framed transport was designed to own).
   */
  private async execViaOpStream(
    client: OpStreamExecClient,
    execReq: ExecRequest,
    executionTimeoutMs: number,
  ): Promise<SelfhostedExecResult> {
    const startedAt = Date.now();
    const opId = nextDurableOpId() ?? `anon_${crypto.randomUUID()}`;
    this.inFlightOpStreamClients.set(opId, client);
    try {
      const outcome = await client.exec(
        opId,
        execReq,
        executionTimeoutMs,
        executionTimeoutMs > 0 ? executionTimeoutMs + SELFHOSTED_EXEC_REPLY_GRACE_MS : 0,
      );
      const retries = outcome.heals + outcome.startRetries;
      this.emitOp({
        op: "exec",
        outcome: "ok",
        healed: retries > 0,
        retries,
        durationMs: Date.now() - startedAt,
        machineId: this.agentId,
        replyBytes: outcome.replyBytes,
        // A healed op's class: attach heals are link blips (reconnecting);
        // start retries without heals were admission backpressure (draining).
        ...(retries > 0 ? { faultClass: outcome.heals > 0 ? "reconnecting" : "draining" } : {}),
      });
      return execResultToChannelA(outcome.response, executionTimeoutMs);
    } catch (error) {
      if (error instanceof OpStreamUnavailableError) throw error;
      const controlError =
        error instanceof SelfhostedControlError
          ? error
          : new SelfhostedControlError({
              message: error instanceof Error ? error.message : String(error),
              code: ErrorCode.ERROR_CODE_PROTOCOL,
              reason: null,
              retryable: false,
            });
      this.emitOp({
        op: "exec",
        outcome: "failed",
        healed: false,
        retries: 0,
        durationMs: Date.now() - startedAt,
        code: controlError.code,
        reason: controlError.reason,
        neverSent: controlError.neverSent,
        machineId: this.agentId,
        faultClass: selfhostedFaultClass(controlError),
      });
      throw controlError;
    } finally {
      this.inFlightOpStreamClients.delete(opId);
    }
  }

  /**
   * The turn-end op-stream durability hook: persists each settled op's frontier
   * to the journal, then final-acks it on the wire (licensing the runner to GC
   * its retained frames). The WORKER calls this after the turn's results are
   * durably recorded — never mid-turn (the durable-before-wire-ack ordering).
   * A no-op for sessions without the op-stream transport.
   */
  async finalizeOpStreamOps(): Promise<void> {
    for (const client of this.opStreamClients.values()) {
      await client.finalizeSettledOps();
    }
  }

  // ── The agent-turn provided-session contract (over the SAME NATS primitives) ──
  // These are what the @openai/agents shell/filesystem/skills capabilities call on
  // the ACTIVE session once the routing proxy resolves selfhosted. They reuse the
  // exec/fs ops above; the machine owns its filesystem (materialization is a no-op).

  /** SDK shell capability `execCommand`: the `exec_command` tool. Selfhosted exec
   *  is non-interactive (no PTY) — `tty` is ignored; `supportsPty()` is false so
   *  the SDK never offers a stdin session.
   *
   *  Docker/unix-local return `formatExecResponse` (exit code + combined
   *  stdout/stderr). This path must match that contract: returning raw stdout
   *  made `ls` ENOENT and `npx --help` look like success with empty output.
   *  The structured `exec()` result stays split for Channel-A parsers; the
   *  deadline hint already lands on stderr there and is included in this body. */
  async execCommand(args: SelfhostedExecArgs): Promise<string> {
    const startedAt = Date.now();
    const result = await this.exec(args);
    const exitCode =
      typeof result.exitCode === "number" && Number.isSafeInteger(result.exitCode)
        ? result.exitCode
        : 1;
    return formatExecResponse({
      output: joinExecCommandOutput(result.stdout, result.stderr),
      wallTimeSeconds: Math.max(0, Date.now() - startedAt) / 1000,
      exitCode,
    });
  }

  /**
   * Physical turn-cancellation seam used by the runtime tool fence. Only the
   * op-stream transport has a process-tree cancellation protocol; a legacy
   * runner returns false and the caller remains fail-closed until its exec
   * deadline rather than claiming the machine is quiescent.
   */
  async cancelExecCommand(opId: string): Promise<boolean> {
    const client = this.inFlightOpStreamClients.get(opId) ?? this.defaultOpStreamClient;
    if (!client) return false;
    await client.cancel(opId);
    return true;
  }

  /** SDK shell capability never calls this (gated on `supportsPty()` which is
   *  false), but the surface advertises it. Selfhosted exec has no interactive PTY
   *  session over the structured RPC, so a stdin write is unsupported. */
  supportsPty(): boolean {
    return false;
  }

  /** SDK filesystem capability `view_image`: read the image bytes off the machine
   *  and wrap them in the tool-output image shape (magic-byte sniff + path fallback,
   *  mirroring the SDK's `imageOutputFromBytes`). */
  async viewImage(args: { path: string; runAs?: string }): Promise<SelfhostedImageOutput> {
    const bytes = await this.readFile({
      path: args.path,
      ...(args.runAs ? { runAs: args.runAs } : {}),
    });
    const mediaType = sniffImageMediaType(bytes, args.path);
    if (!mediaType) {
      throw new Error(`selfhosted view_image: unsupported image format for ${args.path}`);
    }
    return {
      type: "image",
      image: { data: Uint8Array.from(bytes), mediaType },
    };
  }

  /** SDK skills/filesystem `pathExists`: whether a path exists on the machine. */
  async pathExists(path: string, _runAs?: string): Promise<boolean> {
    const { exists } = await this.statFile({ path });
    return exists;
  }

  /** SDK skills `listDir`: list a directory as `{name, path, type}[]`. */
  async listDir(args: {
    path: string;
    runAs?: string;
  }): Promise<Array<{ name: string; path: string; type: "file" | "dir" | "other" }>> {
    const result = await this.listFiles({ path: args.path });
    return result.fsList.entries.map((entry) => ({
      name: entry.name,
      path: entry.path,
      type:
        entry.kind === FsEntryKind.FS_ENTRY_KIND_DIRECTORY
          ? ("dir" as const)
          : entry.kind === FsEntryKind.FS_ENTRY_KIND_FILE
            ? ("file" as const)
            : ("other" as const),
    }));
  }

  /** SDK manifest-delta `materializeEntry`: a NO-OP for selfhosted. Source
   *  materialization (cloning repos / staging files into the box) is how cloud
   *  providers prepare a fresh box; a bring-your-own machine already owns its
   *  filesystem and is prepared by the agent itself, so there is nothing to stage.
   *  Present (not absent) so the SDK's provided-session manifest apply path — which
   *  requires `applyManifest()` OR `materializeEntry()` when the agent declares
   *  entries — is satisfied without error. A session swapped from a managed
   *  sandbox can still present managed-only manifest entries here; they remain
   *  intentionally unstaged on the user-owned machine. */
  async materializeEntry(_args: { path: string; entry: unknown; runAs?: string }): Promise<void> {
    // There is deliberately no provider write for BYO compute, but the model's
    // materialization operation must still fail closed when a cached personal
    // route lost its exact-attempt authority.
    await this.admitOperation(false);
    return;
  }

  /** SDK filesystem capability `createEditor`: the apply_patch host. Applies V4A
   *  diffs over the NATS fs ops (read → applyDiff → write). `applyDiff` is the SDK's
   *  own parser, injected by the runtime barrel (the leaf cannot import it). */
  createEditor(runAs?: string): SelfhostedEditor {
    const applyDiff = injectedApplyDiff;
    if (!applyDiff) {
      throw new Error(
        "selfhosted createEditor: applyDiff not injected (the runtime barrel must call setSelfhostedApplyDiff before an agent turn binds the filesystem capability)",
      );
    }
    const pathExists = (path: string): Promise<boolean> => this.pathExists(path, runAs);
    const readText = async (path: string): Promise<string> =>
      decoder.decode(await this.readFile({ path, ...(runAs ? { runAs } : {}) }));
    const writeText = async (path: string, content: string): Promise<void> => {
      await this.writeFile({ path, content, createParents: true });
    };
    const deletePath = async (path: string): Promise<void> => {
      // No fs-delete op in the proto; remove via the shell (the machine's own rm).
      // The path arg is embedded in the command, and this.exec runs it with the
      // DEFAULT cwd = the session workingDir. So target the path RELATIVE to that
      // cwd: strip the virtual root to its bare remainder (toMachinePath with an
      // EMPTY base) — prefixing workingDir here too would DOUBLE it (the cwd is
      // already workingDir). A non-virtual absolute path passes through and rm
      // uses it as-is; an empty workingDir is byte-identical to before.
      await this.exec({
        cmd: `rm -rf -- ${shellQuote(toMachinePath(path, ""))}`,
        ...(runAs ? { runAs } : {}),
      });
    };
    return {
      async createFile(operation) {
        if (await pathExists(operation.path)) {
          throw new Error(`selfhosted createFile: file already exists: ${operation.path}`);
        }
        await writeText(operation.path, applyDiff("", operation.diff, "create"));
        return {};
      },
      async updateFile(operation) {
        const current = await readText(operation.path);
        const next = applyDiff(current, operation.diff);
        const destination = operation.moveTo ?? operation.path;
        await writeText(destination, next);
        if (operation.moveTo && destination !== operation.path) {
          await deletePath(operation.path);
        }
        return {};
      },
      async deleteFile(operation) {
        await deletePath(operation.path);
        return {};
      },
    };
  }

  /** Channel-A `readFile`: read a file off the machine (binary-safe). */
  async readFile(args: { path: string; runAs?: string; maxBytes?: number }): Promise<Uint8Array> {
    const path = toMachinePath(args.path, this.workingDir);
    const requestedBytes = args.maxBytes ?? Number.POSITIVE_INFINITY;
    const chunks: Uint8Array[] = [];
    let offset = 0;
    let totalSize = Number.POSITIVE_INFINITY;

    while (offset < requestedBytes && offset < totalSize) {
      const remaining = Math.min(requestedBytes - offset, SELFHOSTED_FS_READ_CHUNK_BYTES);
      const result = await this.call({
        $case: "fsRead",
        fsRead: {
          path,
          offset: String(offset),
          length: String(remaining),
        },
      });
      if (result.$case !== "fsRead") {
        throw new Error(`selfhosted readFile: unexpected result ${result.$case}`);
      }
      totalSize = safeWireSize(result.fsRead.totalSize, "selfhosted file size");
      if (result.fsRead.content.byteLength === 0) break;
      chunks.push(result.fsRead.content);
      offset += result.fsRead.content.byteLength;
    }

    const content = new Uint8Array(offset);
    let cursor = 0;
    for (const chunk of chunks) {
      content.set(chunk, cursor);
      cursor += chunk.byteLength;
    }
    return content;
  }

  /** Write a file onto the machine (the fs surface the descriptor advertises). */
  async writeFile(args: {
    path: string;
    content: string | Uint8Array;
    createParents?: boolean;
    append?: boolean;
  }): Promise<number> {
    const content = typeof args.content === "string" ? encoder.encode(args.content) : args.content;
    const result = await this.call({
      $case: "fsWrite",
      fsWrite: {
        path: toMachinePath(args.path, this.workingDir),
        content,
        createParents: args.createParents ?? true,
        append: args.append ?? false,
        mode: 0,
      },
    });
    if (result.$case !== "fsWrite") {
      throw new Error(`selfhosted writeFile: unexpected result ${result.$case}`);
    }
    return Number(result.fsWrite.bytesWritten);
  }

  /** Stage one bounded controller-owned authority file outside the workspace.
   * The exact private path is deliberately narrower than the ordinary fs
   * surface, and the explicit wire mode keeps the file private even when the
   * Connected Machine agent was launched under a permissive umask. */
  async writePlacementPrivate(args: {
    path: string;
    content: string | Uint8Array;
    createParents?: boolean;
    runAs?: string;
  }): Promise<number> {
    const path = selfhostedPlacementPrivatePath(args.path);
    const content = typeof args.content === "string" ? encoder.encode(args.content) : args.content;
    if (content.byteLength > SELFHOSTED_PLACEMENT_PRIVATE_MAX_BYTES) {
      throw new TypeError("selfhosted placement-private content is invalid");
    }
    const result = await this.call({
      $case: "fsWrite",
      fsWrite: {
        path,
        content,
        createParents: args.createParents ?? true,
        append: false,
        mode: 0o600,
      },
    });
    if (result.$case !== "fsWrite") {
      throw new Error(`selfhosted writePlacementPrivate: unexpected result ${result.$case}`);
    }
    return Number(result.fsWrite.bytesWritten);
  }

  /** Idempotently remove only an OpenGeni placement-private authority file.
   * This uses the filesystem control op rather than exec, so cleanup still
   * runs when the consuming command fails before a child process starts. */
  async deletePlacementPrivate(path: string, _runAs?: string): Promise<void> {
    const privatePath = selfhostedPlacementPrivatePath(path);
    try {
      const result = await this.call({
        $case: "fsRemove",
        fsRemove: { path: privatePath, recursive: false },
      });
      if (result.$case !== "fsRemove") {
        throw new Error(`selfhosted deletePlacementPrivate: unexpected result ${result.$case}`);
      }
    } catch (error) {
      if (error instanceof SelfhostedControlError && error.osNotFound) return;
      throw error;
    }
  }

  /** List a directory on the machine. */
  async listFiles(args: {
    path: string;
    recursive?: boolean;
  }): Promise<NonNullable<ControlResponse["result"]> & { $case: "fsList" }> {
    const result = await this.call({
      $case: "fsList",
      fsList: {
        path: toMachinePath(args.path, this.workingDir),
        recursive: args.recursive ?? false,
      },
    });
    if (result.$case !== "fsList") {
      throw new Error(`selfhosted listFiles: unexpected result ${result.$case}`);
    }
    return result;
  }

  /** Stat a path on the machine. */
  async statFile(args: { path: string }): Promise<{ exists: boolean }> {
    const result = await this.call({
      $case: "fsStat",
      fsStat: { path: toMachinePath(args.path, this.workingDir) },
    });
    if (result.$case !== "fsStat") {
      throw new Error(`selfhosted statFile: unexpected result ${result.$case}`);
    }
    return { exists: result.fsStat.exists };
  }

  // ── Computer-use control plane (the agent drives its OWN screen) ──────────────
  // The CONTROL-PLANE twin of the relay DesktopInput/desktop stream: instead of a
  // human viewer channel, the agent injects synthetic input into — and captures —
  // its own display for the model's computer-use loop. Both route over the SAME
  // `call()` primitive, so a consent/epoch rejection surfaces as the mapped
  // `SelfhostedControlError` exactly like every other op. `NativeDesktopComputer`
  // (sandbox-computer.ts) is the sole consumer.

  /** Computer-use WRITE op: inject one synthetic desktop input event (pointer/key/
   *  scroll) on the machine's OWN display. The agent injects via CGEvent (macOS) /
   *  XTEST (Linux) and CONSENT-GATES it — an unconsented call never touches the OS
   *  and surfaces the mapped control error (ERROR_CODE_CONSENT_REQUIRED) via `call()`. */
  async desktopInput(event: DesktopInputRequest["event"]): Promise<void> {
    const result = await this.call({
      $case: "desktopInput",
      desktopInput: { event },
    });
    if (result.$case !== "desktopInput") {
      throw new Error(`selfhosted desktopInput: unexpected result ${result.$case}`);
    }
  }

  /** Computer-use VIEW op: capture a single PNG screenshot of the machine's desktop
   *  plus its geometry (via ScreenCaptureKit / x11). NOT consent-gated (a view op —
   *  the view/control decoupling), so it works with a display but no screen-control
   *  consent. Returns the raw encoded bytes + the ENCODED width/height, plus the
   *  NATIVE (pre-downscale) geometry: when the agent had to downscale the PNG to fit
   *  the transport's max payload, `nativeWidth`/`nativeHeight` carry the original
   *  capture size so the computer-use layer can scale model clicks (in encoded-pixel
   *  space) back to native pixels. An older agent leaves them 0 → read as "same as
   *  width/height" (no downscale). */
  async screenshot(): Promise<{
    png: Uint8Array;
    width: number;
    height: number;
    nativeWidth: number;
    nativeHeight: number;
  }> {
    const result = await this.call({
      $case: "desktopScreenshot",
      desktopScreenshot: {},
    });
    if (result.$case !== "desktopScreenshot") {
      throw new Error(`selfhosted screenshot: unexpected result ${result.$case}`);
    }
    const s = result.desktopScreenshot;
    // Back-compat: an agent predating the native-geometry fields sends 0 → treat the
    // encoded geometry AS the native geometry (scale factor 1.0, no coordinate shift).
    return {
      png: s.png,
      width: s.width,
      height: s.height,
      nativeWidth: s.nativeWidth || s.width,
      nativeHeight: s.nativeHeight || s.height,
    };
  }

  /** Ensure the loopback browser controller sidecar owned by this connected
   * machine. The authority scope is supplied by the caller and remains local. */
  async ensureBrowserControl(
    request: BrowserControlEnsureRequest,
  ): Promise<BrowserControlEnsureResponse> {
    const result = await this.call({
      $case: "browserControlEnsure",
      browserControlEnsure: request,
    });
    if (result.$case !== "browserControlEnsure") {
      throw new Error(`selfhosted ensureBrowserControl: unexpected result ${result.$case}`);
    }
    return result.browserControlEnsure;
  }

  /** Open one browser-native frame producer and return its canonical relay
   * endpoint. This does not route through `resolveExposedPort`: that legacy
   * method allocates PTY/desktop resources based on fixed ports, while this op
   * returns the exact fresh browser StreamChannel allocated by the agent. */
  async openBrowserFrames(
    request: BrowserFramesOpenRequest,
  ): Promise<{ channel: StreamChannel; endpoint: ExposedPortEndpoint }> {
    const result = await this.call({
      $case: "browserFramesOpen",
      browserFramesOpen: request,
    });
    if (result.$case !== "browserFramesOpen" || !result.browserFramesOpen.channel) {
      throw new Error(`selfhosted openBrowserFrames: unexpected result ${result.$case}`);
    }
    const channel = result.browserFramesOpen.channel;
    return { channel, endpoint: this.relayEndpoint(channel) };
  }

  /** Open one ComputerSession frame producer through the same relay fabric. */
  async openComputerFrames(
    request: ComputerFramesOpenRequest,
  ): Promise<{ channel: StreamChannel; endpoint: ExposedPortEndpoint }> {
    const result = await this.call({
      $case: "computerFramesOpen",
      computerFramesOpen: request,
    });
    if (result.$case !== "computerFramesOpen" || !result.computerFramesOpen.channel) {
      throw new Error(`selfhosted openComputerFrames: unexpected result ${result.$case}`);
    }
    const channel = result.computerFramesOpen.channel;
    return { channel, endpoint: this.relayEndpoint(channel) };
  }

  /** A cheap liveness probe — request a Ping on the subject; returns true iff a
   *  responder answered (no AgentError). Used by `negotiateSelfhostedCapabilities`.
   *  The wire `nonce` is a uint64 (a numeric string), so the default is a random
   *  numeric value — NOT a UUID (which would fail proto uint64 encoding). */
  async ping(nonce = randomNonce()): Promise<boolean> {
    const admission = await this.admitOperation(false);
    const req: ControlRequest = {
      requestId: crypto.randomUUID(),
      epoch: this.epoch,
      resourcePolicy: undefined,
      op: { $case: "ping", ping: { nonce } },
    };
    const res = await this.controlRpc.request(admission.subject, req, {
      timeoutMs: this.timeoutMs,
    });
    return !res.error && res.result?.$case === "ping";
  }

  /**
   * Resolve an exposed port to a relay stream endpoint (the viewer/pty plane).
   * Returns the relay URL SHAPE — `{host:relay, port, tls, query:channel-key}` —
   * after asking the agent to ensure a stream channel for the port. M8b wires the
   * real relay tier (the byte pump) behind THIS seam.
   *
   * THE CHANNEL-KEY QUERY (the M8b relay-dial contract): the relay
   * routes by `{workspaceId, agentId, port, channelId}` — the EXACT `ChannelKey::query` the
   * agent's relay client (`opengeni-agent-stream`) appends when it registers the
   * producer side: `ws=<workspaceId>&agent=<agentId>&port=<port>&channel=<channelId>`.
   * Channel id is routing identity, not a correlation hint, so concurrent PTYs
   * on one connected machine never replace one another. The viewer
   * dials `wss://<relay>/stream?ws=&agent=&port=&channel=` and presents the minted
   * `ogs_` token in-band (NEVER as a URL param) — the relay pairs it with the
   * producer by the routing key.
   */
  async resolveExposedPort(port: number): Promise<ExposedPortEndpoint> {
    // Ask the agent to ensure a relay PRODUCER channel exists for the port, using the
    // PORT-APPROPRIATE op. The PTY plane (7681) is INDEPENDENT of the desktop display:
    // route it through `ptyOpen` (which spawns/attaches a PTY and NEVER touches X11),
    // and ONLY the desktop framebuffer plane (6080) through `desktopEnsure` (which
    // hard-requires a live virtual display). Earlier M8b used `desktopEnsure` for
    // EVERY port — that wrongly coupled the terminal to the desktop probe, so a
    // headless (or display-degraded) machine could never get a terminal even though
    // `ptyOpen` would have succeeded. The returned channelId is the relay
    // routing identity; both ops carry a `StreamChannel` on their response.
    let channel: StreamChannel | undefined;
    if (port === DESKTOP_STREAM_PORT) {
      const result = await this.call({
        $case: "desktopEnsure",
        desktopEnsure: { width: 0, height: 0 },
      });
      if (result.$case !== "desktopEnsure") {
        throw new Error(
          `selfhosted resolveExposedPort(${port}): unexpected result ${result.$case}`,
        );
      }
      channel = result.desktopEnsure.channel;
    } else {
      // The PTY plane (7681) + any non-desktop stream port. `command: []` => the
      // user's default login shell; the agent's pty_pump bridges the PTY master to
      // the relay channel. Display-INDEPENDENT — works on a headless machine.
      const result = await this.call({
        $case: "ptyOpen",
        // Open the terminal in the session workingDir (default "" ⇒ the agent's
        // workspace_root, byte-identical to before). A relative workingDir resolves
        // under workspace_root; an absolute one is used as-is by the agent.
        ptyOpen: {
          command: [],
          cwd: this.workingDir,
          env: {},
          cols: 0,
          rows: 0,
          term: "xterm-256color",
          scopeId: this.terminalScopeId,
        },
      });
      if (result.$case !== "ptyOpen") {
        throw new Error(
          `selfhosted resolveExposedPort(${port}): unexpected result ${result.$case}`,
        );
      }
      channel = result.ptyOpen.channel;
    }
    if (channel) return this.relayEndpoint(channel);
    const channelId = channelKey(this.controlWorkspaceId, this.agentId, port);
    const tls = this.relay.tls ?? true;
    // The routing key the relay pairs producer↔consumer by — IDENTICAL to the
    // agent's `ChannelKey::query`, including the stream-instance channel id.
    const routingQuery =
      `ws=${encodeURIComponent(this.controlWorkspaceId)}` +
      `&agent=${encodeURIComponent(this.agentId)}` +
      `&port=${port}` +
      `&channel=${encodeURIComponent(channelId)}`;
    return {
      host: this.relay.host,
      port: this.relay.port ?? (tls ? 443 : 80),
      tls,
      // The relay's wss route (`/stream`); buildStreamUrl honors `path`.
      path: this.relay.path ?? SELFHOSTED_RELAY_STREAM_PATH,
      query: routingQuery,
    };
  }

  private relayEndpoint(channel: StreamChannel): ExposedPortEndpoint {
    const tls = this.relay.tls ?? true;
    const routingQuery =
      `ws=${encodeURIComponent(channel.workspaceId)}` +
      `&agent=${encodeURIComponent(channel.agentId)}` +
      `&port=${channel.port}` +
      `&channel=${encodeURIComponent(channel.channelId)}`;
    return {
      host: this.relay.host,
      port: this.relay.port ?? (tls ? 443 : 80),
      tls,
      path: this.relay.path ?? SELFHOSTED_RELAY_STREAM_PATH,
      query: routingQuery,
      protocol: kindToProtocol(channel.kind),
    };
  }

  /** Round-trip the persistable state — `{agentId}` ONLY (resume = re-address). */
  async serializeSessionState(): Promise<SelfhostedSessionState> {
    return { agentId: this.agentId };
  }
}

/**
 * The selfhosted SDK-client surface the registry builds. `backendId:"selfhosted"`
 * (the resume-fence field asserted against the descriptor). `create()`/`resume()`
 * return a `SelfhostedSession` bound to `{workspaceId, agentId, controlRpc}`.
 *
 * `create()` and `resume()` are IDENTICAL for selfhosted — there is no box to
 * provision (the machine already exists); both just bind a session to the live
 * subject. `serializeSessionState`/`deserializeSessionState` round-trip
 * `{agentId}` only.
 *
 * The `controlRpc` is constructed LAZILY via an injected factory (defaulting to
 * `NatsControlRpc`); a session built before NATS is configured surfaces
 * `agent_offline` on its first op rather than failing at construction.
 */
export class SelfhostedSandboxClient {
  readonly backendId = "selfhosted" as const;
  readonly supportsDefaultOptions = false;
  private readonly workspaceId: string;
  private readonly controlWorkspaceId: string | undefined;
  private readonly relay: SelfhostedRelayConfig;
  private readonly controlRpcFactory: () => ControlRpc;
  private readonly defaultAgentId: string | undefined;
  private readonly connectionInstanceId: string | undefined;
  private readonly terminalScopeId: string | undefined;
  private readonly epoch: number | undefined;
  private readonly timeoutMs: number | undefined;
  private readonly execTimeoutMs: number | undefined;
  private readonly environment: Record<string, string> | undefined;
  private readonly transientExecEnvironment: (() => Readonly<Record<string, string>>) | undefined;
  private readonly workingDir: string | undefined;
  private readonly operationResourcePolicy: SelfhostedOperationResourcePolicy | undefined;
  private readonly operationResourcePolicySupported: boolean | undefined;
  private readonly operationCpuQuotaSupported: boolean | undefined;
  private readonly resolveOperationAdmission:
    | (() => Promise<SelfhostedOperationAdmission | null>)
    | undefined;
  private readonly onOp: SelfhostedOpObserver | undefined;
  private readonly opStream: SelfhostedOpStreamDeps | undefined;
  private controlRpcMemo: ControlRpc | undefined;

  constructor(opts: {
    workspaceId: string;
    controlWorkspaceId?: string;
    relay: SelfhostedRelayConfig;
    /** Lazily build the ControlRpc (defaults to NatsControlRpc in the provider). */
    controlRpcFactory: () => ControlRpc;
    /** The agentId a bare create()/resume() (no state) binds to. Optional: the
     *  resume path supplies it via deserializeSessionState. */
    agentId?: string;
    /** Exact live daemon process. Production builders always supply it. */
    connectionInstanceId?: string;
    /** Stable terminal identity (normally the durable OpenGeni session id). */
    terminalScopeId?: string;
    epoch?: number;
    /** The control-op timeout threaded into every bound session. */
    timeoutMs?: number;
    /** The exec process deadline threaded into every bound session (distinct from
     *  `timeoutMs`; 0 means no duration deadline, while omission preserves the
     *  historical control-timeout value fallback for embedding callers). */
    execTimeoutMs?: number;
    operationResourcePolicy?: SelfhostedOperationResourcePolicy;
    operationResourcePolicySupported?: boolean;
    operationCpuQuotaSupported?: boolean;
    resolveOperationAdmission?: () => Promise<SelfhostedOperationAdmission | null>;
    /** The run's declared sandbox environment, threaded into every bound session's
     *  `state.manifest.environment` so the SDK's per-turn manifest-env delta is
     *  empty (validateNoEnvironmentDelta). See SelfhostedSessionDeps.environment.
     *  Omitted → `{}` (the negotiation-only path; no turn manifest is applied). */
    environment?: Record<string, string>;
    /** Attempt-local child-process environment; never persisted or manifested. */
    transientExecEnvironment?: () => Readonly<Record<string, string>>;
    /** The session working directory threaded into every bound session (the path/
     *  cwd base; see SelfhostedSessionDeps.workingDir). Omitted/empty ⇒ the default
     *  workspace_root behavior. */
    workingDir?: string;
    /** The per-op observer threaded into every bound session (out-of-band telemetry). */
    onOp?: SelfhostedOpObserver;
    /** The op-stream exec transport threaded into every bound session (present
     *  = enabled; see SelfhostedOpStreamDeps). */
    opStream?: SelfhostedOpStreamDeps;
  }) {
    this.workspaceId = opts.workspaceId;
    this.controlWorkspaceId = opts.controlWorkspaceId;
    this.relay = opts.relay;
    this.controlRpcFactory = opts.controlRpcFactory;
    this.defaultAgentId = opts.agentId;
    this.connectionInstanceId = opts.connectionInstanceId;
    this.terminalScopeId = opts.terminalScopeId;
    this.epoch = opts.epoch;
    this.timeoutMs = opts.timeoutMs;
    this.execTimeoutMs = opts.execTimeoutMs;
    this.operationResourcePolicy = opts.operationResourcePolicy;
    this.operationResourcePolicySupported = opts.operationResourcePolicySupported;
    this.operationCpuQuotaSupported = opts.operationCpuQuotaSupported;
    this.resolveOperationAdmission = opts.resolveOperationAdmission;
    this.environment = opts.environment;
    this.transientExecEnvironment = opts.transientExecEnvironment;
    this.workingDir = opts.workingDir;
    this.onOp = opts.onOp;
    this.opStream = opts.opStream;
  }

  private controlRpc(): ControlRpc {
    if (!this.controlRpcMemo) {
      this.controlRpcMemo = this.controlRpcFactory();
    }
    return this.controlRpcMemo;
  }

  private bind(agentId: string): SelfhostedSession {
    return new SelfhostedSession({
      workspaceId: this.workspaceId,
      ...(this.controlWorkspaceId !== undefined
        ? { controlWorkspaceId: this.controlWorkspaceId }
        : {}),
      agentId,
      ...(this.connectionInstanceId !== undefined
        ? { connectionInstanceId: this.connectionInstanceId }
        : {}),
      controlRpc: this.controlRpc(),
      relay: this.relay,
      ...(this.terminalScopeId !== undefined ? { terminalScopeId: this.terminalScopeId } : {}),
      ...(this.epoch !== undefined ? { epoch: this.epoch } : {}),
      ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
      ...(this.execTimeoutMs !== undefined ? { execTimeoutMs: this.execTimeoutMs } : {}),
      ...(this.operationResourcePolicy !== undefined
        ? { operationResourcePolicy: this.operationResourcePolicy }
        : {}),
      ...(this.operationResourcePolicySupported !== undefined
        ? {
            operationResourcePolicySupported: this.operationResourcePolicySupported,
          }
        : {}),
      ...(this.operationCpuQuotaSupported !== undefined
        ? { operationCpuQuotaSupported: this.operationCpuQuotaSupported }
        : {}),
      ...(this.resolveOperationAdmission !== undefined
        ? { resolveOperationAdmission: this.resolveOperationAdmission }
        : {}),
      ...(this.environment !== undefined ? { environment: this.environment } : {}),
      ...(this.transientExecEnvironment !== undefined
        ? { transientExecEnvironment: this.transientExecEnvironment }
        : {}),
      ...(this.workingDir !== undefined ? { workingDir: this.workingDir } : {}),
      ...(this.onOp !== undefined ? { onOp: this.onOp } : {}),
      ...(this.opStream !== undefined ? { opStream: this.opStream } : {}),
    });
  }

  /** Bind a session to the live agent subject. There is no box to provision. */
  async create(_manifest?: unknown, _options?: unknown): Promise<SelfhostedSession> {
    const agentId = this.requireAgentId();
    return this.bind(agentId);
  }

  /** Resume = re-address the subject. Identical to create — no provider state. */
  async resume(
    state: SelfhostedSessionState | Record<string, unknown>,
    _options?: unknown,
  ): Promise<SelfhostedSession> {
    const agentId = readAgentId(state) ?? this.requireAgentId();
    return this.bind(agentId);
  }

  /** Serialize a live session's state → `{agentId}` ONLY. */
  async serializeSessionState(
    state: SelfhostedSessionState | { agentId?: string } | unknown,
  ): Promise<SelfhostedSessionState> {
    const agentId = readAgentId(state) ?? this.requireAgentId();
    return { agentId };
  }

  /** Deserialize `{agentId}` from the persisted envelope. */
  async deserializeSessionState(state: Record<string, unknown>): Promise<SelfhostedSessionState> {
    const agentId = readAgentId(state) ?? this.requireAgentId();
    return { agentId };
  }

  /** selfhosted is NOT persistable — there is no owned session state to preserve
   *  (the machine is the persistence). The lease never snapshots it. */
  async canPersistOwnedSessionState(): Promise<boolean> {
    return false;
  }

  private requireAgentId(): string {
    if (!this.defaultAgentId) {
      throw new Error(
        "selfhosted sandbox client: no agentId bound (create()/resume() need a session state carrying agentId)",
      );
    }
    return this.defaultAgentId;
  }
}

/**
 * The dependency shape `buildSelfhostedBackendSession` needs to bind a live
 * selfhosted session to a target machine. A structural superset of the fields the
 * routing resolver (backend-resolver.ts) reads off its deps + pointer, and the
 * fields the WORKER turn's machine-primary establish branch threads in — so a
 * SINGLE build shape is shared by both (never two divergent constructions of the
 * same SelfhostedSandboxClient/resume pair).
 */
export interface SelfhostedSessionBuild {
  /** Authorization/session workspace. */
  workspaceId: string;
  /** Physical machine-origin workspace used in agent and relay routes. */
  controlWorkspaceId?: string;
  /** The enrollment id == the agent id the exact process subject addresses. */
  agentId: string;
  /** Exact daemon instance holding the enrollment's live connection lease. */
  connectionInstanceId: string;
  /** The relay-URL shape for stream endpoints. */
  relay: SelfhostedRelayConfig;
  /** Stable terminal identity; normally the durable OpenGeni session id. */
  terminalScopeId?: string;
  /** Lazily build the live ControlRpc (the request-scoped NATS connection). */
  controlRpcFactory: () => ControlRpc;
  /** The lease/active epoch the session is fenced under (echoed on every op). */
  epoch: number;
  /** The run's declared sandbox environment → the session manifest.environment
   *  (env-parity; see SelfhostedSessionDeps.environment). */
  environment?: Record<string, string>;
  /** Attempt-local child-process values; see SelfhostedSessionDeps. */
  transientExecEnvironment?: () => Readonly<Record<string, string>>;
  /** The session working directory (the path/cwd base). Null/absent ⇒ workspace_root. */
  workingDir?: string | null;
  /** The control-op timeout (ping/fs/desktop/pty). Absent ⇒ the 30s default. */
  timeoutMs?: number;
  /** The exec process deadline, distinct from `timeoutMs`. 0 = none; absence
   *  preserves the historical control-timeout value fallback for embedding callers. */
  execTimeoutMs?: number;
  /** Per-enrollment optional command policy resolved from the same database
   * snapshot as the exact connection identity. */
  operationResourcePolicy?: SelfhostedOperationResourcePolicy;
  /** Exact live runner capability paired with that snapshot. */
  operationResourcePolicySupported?: boolean;
  /** Exact live CPU enforcement capability paired with the initial snapshot. */
  operationCpuQuotaSupported?: boolean;
  /** Live last-boundary operation admission resolver; see SelfhostedSessionDeps. */
  resolveOperationAdmission?: () => Promise<SelfhostedOperationAdmission | null>;
  /** The per-op observer (out-of-band telemetry). Absent ⇒ no-op. */
  onOp?: SelfhostedOpObserver;
  /** The op-stream exec transport (present when the runner advertises it and the
   *  server flag is on). Required for every Connected Machine exec command. */
  opStream?: SelfhostedOpStreamDeps;
}

/**
 * Build a live selfhosted session bound to a target machine: construct a request-
 * scoped `SelfhostedSandboxClient` (fenced under `epoch`, carrying the run's env +
 * working dir) and `resume()` it (= re-address the live subject — no provider box
 * is created). Returns BOTH the client (the OWNED-sandbox client the turn injects,
 * whose `serializeSessionState` round-trips `{agentId}`) and the live session.
 *
 * Shared by:
 *   - the routing resolver (backend-resolver.ts) — a swap target, where only the
 *     session is needed; and
 *   - the worker turn's machine-primary establish branch — where the client is the
 *     owned-sandbox client AND the session is the pinned routing default.
 * Factoring it here keeps the two builds identical (no divergence in the fence
 * epoch, env threading, or working-dir base).
 */
export async function buildSelfhostedBackendSession(
  deps: SelfhostedSessionBuild,
): Promise<{ client: SelfhostedSandboxClient; session: SelfhostedSession }> {
  const client = new SelfhostedSandboxClient({
    workspaceId: deps.workspaceId,
    ...(deps.controlWorkspaceId !== undefined
      ? { controlWorkspaceId: deps.controlWorkspaceId }
      : {}),
    relay: deps.relay,
    controlRpcFactory: deps.controlRpcFactory,
    agentId: deps.agentId,
    connectionInstanceId: deps.connectionInstanceId,
    epoch: deps.epoch,
    ...(deps.terminalScopeId !== undefined ? { terminalScopeId: deps.terminalScopeId } : {}),
    ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
    ...(deps.execTimeoutMs !== undefined ? { execTimeoutMs: deps.execTimeoutMs } : {}),
    ...(deps.operationResourcePolicy !== undefined
      ? { operationResourcePolicy: deps.operationResourcePolicy }
      : {}),
    ...(deps.operationResourcePolicySupported !== undefined
      ? {
          operationResourcePolicySupported: deps.operationResourcePolicySupported,
        }
      : {}),
    ...(deps.operationCpuQuotaSupported !== undefined
      ? { operationCpuQuotaSupported: deps.operationCpuQuotaSupported }
      : {}),
    ...(deps.resolveOperationAdmission !== undefined
      ? { resolveOperationAdmission: deps.resolveOperationAdmission }
      : {}),
    ...(deps.onOp !== undefined ? { onOp: deps.onOp } : {}),
    ...(deps.environment !== undefined ? { environment: deps.environment } : {}),
    ...(deps.transientExecEnvironment !== undefined
      ? { transientExecEnvironment: deps.transientExecEnvironment }
      : {}),
    ...(deps.workingDir ? { workingDir: deps.workingDir } : {}),
    ...(deps.opStream !== undefined ? { opStream: deps.opStream } : {}),
  });
  const session = await client.resume({ agentId: deps.agentId });
  return { client, session };
}

function readAgentId(state: unknown): string | undefined {
  if (state && typeof state === "object") {
    const candidate =
      (state as { agentId?: unknown }).agentId ??
      (state as { providerState?: { agentId?: unknown } }).providerState?.agentId;
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return undefined;
}

function safeWireSize(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} is outside the supported range`);
  }
  return parsed;
}

function selfhostedPlacementPrivatePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < `${SELFHOSTED_PLACEMENT_PRIVATE_PREFIX}x`.length ||
    value.length > 4_096 ||
    !value.startsWith(SELFHOSTED_PLACEMENT_PRIVATE_PREFIX) ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    value.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new TypeError("selfhosted placement-private path is invalid");
  }
  return value;
}

function joinExecCommandOutput(stdout: string, stderr: string): string {
  return [stdout, stderr].filter((value) => value.trim().length > 0).join("\n");
}

function execResultToChannelA(res: ExecResponse, execDeadlineMs: number): SelfhostedExecResult {
  const stdout = decoder.decode(res.stdout);
  let stderr = decoder.decode(res.stderr);
  if (res.timedOut && execDeadlineMs > 0) {
    // The agent killed the child at the exec deadline. Surface an actionable hint
    // on STDERR ONLY — stdout is left byte-exact because the structural Channel-A
    // surface parses command stdout (find/stat/git listings); a hint injected there
    // would corrupt those parsers.
    const hint = execDeadlineHint(Math.round(execDeadlineMs / 1000));
    stderr = stderr ? `${stderr}\n${hint}` : hint;
  }
  return {
    output: stdout,
    stdout,
    stderr,
    exitCode: res.exitCode,
    timedOut: res.timedOut,
  };
}

function execRequiresOpStream(cause?: OpStreamUnavailableError): SelfhostedControlError {
  const runnerUpgrade = cause?.unavailableKind === "runner" || cause === undefined;
  return new SelfhostedControlError({
    message: runnerUpgrade
      ? "This Connected Machine does not advertise the streaming command protocol required for exec. Update and reconnect the OpenGeni agent. The command was not started."
      : "The Connected Machine streaming channel is temporarily unavailable. OpenGeni did not downgrade to an ambiguous request/reply command; the command was not started. Retry after the machine reconnects.",
    code: runnerUpgrade ? ErrorCode.ERROR_CODE_UNSUPPORTED : ErrorCode.ERROR_CODE_STREAM,
    reason: runnerUpgrade ? null : "agent_reconnecting",
    retryable: !runnerUpgrade,
  });
}

function channelKey(workspaceId: string, agentId: string, port: number): string {
  return `${workspaceId}:${agentId}:${port}`;
}

/** Single-quote a string for POSIX shell (the editor's delete uses the machine's
 *  own `rm`). Mirrors the standard `'…'` quoting with `'\''` escaping. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Detect an image media type from magic bytes (with a path-extension fallback),
 *  mirroring @openai/agents-core's `sniffImageMediaType` so `viewImage` returns the
 *  SAME media types the SDK would. Returns undefined for an unrecognized format. */
function sniffImageMediaType(bytes: Uint8Array, path: string): string | undefined {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38)
    return "image/gif";
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return "image/webp";
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";
  if (
    (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
    (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a)
  )
    return "image/tiff";
  if (looksLikeSvg(bytes)) return "image/svg+xml";
  return mediaTypeFromPath(path);
}

function looksLikeSvg(bytes: Uint8Array): boolean {
  const prefix = decoder
    .decode(bytes.subarray(0, Math.min(bytes.byteLength, 512)))
    .trimStart()
    .toLowerCase();
  return prefix.startsWith("<svg") || /^<\?xml[\s\S]*<svg/u.test(prefix);
}

function mediaTypeFromPath(path: string): string | undefined {
  const p = path?.trim().toLowerCase() ?? "";
  if (p.endsWith(".png")) return "image/png";
  if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
  if (p.endsWith(".gif")) return "image/gif";
  if (p.endsWith(".webp")) return "image/webp";
  if (p.endsWith(".bmp")) return "image/bmp";
  if (p.endsWith(".tif") || p.endsWith(".tiff")) return "image/tiff";
  if (p.endsWith(".svg") || p.endsWith(".svgz")) return "image/svg+xml";
  return undefined;
}

/** A random uint64-safe numeric nonce (the wire `PingRequest.nonce` is a uint64,
 *  represented as a numeric string by ts-proto). */
function randomNonce(): string {
  // 2^53-safe random integer as a decimal string.
  return String(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
}

function kindToProtocol(kind: StreamKind | undefined): string {
  switch (kind) {
    case StreamKind.STREAM_KIND_PTY:
      return "pty";
    case StreamKind.STREAM_KIND_DESKTOP:
      return "vnc";
    default:
      return "raw";
  }
}

/**
 * The selfhosted NotFound discriminator — THE load-bearing safety property
 *: for selfhosted, `agent-offline` (no responder) is NEVER a
 * provider NotFound. A user's real machine is not recreatable; if the lease saw
 * agent-offline as NotFound it would cold-create a RIVAL box (a Modal box) for
 * the user's machine. So this ALWAYS returns FALSE for selfhosted — there is no
 * "box gone, recreate it" condition. An OS-level file NotFound is an op-level
 * error the fs layer 404s; it is likewise NOT a session-recreate condition.
 *
 * `establishSandboxSessionFromEnvelope` cold-restores ONLY when the per-backend
 * NotFound discriminator returns true; returning false here guarantees the
 * selfhosted path never cold-creates a rival — the op surfaces agent_offline and
 * the caller backs off / retries.
 */
export function isSelfhostedProviderNotFoundError(_error: unknown): false {
  return false;
}
