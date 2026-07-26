// `RoutingSandboxSession` — the per-session hot-swap routing proxy (M7).
//
// THE load-bearing SDK finding: when a box is injected
// NON-OWNED into a turn (`ownedSandbox.session`), the agent SDK's sandbox
// capabilities bind to that ONE session OBJECT ONCE and call ITS methods
// (`exec`/`execCommand`/`readFile`/`listDir`/`resolveExposedPort`/…) per tool
// call WITHOUT re-resolving the session. So to make the active sandbox flippable
// mid-turn we cannot swap the object the SDK holds — we must give the SDK ONE
// STABLE session-shaped object that, on EACH method call, re-reads the
// per-session active pointer `(active_sandbox_id, active_epoch)` and DISPATCHES
// to the CURRENTLY-active backend session (Modal or selfhosted).
//
// The contract:
//   - ONE stable object implementing the `SandboxSessionLike` structural surface.
//   - On EVERY op, re-read `(activeSandboxId, activeEpoch)` via `readPointer`.
//   - Cache the resolved backend session keyed by `activeEpoch`; when the epoch
//     changes mid-turn (a swap bumped it), re-resolve so the NEXT op hits the new
//     backend. Single active at a time (NOT parallel multi-attach).
//   - An in-flight op fenced by a STALE `active_epoch` (the backend rejects with a
//     fence error, OR the pointer moved under us between read and dispatch)
//     RETRIES against the new active sandbox — reusing the existing fenced-retry
//     role. Bounded retries so a pathological swap-storm can't loop forever.
//
// This module is agent-loop-free (it lives in the sandbox leaf). It depends ONLY
// on injected closures (`readPointer` + `resolveActiveBackend`), so the API
// (`withChannelA`) and the worker (`resumeBoxForTurn`/the turn) wire it to the
// real `readActiveSandbox` DAO + a backend resolver without coupling the leaf to
// `@opengeni/db`.

import type { ExposedPortEndpoint } from "../stream-port";
import { SelfhostedControlError } from "../selfhosted/control-rpc";
import { renderSelfhostedFault } from "../selfhosted/fault-rendering";
import { isExecSessionLostBanner } from "../channel-a";
import { parseExecBannerExitCode, parseExecBannerSessionId } from "../exec-banner";

/** The per-session active-sandbox pointer the proxy re-reads on every op. Mirror
 *  of `@opengeni/db`'s `ActiveSandboxPointer` (structural, so the leaf does not
 *  import the DB package). `activeSandboxId === null` == "use the session's own
 *  group sandbox" (the default/backward-compat target). */
export interface ActivePointer {
  activeSandboxId: string | null;
  activeEpoch: number;
  /** The session's working directory — the path/cwd base for a selfhosted backend
   *  (threaded into the SelfhostedSession via the resolver). `null`/absent ⇒ the
   *  default workspace_root behavior. Optional so the default-pointer fallback
   *  (`{ activeSandboxId: null, activeEpoch: 0 }`) the readPointer wiring synthesizes
   *  when no row exists needs no extra field. Only the selfhosted branch reads it;
   *  the modal/default branches ignore it. */
  workingDir?: string | null;
}

/**
 * The structural slice of a backend session the routing proxy forwards to. It is
 * a superset-by-optionality of every backend's surface (Modal's `SandboxSession`
 * AND the `SelfhostedSession`): each method is optional because a heterogeneous
 * target may or may not implement it, and the proxy reflects that at call-time.
 */
export interface RoutableBackendSession {
  state?: unknown;
  exec?(args: unknown): Promise<unknown>;
  execCommand?(args: unknown): Promise<string>;
  writeStdin?(args: unknown): Promise<string>;
  cancelExecCommand?(opId: string): Promise<boolean>;
  readFile?(args: unknown): Promise<string | Uint8Array>;
  writeFile?(args: unknown): Promise<unknown>;
  createEditor?(runAs?: string): unknown;
  listDir?(args: unknown): Promise<unknown>;
  pathExists?(path: string, runAs?: string): Promise<boolean>;
  viewImage?(args: unknown): Promise<unknown>;
  materializeEntry?(args: unknown): Promise<void>;
  supportsPty?(): boolean;
  resolveExposedPort?(port: number): Promise<ExposedPortEndpoint>;
  serializeSessionState?(): Promise<unknown>;
  // The native-desktop control-plane surface (self-hosted / macOS): a backend that
  // drives the desktop NATIVELY (input inject + frame capture) instead of shelling
  // xdotool/scrot over `exec`. Optional like the rest — only a `SelfhostedSession`
  // implements these; a Modal box does not. The computer-use capability duck-types
  // on their PRESENCE (`isNativeDesktopSession`) to pick the native vs exec Computer.
  // `event` is kept `unknown` (mirroring the interface's structural style + avoiding
  // a proto import into the leaf); the SelfhostedSession takes `DesktopInputRequest["event"]`.
  desktopInput?(event: unknown): Promise<void>;
  screenshot?(): Promise<{
    png: Uint8Array;
    width: number;
    height: number;
    nativeWidth: number;
    nativeHeight: number;
  }>;
}

/** The resolved active backend for an epoch: the live session + the sandbox id it
 *  belongs to (`null` == the group sandbox) so a fence-retry can detect a move. */
export interface ResolvedActiveBackend {
  session: RoutableBackendSession;
  /** The sandbox id this backend serves (`null` == the session's group sandbox). */
  sandboxId: string | null;
  /** A label for diagnostics ("modal" | "selfhosted" | the sandbox name). */
  kind: string;
  /** Exact durable home-lease epoch for a persistable provider. Absent for
   * connected-machine and other non-persistable route targets. */
  leaseEpoch?: number;
  /** Exact durable provider identity paired with `leaseEpoch`. This is internal
   * routing metadata only; it is never projected to an agent or public API. */
  providerInstanceId?: string;
  /** Active-pointer epoch observed when this route was resolved. The proxy fills
   * this internally even when a resolver omits it. */
  activeEpoch?: number;
}

