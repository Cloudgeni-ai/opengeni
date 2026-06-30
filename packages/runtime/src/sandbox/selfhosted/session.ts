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
  FsEntryKind,
  StreamKind,
  type ExecRequest,
  type ExecResponse,
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
import type { ExposedPortEndpoint } from "../stream-port";
import {
  agentErrorToControlError,
  subjectFor,
  type ControlRpc,
} from "./control-rpc";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * The SDK's VIRTUAL sandbox root. The `@openai/agents` agent loop presents the
 * sandbox to the model rooted at this path — it equals `state.manifest.root`,
 * which is held at "/workspace" to match the Modal createManifest root for the
 * provided-session root-delta guard (`validateProvidedSessionManifestUpdate`).
 *
 * On a bring-your-own machine this path DOES NOT EXIST: the machine's real root
 * is the agent's `workspace_root` (reported in Hello, e.g. "/home/jorge/repo").
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
export type SelfhostedApplyDiff = (input: string, diff: string, mode?: "default" | "create") => string;
let injectedApplyDiff: SelfhostedApplyDiff | undefined;

/** Register the SDK's `applyDiff` so `SelfhostedSession.createEditor()` can apply
 *  V4A diffs over the NATS fs ops. Called once by the runtime barrel. */
export function setSelfhostedApplyDiff(fn: SelfhostedApplyDiff): void {
  injectedApplyDiff = fn;
}

/** The structural Editor surface the SDK's filesystem capability consumes (the
 *  three apply_patch operations). Mirrors `@openai/agents-core`'s `Editor`. */
export interface SelfhostedEditor {
  createFile(operation: { path: string; diff: string }, context?: unknown): Promise<{ output?: string } | void>;
  updateFile(operation: { path: string; diff: string; moveTo?: string }, context?: unknown): Promise<{ output?: string } | void>;
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
  /**
   * The run's declared sandbox environment — the SAME `Record<string,string>` the
   * worker turn passes to `runtime.buildAgent`'s `sandboxEnvironment` (and that the
   * agent's TARGET manifest, `buildManifest`, carries). The SDK injects this
   * selfhosted session NON-OWNED and applies the agent's manifest as a provided-
   * session delta; `validateNoEnvironmentDelta` throws "Live sandbox sessions cannot
   * change manifest environment variables" on ANY env mismatch. So `state.manifest`'s
   * `environment` MUST EQUAL the turn's environment for the delta to be empty. The
   * selfhosted exec routes over NATS and does NOT consume the env, but the manifest
   * must carry it for parity. Omitted → `{}` (the negotiation-only / test path,
   * which never applies a turn manifest, so there is no delta to validate).
   */
  environment?: Record<string, string>;
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
  /** The session working directory — the path/cwd base every op is rooted under
   *  (see `toMachinePath`). "" by default ⇒ today's workspace_root behavior. */
  private readonly workingDir: string;

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
  readonly state: { agentId: string; instanceId: string; manifest: Manifest; environment: Record<string, string> };

