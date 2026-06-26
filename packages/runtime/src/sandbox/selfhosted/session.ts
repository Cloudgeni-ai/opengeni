// `SelfhostedSession` + `SelfhostedSandboxClient` — the NATS-backed structural
// sandbox surface for the `selfhosted` backend (bring-your-own-compute).
//
// The insight (dossier §7): every existing seam (Channel-A exec/fs/git, the
// viewer's `resolveExposedPort`, computer-use) consumes a provider session
// STRUCTURALLY — `session.exec ?? session.execCommand`, `session.readFile`,
// `session.resolveExposedPort`, `session.serializeSessionState`. If the
// selfhosted client's `create()`/`resume()` return a session presenting that
// EXACT surface — but backed by `ControlRpc` (request/reply to the agent over
// `agent.<ws>.<id>.rpc`, encoded via `@opengeni/agent-proto`) instead of a
// provider SDK — then those seams work UNCHANGED. The agent IS the box.
//
// The session depends ONLY on `ControlRpc` + `{workspaceId, agentId}` (+ the
// relay config for the stream-URL SHAPE). It knows nothing about NATS directly
// (the M3/M4 seam). `serializeSessionState`/`deserializeSessionState` round-trip
// `{agentId}` ONLY — resume = re-address the live subject, NO provider state.

import {
  ControlRequest,
  ControlResponse,
  StreamKind,
  type ExecRequest,
  type ExecResponse,
} from "@opengeni/agent-proto";
// `Manifest` from the ALLOWED sandbox-leaf entrypoint (`@openai/agents/sandbox`
// re-exports `@openai/agents-core/sandbox`, which exports the Manifest class) —
// NOT the agent-loop `@openai/agents` root the sandbox leaf forbids. The live
// `state.manifest` slice the @openai/agents SDK reads per turn must be a real
// Manifest (see the `state` field below); selfhosted exec routes over NATS and
// does not use the manifest, but the SDK requires it present + well-formed.
import { Manifest } from "@openai/agents/sandbox";
import type { ExposedPortEndpoint } from "../stream-port";
import {
  agentErrorToControlError,
  subjectFor,
  type ControlRpc,
} from "./control-rpc";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Default control-op timeout. A transient miss surfaces as `agent_reconnecting`
 *  (the turn pauses + retries); it is NOT a hard failure. */
export const SELFHOSTED_DEFAULT_TIMEOUT_MS = 30_000;

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

export interface SelfhostedSessionDeps {
  workspaceId: string;
  agentId: string;
  controlRpc: ControlRpc;
  relay: SelfhostedRelayConfig;
  /** The lease/active epoch this session is fenced under (echoed on every
   *  ControlRequest so the agent can reject a stale op with ERROR_CODE_FENCED).
   *  Defaults to 0 (no fence) for the negotiation-only / test path. */
  epoch?: number;
  /** Override the control-op timeout (tests). */
  timeoutMs?: number;
}

/** The Channel-A `exec` result shape (a structural superset of the SDK's). */
export interface SelfhostedExecResult {
  output: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
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
  readonly agentId: string;
  private readonly controlRpc: ControlRpc;
  private readonly relay: SelfhostedRelayConfig;
  private readonly epoch: number;
  private readonly timeoutMs: number;
  private readonly subject: string;

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
   */
  readonly state: { agentId: string; instanceId: string; manifest: Manifest };

  constructor(deps: SelfhostedSessionDeps) {
    this.workspaceId = deps.workspaceId;
    this.agentId = deps.agentId;
    this.controlRpc = deps.controlRpc;
    this.relay = deps.relay;
    this.epoch = deps.epoch ?? 0;
    this.timeoutMs = deps.timeoutMs ?? SELFHOSTED_DEFAULT_TIMEOUT_MS;
    this.subject = subjectFor(deps.workspaceId, deps.agentId);
    // An EMPTY-but-valid Manifest mirroring the Modal create-manifest shape
    // (sandbox/index.ts `createManifest`: a bare `new Manifest({...})` defaults
    // `root` to "/workspace" and `environment` to `{}`, matching buildManifest's
    // declared root). The SDK reads `manifest.root` (defined) and iterates
    // `manifest.environment` (an object) per turn; both hold for the empty Manifest.
    //
    // TODO(selfhosted-env): thread the workspace environment (the agent's declared
    // env vars) into `environment` here. It is NOT readily available on
    // SelfhostedSessionDeps today (create()/resume()/bind() carry only
    // {workspaceId, agentId, controlRpc, relay, epoch, timeoutMs}; create() even
    // ignores the passed manifest), so applying the workspace env to selfhosted
    // exec is follow-up. `{}` is correct for now: selfhosted exec routes over NATS
    // and does NOT consume the manifest's environment, and an empty environment
    // means the SDK's per-turn provided-session manifest delta has no env mismatch
    // to validate against this empty baseline.
    this.state = {
      agentId: deps.agentId,
      instanceId: deps.agentId,
      manifest: new Manifest({ root: "/workspace", entries: {}, environment: {} }),
    };
  }

