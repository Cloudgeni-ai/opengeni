// apps/api/src/sandbox/viewer.ts — the API-DIRECT viewer-holder lifecycle (P1.4).
//
// A viewer (a human watching a session's box) acquires a `viewer` holder on the
// GROUP lease so the box stays warm WHILE WATCHED — liveness = turn OR viewer
// (the §C group-refcount win). All IN-PROCESS: the API runs the cold->warming
// CAS as a Postgres txn it owns, resumes the box BY ID via the leaf
// (@opengeni/runtime/sandbox), and never signals Temporal or a worker.
//
//   attach  -> acquireLease(kind:'viewer') under FOR UPDATE + cold->warming CAS.
//              spawner role  -> establish the box in-process + commitWarmingToWarm.
//              attached/rearmed -> the holder alone keeps the box warm.
//              fenced -> release + surface a 409 (a newer epoch re-established it).
//   heartbeat -> heartbeatLeaseHolder (epoch-fenced) refreshes the holder TTL.
//   detach  -> releaseLeaseHolder (idempotent); the reaper (P1.3) stop()s the
//              box at refcount 0 past the drain grace.
//
// The desktop pixel tunnel-URL mint + the un-redacted acknowledgment + the
// scoped token are P3/P4. Here we surface only the holder lifecycle + the
// lease's recorded data_plane_url (null until P4 mints it).

import type { Settings } from "@opengeni/config";
import type { Session } from "@opengeni/contracts";
import {
  acquireLease,
  commitWarmingToWarm,
  failWarmingToCold,
  getSandboxSessionEnvelope,
  heartbeatLeaseHolder,
  readLease,
  releaseLeaseHolder,
  SandboxLeaseSupersededError,
  type Database,
  type LeaseSnapshot,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";

// The leaf — agent-loop-free. apps/api imports sandbox symbols ONLY from here
// (enforced by sandbox-access-import-guard.test.ts).
import {
  establishSandboxSessionFromEnvelope,
  type EstablishedSandboxSession,
} from "@opengeni/runtime/sandbox";

/** The minimal services a viewer op needs: the DB + settings (lease cadence +
 *  the sandbox client construction the leaf reads from settings). */
export type ViewerServices = {
  db: Database;
  settings: Settings;
};

/** A coherent snapshot the routes echo back: the holder id (the viewer's fence-
 *  carrying handle), the lease liveness/epoch, and the recorded data-plane URL
 *  (null until P4 mints the desktop tunnel). */
export type ViewerAttachResult = {
  viewerId: string;
  liveness: LeaseSnapshot["liveness"];
  leaseEpoch: number;
  sandboxGroupId: string;
  // The viewer heartbeat cadence the client must beat at to keep the holder
  // alive (shorter than the viewer-holder TTL the reaper enforces).
  viewerHeartbeatIntervalMs: number;
  // The desktop pixel tunnel URL the viewer connects to directly. Null in P1.4
  // (the mint is P4); surfaced here so the shape is stable.
  dataPlaneUrl: string | null;
};

/**
 * Acquire a `viewer` holder on the group lease, spinning up the box IN-PROCESS
 * when cold. Mirrors the worker's resumeBoxForTurn spawner/attached branches,
 * but with kind:'viewer' and run by the API process — no Temporal, no worker.
 *
 * `viewerId` is the unique-per-connection holder id (a uuid the client carries
 * through heartbeats + detach); generated when absent.
 */
export async function attachViewer(
  services: ViewerServices,
  input: { accountId: string; workspaceId: string; session: Session; viewerId?: string },
): Promise<ViewerAttachResult> {
  const { db, settings } = services;
  const { accountId, workspaceId, session } = input;
  const viewerId = input.viewerId ?? crypto.randomUUID();
  const leaseTtlMs = settings.sandboxLeaseTtlMs;
  const sandboxGroupId = session.sandboxGroupId;

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

  // FENCED: a newer epoch re-established the box. Release our just-registered
  // holder and surface a 409 — the client re-reads capabilities and re-attaches.
  if (acquired.role === "fenced") {
    await release();
    throw new HTTPException(409, { message: `sandbox lease superseded (epoch ${acquired.lease.leaseEpoch}); re-read capabilities and re-attach` });
  }

  // SPAWNER: we won the cold->warming CAS. Establish the box in-process from the
  // session's persisted envelope (warm reattach by id, or cold-restore on a
  // provider NotFound), then commit warm (the lease_epoch++ fence + fold the
  // resume envelope onto the lease). A held in-memory handle is dropped after
  // commit — the lease owns lifecycle, not this handle (non-owned by id).
  if (acquired.role === "spawner") {
    const expectedEpoch = acquired.lease.leaseEpoch;
    let established: EstablishedSandboxSession | undefined;
    try {
      const envelope = await getSandboxSessionEnvelope(db, workspaceId, session.id);
      established = await establishSandboxSessionFromEnvelope(settings, envelope, {
        sessionId: session.id,
        backendOverride: session.sandboxBackend,
      });
      const committed = await commitWarmingToWarm(db, {
        accountId,
        workspaceId,
        sandboxGroupId,
        expectedEpoch,
        instanceId: established.instanceId,
        // The desktop tunnel-URL mint is P4; record null for now.
        dataPlaneUrl: null,
        resumeBackendId: established.backendId,
        resumeState: envelope ?? null,
        leaseTtlMs,
      });
      if (!committed.committed || !committed.lease) {
        // A reaper reset our warming row (we were too slow) or a sibling
        // re-established and bumped the epoch. Release our holder and surface a
        // 409. NEVER provider-delete the box (it rides the provider idle-timeout).
        await release();
        throw new SandboxLeaseSupersededError(sandboxGroupId, expectedEpoch);
      }
      return {
        viewerId,
        liveness: committed.lease.liveness,
        leaseEpoch: committed.lease.leaseEpoch,
        sandboxGroupId,
        viewerHeartbeatIntervalMs: viewerHeartbeatIntervalMs(settings),
        dataPlaneUrl: committed.lease.dataPlaneUrl,
      };
    } catch (error) {
      if (error instanceof SandboxLeaseSupersededError) {
        throw new HTTPException(409, { message: `sandbox lease superseded (epoch ${error.leaseEpoch}); re-read capabilities and re-attach` });
      }
      // Caught spawn failure: roll the warming row back to cold so the next
      // arrival (a turn or another viewer) re-acquires and re-spawns. Holders
      // are intentionally kept by failWarmingToCold for the re-acquire; then
      // release our own holder so we don't pin a cold lease.
      await failWarmingToCold(db, { accountId, workspaceId, sandboxGroupId, expectedEpoch });
      await release();
      throw error;
    } finally {
      // Drop the in-process handle: the API resumed BY ID for the cold-spawn,
      // it does NOT own the box. The lease's refcount (this viewer holder) keeps
      // it warm; the reaper stops it at refcount 0.
      await dropEstablishedHandle(established);
    }
  }

  // ATTACHED / REARMED: the box is live (or a sibling is mid-warm). The viewer
  // holder alone keeps it warm — no establish needed (the holder lifecycle is
  // the P1.4 deliverable; P4 mints the pixel URL on the negotiation read).
  return {
    viewerId,
    liveness: acquired.lease.liveness,
    leaseEpoch: acquired.lease.leaseEpoch,
    sandboxGroupId,
    viewerHeartbeatIntervalMs: viewerHeartbeatIntervalMs(settings),
    dataPlaneUrl: acquired.lease.dataPlaneUrl,
  };
}

/**
 * Refresh a viewer holder's TTL (the app-level viewer heartbeat). Epoch-fenced:
 * a stale-epoch heartbeat (a box re-established under a newer epoch) returns
 * false and the client must re-attach. Returns whether the holder is still live.
 */
export async function heartbeatViewer(
  services: ViewerServices,
  input: { accountId: string; workspaceId: string; sandboxGroupId: string; viewerId: string; expectedEpoch: number },
): Promise<boolean> {
  return await heartbeatLeaseHolder(services.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sandboxGroupId: input.sandboxGroupId,
    kind: "viewer",
    holderId: input.viewerId,
    leaseTtlMs: services.settings.sandboxLeaseTtlMs,
    expectedEpoch: input.expectedEpoch,
  });
}