  constructor(deps: SelfhostedSessionDeps) {
    this.workspaceId = deps.workspaceId;
    this.agentId = deps.agentId;
    this.controlRpc = deps.controlRpc;
    this.relay = deps.relay;
    this.epoch = deps.epoch ?? 0;
    this.timeoutMs = deps.timeoutMs ?? SELFHOSTED_DEFAULT_TIMEOUT_MS;
    this.subject = subjectFor(deps.workspaceId, deps.agentId);
    this.workingDir = deps.workingDir ?? "";
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
      manifest: new Manifest({ root: "/workspace", entries: {}, environment: deps.environment ?? {} }),
      // The SDK `SandboxSessionState.environment` — the run's threaded env (or `{}`).
      // The group client's end-of-turn serialize reads `state.environment` directly
      // (Object.entries), so it must be a defined object, not absent.
      environment: deps.environment ?? {},
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
      // Rewrite a virtual-root cwd ("/workspace[/…]") onto the machine's frame —
      // an absolute "/workspace" would ENOENT on a real machine (see
      // SELFHOSTED_VIRTUAL_ROOT). Empty → the session workingDir (itself "" by
      // default ⇒ the agent runs in its workspace_root).
      cwd: toMachinePath(args.workdir, this.workingDir),
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

  // ── The agent-turn provided-session contract (over the SAME NATS primitives) ──
  // These are what the @openai/agents shell/filesystem/skills capabilities call on
  // the ACTIVE session once the routing proxy resolves selfhosted. They reuse the
  // exec/fs ops above; the machine owns its filesystem (materialization is a no-op).

  /** SDK shell capability `execCommand`: run a command and return its stdout (the
   *  `exec_command` tool). Selfhosted exec is non-interactive (no PTY) — `tty` is
   *  ignored; `supportsPty()` is false so the SDK never offers a stdin session. */
  async execCommand(args: { cmd: string; workdir?: string; runAs?: string }): Promise<string> {
    const result = await this.exec({ cmd: args.cmd, workdir: args.workdir, runAs: args.runAs });
    return result.output;
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
    const bytes = await this.readFile({ path: args.path, ...(args.runAs ? { runAs: args.runAs } : {}) });
    const mediaType = sniffImageMediaType(bytes, args.path);
    if (!mediaType) {
      throw new Error(`selfhosted view_image: unsupported image format for ${args.path}`);
    }
    return { type: "image", image: { data: Uint8Array.from(bytes), mediaType } };
  }

  /** SDK skills/filesystem `pathExists`: whether a path exists on the machine. */
  async pathExists(path: string, _runAs?: string): Promise<boolean> {
    const { exists } = await this.statFile({ path });
    return exists;
  }

  /** SDK skills `listDir`: list a directory as `{name, path, type}[]`. */
  async listDir(args: { path: string; runAs?: string }): Promise<Array<{ name: string; path: string; type: "file" | "dir" | "other" }>> {
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
   *  entries — is satisfied without error. The selfhosted manifest declares no
   *  entries, so in practice this is never invoked with a real entry. */
  async materializeEntry(_args: { path: string; entry: unknown; runAs?: string }): Promise<void> {
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
      await this.exec({ cmd: `rm -rf -- ${shellQuote(toMachinePath(path, ""))}`, ...(runAs ? { runAs } : {}) });
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
    const result = await this.call({
      $case: "fsRead",
      fsRead: {
        path: toMachinePath(args.path, this.workingDir),
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

  /** List a directory on the machine. */
  async listFiles(args: { path: string; recursive?: boolean }): Promise<NonNullable<ControlResponse["result"]> & { $case: "fsList" }> {
    const result = await this.call({
      $case: "fsList",
      fsList: { path: toMachinePath(args.path, this.workingDir), recursive: args.recursive ?? false },
    });
    if (result.$case !== "fsList") {
      throw new Error(`selfhosted listFiles: unexpected result ${result.$case}`);
    }
    return result;
  }

  /** Stat a path on the machine. */
  async statFile(args: { path: string }): Promise<{ exists: boolean }> {
    const result = await this.call({ $case: "fsStat", fsStat: { path: toMachinePath(args.path, this.workingDir) } });
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
    // Ask the agent to ensure a relay PRODUCER channel exists for the port, using the
    // PORT-APPROPRIATE op. The PTY plane (7681) is INDEPENDENT of the desktop display:
    // route it through `ptyOpen` (which spawns/attaches a PTY and NEVER touches X11),
    // and ONLY the desktop framebuffer plane (6080) through `desktopEnsure` (which
    // hard-requires a live virtual display). Earlier M8b used `desktopEnsure` for
    // EVERY port — that wrongly coupled the terminal to the desktop probe, so a
    // headless (or display-degraded) machine could never get a terminal even though
    // `ptyOpen` would have succeeded. The returned channelId is the relay
    // correlation hint; both ops carry a `StreamChannel` on their response.
    let channel: StreamChannel | undefined;
    if (port === DESKTOP_STREAM_PORT) {
      const result = await this.call({
        $case: "desktopEnsure",
        desktopEnsure: { width: 0, height: 0 },
      });
      if (result.$case !== "desktopEnsure") {
        throw new Error(`selfhosted resolveExposedPort(${port}): unexpected result ${result.$case}`);
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
        ptyOpen: { command: [], cwd: this.workingDir, env: {}, cols: 0, rows: 0, term: "xterm-256color" },
      });
      if (result.$case !== "ptyOpen") {
        throw new Error(`selfhosted resolveExposedPort(${port}): unexpected result ${result.$case}`);
      }
      channel = result.ptyOpen.channel;
    }
    const channelId = channel?.channelId ?? channelKey(this.workspaceId, this.agentId, port);
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
      protocol: kindToProtocol(channel?.kind),
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
  private readonly environment: Record<string, string> | undefined;
  private readonly workingDir: string | undefined;
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
    /** The run's declared sandbox environment, threaded into every bound session's
     *  `state.manifest.environment` so the SDK's per-turn manifest-env delta is
     *  empty (validateNoEnvironmentDelta). See SelfhostedSessionDeps.environment.
     *  Omitted → `{}` (the negotiation-only path; no turn manifest is applied). */
    environment?: Record<string, string>;
    /** The session working directory threaded into every bound session (the path/
     *  cwd base; see SelfhostedSessionDeps.workingDir). Omitted/empty ⇒ the default
     *  workspace_root behavior. */
    workingDir?: string;
  }) {
    this.workspaceId = opts.workspaceId;
    this.relay = opts.relay;
    this.controlRpcFactory = opts.controlRpcFactory;
    this.defaultAgentId = opts.agentId;
    this.epoch = opts.epoch;
    this.timeoutMs = opts.timeoutMs;
    this.environment = opts.environment;
    this.workingDir = opts.workingDir;
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
      ...(this.environment !== undefined ? { environment: this.environment } : {}),
      ...(this.workingDir !== undefined ? { workingDir: this.workingDir } : {}),
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

/**
 * The dependency shape `buildSelfhostedBackendSession` needs to bind a live
 * selfhosted session to a target machine. A structural superset of the fields the
 * routing resolver (backend-resolver.ts) reads off its deps + pointer, and the
 * fields the WORKER turn's machine-primary establish branch threads in — so a
 * SINGLE build shape is shared by both (never two divergent constructions of the
 * same SelfhostedSandboxClient/resume pair).
 */
export interface SelfhostedSessionBuild {
  /** The workspace the machine's control-plane subject is scoped to. */
  workspaceId: string;
  /** The enrollment id == the agent id `agent.<ws>.<id>.rpc` addresses. */
  agentId: string;
  /** The relay-URL shape for stream endpoints. */
  relay: SelfhostedRelayConfig;
  /** Lazily build the live ControlRpc (the request-scoped NATS connection). */
  controlRpcFactory: () => ControlRpc;
  /** The lease/active epoch the session is fenced under (echoed on every op). */
  epoch: number;
  /** The run's declared sandbox environment → the session manifest.environment
   *  (env-parity; see SelfhostedSessionDeps.environment). */
  environment?: Record<string, string>;
  /** The session working directory (the path/cwd base). Null/absent ⇒ workspace_root. */
  workingDir?: string | null;
  /** Override the control-op timeout (tests). */
  timeoutMs?: number;
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
    relay: deps.relay,
    controlRpcFactory: deps.controlRpcFactory,
    agentId: deps.agentId,
    epoch: deps.epoch,
    ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
    ...(deps.environment !== undefined ? { environment: deps.environment } : {}),
    ...(deps.workingDir ? { workingDir: deps.workingDir } : {}),
  });
  const session = await client.resume({ agentId: deps.agentId });
  return { client, session };
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

/** Single-quote a string for POSIX shell (the editor's delete uses the machine's
 *  own `rm`). Mirrors the standard `'…'` quoting with `'\''` escaping. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Detect an image media type from magic bytes (with a path-extension fallback),
 *  mirroring @openai/agents-core's `sniffImageMediaType` so `viewImage` returns the
 *  SAME media types the SDK would. Returns undefined for an unrecognized format. */
function sniffImageMediaType(bytes: Uint8Array, path: string): string | undefined {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif";
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return "image/webp";
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";
  if (
    (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
    (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a)
  ) return "image/tiff";
  if (looksLikeSvg(bytes)) return "image/svg+xml";
  return mediaTypeFromPath(path);
}

function looksLikeSvg(bytes: Uint8Array): boolean {
  const prefix = decoder.decode(bytes.subarray(0, Math.min(bytes.byteLength, 512))).trimStart().toLowerCase();
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
