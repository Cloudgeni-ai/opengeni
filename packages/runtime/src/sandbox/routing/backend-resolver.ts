// `makeActiveBackendResolver` — builds the `resolveActiveBackend` closure the
// `RoutingSandboxSession` calls to turn an active pointer into a live backend
// session (M7). It is the heterogeneous-dispatch core: a pointer's target is
// EITHER the session's own group sandbox (the default, `activeSandboxId === null`)
// OR a first-class named sandbox the session swapped to — a sibling Modal box or
// a selfhosted machine.
//
// This lives in the agent-loop-free leaf and depends ONLY on injected closures +
// the selfhosted session builder, so the API/worker wire it to the real DB
// (`getSandbox`/`getEnrollment`/`readActiveSandbox`) + the live NATS ControlRpc
// without coupling the leaf to `@opengeni/db`.
//
// The DEFAULT target (the group box) is supplied as an already-established
// session (the turn box `resumeBoxForTurn` produced, or the Channel-A established
// handle) — the proxy does NOT re-establish it (the lease owns its lifecycle). A
// NON-DEFAULT selfhosted target builds a `SelfhostedSession` bound to the target's
// enrollment agentId, fenced under the swap's active_epoch. A non-default MODAL
// target is established via the injected `establishModalTarget` resolver (the
// API/worker pass a resume-by-id closure for the sibling box's lease).

import { buildSelfhostedBackendSession, type SelfhostedRelayConfig } from "../selfhosted/session";
import type { SelfhostedOpObserver } from "../selfhosted/op-observer";
import type { ControlRpc } from "../selfhosted/control-rpc";
import type {
  ActivePointer,
  RoutableBackendSession,
  ResolvedActiveBackend,
} from "./routing-session";

/** The structural slice of a first-class sandbox the resolver reads (mirror of
 *  `@opengeni/db`'s `SandboxRecord`; structural so the leaf does not import DB). */
export interface RoutableSandbox {
  id: string;
  kind: "modal" | "selfhosted" | string;
  name: string;
  /** For a selfhosted sandbox this is its enrollment id (== the agent id the
   *  control-plane subject `agent.<ws>.<id>.rpc` addresses). Null for modal. */
  enrollmentId: string | null;
}

