// apps/api/src/sandbox/channel-a.ts — the API-DIRECT Channel-A seam (P4.4).
//
// The structured services (FileSystem / Git / Terminal) are SYNCHRONOUS point
// queries served client -> API -> box IN-PROCESS. Each call:
//
// For a provider-backed home it acquires an exact direct-request lease holder,
// resumes the box by id, and releases the holder after the operation. For a
// Connected Machine home it follows the durable active pointer directly and
// uses its NATS request/reply control channel; it creates no phantom cloud lease.
// Both paths build one SandboxChannelAService, run the operation, and return the
// result inline.
//
// NO Temporal or worker RPC sits in this path. Provider-backed reads remain
// process-local; Connected Machine operations necessarily ride NATS. Side-effect
// notifications (fs.changed/git.changed/terminal.pty.*) ride A1.
//
// IMPORT DISCIPLINE: sandbox symbols come ONLY from @opengeni/runtime/sandbox
// (the agent-loop-free leaf) — enforced by sandbox-access-import-guard.test.ts.

import {
  applyGitAuthPointerEnvironment,
  hasGitCredentialRepositorySelection,
  hasGitHubRepositorySelection,
  sandboxArchiveCaptureTimeoutMs,
  stableSandboxEnvironmentForRun,
  type Settings,
} from "@opengeni/config";
import { githubAppBotIdentity } from "@opengeni/github";
import type { Session } from "@opengeni/contracts";
import {
  acquireLease,
  getSandboxSessionEnvelope,
  getSandbox,
  loadWorkspaceEnvironmentForRun,
  markWarmLeaseInstanceLost,
  readActiveSandbox,
  readLease,
  releaseLeaseHolder,
  type Database,
  type LeaseSnapshot,
} from "@opengeni/db";
import { appendAndPublishEvents, type EventBus } from "@opengeni/events";
import { sandboxOperationMetricObserver, type Observability } from "@opengeni/observability";
import { HTTPException } from "hono/http-exception";

import {
  buildSelfhostedBackendSession,
  establishSandboxSessionFromEnvelope,
  isProviderSandboxNotFoundError,
  SandboxChannelAService,
  NatsControlRpc,
  ChannelAConflictError,
  ChannelANotFoundError,
  ChannelAUnsupportedError,
  ChannelAUnavailableError,
  ChannelAValidationError,
  toolspaceTokenFileFromEnvironment,
  withToolspaceTokenSession,
  withRunCredentialsSession,
  type ChannelASession,
  type EstablishedSandboxSession,
  type RoutingSandboxSession,
} from "@opengeni/runtime/sandbox";
import { relayConfigFromSettings, wrapChannelABoxWithRouting } from "@opengeni/core";
import { establishApiSandboxSpawner } from "./rematerialize";

export type ChannelAServices = {
  db: Database;
  settings: Settings;
  bus: EventBus;
  observability?: Observability | undefined;
};

export type ChannelAContext = {
  accountId: string;
  workspaceId: string;
  session: Session;
  // The principal that drives the op (for emit attribution + pty opened_by).
  subjectId: string;
};

// The live op surface handed to a route's callback: the service + the live lease
// (for the pty exec-session epoch fence + revision seeding).
export type ChannelAHandle = {
  service: SandboxChannelAService;
  /** Connected Machine homes deliberately have no cloud lease. Durable PTYs
   * require a real home-provider lease and reject this null case. */
  lease: LeaseSnapshot | null;
  routingSession: RoutingSandboxSession;
  requestId: string;
};

/**
 * Run a Channel-A op against a live box, API-direct. Acquires an exact direct holder
 * (warming the box when cold), resumes by id, builds the service, runs `fn`, and
 * ALWAYS releases the holder + drops the handle in `finally`. Maps the service's
 * typed errors to HTTP status (the route never sees a raw ChannelA*Error).
 *
 * Gated behind sandboxOwnershipEnabled at the route (the lease is dormant
 * otherwise). A `backend:none` session has no box -> 409 before touching it.
 */
