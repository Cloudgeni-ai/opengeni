// apps/worker/src/sandbox-routing.ts — wire the agent-loop-free routing proxy
// (`@opengeni/runtime` RoutingSandboxSession + makeActiveBackendResolver) to the
// real DB pointer + the live NATS control plane for the WORKER TURN path (M7).
//
// The turn resumes its group box by id (resumeBoxForTurn) and injects it
// NON-OWNED into the run. With hot-swap, the injected `session` must be the
// STABLE routing proxy: the SDK binds to it ONCE and calls its
// methods per tool call; the proxy re-reads `(active_sandbox_id, active_epoch)`
// per op and dispatches to the currently-active backend (the group Modal box by
// default, or a swap target — a sibling Modal box or a selfhosted machine).
//
// The glue here is the DB-coupled half the leaf cannot own (the leaf must stay
// agent-loop-free + db-free): readActiveSandbox (the pointer), getSandbox (the
// target lookup), and the selfhosted ControlRpc built over the events bus's NATS
// request/reply connection.

import { sandboxLifecycleTransitionWaitMs, type Settings } from "@opengeni/config";
import {
  advanceWorkspaceGenerationForRetainedProcess,
  advanceWorkspaceGeneration,
  getRetainedProcess,
  retainWorkspaceMutationProcess,
  retainedProcessSettlementIdentity,
  settleRetainedProcess,
  verifyRetainedProcessMutationSettlement,
  verifyWorkspaceMutationSettlement,
  getSandbox,
  getEnrollment,
  markWarmLeaseInstanceLost,
  readLease,
  readActiveSandbox,
  SandboxRetainedProcessPromotionFencedError,
  type Database,
  type SandboxWorkspaceMutationAdmission,
} from "@opengeni/db";
import type { EventBus } from "@opengeni/events";
import {
  buildSelfhostedBackendSession,
  establishSandboxSessionFromEnvelope,
  isProviderSandboxGoneDuringRoutedOperation,
  isProviderSandboxNotFoundError,
  makeActiveBackendResolver,
  NatsControlRpc,
  NatsOpStreamTransport,
  RoutingBackendRecoveryRequiredError,
  RoutingSandboxSession,
  resolveModalCheckpointProviderBindingForSession,
  sandboxProviderInstanceIdFromEnvelope,
  sandboxBackendForSdkBackendId,
  selectBackend,
  verifySandboxExecReadiness,
  type ControlRpc,
  type EstablishedSandboxSession,
  type NatsRequestConnection,
  type RoutableBackendSession,
  type RoutableSandbox,
  type ResolvedActiveBackend,
  type RoutingMutationSettlementResult,
  type RoutingSandboxOperationObserver,
  type RoutingRetainedProcess,
  type RoutingRetainedProcessTerminalProof,
  type SelfhostedOpObserver,
  type SelfhostedRelayConfig,
  type OpStreamJournal,
  type SelfhostedOpStreamDeps,
} from "@opengeni/runtime";
import { sandboxLeaseHolderIdForAttempt } from "./sandbox-resume";

type PersistableMutationAdmission = {
  admission: SandboxWorkspaceMutationAdmission;
  providerBinding: Awaited<
    ReturnType<typeof resolveModalCheckpointProviderBindingForSession>
  > | null;
};

export type RoutingWiringServices = {
  db: Database;
  settings: Settings;
  /** The events bus, for the selfhosted control-plane request/reply connection.
   *  Optional: when absent (or NATS unconfigured) a selfhosted swap target
   *  surfaces agent_offline on its first op rather than failing to build. */
  bus?: EventBus;
  /** The per-op observer wired into every selfhosted session this turn builds
   *  (out-of-band telemetry — op metrics + machine.* events). Absent ⇒ no-op. */
  onOp?: SelfhostedOpObserver;
  /** Every physical routed provider call, across cloud and selfhosted homes. */
  onSandboxOperation?: RoutingSandboxOperationObserver;
  /** The op-stream durable-resume journal (the Temporal adaptation from
   *  op-journal.ts): attach generation + settled-frontier persistence. Absent ⇒
   *  the runtime defaults (generation "1", no persistence) — tests / non-turn
   *  callers. Only consulted when op-stream is actually enabled for the turn. */
  opJournal?: OpStreamJournal;
  /** Durable lifecycle notification emitted only by the observer that wins the
   * exact warm-instance loss CAS. */
  onHomeSandboxLost?: (input: {
    sandboxGroupId: string;
    instanceId: string;
    leaseEpoch: number;
  }) => Promise<void>;
  /** Called when a route repair replaces the worker's original home handle. */
  onHomeSandboxRebound?: (input: {
    established: EstablishedSandboxSession;
    leaseEpoch: number;
  }) => void;
  /** Cancel bounded capture waits with the owning turn activity. */
  waitSignal?: AbortSignal;
};

/** Worker-turn routing may final-ack streamed command output, so it must always
 * carry the turn's durable frontier journal. Non-turn helpers may still omit it
 * through the broader service shape above. */
type TurnRoutingWiringServices = RoutingWiringServices & {
  opJournal: OpStreamJournal;
};