export interface ActiveBackendResolverDeps {
  /** The workspace the session belongs to (the control-plane subject scope). */
  workspaceId: string;
  /** The session's own group sandbox session — the DEFAULT target
   *  (`activeSandboxId === null`). Already established (lease-owned); the proxy
   *  never re-establishes it. */
  defaultBackend: RoutableBackendSession;
  /** A label for the default backend (its backend id: "modal"/"selfhosted"/…). */
  defaultKind: string;
  /**
   * Re-resolve the session's HOME backend after the route cache is fenced.
   *
   * The normal path returns `defaultBackend` (the turn's already-established
   * handle), but an API-side same-target repair can rematerialize that lease
   * while a worker turn is still alive. Such a repair advances the route epoch
   * without changing the null pointer; callers that can resume the current
   * lease-owned identity may provide this callback so the next epoch does not
   * keep dispatching to the dead pre-repair object. This callback must never
   * create a provider or replay an operation.
   */
  resolveDefaultBackend?: (pointer: ActivePointer) => Promise<ResolvedActiveBackend>;
  /** Look up a first-class sandbox by id (the swap target). Returns null when the
   *  id is unknown or not in this workspace (the caller 409s the swap). */
  getSandbox(sandboxId: string): Promise<RoutableSandbox | null>;
  /** Build a live `ControlRpc` for the selfhosted control plane (the request-
   *  scoped NATS connection). Returns a ControlRpc whose offline/timeout maps to
   *  agent_offline/agent_reconnecting (never a NotFound). */
  controlRpcFactory(): ControlRpc;
  /** The relay-URL shape config for selfhosted stream endpoints. */
  relay: SelfhostedRelayConfig;
  /** Establish (resume-by-id) a NON-DEFAULT modal target's box session for a swap.
   *  Supplied by the API/worker (a closure over the sibling sandbox's lease). When
   *  absent, a modal swap target surfaces as unsupported (the caller validated
   *  liveness, so this is the "modal swap not wired in this context" guard). */
  establishModalTarget?: (sandbox: RoutableSandbox) => Promise<RoutableBackendSession>;
  /** The selfhosted CONTROL-op timeout (ping/fs/desktop/pty) for a swap/pin target.
   *  Absent ⇒ the session's 30s default. */
  selfhostedTimeoutMs?: number;
  /** The selfhosted EXEC process deadline for a swap/pin target, distinct from the
   *  control timeout (a swapped-to machine runs real commands too). Absent ⇒ falls
   *  back to the control timeout, as in the session leaf. */
  selfhostedExecTimeoutMs?: number;
  /** The per-op observer threaded into a selfhosted swap/pin target (out-of-band
   *  telemetry — metrics + machine.* events). Absent ⇒ no-op. */
  selfhostedOnOp?: SelfhostedOpObserver;
  /**
   * The run's declared sandbox environment — the SAME `Record<string,string>` the
   * worker turn threads into the agent's TARGET manifest (and into the group box at
   * create). Threaded into a selfhosted swap target's session so its
   * `state.manifest.environment` EQUALS the turn's, making the SDK's per-turn
   * provided-session manifest-env delta empty (validateNoEnvironmentDelta).
   * WITHOUT this a pin-to-vm turn throws "Live sandbox sessions cannot change
   * manifest environment variables". Omitted → `{}` (the test/negotiation path).
   */
  environment?: Record<string, string>;
  /**
   * A pre-established selfhosted session to PIN for the STEADY-STATE machine
   * pointer (the worker turn's machine-primary path, Stage D). When the pointer
   * targets THIS sandbox at THIS epoch, the resolver returns this SAME instance
   * instead of building a fresh `SelfhostedSession`. This is the instance-identity
   * pin: the SDK reads/writes `state.manifest` at turn START via the proxy's `state`
   * getter (which reads the default/last-resolved backend's state) and then reads it
   * per op via this resolver — those MUST land on ONE SelfhostedSession/manifest, or
   * a turn-start manifest write is invisible to the per-op reads (two-instance
   * divergence). A swap AWAY (a different sandbox id, or the same id at a moved epoch)
   * falls through to a fresh build under the new epoch. Omitted for the API/live-swap
   * path (which always builds fresh — it has no pre-established turn session).
   */
  pinnedSelfhosted?: { sandboxId: string; epoch: number; session: RoutableBackendSession };
  /**
   * Whether `defaultBackend` IS the session's home box — i.e. whether the null pointer
   * (== home) may resolve to it. Defaults to TRUE (omitted): a genuine machine-HOME turn
   * (home IS the machine) and a Modal-home turn established on its group box both pass/omit
   * true, so null resolves to `defaultBackend` as before. Set explicitly FALSE only for a
   * machine-primary turn of a Modal-HOME session (pinned to a machine, group box never
   * established this turn): the null pointer then has nothing to resolve to THIS turn, so
   * rather than silently keep serving the pinned machine as if the detach never happened,
   * the null branch throws a typed `home_unavailable_this_turn` error — the detach's pointer
   * commit stands and takes effect on the NEXT turn, which starts null and establishes the
   * home box normally. Lazily establishing the home box mid-turn on such a clear is a
   * deferred follow-up (issue #341); until then this makes the gap fail typed-and-specific,
   * never silent.
   */
  defaultIsHome?: boolean;
}

/** Why a persisted pointer / swap target cannot be turned into a live backend. A
 *  typed discriminant so callers (turn-start reconcile, the swap tool, future
 *  reports) can distinguish a stale pointer from an unaddressable enrollment from a
 *  backend the turn context simply cannot establish — instead of string-matching
 *  one opaque message (issue #341: "typed diagnostics that distinguish stale
 *  pointer, offline enrollment, unsupported backend context, transient failure").
 *   - `stale_pointer`               — the pointed-at sandbox row is gone (deleted/orphaned).
 *   - `offline_enrollment`          — a selfhosted target carries no enrollment/agent id to address.
 *   - `unsupported_backend_context` — a target no turn routing context can establish
 *                                     (a non-group Modal sibling; an unknown kind).
 *   - `transient_establishment`     — a momentary establish failure worth a retry (reserved;
 *                                     control-plane timeouts surface as their own typed error).
 *   - `home_unavailable_this_turn`  — the pointer was cleared to the session default (home)
 *                                     mid-turn, but this turn started pinned to a machine and
 *                                     never established the home box, so null has nothing to
 *                                     resolve to THIS turn (the detach takes effect next turn). */
export type BackendUnresolvableCode =
  | "stale_pointer"
  | "offline_enrollment"
  | "unsupported_backend_context"
  | "transient_establishment"
  | "home_unavailable_this_turn";

