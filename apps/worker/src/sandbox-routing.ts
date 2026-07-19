// apps/worker/src/sandbox-routing.ts — wire the agent-loop-free routing proxy
// (`@opengeni/runtime` RoutingSandboxSession + makeActiveBackendResolver) to the
// real DB pointer + the live NATS control plane for the WORKER TURN path (M7).
//
// The turn resumes its group box by id (resumeBoxForTurn) and injects it
// NON-OWNED into the run. With hot-swap, the injected `session` must be the
// STABLE routing proxy (dossier §10.3): the SDK binds to it ONCE and calls its
// methods per tool call; the proxy re-reads `(active_sandbox_id, active_epoch)`
// per op and dispatches to the currently-active backend (the group Modal box by
// default, or a swap target — a sibling Modal box or a selfhosted machine).
//
// The glue here is the DB-coupled half the leaf cannot own (the leaf must stay
// agent-loop-free + db-free): readActiveSandbox (the pointer), getSandbox (the
// target lookup), and the selfhosted ControlRpc built over the events bus's NATS
// request/reply connection.

import type { Settings } from "@opengeni/config";
import {
  getSandbox,
  markWarmLeaseInstanceLost,
  readLease,
  readActiveSandbox,
  type Database,
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
  verifySandboxExecReadiness,
  type ControlRpc,
  type EstablishedSandboxSession,
  type NatsRequestConnection,
  type RoutableBackendSession,
  type RoutableSandbox,
  type ResolvedActiveBackend,
  type SelfhostedOpObserver,
  type SelfhostedRelayConfig,
  type OpStreamJournal,
  type SelfhostedOpStreamDeps,
} from "@opengeni/runtime";

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
};