/**
 * Release a viewer holder (the client disconnected). Idempotent: a double
 * detach (or a detach after the reaper already TTL-reaped the holder) is a
 * no-op. The box drains/stops only when no turn AND no viewer holds it.
 */
export async function detachViewer(
  services: ViewerServices,
  input: { accountId: string; workspaceId: string; sandboxGroupId: string; viewerId: string },
): Promise<{ liveness: LeaseSnapshot["liveness"]; refcount: number } | null> {
  return await releaseLeaseHolder(services.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sandboxGroupId: input.sandboxGroupId,
    kind: "viewer",
    holderId: input.viewerId,
    idleGraceMs: services.settings.sandboxIdleGraceMs,
  });
}

/** Non-locking lease snapshot for the capability-negotiation read. */
export async function readGroupLease(
  services: ViewerServices,
  input: { workspaceId: string; sandboxGroupId: string },
): Promise<LeaseSnapshot | null> {
  return await readLease(services.db, input.workspaceId, input.sandboxGroupId);
}

// The viewer heartbeat cadence: half the viewer-holder TTL, floored at 5s, so a
// single missed beat never reaps a live viewer (two beats fit inside the TTL).
function viewerHeartbeatIntervalMs(settings: Settings): number {
  return Math.max(5_000, Math.floor(settings.sandboxViewerHolderTtlMs / 2));
}

// Best-effort drop of a transiently-established handle (the cold-spawn path).
// The box is NON-OWNED by id, so closing the local handle never terminates it;
// we just free the in-process resources. Swallow errors — a failed close must
// not fail the attach (the lease holder already keeps the box warm).
async function dropEstablishedHandle(established: EstablishedSandboxSession | undefined): Promise<void> {
  if (!established) {
    return;
  }
  const session = established.session as { close?: () => Promise<void> } | undefined;
  if (session && typeof session.close === "function") {
    try {
      await session.close();
    } catch {
      // non-owned handle; the lease owns lifecycle.
    }
  }
}
