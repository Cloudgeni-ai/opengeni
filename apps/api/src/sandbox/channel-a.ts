// apps/api/src/sandbox/channel-a.ts — the API-DIRECT Channel-A seam (P4.4).
//
// The structured services (FileSystem / Git / Terminal) are SYNCHRONOUS point
// queries served client -> API -> box IN-PROCESS. Each call:
//
//   1. acquires a viewer-kind lease holder (warming the box when cold — the
//      same cold->warming CAS attachViewer runs; a Postgres txn the API OWNS),
//   2. resumes the box BY ID from the group lease's resume_state envelope,
//   3. builds ONE SandboxChannelAService around the live `session` handle,
//   4. runs the op (fsList/gitDiff/ptyWrite/...), returns inline JSON,
//   5. releases the viewer holder + drops the live handle.
//
// NO Temporal, NO worker RPC, NO NATS round-trip in this path — reads never ride
// the bus (which would corrupt SSE gap-fill). Only the side-effect NOTIFICATIONS
// (fs.changed/git.changed/terminal.pty.*) ride A1 via appendAndPublishEvents.
//
// IMPORT DISCIPLINE: sandbox symbols come ONLY from @opengeni/runtime/sandbox
// (the agent-loop-free leaf) — enforced by sandbox-access-import-guard.test.ts.

import {
  applyGitAuthPointerEnvironment,
  hasGitCredentialRepositorySelection,
  hasGitHubRepositorySelection,
  stableSandboxEnvironmentForRun,
  type Settings,
} from "@opengeni/config";
import { githubAppBotIdentity } from "@opengeni/github";
import type { Session } from "@opengeni/contracts";
import {
  acquireLease,
  commitWarmingToWarm,
  failWarmingToCold,
  getSandbox,
  getSandboxSessionEnvelope,
  loadWorkspaceEnvironmentForRun,
  readLease,
  recordWarmingSandboxCreated,
  releaseLeaseHolder,
  SandboxLeaseSupersededError,
  type Database,
  type LeaseSnapshot,
} from "@opengeni/db";
import { appendAndPublishEvents, type EventBus } from "@opengeni/events";
import { HTTPException } from "hono/http-exception";

import {
  establishSandboxSessionFromEnvelope,
  serializeEstablishedSandboxEnvelope,
  SandboxChannelAService,
  ChannelAConflictError,
  ChannelANotFoundError,
  ChannelAUnsupportedError,
  ChannelAValidationError,
  type ChannelASession,
  type EstablishedSandboxSession,
  tagModalSandbox,
} from "@opengeni/runtime/sandbox";
import {
  establishNamedModalTarget,
  establishWarmLeaseSandbox,
  routingEnabled,
  terminateExactCreatedSandbox,
  wrapChannelABoxWithRouting,
} from "@opengeni/core";

export type ChannelAServices = {
  db: Database;
  settings: Settings;
  bus: EventBus;
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
  lease: LeaseSnapshot;
};

async function channelAEnvironment(
  db: Database,
  settings: Settings,
  workspaceId: string,
  session: Session,
): Promise<Record<string, string>> {
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
  return environment;
}

function syntheticActiveLease(session: Session, sandboxGroupId: string): LeaseSnapshot {
  return {
    id: `active:${sandboxGroupId}`,
    sandboxGroupId,
    liveness: "warm",
    refcount: 1,
    turnHolders: 0,
    viewerHolders: 0,
    instanceId: sandboxGroupId,
    backend: "selfhosted",
    os: session.sandboxOs,
    image: null,
    rigVersionId: null,
    dataPlaneUrl: null,
    terminalDataPlaneUrl: null,
    leaseEpoch: session.activeEpoch,
    resumeBackendId: "selfhosted",
    resumeState: null,
    expiresAt: new Date(0),
  };
}