export type RoutingWiringIds = {
  workspaceId: string;
  sessionId: string;
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
 *  masked by a slow op; exec gets its own much larger budget so a real command is not
 *  killed at the control wall. Threaded into every turn-path session build + resolver. */
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
  return { selfhostedTimeoutMs: timeoutMs, selfhostedExecTimeoutMs: execTimeoutMs };
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

function providerIdentityFromResumeState(resumeState: Record<string, unknown>): string | null {
  const sessionState =
    resumeState.sessionState && typeof resumeState.sessionState === "object"
      ? (resumeState.sessionState as Record<string, unknown>)
      : null;
  const providerState =
    sessionState?.providerState && typeof sessionState.providerState === "object"
      ? (sessionState.providerState as Record<string, unknown>)
      : null;
  for (const field of [
    "sandboxId",
    "instanceId",
    "id",
    "hostId",
    "containerId",
    "workspaceRootPath",
    "agentId",
  ]) {
    const value = providerState?.[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
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
    services.onHomeSandboxRebound?.({ established, leaseEpoch: lease.leaseEpoch });
    return {
      session: established.session as RoutableBackendSession,
      sandboxId: null,
      kind: established.backendId,
    };
  }

  const resumeState = lease.resumeState;
  const resumeBackend = lease.resumeBackendId ?? lease.backend ?? ids.backend;
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
  if (rebound.instanceId !== lease.instanceId || rebound.backendId !== resumeBackend) {
    throw homeRouteRecoveryError(lease, lease.leaseEpoch);
  }
  services.onHomeSandboxRebound?.({ established: rebound, leaseEpoch: lease.leaseEpoch });
  // Keep the resolver's mutable home reference on the latest verified handle so
  // a later route epoch does not resume the same replacement again. This is only
  // a worker-side handle update; the SDK-facing RoutingSandboxSession remains the
  // stable object returned below and is never replaced.
  Object.assign(established, rebound);
  return {
    session: rebound.session as RoutableBackendSession,
    sandboxId: null,
    kind: rebound.backendId,
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
  services: RoutingWiringServices,
  ids: RoutingWiringIds,
  established: EstablishedSandboxSession,
): EstablishedSandboxSession {
  const { db, settings, bus, onOp } = services;
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
    },
    readPointer: async () => {
      if (!routingEnabled(settings)) {
        return { activeSandboxId: null, activeEpoch: 0 };
      }
      const pointer = await readActiveSandbox(db, ids.workspaceId, ids.sessionId);
      return pointer ?? { activeSandboxId: null, activeEpoch: 0 };
    },
    resolveActiveBackend: resolver,
    ...(ids.homeLease
      ? {
          onDefaultBackendError: async ({ error }: { error: unknown }) => {
            const home = ids.homeLease!;
            if (!isProviderSandboxGoneDuringRoutedOperation(home.backend, error)) return null;
            const marked = await markWarmLeaseInstanceLost(db, {
              accountId: home.accountId,
              workspaceId: ids.workspaceId,
              sandboxGroupId: home.sandboxGroupId,
              expectedEpoch: home.leaseEpoch,
              expectedInstanceId: home.instanceId,
              diagnostic: "provider_not_found_during_routed_operation",
            });
            if (marked.status === "marked") {
              await services.onHomeSandboxLost?.({
                sandboxGroupId: home.sandboxGroupId,
                instanceId: home.instanceId,
                leaseEpoch: marked.lease.leaseEpoch,
              });
            }
            const lease = marked.lease;
            const restore = lease?.recovery.restore.status;
            return {
              leaseEpoch: lease?.leaseEpoch ?? home.leaseEpoch,
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
  services: RoutingWiringServices,
  ids: RoutingWiringIds,
  args: {
    client: EstablishedSandboxSession["client"];
    backendId: string;
    agentDefaultManifest: unknown;
    provisioner: {
      get(): Promise<{ established: EstablishedSandboxSession; leaseEpoch?: number }>;
    };
    homeLeaseIdentity?: {
      accountId: string;
      sandboxGroupId: string;
      backend: string;
    };
  },
): EstablishedSandboxSession {
  const { db, settings, bus, onOp } = services;
  const syntheticSession: RoutableBackendSession = {
    state: { manifest: args.agentDefaultManifest },
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
    ...(args.homeLeaseIdentity
      ? {
          onDefaultBackendError: async ({ error }: { error: unknown }) => {
            const home = args.homeLeaseIdentity!;
            if (!isProviderSandboxGoneDuringRoutedOperation(home.backend, error)) return null;
            const provisioned = await args.provisioner.get();
            if (provisioned.leaseEpoch === undefined) return null;
            const marked = await markWarmLeaseInstanceLost(db, {
              accountId: home.accountId,
              workspaceId: ids.workspaceId,
              sandboxGroupId: home.sandboxGroupId,
              expectedEpoch: provisioned.leaseEpoch,
              expectedInstanceId: provisioned.established.instanceId,
              diagnostic: "provider_not_found_during_routed_operation",
            });
            if (marked.status === "marked") {
              await services.onHomeSandboxLost?.({
                sandboxGroupId: home.sandboxGroupId,
                instanceId: provisioned.established.instanceId,
                leaseEpoch: marked.lease.leaseEpoch,
              });
            }
            const lease = marked.lease;
            const restore = lease?.recovery.restore.status;
            return {
              leaseEpoch: lease?.leaseEpoch ?? provisioned.leaseEpoch,
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

type LegacySelfhostedTurnSessionArgs = Omit<SelfhostedTurnSessionArgs, "opStream">;

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
 * NATS connection as the control rpc (the bus's op-stream accessor); a bus
 * without the accessor (a test double) simply yields no connection and the
 * session falls back to the legacy exec on first use. Swap TARGETS resolved
 * mid-turn stay legacy for now — their capability row is not at hand in the
 * resolver, and legacy is always correct.
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
  args: SelfhostedTurnSessionArgs | LegacySelfhostedTurnSessionArgs,
): Promise<EstablishedSandboxSession> {
  const { settings, bus, onOp } = services;
  const { timeoutMs, execTimeoutMs } = selfhostedTimeoutsFromSettings(settings);
  const opStream = opStreamDepsFor(services, "opStream" in args && args.opStream === true);
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
    // capability AND the server flag is on (latched per-op at OpStart; the
    // legacy exec stays the permanent fallback wire form).
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
