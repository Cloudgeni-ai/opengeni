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
import { getSandbox, readActiveSandbox, type Database } from "@opengeni/db";
import type { EventBus } from "@opengeni/events";
import {
  buildSelfhostedBackendSession,
  makeActiveBackendResolver,
  NatsControlRpc,
  NatsOpStreamTransport,
  RoutingSandboxSession,
  type ControlRpc,
  type EstablishedSandboxSession,
  type NatsRequestConnection,
  type RoutableBackendSession,
  type RoutableSandbox,
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
};

export type RoutingWiringIds = {
  workspaceId: string;
  sessionId: string;
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
      const pointer = await readActiveSandbox(db, ids.workspaceId, ids.sessionId);
      return pointer ?? { activeSandboxId: null, activeEpoch: 0 };
    },
    resolveActiveBackend: resolver,
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
    provisioner: { get(): Promise<{ established: EstablishedSandboxSession }> };
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
        return {
          session: provisioned.established.session as RoutableBackendSession,
          sandboxId: null,
          kind: provisioned.established.backendId,
        };
      }
      return routedResolver(pointer);
    },
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