/** Durable identity assigned to a provider exec that yielded instead of
 * exiting. The UUID is OpenGeni authority; the numeric provider session id is
 * only a locator within the exact copied backend route. */
export type RoutingRetainedProcess = {
  id: string;
  providerSessionId: number;
};

export type RoutingRetainedProcessTerminalProof =
  | { outcome: "exited"; exitCode: number; reason: "provider_exit_banner" }
  | { outcome: "lost"; exitCode: null; reason: "provider_session_lost_banner" };

export interface RoutingSandboxSessionDeps {
  /**
   * The DEFAULT backend resolved at construction time (the same shape `resolve()`
   * caches as `lastResolved`). This seeds `session.state` BEFORE the first op so a
   * consumer that reads `session.state.manifest` at turn START — the @openai/agents
   * SDK does, before any tool runs — sees the real default backend's state object
   * (and writes to `session.state.manifest = …` land on it by reference), instead
   * of an empty `{}` that crashes serializeManifestEnvironment /
   * validateProvidedSessionManifestUpdate. The default-pointer case
   * (`activeSandboxId === null`) resolves synchronously to this same backend, so
   * seeding it here is byte-identical to what the first `resolve()` would produce.
   */
  defaultResolved?: ResolvedActiveBackend;
  /** Re-read the per-session active pointer. Called on EVERY op (the per-call
   *  re-resolve that makes a mid-turn swap visible to the next tool call). */
  readPointer(): Promise<ActivePointer>;
  /**
   * Resolve the active backend session for a pointer. The proxy memoizes the
   * result by `activeEpoch`, so this is called at most once per epoch (per op the
   * pointer is re-read, but the heavy resolve only re-runs when the epoch moved).
   * For `pointer.activeSandboxId === null` this returns the default/group backend
   * (typically the already-established turn box); for a non-null target it builds
   * the target backend (a sibling Modal box or a selfhosted machine session).
   */
  resolveActiveBackend(pointer: ActivePointer): Promise<ResolvedActiveBackend>;
  /** Max fence/stale retries within a single op before surfacing the error.
   *  Defaults to 3 — enough to absorb a couple of concurrent swaps, bounded so a
   *  swap-storm cannot loop forever. */
  maxFenceRetries?: number;
  /** Optional structured-log sink for swap/fence transitions (diagnostics). */
  onTransition?: (event: RoutingTransitionEvent) => void;
  /** Admit a filesystem-writing operation after resolving its exact route but
   * before invoking the provider. A rejection fails closed and is deliberately
   * outside provider fence-retry/error handling, so it can never replay the op
   * against a rival backend. */
  beforeMutation?: (input: { op: string; backend: ResolvedActiveBackend }) => Promise<unknown>;
  /** Mark a mutation physically settled after its provider promise resolves OR
   * rejects. A resolved result is also revalidated against the same durable
   * route and attempt fence before its output is accepted. Settlement rejection
   * leaves a fail-closed blocker and the mutation must never be replayed. */
  afterMutation?: (input: {
    op: string;
    backend: ResolvedActiveBackend;
    admission: unknown;
    outcome: "resolved" | "rejected";
    /** Provider result for a resolved call. Never present for rejection. */
    result?: unknown;
    /** Stable candidate generated before durable promotion is attempted. It is
     * supplied only when the provider returned a positive yielded-session id. */
    retainedProcess?: RoutingRetainedProcess;
  }) => Promise<void>;
  /** Admit one model/user-visible stdin mutation under the already-durable
   * retained process authority. Control polling and helper execs never call it. */
  beforeProcessMutation?: (input: {
    op: string;
    backend: ResolvedActiveBackend;
    process: RoutingRetainedProcess;
  }) => Promise<unknown>;
  /** Physically settle one process-scoped stdin admission. */
  afterProcessMutation?: (input: {
    op: string;
    backend: ResolvedActiveBackend;
    process: RoutingRetainedProcess;
    admission: unknown;
    outcome: "resolved" | "rejected";
    result?: unknown;
  }) => Promise<void>;
  /** Close the durable parent admission/process holder only after exact exit or
   * matching provider-loss proof. Tracking is removed only after this resolves. */
  settleProcess?: (input: {
    backend: ResolvedActiveBackend;
    process: RoutingRetainedProcess;
    proof: RoutingRetainedProcessTerminalProof;
  }) => Promise<void>;
  /** Called only when an operation against the default/home backend throws a
   * non-fence error. Wiring may classify definitive provider disappearance and
   * atomically retire the exact lease epoch. Returning a result makes dispatch
   * throw a typed recovery-required error WITHOUT replaying the operation (the
   * original mutation may have reached the provider). */
  onDefaultBackendError?: (input: {
    op: string;
    error: unknown;
    kind: string;
    backend: ResolvedActiveBackend;
  }) => Promise<DefaultBackendLossResult | null>;
}

export type DefaultBackendLossResult = {
  leaseEpoch: number;
  recovery: "pending" | "degraded" | "unrecoverable" | "superseded";
};

export interface RoutingTransitionEvent {
  type: "resolved" | "fenced-retry" | "epoch-changed";
  fromEpoch: number;
  toEpoch: number;
  sandboxId: string | null;
  kind: string;
}

/** Thrown when the active backend does not implement the requested op (a
 *  heterogeneous target whose surface lacks the method the caller reached for). */
export class RoutingUnsupportedError extends Error {
  readonly name = "RoutingUnsupportedError";
  constructor(op: string, kind: string) {
    super(`the active sandbox (${kind}) does not support "${op}"`);
  }
}

export class RoutingBackendRecoveryRequiredError extends Error {
  readonly name = "RoutingBackendRecoveryRequiredError";
  readonly retryable: boolean;

  constructor(
    public readonly op: string,
    public readonly leaseEpoch: number,
    public readonly recovery: DefaultBackendLossResult["recovery"],
  ) {
    super(
      `sandbox backend disappeared during ${op}; recovery is ${recovery} at epoch ${leaseEpoch}`,
    );
    this.retryable = recovery === "pending" || recovery === "superseded";
  }
}