  /** Issue a control op, decoding the agent's reply or throwing the mapped
   *  `SelfhostedControlError` on an AgentError (incl. a synthesized offline /
   *  timeout error from the transport). */
  private async call(op: NonNullable<ControlRequest["op"]>): Promise<NonNullable<ControlResponse["result"]>> {
    const req: ControlRequest = {
      requestId: crypto.randomUUID(),
      epoch: this.epoch,
      op,
    };
    const res = await this.controlRpc.request(this.subject, req, { timeoutMs: this.timeoutMs });
    if (res.error) {
      throw agentErrorToControlError(res.error);
    }
    if (!res.result) {
      throw agentErrorToControlError({
        code: 7, // ERROR_CODE_PROTOCOL — an empty result is a protocol violation
        message: "agent returned an empty control response",
        retryable: false,
        detail: {},
      });
    }
    return res.result;
  }

  /** Channel-A `exec`: run a command on the machine and return its output. */
  async exec(args: SelfhostedExecArgs): Promise<SelfhostedExecResult> {
    const execReq: ExecRequest = {
      // The agent does NOT shell-interpret unless `shell` — Channel-A passes a
      // single shell command string, so run it through the platform shell.
      command: [args.cmd],
      shell: true,
      cwd: args.workdir ?? "",
      env: {},
      stdin: new Uint8Array(0),
      timeoutMs: 0,
    };
    const result = await this.call({ $case: "exec", exec: execReq });
    if (result.$case !== "exec") {
      throw new Error(`selfhosted exec: unexpected result ${result.$case}`);
    }
    return execResultToChannelA(result.exec);
  }

  /** Channel-A `readFile`: read a file off the machine (binary-safe). */
  async readFile(args: { path: string; runAs?: string; maxBytes?: number }): Promise<Uint8Array> {
    const result = await this.call({
      $case: "fsRead",
      fsRead: {
        path: args.path,
        offset: "0",
        length: args.maxBytes ? String(args.maxBytes) : "0",
      },
    });
    if (result.$case !== "fsRead") {
      throw new Error(`selfhosted readFile: unexpected result ${result.$case}`);
    }
    return result.fsRead.content;
  }