/**
 * Run a Channel-A op against a live box, API-direct. Acquires a viewer holder
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
  const { accountId, workspaceId, session } = ctx;

  if (session.sandboxBackend === "none") {
    throw new HTTPException(409, { message: "sandbox not available" });
  }

  const sandboxGroupId = session.sandboxGroupId;
  const viewerId = crypto.randomUUID();
  const leaseTtlMs = settings.sandboxLeaseTtlMs;

  // A non-home active target is established/addressed directly. Do this BEFORE
  // touching the home lease: otherwise a Channel-A read against a named Modal or
  // Connected Machine would cold-create an unused rival home box first.
  if (routingEnabled(settings) && session.activeSandboxId) {
    const active = await getSandbox(db, workspaceId, session.activeSandboxId);
    if (!active) {
      // The caller selected a non-home target. A stale/deleted target is a
      // routing conflict, never permission to provision or mutate the home box.
      throw new HTTPException(409, {
        message: "the active sandbox target no longer exists; re-read the session route",
      });
    }
    {
      const environment = await channelAEnvironment(db, settings, workspaceId, session);
      const namedTargets = new Map<
        string,
        Promise<Awaited<ReturnType<typeof establishNamedModalTarget>>>
      >();
      const namedModalTarget = async (
        sandbox: { id: string },
        pointer: { activeEpoch: number },
      ) => {
        const cacheKey = `${sandbox.id}:${pointer.activeEpoch}`;
        let pending = namedTargets.get(cacheKey);
        if (!pending) {
          pending = establishNamedModalTarget({
            db,
            settings,
            accountId,
            workspaceId,
            sandboxId: sandbox.id,
            holderKind: "viewer",
            holderId: viewerId,
            subjectId: session.id,
            environment,
            ...((settings.modalImageRef ?? settings.dockerImage)
              ? { image: settings.modalImageRef ?? settings.dockerImage }
              : {}),
          });
          namedTargets.set(cacheKey, pending);
        }
        return await pending;
      };
      const establishModalTarget = async (
        sandbox: { id: string },
        pointer: { activeEpoch: number },
      ) => (await namedModalTarget(sandbox, pointer)).established.session as never;
      let primary: EstablishedSandboxSession;
      let lease: LeaseSnapshot;
      if (active.kind === "modal") {
        const target = await namedModalTarget(active, { activeEpoch: session.activeEpoch });
        primary = target.established;
        lease = target.lease;
      } else {
        // The resolver builds the real SelfhostedSession from the active pointer.
        // This placeholder is never dispatched to while that pointer remains
        // active; it exists only to satisfy the stable proxy's synchronous state
        // surface without provisioning a provider box.
        primary = {
          client: {} as EstablishedSandboxSession["client"],
          session: { state: {} },
          sessionState: undefined,
          instanceId: active.enrollmentId ?? active.id,
          backendId: "selfhosted",
        };
        lease = syntheticActiveLease(session, active.id);
      }
      const emit = async (events: { type: string; payload: unknown }[]): Promise<void> => {
        await appendAndPublishEvents(
          db,
          bus,
          workspaceId,
          session.id,
          events.map((event) => ({ type: event.type as never, payload: event.payload })),
        );
      };
      const routed = wrapChannelABoxWithRouting(
        { db, settings, bus },
        {
          workspaceId,
          sessionId: session.id,
          establishModalTarget,
          defaultIsHome: false,
        },
        primary,
      );
      const service = new SandboxChannelAService({
        session: routed.session as ChannelASession,
        leaseEpoch: lease.leaseEpoch,
        emit,
      });
      try {
        return await fn({ service, lease });
      } catch (error) {
        throw mapChannelAError(error);
      } finally {
        for (const pending of namedTargets.values()) {
          const target = await pending.catch(() => null);
          await target?.release().catch(() => undefined);
        }
      }
    }
  }

  const release = async (): Promise<void> => {
    await releaseLeaseHolder(db, {
      accountId,
      workspaceId,
      sandboxGroupId,
      kind: "viewer",
      holderId: viewerId,
      idleGraceMs: settings.sandboxIdleGraceMs,
    });
  };

  // Acquire a viewer holder; the cold->warming CAS spawns the box when cold.
  const acquired = await acquireLease(db, {
    accountId,
    workspaceId,
    sandboxGroupId,
    kind: "viewer",
    holderId: viewerId,
    subjectId: session.id,
    backend: session.sandboxBackend,
    os: session.sandboxOs,
    leaseTtlMs,
    warmingLeaseTtlMs: settings.sandboxWarmingTimeoutMs,
  });

  if (acquired.role === "fenced") {
    await release();
    throw new HTTPException(409, {
      message: `sandbox lease superseded (epoch ${acquired.lease.leaseEpoch}); retry`,
    });
  }

  let established: EstablishedSandboxSession | undefined;
  let leaseSnapshot: LeaseSnapshot = acquired.lease;
  const namedModalTargets = new Map<
    string,
    Promise<Awaited<ReturnType<typeof establishNamedModalTarget>>>
  >();

  try {
    const envelope = await getSandboxSessionEnvelope(db, workspaceId, session.id);
    // The STABLE run-environment a COLD box must be created with so a later worker
    // turn's agent-manifest apply finds an EMPTY env delta (config base + git
    // identity + decrypted workspace env + HOME + — for a repo-attached session —
    // the stable git-auth pointers the turn declares). Only the rotating token
    // VALUE stays off (it lives in the box file the clone hook seeds). Keyed off
    // the SESSION's backend (the establish below passes backendOverride:
    // session.sandboxBackend, and HOME/token-file/askpass are backend-derived),
    // NOT the deployment default — mirrors sessionAttachEnvironment.
    const environment = await channelAEnvironment(db, settings, workspaceId, session);

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
      const spawnEnvelope = acquired.lease.resumeState ?? envelope;
      let created: EstablishedSandboxSession | undefined;
      let checkpointedInstanceId: string | null = null;
      try {
        established = await establishSandboxSessionFromEnvelope(settings, spawnEnvelope, {
          sessionId: session.id,
          backendOverride: session.sandboxBackend,
          environment,
          createPolicy: "lease_owner",
          onSandboxCreated: async (next) => {
            created = next;
            const checkpoint = await recordWarmingSandboxCreated(db, {
              accountId,
              workspaceId,
              sandboxGroupId,
              expectedEpoch,
              expectedPriorInstanceId: checkpointedInstanceId,
              instanceId: next.instanceId,
              resumeBackendId: next.backendId,
              resumeState: (await serializeEstablishedSandboxEnvelope(next)) ?? spawnEnvelope,
              leaseTtlMs,
              warmingLeaseTtlMs: settings.sandboxWarmingTimeoutMs,
            });
            if (!checkpoint.recorded) {
              throw new SandboxLeaseSupersededError(sandboxGroupId, expectedEpoch);
            }
            checkpointedInstanceId = next.instanceId;
            if (next.backendId === "modal") {
              await tagModalSandbox(settings, next.instanceId, {
                leaseId: acquired.lease.id,
                workspaceId,
                sandboxGroupId,
              }).catch(() => undefined);
            }
          },
        });
      } catch {
        const terminated = await terminateExactCreatedSandbox(created);
        if (terminated) {
          await failWarmingToCold(db, {
            accountId,
            workspaceId,
            sandboxGroupId,
            expectedEpoch,
            expectedInstanceId: checkpointedInstanceId,
          });
        }
        throw new HTTPException(409, {
          message: "sandbox not available; re-read the lease and retry",
        });
      }
      // Persist the LIVE box as the lease's resume_state so the NEXT op resumes
      // this box by id rather than cold-creating a rival (the box-churn the
      // prove-it surfaced). Fall back to the session envelope when serialize is
      // unavailable.
      const resumeEnvelope =
        (await serializeEstablishedSandboxEnvelope(established)) ?? envelope ?? null;
      const committed = await commitWarmingToWarm(db, {
        accountId,
        workspaceId,
        sandboxGroupId,
        expectedEpoch,
        expectedWarmingInstanceId: established.instanceId,
        instanceId: established.instanceId,
        dataPlaneUrl: acquired.lease.dataPlaneUrl,
        resumeBackendId: established.backendId,
        resumeState: resumeEnvelope,
        leaseTtlMs,
        // A nonzero epoch means this cold spawn rematerialized an already-used
        // logical home target. Invalidate null/home routing caches atomically
        // with the lease epoch bump; first materialization has no stale cache.
        ...(expectedEpoch > 0 ? { advanceActiveRoute: { targetSandboxId: null } } : {}),
      });
      if (!committed.committed || !committed.lease) {
        const terminated = await terminateExactCreatedSandbox(established);
        if (terminated) {
          await failWarmingToCold(db, {
            accountId,
            workspaceId,
            sandboxGroupId,
            expectedEpoch,
            expectedInstanceId: established.instanceId,
          }).catch(() => undefined);
        }
        throw new HTTPException(409, {
          message: `sandbox lease superseded (epoch ${expectedEpoch}); retry`,
        });
      }
      leaseSnapshot = committed.lease;
    } else {
      // ATTACHED / REARMED: the box is live. Read the lease to get the
      // authoritative resume_state, then resume by id for this op.
      const live = await readLease(db, workspaceId, sandboxGroupId);
      if (!live) {
        throw new SandboxLeaseSupersededError(sandboxGroupId, leaseSnapshot.leaseEpoch);
      }
      leaseSnapshot = live;
      const resumeEnvelope = leaseSnapshot.resumeState ?? envelope;
      const resumed = await establishWarmLeaseSandbox({
        db,
        settings,
        accountId,
        workspaceId,
        sandboxGroupId,
        lifecycleSessionId: session.id,
        backend: session.sandboxBackend,
        environment,
        initialLease: leaseSnapshot,
        fallbackEnvelope: resumeEnvelope,
        route: { targetSandboxId: null },
      });
      established = resumed.established;
      leaseSnapshot = resumed.lease;
    }

    const emit = async (events: { type: string; payload: unknown }[]): Promise<void> => {
      await appendAndPublishEvents(
        db,
        bus,
        workspaceId,
        session.id,
        // SessionEventType is a string enum at the contract; the producer parses
        // the payload, so this cast is the same shape the worker emits.
        events.map((e) => ({ type: e.type as never, payload: e.payload })),
      );
    };

    // M7 hot-swap: when the selfhosted feature is on, route the Channel-A op to
    // the session's currently-active sandbox (not always the group box). The
    // proxy re-reads (active_sandbox_id, active_epoch) on each session method the
    // service calls and dispatches to the active backend (the group box by
    // default, or a swapped-to selfhosted machine). With the flag off the
    // established group session is used unchanged.
    const routedSession = routingEnabled(settings)
      ? wrapChannelABoxWithRouting(
          { db, settings, bus },
          {
            workspaceId,
            sessionId: session.id,
            establishModalTarget: async (sandbox, pointer) => {
              const cacheKey = `${sandbox.id}:${pointer.activeEpoch}`;
              let pending = namedModalTargets.get(cacheKey);
              if (!pending) {
                pending = establishNamedModalTarget({
                  db,
                  settings,
                  accountId,
                  workspaceId,
                  sandboxId: sandbox.id,
                  holderKind: "viewer",
                  holderId: viewerId,
                  subjectId: session.id,
                  environment,
                  ...((settings.modalImageRef ?? settings.dockerImage)
                    ? { image: settings.modalImageRef ?? settings.dockerImage }
                    : {}),
                });
                namedModalTargets.set(cacheKey, pending);
              }
              return (await pending).established.session as never;
            },
          },
          established,
        ).session
      : established.session;

    const service = new SandboxChannelAService({
      session: routedSession as ChannelASession,
      leaseEpoch: leaseSnapshot.leaseEpoch,
      emit,
    });

    return await fn({ service, lease: leaseSnapshot });
  } catch (error) {
    throw mapChannelAError(error);
  } finally {
    for (const pending of namedModalTargets.values()) {
      const target = await pending.catch(() => null);
      await target?.release().catch(() => undefined);
    }
    await release();
    await dropEstablishedHandle(established);
  }
}

/** Map the service's typed errors to HTTP status (the §5.3 matrix). Re-throws an
 *  already-HTTPException unchanged. */
export function mapChannelAError(error: unknown): unknown {
  if (error instanceof HTTPException) return error;
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