/** A mutating provider call was admitted but could not be settled against the
 * exact route that admitted it. The provider may have applied the effect, so the
 * proxy rejects the output and explicitly forbids an automatic replay. */
export class RoutingMutationOutcomeUnknownError extends Error {
  readonly name = "RoutingMutationOutcomeUnknownError";
  readonly retryable = false;

  constructor(
    public readonly op: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** An explicit process-aware operation named a numeric provider locator that
 * is not retained by this routing session. Callers must never fall back to the
 * current active pointer for such an operation. */
export class RoutingRetainedProcessNotFoundError extends Error {
  readonly name = "RoutingRetainedProcessNotFoundError";
  readonly retryable = false;

  constructor(public readonly providerSessionId: number) {
    super(`retained sandbox process ${providerSessionId} is not tracked on its original route`);
  }
}

type PendingParentPromotion = Parameters<
  NonNullable<RoutingSandboxSessionDeps["afterMutation"]>
>[0];

type PendingProcessMutationSettlement = Parameters<
  NonNullable<RoutingSandboxSessionDeps["afterProcessMutation"]>
>[0];

type RetainedProcessRecord = {
  process: RoutingRetainedProcess;
  backend: ResolvedActiveBackend;
  durable: boolean;
  pendingParentPromotion: PendingParentPromotion | null;
  pendingMutationSettlement: PendingProcessMutationSettlement | null;
  pendingTerminal: {
    proof: RoutingRetainedProcessTerminalProof;
    result: string;
  } | null;
  settlement: Promise<void> | null;
};

/** Recognize a stale-epoch FENCE error from a backend op so the proxy retries
 *  against the re-resolved active sandbox (the existing fenced-retry role). A
 *  selfhosted `SelfhostedControlError` carries `.fenced`; a generic fence is
 *  matched on the message as a fallback. */
function isFenceError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  if ((error as { fenced?: unknown }).fenced === true) {
    return true;
  }
  const name =
    typeof (error as { name?: unknown }).name === "string" ? (error as { name: string }).name : "";
  const message =
    error instanceof Error ? error.message : String((error as { message?: unknown }).message ?? "");
  const haystack = `${name} ${message}`.toLowerCase();
  return haystack.includes("fenced") || (haystack.includes("epoch") && haystack.includes("super"));
}

function positiveProviderSessionId(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function providerSessionIdFromResult(result: unknown): number | null {
  if (typeof result === "string") {
    return positiveProviderSessionId(parseExecBannerSessionId(result));
  }
  if (!result || typeof result !== "object") return null;
  const record = result as { sessionId?: unknown; session_id?: unknown };
  return (
    positiveProviderSessionId(record.sessionId) ?? positiveProviderSessionId(record.session_id)
  );
}

function providerSessionIdFromArgs(args: unknown): number | null {
  if (!args || typeof args !== "object") return null;
  const record = args as { sessionId?: unknown; session_id?: unknown };
  return (
    positiveProviderSessionId(record.sessionId) ?? positiveProviderSessionId(record.session_id)
  );
}

function retainedProcessTerminalProof(
  result: string,
  providerSessionId: number,
): RoutingRetainedProcessTerminalProof | null {
  if (isExecSessionLostBanner(result, providerSessionId)) {
    return {
      outcome: "lost",
      exitCode: null,
      reason: "provider_session_lost_banner",
    };
  }
  const exitCode = parseExecBannerExitCode(result);
  return exitCode === null ? null : { outcome: "exited", exitCode, reason: "provider_exit_banner" };
}

function formatExecResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") {
    throw new Error("sandbox process-control exec returned an invalid result");
  }
  const record = result as {
    output?: unknown;
    stdout?: unknown;
    stderr?: unknown;
    exitCode?: unknown;
    exit_code?: unknown;
    sessionId?: unknown;
    session_id?: unknown;
  };
  const output = [record.output, record.stderr, record.stdout]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");
  const sessionId =
    positiveProviderSessionId(record.sessionId) ?? positiveProviderSessionId(record.session_id);
  if (sessionId !== null) {
    return `Process running with session ID ${sessionId}\n\nOutput:\n${output}`;
  }
  const exitCode =
    typeof record.exitCode === "number"
      ? record.exitCode
      : typeof record.exit_code === "number"
        ? record.exit_code
        : null;
  if (exitCode !== null && Number.isSafeInteger(exitCode)) {
    return `Process exited with code ${exitCode}\n\nOutput:\n${output}`;
  }
  throw new Error("sandbox process-control exec reported neither session id nor exit code");
}

/**
 * ONE stable session-shaped object the SDK binds to. Every method re-reads the
 * pointer, resolves the active backend (cached by epoch), and dispatches. A
 * stale-epoch fence (the pointer moved mid-op) re-resolves and retries.
 *
 * The proxy implements ALL of the consumed surface so the SDK (which binds method
 * presence ONCE) always sees `exec`/`readFile`/`resolveExposedPort`/… present. If
 * the CURRENTLY-active backend lacks a method, the proxy applies the natural
 * fallback (`exec`→`execCommand`) or throws `RoutingUnsupportedError` — degrade is
 * a value, not a crash.
 *
 * `state` is a STABLE getter so a consumer reading `session.state` (channel-a's
 * `readInstanceId`, the docker-network decoration) gets a coherent snapshot of the
 * currently-active backend without a method call.
 */