export type RoutingWiringIds = {
  workspaceId: string;
  sessionId: string;
  /** Canonical turn-attempt fence used to admit persistable-home mutations.
   * Omit outside a running worker attempt; mutation hooks then remain disabled. */
  workspaceMutationFence?: {
    accountId: string;
    turnId: string;
    executionGeneration: number;
    attemptId: string;
  };
  homeLease?: {
    accountId: string;
    sandboxGroupId: string;
    leaseEpoch: number;
    instanceId: string;
    backend: string;
  };
  /**
   * The run's declared sandbox environment — the SAME object the turn passes to
   * `runtime.buildAgent`'s `sandboxEnvironment` and to `resumeBoxForTurn` (so the
   * group box's manifest carries it too). Threaded into a selfhosted swap target's
   * manifest so its `environment` EQUALS the turn's, making the SDK's per-turn
   * provided-session manifest-env delta empty (validateNoEnvironmentDelta).
   * WITHOUT this a pin-to-vm turn throws "Live sandbox sessions cannot change
   * manifest environment variables." Optional → the resolver defaults to `{}`.
   */
  environment?: Record<string, string>;
  /**
   * Stage D machine-primary: PIN the already-established turn SelfhostedSession
   * (the `established` arg's session) for THIS machine pointer `(sandboxId, epoch)`
   * so the per-op resolver returns that SAME instance instead of building a fresh
   * one — the turn-start manifest write + per-op reads then hit ONE
   * SelfhostedSession/manifest. Set ONLY by the machine-primary establish branch
   * (where `established.session` is the SelfhostedSession bound to this pointer);
   * the group-box/swap path omits it (the default is the modal group box, and a
   * swap target is built fresh).
   */
  pinnedSelfhosted?: { sandboxId: string; epoch: number };
  /**
   * Whether the turn's `defaultBackend` IS the session's home (so the null pointer may
   * resolve to it). Defaults to TRUE (omitted). Set explicitly FALSE on a machine-primary
   * turn of a Modal-HOME session (pinned to a machine, no Modal group box established this
   * turn): the routing resolver's null branch then throws a typed `home_unavailable_this_turn`
   * error on a mid-turn clear-to-null instead of silently serving the pinned machine — the
   * detach's pointer commit stands and takes effect next turn. A genuine machine-HOME turn
   * (home IS the machine) passes true.
   */
  defaultIsHome?: boolean;
};

/** Map the deployment relay URL to the leaf's `SelfhostedRelayConfig` shape
 *  (host/port/tls). M8 wires the real relay; until then a configured/placeholder
 *  host yields a well-formed stream-URL shape behind `resolveExposedPort`. */
export function relayConfigFromSettings(settings: Settings): SelfhostedRelayConfig {
  const raw = settings.selfhostedRelayUrl?.trim();
  if (!raw) {
    return { host: "relay.opengeni.local", port: 443, tls: true };
  }
  try {
    const url = new URL(raw.includes("://") ? raw : `wss://${raw}`);
    const tls = url.protocol === "wss:" || url.protocol === "https:";
    const port = url.port ? Number(url.port) : tls ? 443 : 80;
    return { host: url.hostname, port, tls };
  } catch {
    return { host: raw, port: 443, tls: true };
  }
}

/** The selfhosted CONTROL vs EXEC op deadlines for a turn, from settings. Control
 *  ops (ping/fs/desktop/pty) stay on the short timeout so machine liveness is never
 *  masked by a slow op; exec has its own setting and defaults to no duration wall.
 *  Threaded into every turn-path session build + resolver. */
export function selfhostedTimeoutsFromSettings(settings: Settings): {
  timeoutMs: number;
  execTimeoutMs: number;
} {
  return {
    timeoutMs: settings.sandboxSelfhostedControlTimeoutMs,
    execTimeoutMs: settings.sandboxSelfhostedExecTimeoutMs,
  };
}

/** The same split deadlines shaped for `makeActiveBackendResolver`'s dep names
 *  (`selfhostedTimeoutMs` / `selfhostedExecTimeoutMs`), for a swap/pin target. */
function selfhostedResolverTimeouts(settings: Settings): {
  selfhostedTimeoutMs: number;
  selfhostedExecTimeoutMs: number;
} {
  const { timeoutMs, execTimeoutMs } = selfhostedTimeoutsFromSettings(settings);
  return {
    selfhostedTimeoutMs: timeoutMs,
    selfhostedExecTimeoutMs: execTimeoutMs,
  };
}

type HomeRouteLeaseIdentity = {
  accountId: string;
  sandboxGroupId: string;
  backend: string;
};

type HomeRouteResolutionIds = HomeRouteLeaseIdentity & {
  workspaceId: string;
  sessionId: string;
};

type HomeRouteRecovery = "pending" | "degraded" | "unrecoverable" | "superseded";

/**
 * Translate the durable lease/recovery state into the typed disposition the
 * routing proxy exposes when the home cannot be safely resumed. A route repair
 * must never fall back to the old in-memory provider handle when the lease is
 * warming, restoring, unverifiable, or otherwise inconsistent.
 */
function homeRouteRecoveryDisposition(
  lease: Awaited<ReturnType<typeof readLease>>,
): HomeRouteRecovery {
  if (!lease) return "unrecoverable";
  if (lease.liveness === "warming") return "pending";
  if (lease.liveness === "draining") return "superseded";
  if (
    lease.recovery.restore.status === "pending" ||
    lease.recovery.restore.status === "restoring" ||
    lease.recovery.restore.status === "verifying"
  ) {
    return "pending";
  }
  if (
    lease.recovery.restore.status === "degraded" ||
    lease.recovery.workspace.status === "degraded" ||
    lease.recovery.archive.status === "unverified" ||
    lease.recovery.archive.status === "invalid"
  ) {
    return "degraded";
  }
  return "unrecoverable";
}

function homeRouteRecoveryError(
  lease: Awaited<ReturnType<typeof readLease>>,
  fallbackEpoch: number,
): RoutingBackendRecoveryRequiredError {
  return new RoutingBackendRecoveryRequiredError(
    "resolve_home_backend",
    lease?.leaseEpoch ?? fallbackEpoch,
    homeRouteRecoveryDisposition(lease),
  );
}

export function providerIdentityFromResumeState(
  resumeState: Record<string, unknown>,
): string | null {
  return sandboxProviderInstanceIdFromEnvelope(resumeState);
}

