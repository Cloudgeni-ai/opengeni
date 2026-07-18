// apps/api/src/sandbox/routing.ts — wire the agent-loop-free routing proxy to the
// real DB pointer + the live NATS control plane for the API-DIRECT Channel-A path
// (M7). Symmetric with apps/worker/src/sandbox-routing.ts (the turn path).
//
// A Channel-A op resumes the group box by id and runs ONE op against it. With
// hot-swap, the op must land on the session's CURRENTLY-active sandbox, not
// always the group box: if the session swapped to a selfhosted machine, an
// fs.read / git.status / exec from the API must reach THAT machine. So the
// established group session is wrapped in a `RoutingSandboxSession` that re-reads
// (active_sandbox_id, active_epoch) and dispatches to the active backend.
//
// The DB-coupled glue (readActiveSandbox / getSandbox / the selfhosted ControlRpc
// over the events bus) lives here, not in the leaf (which stays db-free).

import type { Settings } from "@opengeni/config";
import {
  getSandbox,
  markWarmLeaseInstanceLost,
  readActiveSandbox,
  type Database,
} from "@opengeni/db";
import { appendAndPublishEvents, type EventBus } from "@opengeni/events";
import {
  isProviderSandboxNotFoundError,
  makeActiveBackendResolver,
  NatsControlRpc,
  RoutingSandboxSession,
  type ControlRpc,
  type EstablishedSandboxSession,
  type NatsRequestConnection,
  type RoutableBackendSession,
  type RoutableSandbox,
  type SelfhostedRelayConfig,
} from "@opengeni/runtime/sandbox";

export type ChannelARoutingServices = {
  db: Database;
  settings: Settings;
  bus?: EventBus;
};

/** Map the deployment relay URL to the leaf's `SelfhostedRelayConfig` shape. The
 *  relay URL (`OPENGENI_SELFHOSTED_RELAY_URL`) may carry a path (the relay's wss
 *  route); a path-less URL defaults to the relay's `/stream` route (M8b). */
export function relayConfigFromSettings(settings: Settings): SelfhostedRelayConfig {
  const raw = settings.selfhostedRelayUrl?.trim();
  if (!raw) {
    return { host: "relay.opengeni.local", port: 443, tls: true, path: "/stream" };
  }
  try {
    const url = new URL(raw.includes("://") ? raw : `wss://${raw}`);
    const tls = url.protocol === "wss:" || url.protocol === "https:";
    const port = url.port ? Number(url.port) : tls ? 443 : 80;
    // Honor an explicit path in the configured URL; default the relay's /stream.
    const path = url.pathname && url.pathname !== "/" ? url.pathname : "/stream";
    return { host: url.hostname, port, tls, path };
  } catch {
    return { host: raw, port: 443, tls: true, path: "/stream" };
  }
}

/** The canonical relay dial-BASE URL (`scheme://host[:port]/stream`) handed to the
 *  agent PRODUCER. The agent's relay channel appends ONLY its routing query to
 *  this base (`channel.rs`: `format!("{relay_url}{sep}{query}")`) and relies on the
 *  base ALREADY carrying the relay's `/stream` route. `OPENGENI_SELFHOSTED_RELAY_URL`
 *  is frequently pathless (e.g. `wss://relay.<env>.app.opengeni.ai`), which made the
 *  producer dial a path-less URL the relay 400s. Derive the base from the SAME parser
 *  the CONSUMER uses (`relayConfigFromSettings`) so producer + consumer always agree
 *  on `/stream` — even when the configured URL omits it. An unconfigured relay maps to
 *  `""` (graceful degrade: the agent reports no-relay rather than dialing a synthetic
 *  host). Fixes preview AND managed prod with no agent rebuild (dossier §V5/§V6). */
export function relayDialBaseFromSettings(settings: Settings): string {
  if (!settings.selfhostedRelayUrl?.trim()) return "";
  const { host, port, tls, path } = relayConfigFromSettings(settings);
  const scheme = tls ? "wss" : "ws";
  const defaultPort = tls ? 443 : 80;
  const authority = port === defaultPort ? host : `${host}:${port}`;
  return `${scheme}://${authority}${path}`;
}

function controlRpcFactory(bus: EventBus | undefined): () => ControlRpc {
  return () =>
    new NatsControlRpc(async (): Promise<NatsRequestConnection | null> => {
      if (!bus) {
        return null;
      }
      return bus.getRequestConnection();
    });
}

/** Whether the routing proxy should wrap the Channel-A box: gated by the
 *  selfhosted flag (the active pointer + swap are only meaningful then). */
export function routingEnabled(settings: Settings): boolean {
  return settings.sandboxSelfhostedEnabled === true;
}

/**
 * Wrap an established group-box session in a `RoutingSandboxSession` so a
 * Channel-A op routes to the session's currently-active sandbox. Returns the
 * established handle with its `session` replaced by the stable proxy. With the
 * default pointer (active_sandbox_id == null) this routes to the group box
 * unchanged; a selfhosted active pointer routes the op to the machine.
 */
export function wrapChannelABoxWithRouting(
  services: ChannelARoutingServices,
  ids: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    homeLease: {
      sandboxGroupId: string;
      leaseEpoch: number;
      instanceId: string;
      backend: string;
    };
  },
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
  });

  const proxy = new RoutingSandboxSession({
    readPointer: async () => {
      if (!routingEnabled(settings)) {
        return { activeSandboxId: null, activeEpoch: 0 };
      }
      const pointer = await readActiveSandbox(db, ids.workspaceId, ids.sessionId);
      return pointer ?? { activeSandboxId: null, activeEpoch: 0 };
    },
    resolveActiveBackend: resolver,
    onDefaultBackendError: async ({ error }) => {
      if (!isProviderSandboxNotFoundError(ids.homeLease.backend, error)) return null;
      const marked = await markWarmLeaseInstanceLost(db, {
        accountId: ids.accountId,
        workspaceId: ids.workspaceId,
        sandboxGroupId: ids.homeLease.sandboxGroupId,
        expectedEpoch: ids.homeLease.leaseEpoch,
        expectedInstanceId: ids.homeLease.instanceId,
        diagnostic: "provider_not_found_during_routed_operation",
      });
      if (marked.status === "marked" && bus) {
        await appendAndPublishEvents(db, bus, ids.workspaceId, ids.sessionId, [
          {
            type: "sandbox.box.lost",
            payload: { sandboxId: ids.homeLease.instanceId },
          },
        ]).catch(() => undefined);
      }
      const lease = marked.lease;
      const restore = lease?.recovery.restore.status;
      return {
        leaseEpoch: lease?.leaseEpoch ?? ids.homeLease.leaseEpoch,
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
  });

  return { ...established, session: proxy };
}