export class RoutingSandboxSession implements RoutableBackendSession {
  private readonly deps: RoutingSandboxSessionDeps;
  private readonly maxFenceRetries: number;
  // The resolved-backend cache. Keyed by the FULL pointer tuple
  // `(activeEpoch, activeSandboxId)` — NOT the epoch alone. A swap bumps the epoch,
  // but a pointer can also change its target id WITHOUT an epoch bump: the
  // `sessions.active_sandbox_id` FK is `ON DELETE SET NULL`, so a cascade that
  // deletes the pointed-at sandbox row nulls the id at the SAME epoch. Keying on the
  // epoch alone would then keep serving the deleted/stale backend for that epoch
  // (issue #341 §5.2 — a swap-free route to the Shape-3 symptom). Keying on the tuple
  // makes any target change — epoch-bumped OR not — invalidate the cache so the next
  // op re-resolves (and, for a null id, re-resolves the session HOME).
  private cachedEpoch: number | undefined;
  private cachedSandboxId: string | null | undefined;
  private cached: ResolvedActiveBackend | undefined;
  // The last-resolved backend, exposed via the `state` getter (a method-free read
  // of the active backend's `state`). Updated on every resolve.
  private lastResolved: ResolvedActiveBackend | undefined;
  /** Provider session ids are scoped to one backend instance. Each entry copies
   * that exact resolved route so pointer movement can never redirect stdin,
   * polling, or process-group helpers to another box. */
  private readonly retainedProcesses = new Map<number, RetainedProcessRecord>();

  // The native-desktop control-plane ops (self-hosted / macOS). Declared as OPTIONAL
  // INSTANCE fields — NOT prototype methods — because their PRESENCE is the selection
  // signal `isNativeDesktopSession` (sandbox-computer.ts) uses to pick the native vs
  // exec-shelling Computer. If they were unconditional prototype methods, this proxy
  // would ALWAYS duck-type as native — misclassifying a Modal-fronting proxy (whose
  // real backend has no native surface) and driving CGEvent/screenshot ops at a box
  // that cannot serve them. So the constructor assigns them ONLY when the
  // construction-time default backend actually implements the native surface (below).
  desktopInput?: (event: unknown) => Promise<void>;
  screenshot?: () => Promise<{
    png: Uint8Array;
    width: number;
    height: number;
    nativeWidth: number;
    nativeHeight: number;
  }>;

  constructor(deps: RoutingSandboxSessionDeps) {
    this.deps = deps;
    this.maxFenceRetries = deps.maxFenceRetries ?? 3;

    // Conditionally expose the native-desktop surface. Presence = the computer-use
    // native/exec selection signal (isNativeDesktopSession duck-types on
    // desktopInput+screenshot being functions); unconditional presence would
    // misclassify Modal-fronting proxies as native. So we mint these per-INSTANCE
    // arrow properties ONLY when the default backend resolved at construction is
    // itself native-capable — the machine-primary (selfhosted) case. Each dispatches
    // to the ACTIVE backend at call-time; if a mid-turn swap lands on a backend that
    // lacks the op (a cross-kind swap to a Modal box), dispatch throws
    // RoutingUnsupportedError — a legible tool failure, never a silent Linux-tool
    // shell onto a Mac.
    const def = deps.defaultResolved?.session;
    if (typeof def?.desktopInput === "function" && typeof def?.screenshot === "function") {
      this.desktopInput = (event: unknown) =>
        this.dispatch("desktopInput", true, async (s) => {
          if (!s.desktopInput) {
            throw new RoutingUnsupportedError("desktopInput", this.cached?.kind ?? "unknown");
          }
          return s.desktopInput(event);
        });
      this.screenshot = () =>
        this.dispatch("screenshot", false, async (s) => {
          if (!s.screenshot) {
            throw new RoutingUnsupportedError("screenshot", this.cached?.kind ?? "unknown");
          }
          return s.screenshot();
        });
    }
  }

  /**
   * A method-free read of the active backend's `state` (best-effort: the last
   * resolved backend, falling back to the default backend resolved at construction
   * so this is non-empty BEFORE the first op). Consumers that read `session.state`
   * (instanceId/decoration) get the active backend's state.
   *
   * CRITICAL: this returns the underlying backend's `state` OBJECT BY REFERENCE
   * (never a fresh `{}` when a backend exists). The @openai/agents SDK both READS
   * `session.state.manifest` and WRITES `session.state.manifest = nextManifest`
   * (providedSessionManifest); returning the live object by reference means those
   * property writes land on the real backend state and persist. Only when NO
   * backend has been resolved yet (no default seeded, no op dispatched) do we
   * return an empty object — and that path no longer occurs in the turn wiring,
   * which always seeds `defaultResolved`.
   */
  get state(): unknown {
    const backendState = (this.lastResolved ?? this.deps.defaultResolved)?.session.state;
    return backendState ?? {};
  }

  /**
   * Re-read the pointer and resolve the active backend, using the per-epoch cache.
   * The cache is keyed by `activeEpoch`: if the epoch is unchanged we return the
   * cached backend; if it moved (a swap) we re-resolve and update the cache. This
   * is THE per-call re-read that makes a mid-turn swap land on the next op.
   */
  private async resolve(): Promise<ResolvedActiveBackend> {
    const pointer = await this.deps.readPointer();
    if (
      this.cachedEpoch === pointer.activeEpoch &&
      this.cachedSandboxId === pointer.activeSandboxId &&
      this.cached
    ) {
      return this.cached;
    }
    const fromEpoch = this.cachedEpoch ?? pointer.activeEpoch;
    const resolved = await this.deps.resolveActiveBackend(pointer);
    // Re-entrancy guard: a resolver that returns THIS proxy as the active backend
    // makes every op (exec/readFile/…) dispatch back into resolve() -> the same
    // backend -> forever (a silent async infinite recursion that HANGS the turn,
    // not a stack overflow). Fail loud instead — a wiring bug must surface as a
    // legible error, never a hung turn.
    if ((resolved.session as unknown) === this) {
      throw new Error(
        "RoutingSandboxSession.resolveActiveBackend returned the proxy itself as the active backend (re-entrancy) — the resolver must return the underlying box session, not the routing proxy.",
      );
    }
    const routed: ResolvedActiveBackend = {
      ...resolved,
      activeEpoch: pointer.activeEpoch,
    };
    this.cachedEpoch = pointer.activeEpoch;
    this.cachedSandboxId = pointer.activeSandboxId;
    this.cached = routed;
    this.lastResolved = routed;
    this.deps.onTransition?.({
      type:
        this.cachedEpoch !== undefined && fromEpoch !== pointer.activeEpoch
          ? "epoch-changed"
          : "resolved",
      fromEpoch,
      toEpoch: pointer.activeEpoch,
      sandboxId: routed.sandboxId,
      kind: routed.kind,
    });
    return routed;
  }