/**
 * Resolve the current durable home identity after the route epoch changes.
 *
 * Same-target attach/repair can replace the provider instance while a worker
 * turn still holds the stable routing proxy. The proxy must therefore resume
 * the lease's CURRENT identity, not reuse the object captured at turn start.
 * This seam is deliberately resume-only: lease election/rematerialization is
 * owned by the API/lease state machine, and a routed tool call must never create
 * a rival provider or replay an ambiguous mutation.
 */
async function resolveCurrentHomeBackend(
  services: RoutingWiringServices,
  ids: HomeRouteResolutionIds,
  established: EstablishedSandboxSession,
): Promise<ResolvedActiveBackend> {
  const lease = await readLease(services.db, ids.workspaceId, ids.sandboxGroupId);
  const fallbackEpoch = lease?.leaseEpoch ?? 0;
  if (
    !lease ||
    lease.liveness !== "warm" ||
    lease.recovery.provider.status !== "exists" ||
    lease.instanceId === null ||
    lease.recovery.provider.instanceId !== lease.instanceId ||
    lease.recovery.workspace.status !== "ready" ||
    (lease.recovery.restore.status !== "not_required" && lease.recovery.restore.status !== "ready")
  ) {
    throw homeRouteRecoveryError(lease, fallbackEpoch);
  }

  // A route epoch can advance without a provider replacement. Reuse the exact
  // established handle only when its identity still equals the durable one.
  if (lease.instanceId === established.instanceId) {
    services.onHomeSandboxRebound?.({
      established,
      leaseEpoch: lease.leaseEpoch,
    });
    return {
      session: established.session as RoutableBackendSession,
      sandboxId: null,
      kind: established.backendId,
      leaseEpoch: lease.leaseEpoch,
      providerInstanceId: lease.instanceId,
    };
  }

  const resumeState = lease.resumeState;
  const durableResumeBackend = lease.resumeBackendId ?? lease.backend ?? ids.backend;
  const resumeBackend = sandboxBackendForSdkBackendId(durableResumeBackend) ?? durableResumeBackend;
  if (
    !resumeState ||
    resumeBackend !== ids.backend ||
    providerIdentityFromResumeState(resumeState) !== lease.instanceId
  ) {
    throw homeRouteRecoveryError(lease, lease.leaseEpoch);
  }

  let rebound: EstablishedSandboxSession;
  try {
    rebound = await establishSandboxSessionFromEnvelope(services.settings, resumeState, {
      sessionId: ids.sessionId,
      recovery: "resume-only",
      backendOverride: resumeBackend as never,
    });
    // A resumed handle is not enough evidence for the route to use it. Keep the
    // same bounded readiness gate used before publishing a Modal lease warm.
    await verifySandboxExecReadiness(rebound);
  } catch (error) {
    if (!isProviderSandboxNotFoundError(resumeBackend, error)) {
      // The durable identity is present, but a transient resume/provider error
      // did not prove the box gone. Keep the lease untouched and make the next
      // independent route operation retry the resume; never use the old handle.
      throw new RoutingBackendRecoveryRequiredError(
        "resolve_home_backend",
        lease.leaseEpoch,
        "pending",
      );
    }
    const marked = await markWarmLeaseInstanceLost(services.db, {
      accountId: ids.accountId,
      workspaceId: ids.workspaceId,
      sandboxGroupId: ids.sandboxGroupId,
      expectedEpoch: lease.leaseEpoch,
      expectedInstanceId: lease.instanceId,
      diagnostic: "provider_not_found_during_home_route_rebind",
    });
    if (marked.status === "marked") {
      await services.onHomeSandboxLost?.({
        sandboxGroupId: ids.sandboxGroupId,
        instanceId: lease.instanceId,
        leaseEpoch: marked.lease.leaseEpoch,
      });
    }
    throw new RoutingBackendRecoveryRequiredError(
      "resolve_home_backend",
      marked.lease?.leaseEpoch ?? lease.leaseEpoch,
      marked.status === "stale" ? "superseded" : homeRouteRecoveryDisposition(marked.lease),
    );
  }

  // The provider identity must agree with the exact durable lease row before
  // any caller can publish or route through this rebound handle. A mismatch is
  // unverifiable local state, not permission to try the old handle.
  const reboundBackend = sandboxBackendForSdkBackendId(rebound.backendId) ?? rebound.backendId;
  if (rebound.instanceId !== lease.instanceId || reboundBackend !== resumeBackend) {
    throw homeRouteRecoveryError(lease, lease.leaseEpoch);
  }
  services.onHomeSandboxRebound?.({
    established: rebound,
    leaseEpoch: lease.leaseEpoch,
  });
  // Keep the resolver's mutable home reference on the latest verified handle so
  // a later route epoch does not resume the same replacement again. This is only
  // a worker-side handle update; the SDK-facing RoutingSandboxSession remains the
  // stable object returned below and is never replaced.
  Object.assign(established, rebound);
  return {
    session: rebound.session as RoutableBackendSession,
    sandboxId: null,
    kind: rebound.backendId,
    leaseEpoch: lease.leaseEpoch,
    providerInstanceId: lease.instanceId,
  };
}

