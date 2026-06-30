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

import { SelfhostedSandboxClient, type SelfhostedRelayConfig } from "../selfhosted/session";
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
  /** Override the selfhosted control-op timeout (tests). */
  selfhostedTimeoutMs?: number;
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
}

/** Thrown when a swap target cannot be resolved (unknown sandbox, or a modal
 *  target with no establisher in this context). The caller maps it to a 409. */
export class ActiveBackendUnresolvableError extends Error {
  readonly name = "ActiveBackendUnresolvableError";
  constructor(message: string) {
    super(message);
  }
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
    // The DEFAULT target: the session's own group sandbox (backward-compat). The
    // proxy routes to the already-established box; the lease owns its lifecycle.
    if (pointer.activeSandboxId === null) {
      return { session: deps.defaultBackend, sandboxId: null, kind: deps.defaultKind };
    }

    const sandbox = await deps.getSandbox(pointer.activeSandboxId);
    if (!sandbox) {
      throw new ActiveBackendUnresolvableError(
        `active sandbox ${pointer.activeSandboxId} not found in workspace ${deps.workspaceId}`,
      );
    }

    if (sandbox.kind === "selfhosted") {
      if (!sandbox.enrollmentId) {
        throw new ActiveBackendUnresolvableError(
          `selfhosted sandbox ${sandbox.id} has no enrollment (agent id) to address`,
        );
      }
      // Build a request-scoped selfhosted client bound to the target's workspace +
      // enrollment agentId, fenced under the swap's active_epoch. The agent echoes
      // the epoch and rejects a stale op with ERROR_CODE_FENCED → the proxy
      // re-resolves + retries against the new active sandbox.
      const client = new SelfhostedSandboxClient({
        workspaceId: deps.workspaceId,
        relay: deps.relay,
        controlRpcFactory: deps.controlRpcFactory,
        agentId: sandbox.enrollmentId,
        epoch: pointer.activeEpoch,
        ...(deps.selfhostedTimeoutMs !== undefined ? { timeoutMs: deps.selfhostedTimeoutMs } : {}),
        // The turn's declared environment → the session's manifest.environment, so
        // the SDK's per-turn manifest-env delta is empty (no "cannot change manifest
        // environment variables" throw on a pin-to-vm turn).
        ...(deps.environment !== undefined ? { environment: deps.environment } : {}),
        // The session's working directory (per-session pointer) → the path/cwd base
        // for this selfhosted backend. Absent/empty ⇒ the default workspace_root.
        ...(pointer.workingDir ? { workingDir: pointer.workingDir } : {}),
      });
      const session = (await client.resume({ agentId: sandbox.enrollmentId })) as RoutableBackendSession;
      return { session, sandboxId: sandbox.id, kind: "selfhosted" };
    }

    if (sandbox.kind === "modal") {
      if (!deps.establishModalTarget) {
        throw new ActiveBackendUnresolvableError(
          `modal swap target ${sandbox.id} cannot be established in this context (no establisher wired)`,
        );
      }
      const session = await deps.establishModalTarget(sandbox);
      return { session, sandboxId: sandbox.id, kind: "modal" };
    }

    throw new ActiveBackendUnresolvableError(
      `unsupported swap target kind "${sandbox.kind}" for sandbox ${sandbox.id}`,
    );
  };
}