  private invalidate(backend: ResolvedActiveBackend): void {
    this.cachedEpoch = undefined;
    this.cachedSandboxId = undefined;
    this.cached = undefined;
    this.deps.onTransition?.({
      type: "fenced-retry",
      fromEpoch: backend.activeEpoch ?? 0,
      toEpoch: 0,
      sandboxId: backend.sandboxId,
      kind: backend.kind,
    });
  }

  private registerRetainedProcess(
    process: RoutingRetainedProcess,
    backend: ResolvedActiveBackend,
  ): RetainedProcessRecord {
    if (this.retainedProcesses.has(process.providerSessionId)) {
      throw new RoutingMutationOutcomeUnknownError(
        "retainProcess",
        `Provider session ${process.providerSessionId} was yielded while that locator was already retained; neither process was rebound`,
      );
    }
    const record: RetainedProcessRecord = {
      process,
      backend,
      durable: !this.deps.afterMutation,
      pendingParentPromotion: null,
      pendingMutationSettlement: null,
      pendingTerminal: null,
      settlement: null,
    };
    this.retainedProcesses.set(process.providerSessionId, record);
    return record;
  }

  private retainedProcess(providerSessionId: number): RetainedProcessRecord {
    const retained = this.retainedProcesses.get(providerSessionId);
    if (!retained) throw new RoutingRetainedProcessNotFoundError(providerSessionId);
    return retained;
  }

  private async ensureParentPromotion(record: RetainedProcessRecord): Promise<void> {
    if (record.durable) return;
    const pending = record.pendingParentPromotion;
    if (!pending || !this.deps.afterMutation) {
      throw new RoutingMutationOutcomeUnknownError(
        "retainProcess",
        `Retained provider session ${record.process.providerSessionId} has no confirmed durable parent admission`,
      );
    }
    try {
      await this.deps.afterMutation(pending);
      record.pendingParentPromotion = null;
      record.durable = true;
    } catch (error) {
      throw new RoutingMutationOutcomeUnknownError(
        pending.op,
        `Yielded sandbox process ${record.process.providerSessionId} could not confirm its durable promotion; tracking remains pinned to the original backend`,
        { cause: error },
      );
    }
  }

  private async settleRetainedProcess(
    record: RetainedProcessRecord,
    proof: RoutingRetainedProcessTerminalProof,
    result: string,
  ): Promise<void> {
    record.pendingTerminal ??= { proof, result };
    const pending = record.pendingTerminal;
    if (
      pending.proof.outcome !== proof.outcome ||
      pending.proof.exitCode !== proof.exitCode ||
      pending.proof.reason !== proof.reason
    ) {
      throw new RoutingMutationOutcomeUnknownError(
        "settleProcess",
        `Retained provider session ${record.process.providerSessionId} produced conflicting terminal proof`,
      );
    }
    record.settlement ??= (async () => {
      await this.ensureParentPromotion(record);
      await this.deps.settleProcess?.({
        backend: record.backend,
        process: record.process,
        proof: pending.proof,
      });
      this.retainedProcesses.delete(record.process.providerSessionId);
      record.pendingTerminal = null;
    })();
    try {
      await record.settlement;
    } catch (error) {
      // A failed DB settlement is not permission to forget the physical process.
      // Keep the exact route and immutable proof so the next control poll retries
      // settlement without issuing a command against a new backend.
      record.settlement = null;
      throw new RoutingMutationOutcomeUnknownError(
        "settleProcess",
        `Retained provider session ${record.process.providerSessionId} reached a terminal state but durable settlement failed; tracking remains pinned`,
        { cause: error },
      );
    }
  }

  private async flushPendingProcessMutation(record: RetainedProcessRecord): Promise<string | null> {
    const pending = record.pendingMutationSettlement;
    if (!pending) return null;
    try {
      await this.deps.afterProcessMutation?.(pending);
      record.pendingMutationSettlement = null;
    } catch (error) {
      throw new RoutingMutationOutcomeUnknownError(
        pending.op,
        `Retained-process mutation ${pending.op} still lacks durable physical settlement; no later process mutation was admitted`,
        { cause: error },
      );
    }
    if (pending.outcome === "resolved" && typeof pending.result === "string") {
      const proof = retainedProcessTerminalProof(pending.result, record.process.providerSessionId);
      if (proof) {
        await this.settleRetainedProcess(record, proof, pending.result);
        return pending.result;
      }
    }
    return null;
  }

  private async dispatchProcessMutation(args: unknown): Promise<string> {
    const providerSessionId = providerSessionIdFromArgs(args);
    if (providerSessionId === null) throw new RoutingRetainedProcessNotFoundError(-1);
    const record = this.retainedProcess(providerSessionId);
    const priorTerminal = await this.flushPendingProcessMutation(record);
    if (priorTerminal !== null) return priorTerminal;
    if (record.pendingTerminal) {
      const terminal = record.pendingTerminal;
      await this.settleRetainedProcess(record, terminal.proof, terminal.result);
      return terminal.result;
    }
    await this.ensureParentPromotion(record);
    const op = "writeStdin";
    const admission = await this.deps.beforeProcessMutation?.({
      op,
      backend: record.backend,
      process: record.process,
    });
    const write = record.backend.session.writeStdin;
    if (!write) throw new RoutingUnsupportedError(op, record.backend.kind);
    let result: string;
    try {
      result = await write.call(record.backend.session, args);
    } catch (error) {
      if (this.deps.afterProcessMutation) {
        const pending: PendingProcessMutationSettlement = {
          op,
          backend: record.backend,
          process: record.process,
          admission,
          outcome: "rejected",
        };
        try {
          await this.deps.afterProcessMutation(pending);
        } catch (settlementError) {
          record.pendingMutationSettlement = pending;
          throw new RoutingMutationOutcomeUnknownError(
            op,
            `Retained-process stdin rejected at the provider but lost durable settlement; it was not replayed`,
            { cause: settlementError },
          );
        }
      }
      throw error;
    }
    if (this.deps.afterProcessMutation) {
      const pending: PendingProcessMutationSettlement = {
        op,
        backend: record.backend,
        process: record.process,
        admission,
        outcome: "resolved",
        result,
      };
      try {
        await this.deps.afterProcessMutation(pending);
      } catch (error) {
        record.pendingMutationSettlement = pending;
        throw new RoutingMutationOutcomeUnknownError(
          op,
          `Retained-process stdin returned from the provider but lost durable settlement; tracking remains pinned and it was not replayed`,
          { cause: error },
        );
      }
    }
    const proof = retainedProcessTerminalProof(result, providerSessionId);
    if (proof) await this.settleRetainedProcess(record, proof, result);
    return result;
  }