function beforePersistableHomeMutation(
  services: RoutingWiringServices,
  ids: RoutingWiringIds,
  home: { accountId: string; sandboxGroupId: string; backend: string } | undefined,
):
  | ((input: {
      op: string;
      backend: ResolvedActiveBackend;
    }) => Promise<PersistableMutationAdmission | null>)
  | undefined {
  const fence = ids.workspaceMutationFence;
  if (!home || !fence) return undefined;
  return async ({ op, backend }) => {
    // A connected-machine target is intentionally non-persistable: its writes
    // do not dirty the session home's archive. Exact home identity metadata is
    // present only on a verified durable home route.
    if (
      backend.sandboxId !== null ||
      backend.leaseEpoch === undefined ||
      backend.providerInstanceId === undefined
    ) {
      return null;
    }
    const providerBinding =
      home.backend === "modal"
        ? await resolveModalCheckpointProviderBindingForSession(services.settings, backend.session)
        : null;
    const admission = await advanceWorkspaceGeneration(services.db, {
      accountId: fence.accountId,
      workspaceId: ids.workspaceId,
      sessionId: ids.sessionId,
      turnId: fence.turnId,
      executionGeneration: fence.executionGeneration,
      attemptId: fence.attemptId,
      holderId: sandboxLeaseHolderIdForAttempt(fence.attemptId),
      sandboxGroupId: home.sandboxGroupId,
      expectedEpoch: backend.leaseEpoch,
      expectedInstanceId: backend.providerInstanceId,
      operation: op,
      captureWaitMs: sandboxLifecycleTransitionWaitMs(services.settings),
      ...(services.waitSignal ? { waitSignal: services.waitSignal } : {}),
    });
    return { admission, providerBinding };
  };
}

function afterPersistableHomeMutation(
  services: RoutingWiringServices,
  ids: RoutingWiringIds,
  home: { accountId: string; sandboxGroupId: string; backend: string } | undefined,
):
  | ((input: {
      op: string;
      backend: ResolvedActiveBackend;
      admission: unknown;
      outcome: "resolved" | "rejected";
      result?: unknown;
      retainedProcess?: RoutingRetainedProcess;
    }) => Promise<void | RoutingMutationSettlementResult>)
  | undefined {
  const fence = ids.workspaceMutationFence;
  if (!home || !fence) return undefined;
  return async ({ op, backend, admission, outcome, retainedProcess }) => {
    if (
      backend.sandboxId !== null ||
      backend.leaseEpoch === undefined ||
      backend.providerInstanceId === undefined ||
      !admission ||
      typeof admission !== "object"
    ) {
      return;
    }
    const boundAdmission = admission as Partial<PersistableMutationAdmission>;
    const exactAdmission = boundAdmission.admission;
    if (
      !exactAdmission ||
      typeof exactAdmission.id !== "string" ||
      typeof exactAdmission.workspaceGeneration !== "number" ||
      !("providerBinding" in boundAdmission)
    ) {
      throw new Error("Persistable home mutation settlement lacked its bound admission");
    }
    if (outcome === "resolved" && retainedProcess) {
      try {
        await retainWorkspaceMutationProcess(services.db, {
          accountId: fence.accountId,
          workspaceId: ids.workspaceId,
          sessionId: ids.sessionId,
          processId: retainedProcess.id,
          providerSessionId: retainedProcess.providerSessionId,
          admissionId: exactAdmission.id,
          admittedWorkspaceGeneration: exactAdmission.workspaceGeneration,
          operation: op,
          providerBinding: boundAdmission.providerBinding ?? null,
          owner: {
            kind: "turn",
            turnId: fence.turnId,
            executionGeneration: fence.executionGeneration,
            attemptId: fence.attemptId,
            holderId: sandboxLeaseHolderIdForAttempt(fence.attemptId),
            sandboxGroupId: home.sandboxGroupId,
            expectedEpoch: backend.leaseEpoch,
            expectedInstanceId: backend.providerInstanceId,
            routeKind: exactAdmission.routeKind,
            routeTargetId: exactAdmission.routeTargetId,
            routeEpoch: exactAdmission.routeEpoch,
          },
        });
      } catch (error) {
        if (!(error instanceof SandboxRetainedProcessPromotionFencedError)) throw error;
        const durable = error.process;
        if (
          durable.id !== retainedProcess.id ||
          durable.providerSessionId !== retainedProcess.providerSessionId ||
          durable.sessionId !== ids.sessionId ||
          durable.sandboxGroupId !== home.sandboxGroupId ||
          durable.parentAdmissionId !== exactAdmission.id ||
          durable.leaseEpoch !== backend.leaseEpoch ||
          durable.providerInstanceId !== backend.providerInstanceId ||
          durable.routeKind !== exactAdmission.routeKind ||
          durable.routeTargetId !== exactAdmission.routeTargetId ||
          durable.routeEpoch !== exactAdmission.routeEpoch ||
          durable.state !== "active"
        ) {
          throw new Error("Durable retained-process promotion returned a mismatched identity", {
            cause: error,
          });
        }
        return {
          status: "retained_process_durable_output_rejected",
          retainedProcess: {
            id: durable.id,
            providerSessionId: durable.providerSessionId,
          },
        };
      }
      return;
    }
    await verifyWorkspaceMutationSettlement(services.db, {
      accountId: fence.accountId,
      workspaceId: ids.workspaceId,
      sessionId: ids.sessionId,
      turnId: fence.turnId,
      executionGeneration: fence.executionGeneration,
      attemptId: fence.attemptId,
      holderId: sandboxLeaseHolderIdForAttempt(fence.attemptId),
      sandboxGroupId: home.sandboxGroupId,
      expectedEpoch: backend.leaseEpoch,
      expectedInstanceId: backend.providerInstanceId,
      admission: exactAdmission,
      operation: op,
      outcome,
    });
  };
}

function beforeRetainedProcessMutation(
  services: RoutingWiringServices,
  ids: RoutingWiringIds,
):
  | ((input: {
      op: string;
      backend: ResolvedActiveBackend;
      process: RoutingRetainedProcess;
    }) => Promise<SandboxWorkspaceMutationAdmission>)
  | undefined {
  const fence = ids.workspaceMutationFence;
  if (!fence) return undefined;
  return async ({ op, process }) =>
    await advanceWorkspaceGenerationForRetainedProcess(services.db, {
      accountId: fence.accountId,
      workspaceId: ids.workspaceId,
      sessionId: ids.sessionId,
      processId: process.id,
      operation: op,
      captureWaitMs: sandboxLifecycleTransitionWaitMs(services.settings),
      ...(services.waitSignal ? { waitSignal: services.waitSignal } : {}),
    });
}