export async function withChannelA<T>(
  services: ChannelAServices,
  ctx: ChannelAContext,
  fn: (handle: ChannelAHandle) => Promise<T>,
): Promise<T> {
  const { db, settings, bus } = services;
  const onSandboxOperation = services.observability
    ? sandboxOperationMetricObserver(services.observability)
    : undefined;
  const { accountId, workspaceId, session } = ctx;

  if (session.sandboxBackend === "none") {
    throw new HTTPException(409, { message: "sandbox not available" });
  }

  const sandboxGroupId = session.sandboxGroupId;
  const requestId = crypto.randomUUID();
  const holderId = `direct:${requestId}`;
  const leaseTtlMs = settings.sandboxLeaseTtlMs;

  // The STABLE run-environment used by both a cloud home and a machine home.
  // It also carries the per-session Toolspace pointer selected below.
  const workspaceEnvironment = await loadWorkspaceEnvironmentForRun(
    db,
    settings,
    workspaceId,
    session.environmentId,
  );
  const settingsForSession =
    session.sandboxBackend !== settings.sandboxBackend
      ? { ...settings, sandboxBackend: session.sandboxBackend }
      : settings;
  const environment = stableSandboxEnvironmentForRun(
    settingsForSession,
    workspaceEnvironment?.values ?? {},
    { workspaceId },
  );
  if (hasGitCredentialRepositorySelection(session.resources)) {
    applyGitAuthPointerEnvironment(
      environment,
      hasGitHubRepositorySelection(session.resources) ? githubAppBotIdentity(settings) : null,
    );
  }

  const runEstablished = async (
    routed: EstablishedSandboxSession,
    lease: LeaseSnapshot | null,
  ): Promise<T> => {
    const emit = async (events: { type: string; payload: unknown }[]): Promise<void> => {
      await appendAndPublishEvents(
        db,
        bus,
        workspaceId,
        session.id,
        events.map((e) => ({ type: e.type as never, payload: e.payload })),
      );
    };
    const routingSession = routed.session as RoutingSandboxSession;
    const credentialSession = withRunCredentialsSession(routingSession as object, session.id);
    const scopedSession = environment.OPENGENI_TOOLSPACE_TOKEN_FILE
      ? withToolspaceTokenSession(
          credentialSession,
          toolspaceTokenFileFromEnvironment(environment, session.id),
        )
      : credentialSession;
    const service = new SandboxChannelAService({
      session: scopedSession as ChannelASession,
      leaseEpoch: lease?.leaseEpoch ?? session.activeEpoch,
      emit,
    });
    return await fn({ service, lease, routingSession, requestId });
  };

  // A machine-targeted top-level session has an honest selfhosted HOME label.
  // It has no cloud provider box and therefore must not acquire or establish a
  // phantom home lease before following its active machine pointer.
  if (session.sandboxBackend === "selfhosted") {
    let established: EstablishedSandboxSession | undefined;
    try {
      const pointer = await readActiveSandbox(db, workspaceId, session.id);
      if (!pointer?.activeSandboxId) {
        throw new HTTPException(409, {
          message: "machine-home session has no active Connected Machine",
        });
      }
      const sandbox = await getSandbox(db, workspaceId, pointer.activeSandboxId);
      if (sandbox?.kind !== "selfhosted" || !sandbox.enrollmentId) {
        throw new HTTPException(409, {
          message: "machine-home session points to an unavailable Connected Machine",
        });
      }
      const built = await buildSelfhostedBackendSession({
        workspaceId,
        agentId: sandbox.enrollmentId,
        relay: relayConfigFromSettings(settings),
        controlRpcFactory: () => new NatsControlRpc(async () => bus.getRequestConnection()),
        epoch: pointer.activeEpoch,
        environment,
        workingDir: pointer.workingDir,
        timeoutMs: settings.sandboxSelfhostedControlTimeoutMs,
        execTimeoutMs: settings.sandboxSelfhostedExecTimeoutMs,
      });
      established = {
        client: built.client,
        session: built.session,
        sessionState: { agentId: sandbox.enrollmentId },
        instanceId: sandbox.enrollmentId,
        backendId: "selfhosted",
      };
      const routed = wrapChannelABoxWithRouting(
        { db, settings, bus, ...(onSandboxOperation ? { onSandboxOperation } : {}) },
        {
          accountId,
          workspaceId,
          sessionId: session.id,
          pinnedSelfhosted: {
            sandboxId: sandbox.id,
            epoch: pointer.activeEpoch,
          },
          directRequest: { requestId, holderId },
        },
        established,
      );
      return await runEstablished(routed, null);
    } catch (error) {
      throw mapChannelAError(error);
    } finally {
      await dropEstablishedHandle(established);
    }
  }

  const release = async (): Promise<void> => {
    await releaseLeaseHolder(db, {
      accountId,
      workspaceId,
      sandboxGroupId,
      kind: "direct",
      holderId,
      idleGraceMs: settings.sandboxIdleGraceMs,
    });
  };

  // Acquire exact request authority; the cold->warming CAS spawns the box when cold.
  const acquired = await acquireLease(db, {
    accountId,
    workspaceId,
    sandboxGroupId,
    kind: "direct",
    holderId,
    subjectId: session.id,
    backend: session.sandboxBackend,
    os: session.sandboxOs,
    leaseTtlMs,
    warmingLeaseTtlMs: settings.sandboxWarmingTimeoutMs,
    captureWaitMs: sandboxArchiveCaptureTimeoutMs(settings),
  });

  if (acquired.role === "blocked") {
    await release();
    throw new HTTPException(409, {
      message: `sandbox recovery ${acquired.lease.recovery.restore.status} at epoch ${acquired.lease.leaseEpoch}`,
    });
  }
  if (acquired.role === "fenced") {
    await release();
    throw new HTTPException(409, {
      message: `sandbox lease superseded (epoch ${acquired.lease.leaseEpoch}); retry`,
    });
  }

  let established: EstablishedSandboxSession | undefined;
  let leaseSnapshot: LeaseSnapshot = acquired.lease;

  try {
    const envelope = await getSandboxSessionEnvelope(db, workspaceId, session.id);
    if (acquired.role === "spawner") {
      // We won the cold->warming CAS: establish the box from the envelope, then
      // commit warm. The established handle IS our live handle for the op.
      const expectedEpoch = acquired.lease.leaseEpoch;
      // Prefer the COLD lease's preserved resume_state when it carries a persisted
      // /workspace snapshot (confirmDrainCold keeps a minimal archive-only envelope
      // across draining->cold for exactly this re-warm). establishSandboxSessionFromEnvelope
      // cold-creates a fresh box and replays the archive via hydrateWorkspace, so
      // /workspace survives the box churn (sandbox-file-persistence). No archive ->
      // the bare session envelope (a never-warmed cold start). The order matters:
      // resume_state is the lease's authoritative box descriptor; the session
      // `_sandbox` envelope is only the per-session fallback.
      try {
        const result = await establishApiSandboxSpawner({
          db,
          settings,
          accountId,
          workspaceId,
          sandboxGroupId,
          sessionId: session.id,
          backend: session.sandboxBackend,
          environment,
          expectedEpoch,
          acquiredLease: acquired.lease,
          fallbackEnvelope: envelope,
          dataPlaneUrl: acquired.lease.dataPlaneUrl,
        });
        established = result.established;
        leaseSnapshot = result.lease;
      } catch (error) {
        throw new HTTPException(409, {
          message: `sandbox not available (${error instanceof Error ? error.message : "spawn failed"})`,
        });
      }
    } else {
      // ATTACHED / REARMED: the box is live. Read the lease to get the
      // authoritative resume_state, then resume by id for this op.
      const live = await readLease(db, workspaceId, sandboxGroupId);
      if (
        !live ||
        live.liveness !== "warm" ||
        live.leaseEpoch !== acquired.lease.leaseEpoch ||
        live.instanceId === null
      ) {
        throw new HTTPException(409, {
          message: `sandbox lease is not attachable; retry`,
        });
      }
      leaseSnapshot = live;
      try {
        established = await establishSandboxSessionFromEnvelope(settings, live.resumeState, {
          sessionId: session.id,
          recovery: "resume-only",
          backendOverride: session.sandboxBackend,
          environment,
        });
      } catch (error) {
        if (!isProviderSandboxNotFoundError(session.sandboxBackend, error)) {
          throw error;
        }
        const marked = await markWarmLeaseInstanceLost(db, {
          accountId,
          workspaceId,
          sandboxGroupId,
          expectedEpoch: live.leaseEpoch,
          expectedInstanceId: live.instanceId,
        });
        if (marked.status === "marked") {
          await appendAndPublishEvents(db, bus, workspaceId, session.id, [
            {
              type: "sandbox.box.lost",
              payload: { sandboxId: live.instanceId },
            },
          ]);
        }
        throw new HTTPException(409, {
          message: `sandbox instance was lost; retry to restore it`,
        });
      }
    }

    // Route every call through the same proxy, even when hot-swap is disabled:
    // routing may be dormant, but its direct mutation admission is mandatory for
    // every persistable provider write.
    const routed = wrapChannelABoxWithRouting(
      { db, settings, bus, ...(onSandboxOperation ? { onSandboxOperation } : {}) },
      {
        accountId,
        workspaceId,
        sessionId: session.id,
        homeLease: {
          sandboxGroupId,
          leaseEpoch: leaseSnapshot.leaseEpoch,
          instanceId: leaseSnapshot.instanceId!,
          backend: session.sandboxBackend,
        },
        directRequest: { requestId, holderId },
      },
      established,
    );
    return await runEstablished(routed, leaseSnapshot);
  } catch (error) {
    throw mapChannelAError(error);
  } finally {
    await release();
    await dropEstablishedHandle(established);
  }
}