/** Thrown when a swap target cannot be resolved (unknown sandbox, or a modal
 *  target with no establisher in this context). The caller maps it to a 409.
 *  Carries a typed {@link BackendUnresolvableCode} in addition to the message. */
export class ActiveBackendUnresolvableError extends Error {
  readonly name = "ActiveBackendUnresolvableError";
  readonly code: BackendUnresolvableCode;
  constructor(code: BackendUnresolvableCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** The outcome of {@link swapTargetEstablishability}. */
export type SwapTargetEstablishability =
  | { ok: true }
  | { ok: false; code: BackendUnresolvableCode; reason: string };

/**
 * THE SINGLE SOURCE OF TRUTH for "can a turn's routing context ESTABLISH this swap
 * target?" — shared by swap/seed ADMISSION (`fleet.resolveTarget`, before the CAS
 * pointer commit) and turn-time ESTABLISHMENT (this resolver + `wrapTurnBoxWithRouting`).
 * Admission MUST reject any target this predicate calls unestablishable, so the
 * pointer is never committed to a backend no turn can resume (issue #341 Shape 1:
 * a Modal-sibling swap was admitted + epoch-bumped, then every following op
 * stranded because no context wires an establisher for it).
 *
 *  - the session's OWN group box (`isSessionGroup`) is the null/home target and is
 *    always establishable (it IS the default backend);
 *  - a `selfhosted` machine target is establishable (`buildSelfhostedBackendSession`);
 *    admission's separate liveness probe — not this predicate — gates online-ness;
 *  - a NON-group `modal` target is NOT establishable: no turn context wires
 *    `establishModalTarget` (cross-group Modal resume-by-id is a future, billing-
 *    touching feature — sandbox-routing.ts). Wiring that establisher is the ONE
 *    toggle that flips this branch; keep admission and the resolver in lockstep.
 */
export function swapTargetEstablishability(target: {
  kind: string;
  isSessionGroup: boolean;
}): SwapTargetEstablishability {
  if (target.isSessionGroup) {
    return { ok: true };
  }
  if (target.kind === "selfhosted") {
    return { ok: true };
  }
  if (target.kind === "modal") {
    return {
      ok: false,
      code: "unsupported_backend_context",
      reason:
        "a Modal sandbox other than this session's own box cannot be established by a turn yet; swap back to the session default or attach a Connected Machine",
    };
  }
  return {
    ok: false,
    code: "unsupported_backend_context",
    reason: `a sandbox of kind "${target.kind}" cannot be established by a turn`,
  };
}

/**
 * Build the `resolveActiveBackend(pointer)` closure for a `RoutingSandboxSession`.
 * The returned closure is re-invoked by the proxy whenever the active_epoch moves
 * (the per-epoch cache miss), so it must be cheap-and-correct for the steady-state
 * (default pointer → the already-established group box) and build a fresh backend
 * for a swap target.
 *
 *  - `activeSandboxId === null` → the default group backend (no re-establish).
 *  - a selfhosted target → a `SelfhostedSession` bound to the enrollment agentId,
 *    fenced under `pointer.activeEpoch` (echoed on every ControlRequest so the
 *    agent can reject a stale op with ERROR_CODE_FENCED — the swap-race fence).
 *  - a modal target → `establishModalTarget` (the resume-by-id closure), else
 *    unresolvable.
 */
export function makeActiveBackendResolver(
  deps: ActiveBackendResolverDeps,
): (pointer: ActivePointer) => Promise<ResolvedActiveBackend> {
  return async (pointer: ActivePointer): Promise<ResolvedActiveBackend> => {
    // NULL == the session's HOME backend (issue #341 invariant 1). `defaultBackend`
    // is the already-established home the wiring handed us — the Modal group box for a
    // Modal-home turn, or the machine itself for a machine-home turn. It is NEVER a
    // swap target's SelfhostedSession: a clear-to-null must re-land on the home, never
    // keep serving the machine a prior op swapped to. (The proxy caches by the FULL
    // pointer tuple, so a clear-to-null — epoch-bumped OR a same-epoch FK null —
    // invalidates the cached machine and re-enters this branch.) The lease owns the
    // home box lifecycle; the proxy does not re-establish it.
    if (pointer.activeSandboxId === null) {
      // A machine-pinned turn (Modal-home session pinned to a machine) never
      // established its home box, so a mid-turn clear-to-null has no home to resolve
      // THIS turn. Fail typed-and-specific — the detach was accepted and its pointer
      // commit STANDS, taking effect on the next turn (which starts null and
      // establishes the home box) — instead of silently serving the pinned machine as
      // if the clear never happened. Only an EXPLICIT `false` throws; omitted (the
      // common path) resolves to the home default as before. (Lazily establishing the
      // home box mid-turn on such a clear is a deferred follow-up; issue #341.)
      if (deps.defaultIsHome === false) {
        throw new ActiveBackendUnresolvableError(
          "home_unavailable_this_turn",
          "the active sandbox was detached to the session default (home), but this turn started pinned to a machine and established no home box; the detach is accepted and takes effect on the next turn — this turn has no active home box",
        );
      }
      if (deps.resolveDefaultBackend) {
        return await deps.resolveDefaultBackend(pointer);
      }
      return { session: deps.defaultBackend, sandboxId: null, kind: deps.defaultKind };
    }

    // INSTANCE PIN (Stage D machine-primary): the steady-state machine pointer
    // returns the pre-established turn session BY REFERENCE — never a fresh build —
    // so the turn-start manifest write + the per-op reads land on ONE
    // SelfhostedSession/manifest. Matched on BOTH the sandbox id AND the epoch: a
    // swap away (different id) or a swap-back (same id, higher epoch) falls through
    // to a fresh build fenced under the CURRENT epoch (the stale pinned instance is
    // fenced at the old epoch and must not be reused).
    if (
      deps.pinnedSelfhosted &&
      pointer.activeSandboxId === deps.pinnedSelfhosted.sandboxId &&
      pointer.activeEpoch === deps.pinnedSelfhosted.epoch
    ) {
      return {
        session: deps.pinnedSelfhosted.session,
        sandboxId: pointer.activeSandboxId,
        kind: "selfhosted",
      };
    }

    const sandbox = await deps.getSandbox(pointer.activeSandboxId);
    if (!sandbox) {
      throw new ActiveBackendUnresolvableError(
        "stale_pointer",
        `active sandbox ${pointer.activeSandboxId} not found in workspace ${deps.workspaceId}`,
      );
    }

    if (sandbox.kind === "selfhosted") {
      if (!sandbox.enrollmentId) {
        throw new ActiveBackendUnresolvableError(
          "offline_enrollment",
          `selfhosted sandbox ${sandbox.id} has no enrollment (agent id) to address`,
        );
      }
      // Build a request-scoped selfhosted client bound to the target's workspace +
      // enrollment agentId, fenced under the swap's active_epoch. The agent echoes
      // the epoch and rejects a stale op with ERROR_CODE_FENCED → the proxy
      // re-resolves + retries against the new active sandbox. The SAME factory the
      // worker turn's machine-primary establish branch uses (one build shape).
      const { session } = await buildSelfhostedBackendSession({
        workspaceId: deps.workspaceId,
        relay: deps.relay,
        controlRpcFactory: deps.controlRpcFactory,
        agentId: sandbox.enrollmentId,
        epoch: pointer.activeEpoch,
        ...(deps.selfhostedTimeoutMs !== undefined ? { timeoutMs: deps.selfhostedTimeoutMs } : {}),
        ...(deps.selfhostedExecTimeoutMs !== undefined
          ? { execTimeoutMs: deps.selfhostedExecTimeoutMs }
          : {}),
        ...(deps.selfhostedOnOp !== undefined ? { onOp: deps.selfhostedOnOp } : {}),
        // The turn's declared environment → the session's manifest.environment, so
        // the SDK's per-turn manifest-env delta is empty (no "cannot change manifest
        // environment variables" throw on a pin-to-vm turn).
        ...(deps.environment !== undefined ? { environment: deps.environment } : {}),
        // The session's working directory (per-session pointer) → the path/cwd base
        // for this selfhosted backend. Absent/empty ⇒ the default workspace_root.
        ...(pointer.workingDir ? { workingDir: pointer.workingDir } : {}),
      });
      return {
        session: session as RoutableBackendSession,
        sandboxId: sandbox.id,
        kind: "selfhosted",
      };
    }

    if (sandbox.kind === "modal") {
      if (!deps.establishModalTarget) {
        throw new ActiveBackendUnresolvableError(
          "unsupported_backend_context",
          `modal swap target ${sandbox.id} cannot be established in this context (no establisher wired)`,
        );
      }
      const session = await deps.establishModalTarget(sandbox);
      return { session, sandboxId: sandbox.id, kind: "modal" };
    }

    throw new ActiveBackendUnresolvableError(
      "unsupported_backend_context",
      `unsupported swap target kind "${sandbox.kind}" for sandbox ${sandbox.id}`,
    );
  };
}