function afterRetainedProcessMutation(
  services: RoutingWiringServices,
  ids: RoutingWiringIds,
):
  | ((input: {
      op: string;
      backend: ResolvedActiveBackend;
      process: RoutingRetainedProcess;
      admission: unknown;
      outcome: "resolved" | "rejected";
      result?: unknown;
    }) => Promise<void>)
  | undefined {
  const fence = ids.workspaceMutationFence;
  if (!fence) return undefined;
  return async ({ op, process, admission, outcome }) => {
    if (
      !admission ||
      typeof admission !== "object" ||
      typeof (admission as Partial<SandboxWorkspaceMutationAdmission>).id !== "string" ||
      typeof (admission as Partial<SandboxWorkspaceMutationAdmission>).workspaceGeneration !==
        "number"
    ) {
      throw new Error("Retained-process mutation settlement lacked its exact admission");
    }
    await verifyRetainedProcessMutationSettlement(services.db, {
      accountId: fence.accountId,
      workspaceId: ids.workspaceId,
      sessionId: ids.sessionId,
      processId: process.id,
      admission: admission as SandboxWorkspaceMutationAdmission,
      operation: op,
      outcome,
    });
  };
}

function settleRetainedProcessForTurn(
  services: RoutingWiringServices,
  ids: RoutingWiringIds,
):
  | ((input: {
      backend: ResolvedActiveBackend;
      process: RoutingRetainedProcess;
      proof: RoutingRetainedProcessTerminalProof;
    }) => Promise<void>)
  | undefined {
  const fence = ids.workspaceMutationFence;
  if (!fence) return undefined;
  return async ({ backend, process, proof }) => {
    const durable = await getRetainedProcess(services.db, {
      workspaceId: ids.workspaceId,
      sessionId: ids.sessionId,
      processId: process.id,
    });
    if (
      !durable ||
      durable.providerSessionId !== process.providerSessionId ||
      durable.providerBackend !== backend.kind ||
      durable.providerInstanceId !== backend.providerInstanceId ||
      durable.leaseEpoch !== backend.leaseEpoch ||
      durable.routeKind !== (backend.sandboxId === null ? "home" : "active") ||
      durable.routeTargetId !== backend.sandboxId ||
      durable.routeEpoch !== backend.activeEpoch
    ) {
      throw new Error("Retained-process settlement lost its exact durable backend identity");
    }
    await settleRetainedProcess(services.db, {
      accountId: fence.accountId,
      workspaceId: ids.workspaceId,
      sessionId: ids.sessionId,
      processId: process.id,
      expected: retainedProcessSettlementIdentity(durable),
      outcome: proof.outcome,
      exitCode: proof.exitCode,
      reason: proof.reason,
      idleGraceMs: services.settings.sandboxIdleGraceMs,
    });
  };
}

/** Build the selfhosted `ControlRpc` over the events bus's request/reply
 *  connection. A null bus / unconfigured NATS yields a NatsControlRpc whose
 *  connection factory returns null → agent_offline on every op (never a throw). */
function controlRpcFactory(bus: EventBus | undefined): () => ControlRpc {
  return () =>
    new NatsControlRpc(async (): Promise<NatsRequestConnection | null> => {
      if (!bus) {
        return null;
      }
      return bus.getRequestConnection();
    });
}

/**
 * Wrap an established group-box session in a `RoutingSandboxSession` so a mid-turn
 * swap routes the NEXT tool call to the new active sandbox. Returns the SAME
 * established handle with its `session` replaced by the stable proxy; the
 * client/sessionState/instanceId/backendId are preserved (the lease still owns
 * the group box's lifecycle — the proxy is a routing veneer, not an owner).
 *
 * The DEFAULT pointer (active_sandbox_id == null) routes to the established group
 * session unchanged (backward-compat). A swap to a selfhosted machine routes to a
 * SelfhostedSession bound to the target's enrollment agentId, fenced under the
 * swap's active_epoch.
 */
