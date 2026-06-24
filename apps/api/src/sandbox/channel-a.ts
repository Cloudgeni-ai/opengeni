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

import { stableSandboxEnvironmentForRun, type Settings } from "@opengeni/config";
import type { Session } from "@opengeni/contracts";
import {
  acquireLease,
  commitWarmingToWarm,
  failWarmingToCold,
  getSandboxSessionEnvelope,
  loadWorkspaceEnvironmentForRun,
  readLease,
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
} from "@opengeni/runtime/sandbox";

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
  const { accountId, workspaceId, session, subjectId } = ctx;

  if (session.sandboxBackend === "none") {
    throw new HTTPException(409, { message: "sandbox not available" });
  }

  const sandboxGroupId = session.sandboxGroupId;
  const viewerId = crypto.randomUUID();
  const leaseTtlMs = settings.sandboxLeaseTtlMs;

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
  });

  if (acquired.role === "fenced") {
    await release();
    throw new HTTPException(409, { message: `sandbox lease superseded (epoch ${acquired.lease.leaseEpoch}); retry` });
  }

  let established: EstablishedSandboxSession | undefined;
  let leaseSnapshot: LeaseSnapshot = acquired.lease;

  try {
    const envelope = await getSandboxSessionEnvelope(db, workspaceId, session.id);
    // The STABLE run-environment a COLD box must be created with so a later worker
    // turn's agent-manifest apply finds an EMPTY env delta (config base + git
    // identity + decrypted workspace env + HOME). Mirrors the worker turn's stable
    // subset; omits the per-run rotating GitHub token (no repo resources here).
    const workspaceEnvironment = await loadWorkspaceEnvironmentForRun(db, settings, workspaceId, session.environmentId);
    const environment = stableSandboxEnvironmentForRun(settings, workspaceEnvironment?.values ?? {});

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
      try {
        established = await establishSandboxSessionFromEnvelope(settings, spawnEnvelope, {
          sessionId: session.id,
          backendOverride: session.sandboxBackend,
          environment,
        });
      } catch (error) {
        await failWarmingToCold(db, { accountId, workspaceId, sandboxGroupId, expectedEpoch });
        throw new HTTPException(409, { message: `sandbox not available (${error instanceof Error ? error.message : "spawn failed"})` });
      }
      // Persist the LIVE box as the lease's resume_state so the NEXT op resumes
      // this box by id rather than cold-creating a rival (the box-churn the
      // prove-it surfaced). Fall back to the session envelope when serialize is
      // unavailable.
      const resumeEnvelope = (await serializeEstablishedSandboxEnvelope(established)) ?? envelope ?? null;
      const committed = await commitWarmingToWarm(db, {
        accountId,
        workspaceId,
        sandboxGroupId,
        expectedEpoch,
        instanceId: established.instanceId,
        dataPlaneUrl: acquired.lease.dataPlaneUrl,
        resumeBackendId: established.backendId,
        resumeState: resumeEnvelope,
        leaseTtlMs,
      });
      if (!committed.committed || !committed.lease) {
        throw new HTTPException(409, { message: `sandbox lease superseded (epoch ${expectedEpoch}); retry` });
      }
      leaseSnapshot = committed.lease;
    } else {
      // ATTACHED / REARMED: the box is live. Read the lease to get the
      // authoritative resume_state, then resume by id for this op.
      const live = await readLease(db, workspaceId, sandboxGroupId);
      if (live) leaseSnapshot = live;
      const resumeEnvelope = leaseSnapshot.resumeState ?? envelope;
      established = await establishSandboxSessionFromEnvelope(settings, resumeEnvelope, {
        sessionId: session.id,
        backendOverride: session.sandboxBackend,
        environment,
      });
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

    const service = new SandboxChannelAService({
      session: established.session as ChannelASession,
      leaseEpoch: leaseSnapshot.leaseEpoch,
      emit,
    });

    return await fn({ service, lease: leaseSnapshot });
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
  if (error instanceof ChannelAValidationError) return new HTTPException(400, { message: error.message });
  if (error instanceof ChannelANotFoundError) return new HTTPException(404, { message: error.message });
  if (error instanceof ChannelAConflictError) return new HTTPException(409, { message: error.message });
  if (error instanceof ChannelAUnsupportedError) return new HTTPException(409, { message: error.message });
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
async function dropEstablishedHandle(established: EstablishedSandboxSession | undefined): Promise<void> {
  // No-op beyond dropping the reference: the lease owns lifecycle, the reaper
  // owns teardown. Never session.close()/terminate() a non-owned handle here.
  void established;
}
