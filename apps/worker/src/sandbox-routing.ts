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
  makeActiveBackendResolver,
  NatsControlRpc,
  RoutingSandboxSession,
  type ControlRpc,
  type EstablishedSandboxSession,
  type NatsRequestConnection,
  type RoutableBackendSession,
  type RoutableSandbox,
  type SelfhostedRelayConfig,
} from "@opengeni/runtime";

export type RoutingWiringServices = {
  db: Database;
  settings: Settings;
  /** The events bus, for the selfhosted control-plane request/reply connection.
   *  Optional: when absent (or NATS unconfigured) a selfhosted swap target
   *  surfaces agent_offline on its first op rather than failing to build. */
  bus?: EventBus;
};

export type RoutingWiringIds = {
  workspaceId: string;
  sessionId: string;
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
  const { db, settings, bus } = services;
  const resolver = makeActiveBackendResolver({
    workspaceId: ids.workspaceId,
    defaultBackend: established.session as RoutableBackendSession,
    defaultKind: established.backendId,
    getSandbox: async (sandboxId): Promise<RoutableSandbox | null> => {
      const sandbox = await getSandbox(db, ids.workspaceId, sandboxId);
      return sandbox
        ? { id: sandbox.id, kind: sandbox.kind, name: sandbox.name, enrollmentId: sandbox.enrollmentId }
        : null;
    },
    controlRpcFactory: controlRpcFactory(bus),
    relay: relayConfigFromSettings(settings),
    // A modal swap target in the turn path would need its own lease resume-by-id;
    // that is a future cross-group-box concern. Until then a modal swap target is
    // unresolvable (the swap tool validates liveness, so this only triggers if a
    // session points at a sibling modal box the turn cannot resume here) and the
    // op surfaces unresolvable — never a silent wrong-box landing.
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

/** Whether the routing proxy should wrap the turn box: the hot-swap feature is
 *  gated by the selfhosted flag (the active pointer + swap tools are only
 *  meaningful when selfhosted is enabled). With the flag off the established
 *  group box is injected unchanged — byte-for-byte today. */
export function routingEnabled(settings: Settings): boolean {
  return settings.sandboxSelfhostedEnabled === true;
}