export function wrapTurnBoxWithRouting(
  services: TurnRoutingWiringServices,
  ids: RoutingWiringIds,
  established: EstablishedSandboxSession,
): EstablishedSandboxSession {
  const { db, settings, bus, onOp } = services;
  const beforeMutation = beforePersistableHomeMutation(services, ids, ids.homeLease);
  const afterMutation = afterPersistableHomeMutation(services, ids, ids.homeLease);
  const beforeProcessMutation = beforeRetainedProcessMutation(services, ids);
  const afterProcessMutation = afterRetainedProcessMutation(services, ids);
  const settleProcess = settleRetainedProcessForTurn(services, ids);
  const resolver = makeActiveBackendResolver({
    workspaceId: ids.workspaceId,
    defaultBackend: established.session as RoutableBackendSession,
    defaultKind: established.backendId,
    getSandbox: async (sandboxId): Promise<RoutableSandbox | null> => {
      const sandbox = await getSandbox(db, ids.workspaceId, sandboxId);
      return sandbox
        ? {
            id: sandbox.id,
            kind: sandbox.kind,
            name: sandbox.name,
            enrollmentId: sandbox.enrollmentId,
          }
        : null;
    },
    controlRpcFactory: controlRpcFactory(bus),
    resolveSelfhostedOpStream: async (sandbox) => {
      if (!sandbox.enrollmentId) return undefined;
      const enrollment = await getEnrollment(db, ids.workspaceId, sandbox.enrollmentId);
      return opStreamDepsFor(services, enrollment?.opStream === true);
    },
    relay: relayConfigFromSettings(settings),
    // A selfhosted swap target runs real commands too, so give it the same split
    // deadlines the machine-primary establish path uses (short control, long exec).
    ...selfhostedResolverTimeouts(settings),
    ...(onOp !== undefined ? { selfhostedOnOp: onOp } : {}),
    // The turn's declared environment → a selfhosted swap target's manifest, so the
    // SDK's per-turn manifest-env delta is empty (no "cannot change manifest
    // environment variables" throw when the turn pins to a vm). Mirrors the group
    // box, which is created WITH this same environment (resumeBoxForTurn).
    ...(ids.environment !== undefined ? { environment: ids.environment } : {}),
    // Stage D machine-primary: pin THIS established SelfhostedSession for the machine
    // pointer so the resolver returns the SAME instance (no two-instance manifest
    // divergence). `established.session` is the SelfhostedSession the establish branch
    // bound to (sandboxId, epoch).
    ...(ids.pinnedSelfhosted
      ? {
          pinnedSelfhosted: {
            sandboxId: ids.pinnedSelfhosted.sandboxId,
            epoch: ids.pinnedSelfhosted.epoch,
            session: established.session as RoutableBackendSession,
          },
        }
      : {}),
    // A modal swap target in the turn path would need its own lease resume-by-id;
    // that is a future cross-group-box concern. Until then a modal swap target is
    // unresolvable (the swap tool validates liveness, so this only triggers if a
    // session points at a sibling modal box the turn cannot resume here) and the
    // op surfaces unresolvable — never a silent wrong-box landing.
    //
    // For a machine-primary turn of a Modal-HOME session (pinned to a machine, no
    // group box established this turn), a mid-turn clear-to-null must NOT fall back to
    // the pinned machine — passing defaultIsHome:false makes the null branch throw typed
    // `home_unavailable_this_turn` instead. Forward the explicit boolean (including false).
    ...(ids.defaultIsHome !== undefined ? { defaultIsHome: ids.defaultIsHome } : {}),
    ...(ids.homeLease
      ? {
          resolveDefaultBackend: () =>
            resolveCurrentHomeBackend(
              services,
              {
                workspaceId: ids.workspaceId,
                sessionId: ids.sessionId,
                accountId: ids.homeLease!.accountId,
                sandboxGroupId: ids.homeLease!.sandboxGroupId,
                backend: ids.homeLease!.backend,
              },
              established,
            ),
        }
      : {}),
  });

  const proxy = new RoutingSandboxSession({
    // Seed the DEFAULT backend (the established group box) at construction so
    // `session.state` is the real backend's state object BEFORE the first op. The
    // SDK reads `session.state.manifest` at turn START (and writes it back); an
    // empty `{}` there crashes serializeManifestEnvironment /
    // validateProvidedSessionManifestUpdate. This is byte-identical to what the
    // resolver returns for the default pointer (`activeSandboxId === null`).
    defaultResolved: {
      session: established.session as RoutableBackendSession,
      sandboxId: null,
      kind: established.backendId,
      ...(ids.homeLease
        ? {
            leaseEpoch: ids.homeLease.leaseEpoch,
            providerInstanceId: ids.homeLease.instanceId,
          }
        : {}),
    },
    readPointer: async () => {
      if (!routingEnabled(settings)) {
        return { activeSandboxId: null, activeEpoch: 0 };
      }
      const pointer = await readActiveSandbox(db, ids.workspaceId, ids.sessionId);
      return pointer ?? { activeSandboxId: null, activeEpoch: 0 };
    },
    resolveActiveBackend: resolver,
    ...(services.onSandboxOperation ? { onOperation: services.onSandboxOperation } : {}),
    ...(beforeMutation ? { beforeMutation } : {}),
    ...(afterMutation ? { afterMutation } : {}),
    ...(beforeProcessMutation ? { beforeProcessMutation } : {}),
    ...(afterProcessMutation ? { afterProcessMutation } : {}),
    ...(settleProcess ? { settleProcess } : {}),
    ...(ids.homeLease
      ? {
          onDefaultBackendError: async ({
            error,
            backend,
          }: {
            error: unknown;
            backend: ResolvedActiveBackend;
          }) => {
            const home = ids.homeLease!;
            if (!isProviderSandboxGoneDuringRoutedOperation(home.backend, error)) return null;
            const expectedEpoch = backend.leaseEpoch ?? home.leaseEpoch;
            const expectedInstanceId = backend.providerInstanceId ?? home.instanceId;
            const marked = await markWarmLeaseInstanceLost(db, {
              accountId: home.accountId,
              workspaceId: ids.workspaceId,
              sandboxGroupId: home.sandboxGroupId,
              expectedEpoch,
              expectedInstanceId,
              diagnostic: "provider_not_found_during_routed_operation",
            });
            if (marked.status === "marked") {
              await services.onHomeSandboxLost?.({
                sandboxGroupId: home.sandboxGroupId,
                instanceId: expectedInstanceId,
                leaseEpoch: marked.lease.leaseEpoch,
              });
            }
            const lease = marked.lease;
            const restore = lease?.recovery.restore.status;
            return {
              leaseEpoch: lease?.leaseEpoch ?? expectedEpoch,
              recovery:
                marked.status === "stale"
                  ? ("superseded" as const)
                  : restore === "pending"
                    ? ("pending" as const)
                    : restore === "degraded"
                      ? ("degraded" as const)
                      : ("unrecoverable" as const),
            };
          },
        }
      : {}),
  });

  return { ...established, session: proxy };
}