/** Map the service's typed errors to HTTP status (the §5.3 matrix). Re-throws an
 *  already-HTTPException unchanged. */
export function mapChannelAError(error: unknown): unknown {
  if (error instanceof HTTPException) return error;
  if (error instanceof ChannelAUnavailableError)
    return new HTTPException(503, { message: error.message });
  if (error instanceof ChannelAValidationError)
    return new HTTPException(400, { message: error.message });
  if (error instanceof ChannelANotFoundError)
    return new HTTPException(404, { message: error.message });
  if (error instanceof ChannelAConflictError)
    return new HTTPException(409, { message: error.message });
  if (error instanceof ChannelAUnsupportedError)
    return new HTTPException(409, { message: error.message });
  return error;
}

// Drop a transiently-established, NON-OWNED handle WITHOUT terminating the box.
// The box is owned by the LEASE (resumed by id); this handle is incidental.
//
// CRITICAL (deployed-integration bug, prove-it D2): a provider session's
// `close()` is NOT a neutral local-resource free — Modal's session.close() calls
// sandbox.terminate(), KILLING THE BOX. Calling it after each Channel-A op
// destroyed the box mid-flight, so a subsequent fs.read/git/exec hit a different
// (cold-restored) box and 404'd. We DO NOT close the session; only the reaper
// (provider stop at refcount 0) terminates a box.
async function dropEstablishedHandle(
  established: EstablishedSandboxSession | undefined,
): Promise<void> {
  // No-op beyond dropping the reference: the lease owns lifecycle, the reaper
  // owns teardown. Never session.close()/terminate() a non-owned handle here.
  void established;
}
