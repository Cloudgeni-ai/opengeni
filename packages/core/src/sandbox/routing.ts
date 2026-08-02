// apps/api/src/sandbox/channel-a.ts — wire the agent-loop-free routing proxy to the
// real DB pointer + the live NATS control plane for the API-DIRECT Channel-A path
// (M7). Symmetric with apps/worker/src/sandbox-routing.ts (the turn path).
//
// A Channel-A op runs against one established home: either a lease-owned provider
// box or a Connected Machine home that intentionally has no cloud lease. With
// hot-swap, the op must land on the session's CURRENTLY-active sandbox. The
// established session is wrapped in a `RoutingSandboxSession` that re-reads
// (active_sandbox_id, active_epoch) and dispatches to the active backend.
//
// The DB-coupled glue (readActiveSandbox / getSandbox / the selfhosted ControlRpc
// over the events bus) lives here, not in the leaf (which stays db-free).

import { sandboxArchiveCaptureTimeoutMs, type Settings } from "@opengeni/config";
import {
  advanceWorkspaceGenerationForDirectRequest,
  advanceWorkspaceGenerationForRetainedProcess,
  getRetainedProcess,
  getSandbox,
  markWarmLeaseInstanceLost,
  readActiveSandbox,
  retainWorkspaceMutationProcess,
  retainedProcessSettlementIdentity,
  settleRetainedProcess,
  verifyDirectWorkspaceMutationSettlement,
  verifyRetainedProcessMutationSettlement,
  type Database,
  type SandboxWorkspaceMutationAdmission,
} from "@opengeni/db";
import { appendAndPublishEvents, type EventBus } from "@opengeni/events";
import {
  isProviderSandboxGoneDuringRoutedOperation,
  makeActiveBackendResolver,
  NatsControlRpc,
  RoutingSandboxSession,
  resolveModalCheckpointProviderBindingForSession,
  type ControlRpc,
  type EstablishedSandboxSession,
  type NatsRequestConnection,
  type ResolvedActiveBackend,
  type RoutableBackendSession,
  type RoutableSandbox,
  type RoutingRetainedProcess,
  type RoutingRetainedProcessTerminalProof,
  type RoutingSandboxOperationObserver,
  type SelfhostedRelayConfig,
} from "@opengeni/runtime/sandbox";

type PersistableMutationAdmission = {
  admission: SandboxWorkspaceMutationAdmission;
  providerBinding: Awaited<
    ReturnType<typeof resolveModalCheckpointProviderBindingForSession>
  > | null;
};

export type ChannelARoutingServices = {
  db: Database;
  settings: Settings;
  bus?: EventBus;
  onSandboxOperation?: RoutingSandboxOperationObserver;
};

/** Map the deployment relay URL to the leaf's `SelfhostedRelayConfig` shape. The
 *  relay URL (`OPENGENI_SELFHOSTED_RELAY_URL`) may carry a path (the relay's wss
 *  route); a path-less URL defaults to the relay's `/stream` route (M8b). */