export function wrapLazyTurnBoxWithRouting(
  services: TurnRoutingWiringServices,
  ids: RoutingWiringIds,
  args: {
    client: EstablishedSandboxSession["client"];
    backendId: string;
    agentDefaultManifest: unknown;
    provisioner: {
      get(): Promise<{
        established: EstablishedSandboxSession;
        leaseEpoch?: number;
      }>;
    };
    homeLeaseIdentity?: {
      accountId: string;
      sandboxGroupId: string;
      backend: string;
    };
  },
): EstablishedSandboxSession {
  const { db, settings, bus, onOp } = services;
  const beforeMutation = beforePersistableHomeMutation(services, ids, args.homeLeaseIdentity);
  const afterMutation = afterPersistableHomeMutation(services, ids, args.homeLeaseIdentity);
  const beforeProcessMutation = beforeRetainedProcessMutation(services, ids);
  const afterProcessMutation = afterRetainedProcessMutation(services, ids);
  const settleProcess = settleRetainedProcessForTurn(services, ids);
  const defaultBackend = sandboxBackendForSdkBackendId(args.backendId);
  const defaultSupportsPty = defaultBackend
    ? selectBackend(defaultBackend).capabilities.Terminal.pty
    : false;
  const syntheticSession: RoutableBackendSession = {
    state: { manifest: args.agentDefaultManifest },
    // The SDK binds shell tools synchronously before lazy provisioning. Preserve
    // the authoritative descriptor's PTY shape so a Modal home exposes
    // write_stdin on its first turn operation; the async cancellation transport
    // below still resolves the exact live route before executing a command.
    supportsPty: () => defaultSupportsPty,
  };
  const routedResolver = makeActiveBackendResolver({
    workspaceId: ids.workspaceId,
    defaultBackend: syntheticSession,
    defaultKind: "unprovisioned",
    getSandbox: async (sandboxId): Promise<RoutableSandbox | null> => {
      const sandbox = await getSandbox(db, ids.workspaceId, sandboxId);
      return sandbox
        ? {
            id: sandbox.id,
            kind: sandbox.kind,
            name: sandbox.name,
            enrollmentId: sandbox.enrollmentId,
          }
        : null;
    },
    controlRpcFactory: controlRpcFactory(bus),
    resolveSelfhostedOpStream: async (sandbox) => {
      if (!sandbox.enrollmentId) return undefined;
      const enrollment = await getEnrollment(db, ids.workspaceId, sandbox.enrollmentId);
      return opStreamDepsFor(services, enrollment?.opStream === true);
    },
    relay: relayConfigFromSettings(settings),
    ...selfhostedResolverTimeouts(settings),
    ...(onOp !== undefined ? { selfhostedOnOp: onOp } : {}),
    ...(ids.environment !== undefined ? { environment: ids.environment } : {}),
  });

  const proxy = new RoutingSandboxSession({
    // Before the first op the SDK reads `state.manifest`; the synthetic backend
    // points at agent.defaultManifest BY REFERENCE so the provided-session delta is
    // empty. The first default-pointer op resolves the real box through the
    // provisioner and `state` switches to that real backend by reference.
    defaultResolved: {
      session: syntheticSession,
      sandboxId: null,
      kind: "unprovisioned",
    },
    readPointer: async () => {
      const pointer = await readActiveSandbox(db, ids.workspaceId, ids.sessionId);
      return pointer ?? { activeSandboxId: null, activeEpoch: 0 };
    },
    resolveActiveBackend: async (pointer) => {
      if (pointer.activeSandboxId === null || !routingEnabled(settings)) {
        const provisioned = await args.provisioner.get();
        if (args.homeLeaseIdentity && provisioned.leaseEpoch !== undefined) {
          return resolveCurrentHomeBackend(
            services,
            {
              workspaceId: ids.workspaceId,
              sessionId: ids.sessionId,
              accountId: args.homeLeaseIdentity.accountId,
              sandboxGroupId: args.homeLeaseIdentity.sandboxGroupId,
              backend: args.homeLeaseIdentity.backend,
            },
            provisioned.established,
          );
        }
        return {
          session: provisioned.established.session as RoutableBackendSession,
          sandboxId: null,
          kind: provisioned.established.backendId,
        };
      }
      return routedResolver(pointer);
    },
    ...(services.onSandboxOperation ? { onOperation: services.onSandboxOperation } : {}),
    ...(beforeMutation ? { beforeMutation } : {}),
    ...(afterMutation ? { afterMutation } : {}),
    ...(beforeProcessMutation ? { beforeProcessMutation } : {}),
    ...(afterProcessMutation ? { afterProcessMutation } : {}),
    ...(settleProcess ? { settleProcess } : {}),
    ...(args.homeLeaseIdentity
      ? {
          onDefaultBackendError: async ({
            error,
            backend,
          }: {
            error: unknown;
            backend: ResolvedActiveBackend;
          }) => {
            const home = args.homeLeaseIdentity!;
            if (!isProviderSandboxGoneDuringRoutedOperation(home.backend, error)) return null;
            if (backend.leaseEpoch === undefined || backend.providerInstanceId === undefined) {
              return null;
            }
            const marked = await markWarmLeaseInstanceLost(db, {
              accountId: home.accountId,
              workspaceId: ids.workspaceId,
              sandboxGroupId: home.sandboxGroupId,
              expectedEpoch: backend.leaseEpoch,
              expectedInstanceId: backend.providerInstanceId,
              diagnostic: "provider_not_found_during_routed_operation",
            });
            if (marked.status === "marked") {
              await services.onHomeSandboxLost?.({
                sandboxGroupId: home.sandboxGroupId,
                instanceId: backend.providerInstanceId,
                leaseEpoch: marked.lease.leaseEpoch,
              });
            }
            const lease = marked.lease;
            const restore = lease?.recovery.restore.status;
            return {
              leaseEpoch: lease?.leaseEpoch ?? backend.leaseEpoch,
              recovery:
                marked.status === "stale"
                  ? ("superseded" as const)
                  : restore === "pending"
                    ? ("pending" as const)
                    : restore === "degraded"
                      ? ("degraded" as const)
                      : ("unrecoverable" as const),
            };
          },
        }
      : {}),
  });

  return {
    client: args.client,
    session: proxy,
    sessionState: undefined,
    instanceId: "unprovisioned",
    backendId: args.backendId,
  };
}