  private async dispatchProcessControl(args: unknown): Promise<string> {
    const providerSessionId = providerSessionIdFromArgs(args);
    if (providerSessionId === null) throw new RoutingRetainedProcessNotFoundError(-1);
    const record = this.retainedProcess(providerSessionId);
    const priorTerminal = await this.flushPendingProcessMutation(record);
    if (priorTerminal !== null) return priorTerminal;
    if (record.pendingTerminal) {
      const terminal = record.pendingTerminal;
      await this.settleRetainedProcess(record, terminal.proof, terminal.result);
      return terminal.result;
    }
    await this.ensureParentPromotion(record);
    const write = record.backend.session.writeStdin;
    if (!write) throw new RoutingUnsupportedError("writeStdin", record.backend.kind);
    const result = await write.call(record.backend.session, args);
    const proof = retainedProcessTerminalProof(result, providerSessionId);
    if (proof) await this.settleRetainedProcess(record, proof, result);
    return result;
  }

  /**
   * Dispatch an op to the currently-active backend, retrying on a stale-epoch
   * fence. The sequence per attempt:
   *   1. re-read the pointer + resolve the active backend (cached by epoch),
   *   2. run `fn(activeSession)`,
   *   3. on a FENCE error (the pointer moved under us / the backend rejected a
   *      stale epoch), INVALIDATE the cache and retry against the re-resolved
   *      active sandbox — up to `maxFenceRetries`.
   * A non-fence error propagates immediately (it is a real op failure, not a swap
   * race).
   */
  private async dispatch<T>(
    op: string,
    mutatesWorkspace: boolean,
    fn: (session: RoutableBackendSession) => Promise<T>,
  ): Promise<T> {
    let attempt = 0;
    let lastError: unknown;
    while (attempt <= this.maxFenceRetries) {
      const backend = await this.resolve();
      // Admission failures are NOT provider fence errors and must never enter
      // the retry/rebind loop. If this exact route cannot advance its durable
      // mutation generation, fail before the provider sees the operation.
      const admission = mutatesWorkspace
        ? await this.deps.beforeMutation?.({ op, backend })
        : undefined;
      let result: T;
      try {
        result = await fn(backend.session);
      } catch (error) {
        if (mutatesWorkspace && this.deps.afterMutation) {
          try {
            await this.deps.afterMutation({
              op,
              backend,
              admission,
              outcome: "rejected",
            });
          } catch (settlementError) {
            this.invalidate(backend);
            throw new RoutingMutationOutcomeUnknownError(
              op,
              `Mutating sandbox operation "${op}" rejected at the provider but lost its durable physical settlement; its outcome is unknown and it was not replayed`,
              { cause: settlementError },
            );
          }
        }
        if (!isFenceError(error)) {
          if (backend.sandboxId === null && this.deps.onDefaultBackendError) {
            const loss = await this.deps.onDefaultBackendError({
              op,
              error,
              kind: backend.kind,
              backend,
            });
            if (loss) {
              // Never replay an operation after provider disappearance. Even a
              // read may race a route change, and a mutation's provider outcome
              // is ambiguous. The next independently-admitted call observes the
              // advanced epoch and elected recovery state.
              this.invalidate(backend);
              throw new RoutingBackendRecoveryRequiredError(op, loss.leaseEpoch, loss.recovery);
            }
          }
          throw error;
        }
        this.invalidate(backend);
        if (mutatesWorkspace) {
          throw new RoutingMutationOutcomeUnknownError(
            op,
            `Mutating sandbox operation "${op}" was fenced after provider admission; its outcome is unknown and it was not replayed`,
            { cause: error },
          );
        }
        // Stale-epoch fence: the active pointer moved mid-op. Drop the cache so
        // the next resolve re-reads the NEW pointer and the op lands on the new
        // active sandbox (the fenced-retry role). Bounded by maxFenceRetries.
        lastError = error;
        attempt += 1;
        continue;
      }

      const yieldedSessionId =
        mutatesWorkspace && (op === "exec" || op === "execCommand")
          ? providerSessionIdFromResult(result)
          : null;
      const retainedProcess =
        yieldedSessionId === null
          ? undefined
          : { id: crypto.randomUUID(), providerSessionId: yieldedSessionId };
      const retainedRecord = retainedProcess
        ? this.registerRetainedProcess(retainedProcess, backend)
        : null;

      if (mutatesWorkspace && this.deps.afterMutation) {
        const settlement: PendingParentPromotion = {
          op,
          backend,
          admission,
          outcome: "resolved",
          result,
          ...(retainedProcess ? { retainedProcess } : {}),
        };
        try {
          await this.deps.afterMutation(settlement);
          if (retainedRecord) retainedRecord.durable = true;
        } catch (error) {
          if (retainedRecord) retainedRecord.pendingParentPromotion = settlement;
          this.invalidate(backend);
          throw new RoutingMutationOutcomeUnknownError(
            op,
            retainedRecord
              ? `Mutating sandbox operation "${op}" yielded provider session ${retainedRecord.process.providerSessionId} but lost durable process promotion; exact-backend tracking remains and the operation was not replayed`
              : `Mutating sandbox operation "${op}" returned from the provider but lost its durable route settlement; its outcome is unknown and it was not replayed`,
            { cause: error },
          );
        }
      }

      // Durable process promotion validated this exact route under the same
      // transaction that retained the parent admission. Later pointer movement
      // cannot invalidate or redirect that process, so return its locator and
      // let process-aware methods use the copied backend identity.
      if (retainedRecord) return result;

      // Reject output produced by a route that changed while the provider call
      // was in flight. Reads can safely retry on the new route. Mutations cannot:
      // their provider effect may already have happened on the old route.
      let current: ActivePointer;
      try {
        current = await this.deps.readPointer();
      } catch (error) {
        if (mutatesWorkspace) {
          this.invalidate(backend);
          throw new RoutingMutationOutcomeUnknownError(
            op,
            `Mutating sandbox operation "${op}" returned from the provider but its route could not be revalidated; its outcome is unknown and it was not replayed`,
            { cause: error },
          );
        }
        throw error;
      }
      if (
        current.activeEpoch !== backend.activeEpoch ||
        current.activeSandboxId !== backend.sandboxId
      ) {
        this.invalidate(backend);
        if (mutatesWorkspace) {
          throw new RoutingMutationOutcomeUnknownError(
            op,
            `Mutating sandbox operation "${op}" completed on a superseded route; its output was rejected and it was not replayed`,
          );
        }
        lastError = new Error(`sandbox route changed while "${op}" was in flight`);
        attempt += 1;
        continue;
      }
      return result;
    }
    // Exhausted retries against a relentless swap-storm: surface the fence so the
    // caller (turn) backs off — never loop forever.
    throw lastError ?? new Error(`routing op "${op}" exhausted fence retries`);
  }