  /** Write a file onto the machine (the fs surface the descriptor advertises). */
  async writeFile(args: { path: string; content: string | Uint8Array; createParents?: boolean; append?: boolean }): Promise<number> {
    const content = typeof args.content === "string" ? encoder.encode(args.content) : args.content;
    const result = await this.call({
      $case: "fsWrite",
      fsWrite: {
        path: args.path,
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

  /** List a directory on the machine. */
  async listFiles(args: { path: string; recursive?: boolean }): Promise<NonNullable<ControlResponse["result"]> & { $case: "fsList" }> {
    const result = await this.call({
      $case: "fsList",
      fsList: { path: args.path, recursive: args.recursive ?? false },
    });
    if (result.$case !== "fsList") {
      throw new Error(`selfhosted listFiles: unexpected result ${result.$case}`);
    }
    return result;
  }

  /** Stat a path on the machine. */
  async statFile(args: { path: string }): Promise<{ exists: boolean }> {
    const result = await this.call({ $case: "fsStat", fsStat: { path: args.path } });
    if (result.$case !== "fsStat") {
      throw new Error(`selfhosted statFile: unexpected result ${result.$case}`);
    }
    return { exists: result.fsStat.exists };
  }

  /** A cheap liveness probe — request a Ping on the subject; returns true iff a
   *  responder answered (no AgentError). Used by `negotiateSelfhostedCapabilities`.
   *  The wire `nonce` is a uint64 (a numeric string), so the default is a random
   *  numeric value — NOT a UUID (which would fail proto uint64 encoding). */
  async ping(nonce = randomNonce()): Promise<boolean> {
    const req: ControlRequest = {
      requestId: crypto.randomUUID(),
      epoch: this.epoch,
      op: { $case: "ping", ping: { nonce } },
    };
    const res = await this.controlRpc.request(this.subject, req, { timeoutMs: this.timeoutMs });
    return !res.error && res.result?.$case === "ping";
  }

  /**
   * Resolve an exposed port to a relay stream endpoint (the viewer/pty plane).
   * Returns the relay URL SHAPE — `{host:relay, port, tls, query:channel-key}` —
   * after asking the agent to ensure a stream channel for the port. M8b wires the
   * real relay tier (the byte pump) behind THIS seam.
   *
   * THE CHANNEL-KEY QUERY (the M8b relay-dial contract, dossier §10.5): the relay
   * routes by `{workspaceId, agentId, port}` — the EXACT `ChannelKey::query` the
   * agent's relay client (`opengeni-agent-stream`) appends when it registers the
   * producer side: `ws=<workspaceId>&agent=<agentId>&port=<port>`. We append the
   * agent-registered `channel=<channelId>` as a correlation hint. So the viewer
   * dials `wss://<relay>/stream?ws=&agent=&port=&channel=` and presents the minted
   * `ogs_` token in-band (NEVER as a URL param) — the relay pairs it with the
   * producer by the routing key.
   */
  async resolveExposedPort(port: number): Promise<ExposedPortEndpoint> {
    // Ask the agent to ensure a stream channel exists for the port. M8b still uses
    // the desktopEnsure op as the "ensure a channel" RPC (the only stream-channel
    // op in the proto); the returned channelId is the relay correlation hint.
    const result = await this.call({
      $case: "desktopEnsure",
      desktopEnsure: { width: 0, height: 0 },
    });
    if (result.$case !== "desktopEnsure") {
      throw new Error(`selfhosted resolveExposedPort: unexpected result ${result.$case}`);
    }
    const channelId = result.desktopEnsure.channel?.channelId ?? channelKey(this.workspaceId, this.agentId, port);
    const tls = this.relay.tls ?? true;
    // The routing key the relay pairs producer↔consumer by — IDENTICAL to the
    // agent's `ChannelKey::query` — plus the channel-id correlation hint.
    const routingQuery =
      `ws=${encodeURIComponent(this.workspaceId)}` +
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
      protocol: kindToProtocol(result.desktopEnsure.channel?.kind),
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
  private readonly relay: SelfhostedRelayConfig;
  private readonly controlRpcFactory: () => ControlRpc;
  private readonly defaultAgentId: string | undefined;
  private readonly epoch: number | undefined;
  private readonly timeoutMs: number | undefined;
  private controlRpcMemo: ControlRpc | undefined;

  constructor(opts: {
    workspaceId: string;
    relay: SelfhostedRelayConfig;
    /** Lazily build the ControlRpc (defaults to NatsControlRpc in the provider). */
    controlRpcFactory: () => ControlRpc;
    /** The agentId a bare create()/resume() (no state) binds to. Optional: the
     *  resume path supplies it via deserializeSessionState. */
    agentId?: string;
    epoch?: number;
    timeoutMs?: number;
  }) {
    this.workspaceId = opts.workspaceId;
    this.relay = opts.relay;
    this.controlRpcFactory = opts.controlRpcFactory;
    this.defaultAgentId = opts.agentId;
    this.epoch = opts.epoch;
    this.timeoutMs = opts.timeoutMs;
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
      agentId,
      controlRpc: this.controlRpc(),
      relay: this.relay,
      ...(this.epoch !== undefined ? { epoch: this.epoch } : {}),
      ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
    });
  }

  /** Bind a session to the live agent subject. There is no box to provision. */
  async create(_manifest?: unknown, _options?: unknown): Promise<SelfhostedSession> {
    const agentId = this.requireAgentId();
    return this.bind(agentId);
  }

  /** Resume = re-address the subject. Identical to create — no provider state. */
  async resume(state: SelfhostedSessionState | Record<string, unknown>, _options?: unknown): Promise<SelfhostedSession> {
    const agentId = readAgentId(state) ?? this.requireAgentId();
    return this.bind(agentId);
  }

  /** Serialize a live session's state → `{agentId}` ONLY. */
  async serializeSessionState(state: SelfhostedSessionState | { agentId?: string } | unknown): Promise<SelfhostedSessionState> {
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
      throw new Error("selfhosted sandbox client: no agentId bound (create()/resume() need a session state carrying agentId)");
    }
    return this.defaultAgentId;
  }
}

function readAgentId(state: unknown): string | undefined {
  if (state && typeof state === "object") {
    const candidate = (state as { agentId?: unknown }).agentId
      ?? ((state as { providerState?: { agentId?: unknown } }).providerState?.agentId);
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return undefined;
}

function execResultToChannelA(res: ExecResponse): SelfhostedExecResult {
  const stdout = decoder.decode(res.stdout);
  const stderr = decoder.decode(res.stderr);
  return {
    output: stdout,
    stdout,
    stderr,
    exitCode: res.exitCode,
  };
}

function channelKey(workspaceId: string, agentId: string, port: number): string {
  return `${workspaceId}:${agentId}:${port}`;
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
 * (dossier §10.2/§19): for selfhosted, `agent-offline` (no responder) is NEVER a
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