export function relayConfigFromSettings(settings: Settings): SelfhostedRelayConfig {
  const raw = settings.selfhostedRelayUrl?.trim();
  if (!raw) {
    return {
      host: "relay.opengeni.local",
      port: 443,
      tls: true,
      path: "/stream",
    };
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
 * host). Fixes preview AND managed prod with no agent rebuild. */
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
 * Wrap an established home session in a `RoutingSandboxSession` so a Channel-A
 * op routes to the session's currently-active sandbox. Provider homes supply a
 * lease; machine homes supply a pinned selfhosted identity and no lease. Returns
 * the established handle with its `session` replaced by the stable proxy.
 */
export function wrapChannelABoxWithRouting(
  services: ChannelARoutingServices,
  ids: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    homeLease?: {
      sandboxGroupId: string;
      leaseEpoch: number;
      instanceId: string;
      backend: string;
    };
    /** A machine-home Channel-A request has no cloud/home lease. Its already
     * established SelfhostedSession is pinned to the durable active pointer so
     * the first command uses the exact machine instance and epoch. */
    pinnedSelfhosted?: {
      sandboxId: string;
      epoch: number;
    };
    directRequest: {
      requestId: string;
      holderId: string;
    };
  },
  established: EstablishedSandboxSession,
): EstablishedSandboxSession {
  const { db, settings, bus } = services;
  const homeLease = ids.homeLease;
  const beforeMutation = homeLease
    ? async ({
        op,
        backend,
      }: {
        op: string;
        backend: ResolvedActiveBackend;
      }): Promise<PersistableMutationAdmission | null> => {
        // Connected Machines and other non-persistable targets intentionally do
        // not dirty or advance the cloud-home archive generation.
        if (
          backend.sandboxId !== null ||
          backend.leaseEpoch === undefined ||
          backend.providerInstanceId === undefined
        ) {
          return null;
        }
        if (backend.activeEpoch === undefined) {
          throw new Error("API-direct workspace mutation resolved without an active route epoch");
        }
        const providerBinding =
          homeLease.backend === "modal"
            ? await resolveModalCheckpointProviderBindingForSession(settings, backend.session)
            : null;
        const admission = await advanceWorkspaceGenerationForDirectRequest(db, {
          accountId: ids.accountId,
          workspaceId: ids.workspaceId,
          sessionId: ids.sessionId,
          requestId: ids.directRequest.requestId,
          holderId: ids.directRequest.holderId,
          sandboxGroupId: homeLease.sandboxGroupId,
          expectedEpoch: backend.leaseEpoch,
          expectedInstanceId: backend.providerInstanceId,
          routeTargetId: backend.sandboxId,
          routeEpoch: backend.activeEpoch,
          operation: op,
          captureWaitMs: sandboxArchiveCaptureTimeoutMs(settings),
        });
        return { admission, providerBinding };
      }
    : undefined;
  const afterMutation = homeLease
    ? async ({
        op,
        backend,
        admission,
        outcome,
        retainedProcess,
      }: {
        op: string;
        backend: ResolvedActiveBackend;
        admission: unknown;
        outcome: "resolved" | "rejected";
        result?: unknown;
        retainedProcess?: RoutingRetainedProcess;
      }): Promise<void> => {
        if (admission === null) return;
        if (
          !admission ||
          typeof admission !== "object" ||
          backend.leaseEpoch === undefined ||
          backend.providerInstanceId === undefined ||
          backend.activeEpoch === undefined
        ) {
          throw new Error("API-direct workspace mutation settlement lacked its exact admission");
        }
        const boundAdmission = admission as Partial<PersistableMutationAdmission>;
        const exactAdmission = boundAdmission.admission;
        if (
          !exactAdmission ||
          typeof exactAdmission.id !== "string" ||
          typeof exactAdmission.workspaceGeneration !== "number" ||
          !("providerBinding" in boundAdmission)
        ) {
          throw new Error("API-direct workspace mutation settlement lacked its bound admission");
        }
        if (outcome === "resolved" && retainedProcess) {
          await retainWorkspaceMutationProcess(db, {
            accountId: ids.accountId,
            workspaceId: ids.workspaceId,
            sessionId: ids.sessionId,
            processId: retainedProcess.id,
            providerSessionId: retainedProcess.providerSessionId,
            admissionId: exactAdmission.id,
            admittedWorkspaceGeneration: exactAdmission.workspaceGeneration,
            operation: op,
            providerBinding: boundAdmission.providerBinding ?? null,
            owner: {
              kind: "direct",
              requestId: ids.directRequest.requestId,
              holderId: ids.directRequest.holderId,
              sandboxGroupId: homeLease.sandboxGroupId,
              expectedEpoch: backend.leaseEpoch,
              expectedInstanceId: backend.providerInstanceId,
              routeTargetId: exactAdmission.routeTargetId,
              routeEpoch: exactAdmission.routeEpoch,
            },
          });
          return;
        }
        await verifyDirectWorkspaceMutationSettlement(db, {
          accountId: ids.accountId,
          workspaceId: ids.workspaceId,
          sessionId: ids.sessionId,
          requestId: ids.directRequest.requestId,
          holderId: ids.directRequest.holderId,
          sandboxGroupId: homeLease.sandboxGroupId,
          expectedEpoch: backend.leaseEpoch,
          expectedInstanceId: backend.providerInstanceId,
          routeTargetId: exactAdmission.routeTargetId,
          routeEpoch: exactAdmission.routeEpoch,
          admission: exactAdmission,
          operation: op,
          outcome,
        });
      }
    : undefined;
  const beforeProcessMutation = homeLease
    ? async ({
        op,
        process,
      }: {
        op: string;
        backend: ResolvedActiveBackend;
        process: RoutingRetainedProcess;
      }): Promise<SandboxWorkspaceMutationAdmission> =>
        await advanceWorkspaceGenerationForRetainedProcess(db, {
          accountId: ids.accountId,
          workspaceId: ids.workspaceId,
          sessionId: ids.sessionId,
          processId: process.id,
          operation: op,
          captureWaitMs: sandboxArchiveCaptureTimeoutMs(settings),
        })
    : undefined;
  const afterProcessMutation = homeLease
    ? async ({
        op,
        process,
        admission,
        outcome,
      }: {
        op: string;
        backend: ResolvedActiveBackend;
        process: RoutingRetainedProcess;
        admission: unknown;
        outcome: "resolved" | "rejected";
        result?: unknown;
      }): Promise<void> => {
        if (
          !admission ||
          typeof admission !== "object" ||
          typeof (admission as Partial<SandboxWorkspaceMutationAdmission>).id !== "string" ||
          typeof (admission as Partial<SandboxWorkspaceMutationAdmission>).workspaceGeneration !==
            "number"
        ) {
          throw new Error("API retained-process mutation settlement lacked its exact admission");
        }
        await verifyRetainedProcessMutationSettlement(db, {
          accountId: ids.accountId,
          workspaceId: ids.workspaceId,
          sessionId: ids.sessionId,
          processId: process.id,
          admission: admission as SandboxWorkspaceMutationAdmission,
          operation: op,
          outcome,
        });
      }
    : undefined;
  const settleProcess = homeLease
    ? async ({
        backend,
        process,
        proof,
      }: {
        backend: ResolvedActiveBackend;
        process: RoutingRetainedProcess;
        proof: RoutingRetainedProcessTerminalProof;
      }): Promise<void> => {
        if (
          backend.sandboxId !== null ||
          backend.leaseEpoch === undefined ||
          backend.providerInstanceId === undefined ||
          backend.activeEpoch === undefined
        ) {
          return;
        }
        const durable = await getRetainedProcess(db, {
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
          throw new Error(
            "API retained-process settlement lost its exact durable backend identity",
          );
        }
        await settleRetainedProcess(db, {
          accountId: ids.accountId,
          workspaceId: ids.workspaceId,
          sessionId: ids.sessionId,
          processId: process.id,
          expected: retainedProcessSettlementIdentity(durable),
          outcome: proof.outcome,
          exitCode: proof.exitCode,
          reason: proof.reason,
          idleGraceMs: settings.sandboxIdleGraceMs,
        });
      }
    : undefined;
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
    selfhostedTimeoutMs: settings.sandboxSelfhostedControlTimeoutMs,
    selfhostedExecTimeoutMs: settings.sandboxSelfhostedExecTimeoutMs,
    ...(ids.pinnedSelfhosted
      ? {
          pinnedSelfhosted: {
            sandboxId: ids.pinnedSelfhosted.sandboxId,
            epoch: ids.pinnedSelfhosted.epoch,
            session: established.session as RoutableBackendSession,
          },
        }
      : {}),
    ...(homeLease
      ? {
          resolveDefaultBackend: async () => ({
            session: established.session as RoutableBackendSession,
            sandboxId: null,
            kind: established.backendId,
            leaseEpoch: homeLease.leaseEpoch,
            providerInstanceId: homeLease.instanceId,
          }),
        }
      : {}),
  });

  const proxy = new RoutingSandboxSession({
    defaultResolved: {
      session: established.session as RoutableBackendSession,
      sandboxId: null,
      kind: established.backendId,
      ...(homeLease
        ? {
            leaseEpoch: homeLease.leaseEpoch,
            providerInstanceId: homeLease.instanceId,
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
    ...(homeLease
      ? {
          onDefaultBackendError: async ({ error }: { error: unknown }) => {
            if (!isProviderSandboxGoneDuringRoutedOperation(homeLease.backend, error)) return null;
            const marked = await markWarmLeaseInstanceLost(db, {
              accountId: ids.accountId,
              workspaceId: ids.workspaceId,
              sandboxGroupId: homeLease.sandboxGroupId,
              expectedEpoch: homeLease.leaseEpoch,
              expectedInstanceId: homeLease.instanceId,
              diagnostic: "provider_not_found_during_routed_operation",
            });
            if (marked.status === "marked" && bus) {
              await appendAndPublishEvents(db, bus, ids.workspaceId, ids.sessionId, [
                {
                  type: "sandbox.box.lost",
                  payload: { sandboxId: homeLease.instanceId },
                },
              ]).catch(() => undefined);
            }
            const lease = marked.lease;
            const restore = lease?.recovery.restore.status;
            return {
              leaseEpoch: lease?.leaseEpoch ?? homeLease.leaseEpoch,
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