  /**
   * The failure-visibility boundary for the `exec_command` SDK capability tool — the
   * dominant fault surface, and the one whose thrown `SelfhostedControlError` reaches
   * the model wrapped by the SDK's generic tool-error function as
   * "…Please try again. Error: …" — actively wrong for a machine that is offline, a
   * consent that is not granted, or an oversized reply. Since the SDK closure-captures
   * its `errorFunction` (there is no seam to attach one to its internally-built tools),
   * we render the fault into the doctrine's four fields HERE and return it as the
   * tool's string result — legible, in-band, and free of the misleading wrapper.
   * (`apply_patch` already surfaces `error.message` via the SDK's own catch; the
   * skills / `view_image` tools consume their session methods internally, so they are
   * rendered elsewhere or left to their own SDK renderers — not this string boundary.)
   *
   * A FENCE error is re-thrown, NEVER rendered: `dispatch` already retries it against
   * a re-resolved backend, and a fence that escapes retries is a routing condition the
   * turn handles, not a model-facing fault. Any non-selfhosted error (a Modal fault, a
   * `RoutingUnsupportedError`) is re-thrown unchanged.
   */
  private renderSelfhostedFaultOrThrow(error: unknown): string {
    if (error instanceof SelfhostedControlError && !error.fenced) {
      return renderSelfhostedFault(error);
    }
    throw error;
  }

  // ── The forwarded structural surface ──────────────────────────────────────
  // Every method is PRESENT on the proxy (the SDK binds presence once) and
  // dispatches to the active backend at call-time. A missing backend method
  // degrades via the natural fallback or RoutingUnsupportedError.

  async exec(args: unknown): Promise<unknown> {
    return this.dispatch("exec", true, async (s) => {
      if (s.exec) {
        return s.exec(args);
      }
      // Some backends (selfhosted) only expose exec; others only execCommand.
      if (s.execCommand) {
        return s.execCommand(args);
      }
      throw new RoutingUnsupportedError("exec", this.cached?.kind ?? "unknown");
    });
  }

  async execCommand(args: unknown): Promise<string> {
    try {
      return await this.dispatch("execCommand", true, async (s) => {
        if (s.execCommand) {
          return s.execCommand(args);
        }
        if (s.exec) {
          const r = (await s.exec(args)) as { stdout?: string; output?: string };
          return r.stdout ?? r.output ?? "";
        }
        throw new RoutingUnsupportedError("execCommand", this.cached?.kind ?? "unknown");
      });
    } catch (error) {
      // Render a terminal selfhosted fault as the tool's result (four fields, correct
      // verdict) instead of letting the SDK mislabel it "Please try again".
      return this.renderSelfhostedFaultOrThrow(error);
    }
  }

  async writeStdin(args: unknown): Promise<string> {
    const providerSessionId = providerSessionIdFromArgs(args);
    if (providerSessionId !== null && this.retainedProcesses.has(providerSessionId)) {
      return await this.dispatchProcessMutation(args);
    }
    return this.dispatch("writeStdin", true, async (s) => {
      if (!s.writeStdin) {
        throw new RoutingUnsupportedError("writeStdin", this.cached?.kind ?? "unknown");
      }
      return s.writeStdin(args);
    });
  }

  /** Whether a positive provider session locator is still pinned to the exact
   * backend that yielded it. This synchronous probe is used only to select the
   * process-aware routing surface; it is not itself durable authority. */
  hasRetainedProcess(providerSessionId: number): boolean {
    return (
      positiveProviderSessionId(providerSessionId) !== null &&
      this.retainedProcesses.has(providerSessionId)
    );
  }

  /** Model/user-visible stdin is a distinct workspace mutation admission under
   * the durable retained-process holder. It never re-reads the active pointer. */
  async writeStdinForProcessMutation(args: unknown): Promise<string> {
    return await this.dispatchProcessMutation(args);
  }

  /** Cancellation and drain polling are control operations. They stay pinned to
   * the process backend and may prove terminal state, but never advance the
   * workspace generation. */
  async writeStdinForProcessControl(args: unknown): Promise<string> {
    return await this.dispatchProcessControl(args);
  }