export type SelfhostedTurnSessionArgs = {
  workspaceId: string;
  /** The target machine's enrollment id == the agent subject id. */
  agentId: string;
  /** Whether the target machine advertised Capabilities.op_stream in its latest
   *  Hello. The runtime-side transport gate must still require the server flag. */
  opStream: boolean;
  /** The active pointer's epoch — the control-op fence echoed to the agent. */
  epoch: number;
  /** The run's declared sandbox environment (the SAME object fed to buildAgent +
   *  the manifest), threaded so the SDK's per-turn provided-session env delta is
   *  empty. */
  environment: Record<string, string>;
  /** The session working directory (per-session pointer). Null ⇒ workspace_root. */
  workingDir: string | null;
};

/**
 * Stage D machine-primary establish: bind the live SelfhostedSession for a turn
 * whose ACTIVE sandbox is a connected machine — WITHOUT establishing or leasing a
 * phantom Modal home box. Reuses the SAME relay + ControlRpc wiring `wrapTurnBoxWithRouting`
 * builds (so the turn session and a later swap target dial the machine identically),
 * and the SAME `buildSelfhostedBackendSession` factory the routing resolver uses
 * (one build shape). Returns an `EstablishedSandboxSession` whose:
 *   - `client` is the SelfhostedSandboxClient (the OWNED-sandbox client the turn
 *     injects; its `serializeSessionState` round-trips `{agentId}`);
 *   - `session` is the live SelfhostedSession (the routing default + pin instance);
 *   - `backendId` is "selfhosted" (drives recording's desktopCapableBackend gate +
 *     the warm-rate keying) and `instanceId` is the enrollment/agent id.
 * No NATS round-trip happens here — `resume()` just re-addresses the subject — so a
 * headless/offline machine binds fine; its ops surface agent_offline lazily.
 */
/**
 * The op-stream injection for a machine-primary turn: present iff the machine
 * advertised `Capabilities.op_stream` in its latest Hello AND the server flag
 * is on AND a bus exists to carry frames. The transport rides the SAME managed
 * NATS connection as the control rpc (the bus's op-stream accessor). A bus
 * without the accessor yields no stream; an unbounded exec then fails before
 * starting instead of silently degrading to request/reply. Swap targets resolve
 * the same enrollment capability through the injected backend-resolver seam.
 */
function opStreamDepsFor(
  services: RoutingWiringServices,
  machineAdvertisesOpStream: boolean,
): SelfhostedOpStreamDeps | undefined {
  const { settings, bus, opJournal } = services;
  if (!machineAdvertisesOpStream || settings.agentOpStreamEnabled !== true || !bus) {
    return undefined;
  }
  return {
    transport: new NatsOpStreamTransport(async () => bus.getOpStreamConnection?.() ?? null),
    ...(opJournal !== undefined ? { journal: opJournal } : {}),
  };
}

export async function establishSelfhostedTurnSession(
  services: RoutingWiringServices,
  args: SelfhostedTurnSessionArgs,
): Promise<EstablishedSandboxSession> {
  const { settings, bus, onOp } = services;
  const { timeoutMs, execTimeoutMs } = selfhostedTimeoutsFromSettings(settings);
  const opStream = opStreamDepsFor(services, args.opStream);
  const { client, session } = await buildSelfhostedBackendSession({
    workspaceId: args.workspaceId,
    agentId: args.agentId,
    relay: relayConfigFromSettings(settings),
    controlRpcFactory: controlRpcFactory(bus),
    epoch: args.epoch,
    environment: args.environment,
    workingDir: args.workingDir,
    // Give this turn's exec ops the long deadline (control ops stay short) so a real
    // command is not killed at the control wall.
    timeoutMs,
    execTimeoutMs,
    // Meter every control op (out-of-band telemetry) — no-op when unwired.
    ...(onOp !== undefined ? { onOp } : {}),
    // The streaming exec transport — present iff the machine advertised the
    // capability AND the server flag is on. It is required when execTimeoutMs=0;
    // legacy request/reply remains available only for explicitly bounded exec.
    ...(opStream !== undefined ? { opStream } : {}),
  });
  return {
    client,
    session,
    sessionState: { agentId: args.agentId },
    instanceId: args.agentId,
    backendId: "selfhosted",
  };
}

/** Whether the routing proxy should wrap the turn box: the hot-swap feature is
 *  gated by the selfhosted flag (the active pointer + swap tools are only
 *  meaningful when selfhosted is enabled). With the flag off the established
 *  group box is injected unchanged — byte-for-byte today. */
export function routingEnabled(settings: Settings): boolean {
  return settings.sandboxSelfhostedEnabled === true;
}

/** Whether the turn should defer sandbox provisioning to the first dispatched op
 *  (the in-process single-flight provisioner behind the routing proxy's
 *  resolveActiveBackend). Lazy is a property of the OWNED path only — the SDK never
 *  creates/resumes an injected session, so we own establish timing — hence gated on
 *  BOTH flags. With either off the turn provisions eagerly at turn start, exactly as
 *  today. NB: under lazy the box is ALWAYS wrapped in the routing proxy (the proxy's
 *  resolver IS the establish seam), independent of `routingEnabled`. */
export function lazyProvisionEnabled(settings: Settings): boolean {
  return settings.sandboxLazyProvisionEnabled === true && settings.sandboxOwnershipEnabled === true;
}