  /** Run a PID/PGID marker or signal helper on the retained process's exact
   * backend. The helper is control-plane work and therefore has no workspace
   * mutation admission of its own. */
  async execCommandForProcessControl(providerSessionId: number, args: unknown): Promise<string> {
    const exactProviderSessionId = positiveProviderSessionId(providerSessionId);
    if (exactProviderSessionId === null) throw new RoutingRetainedProcessNotFoundError(-1);
    const record = this.retainedProcess(exactProviderSessionId);
    const priorTerminal = await this.flushPendingProcessMutation(record);
    if (priorTerminal !== null) return priorTerminal;
    if (record.pendingTerminal) {
      const terminal = record.pendingTerminal;
      await this.settleRetainedProcess(record, terminal.proof, terminal.result);
      return terminal.result;
    }
    await this.ensureParentPromotion(record);
    if (record.backend.session.execCommand) {
      return await record.backend.session.execCommand(args);
    }
    if (record.backend.session.exec) {
      return formatExecResult(await record.backend.session.exec(args));
    }
    throw new RoutingUnsupportedError("execCommand", record.backend.kind);
  }

  async cancelExecCommand(opId: string): Promise<boolean> {
    return await this.dispatch("cancelExecCommand", false, async (session) => {
      if (!session.cancelExecCommand) return false;
      return await session.cancelExecCommand(opId);
    });
  }

  async readFile(args: unknown): Promise<string | Uint8Array> {
    return this.dispatch("readFile", false, async (s) => {
      if (!s.readFile) {
        throw new RoutingUnsupportedError("readFile", this.cached?.kind ?? "unknown");
      }
      return s.readFile(args);
    });
  }

  async writeFile(args: unknown): Promise<unknown> {
    return this.dispatch("writeFile", true, async (s) => {
      if (!s.writeFile) {
        throw new RoutingUnsupportedError("writeFile", this.cached?.kind ?? "unknown");
      }
      return s.writeFile(args);
    });
  }

  async listDir(args: unknown): Promise<unknown> {
    return this.dispatch("listDir", false, async (s) => {
      if (!s.listDir) {
        throw new RoutingUnsupportedError("listDir", this.cached?.kind ?? "unknown");
      }
      return s.listDir(args);
    });
  }

  async pathExists(path: string, runAs?: string): Promise<boolean> {
    return this.dispatch("pathExists", false, async (s) => {
      if (!s.pathExists) {
        throw new RoutingUnsupportedError("pathExists", this.cached?.kind ?? "unknown");
      }
      return s.pathExists(path, runAs);
    });
  }

  async viewImage(args: unknown): Promise<unknown> {
    return this.dispatch("viewImage", false, async (s) => {
      if (!s.viewImage) {
        throw new RoutingUnsupportedError("viewImage", this.cached?.kind ?? "unknown");
      }
      return s.viewImage(args);
    });
  }

  async materializeEntry(args: unknown): Promise<void> {
    return this.dispatch("materializeEntry", true, async (s) => {
      if (!s.materializeEntry) {
        throw new RoutingUnsupportedError("materializeEntry", this.cached?.kind ?? "unknown");
      }
      return s.materializeEntry(args);
    });
  }

  /** PTY support reflects the LAST-resolved backend (a synchronous probe; the SDK
   *  reads it to decide if the terminal is interactive). It cannot re-read the
   *  pointer (synchronous), so it answers from the last resolve — coherent with
   *  the resolve the surrounding op already performed. Defaults false before the
   *  first resolve. */
  supportsPty(): boolean {
    const s = (this.lastResolved ?? this.deps.defaultResolved)?.session;
    return Boolean(s?.supportsPty?.());
  }

  /** createEditor is a synchronous factory in the SDK surface. The SDK's filesystem
   *  capability calls it ONCE at tool-BIND time — `FilesystemCapability.tools()`,
   *  every turn, before any tool runs — and throws "Filesystem sandbox sessions must
   *  provide createEditor()" if it returns falsy. When a backend is already resolved
   *  (eager/selfhosted routing) we bind to its editor directly, byte-for-byte as
   *  before. But under LAZY provisioning the backend is not established yet
   *  (defaultResolved is the synthetic unprovisioned session with no editor), so a
   *  direct delegate returns undefined and every lazy turn would die at bind. Return a
   *  LAZY EDITOR PROXY instead: a non-null editor whose async ops resolve the active
   *  backend (establishing the box on first use, via `dispatch`) and delegate to its
   *  real editor — mirroring how this proxy defers exec/readFile. Even when an
   *  eager editor already exists, returning it directly would bypass per-edit
   *  route resolution and mutation-generation admission, so every editor is
   *  represented by this dispatching proxy. */
  createEditor(runAs?: string): unknown {
    const op =
      (name: "createFile" | "updateFile" | "deleteFile") =>
      (operation: unknown, context?: unknown): Promise<unknown> =>
        this.dispatch(`editor.${name}`, true, async (s) => {
          const editor = s.createEditor?.(runAs) as
            | Record<string, (operation: unknown, context?: unknown) => Promise<unknown>>
            | undefined;
          if (!editor?.[name]) {
            throw new RoutingUnsupportedError(`editor.${name}`, this.cached?.kind ?? "unknown");
          }
          return editor[name](operation, context);
        });
    return {
      createFile: op("createFile"),
      updateFile: op("updateFile"),
      deleteFile: op("deleteFile"),
    };
  }

  async resolveExposedPort(port: number): Promise<ExposedPortEndpoint> {
    return this.dispatch("resolveExposedPort", false, async (s) => {
      if (!s.resolveExposedPort) {
        throw new RoutingUnsupportedError("resolveExposedPort", this.cached?.kind ?? "unknown");
      }
      return s.resolveExposedPort(port);
    });
  }

  /** Serialize the active backend's session state. Used by the resume-by-id seam
   *  to fold the live box onto the lease. Dispatches to the active backend. */
  async serializeSessionState(): Promise<unknown> {
    return this.dispatch("serializeSessionState", false, async (s) => {
      if (!s.serializeSessionState) {
        // No-op for a backend with no serializable state (selfhosted state is
        // re-addressed, not snapshotted) — surface undefined, not an error.
        return undefined;
      }
      return s.serializeSessionState();
    });
  }

  /** Force a resolve (priming the proxy before the first op so `state`/`supportsPty`
   *  read a real backend). Optional — every op resolves lazily anyway. */
  async prime(): Promise<ResolvedActiveBackend> {
    return this.resolve();
  }
}
