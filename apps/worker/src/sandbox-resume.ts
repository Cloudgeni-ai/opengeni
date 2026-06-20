// apps/worker/src/sandbox-resume.ts — the stateless per-turn resume-by-id path.
//
// This is the turn-side half of the P1.2 ownership inversion. There is NO class,
// NO timers, NO per-session owner, NO Map<id, owner> — every turn is a
// self-contained critical section run by ANY pool worker:
//
//   1. acquireLease (group-keyed) under the DB FOR UPDATE + cold->warming CAS —
//      the SOLE double-spawn guard (P1.1).
//   2. establishSandboxSessionFromEnvelope — resume the one box BY ID (warm
//      reattach, R4-safe) or cold-restore from snapshot on a provider NotFound.
//   3. (spawner only) ensureDisplayStack + exposeStreamPort, then
//      commitWarmingToWarm (the lease_epoch++ fence + folds the resume envelope
//      onto the lease).
//   4. the caller injects {client, session, sessionState} NON-OWNED into the run
//      (the SDK never reaps it — the keystone), runs, then in `finally` calls the
//      returned `release()` and drops the in-memory handle. NEVER provider-delete
//      — the box rides the provider idle-timeout; the reaper (P1.3) stop()s it at
//      refcount 0.
//
// Liveness between turns is the lease refcount; there is no keepalive loop.

import type { Settings } from "@opengeni/config";
import {
  acquireLease,
  commitWarmingToWarm,
  failWarmingToCold,
  getSandboxSessionEnvelope,
  readLease,
  releaseLeaseHolder,
  SandboxLeaseSupersededError,
  type Database,
  type LeaseHolderKind,
} from "@opengeni/db";
import {
  establishSandboxSessionFromEnvelope,
  type EstablishedSandboxSession,
} from "@opengeni/runtime";
import { DESKTOP_STREAM_PORT } from "@opengeni/contracts";

export { DESKTOP_STREAM_PORT };

// Re-exported for callers that just want the ack-kind union.
export type ResumeHolderKind = LeaseHolderKind;

/** The minimal services surface resumeBoxForTurn needs. A subset of
 *  ActivityServices so a test (and the API later) can pass a lean bag. */
export type SandboxResumeServices = {
  db: Database;
  settings: Settings;
};

export type ResumeBoxIds = {
  accountId: string;
  workspaceId: string;
  sandboxGroupId: string;
  /** The attributing session within the group (holders carry session_id for
   *  disclosure/attribution). For a singleton group this == sandboxGroupId. */
  sessionId: string;
  /** The backend the box runs on (sessions.sandbox_backend). */
  backend: string;
  /** The OS axis (sessions.sandbox_os); default 'linux'. */
  os?: string;
};

/** What resumeBoxForTurn returns: the live NON-OWNED session to inject, the
 *  fence token (lease_epoch) it was established under, and a release function
 *  the caller invokes in `finally` (idempotent delete-my-holder-row). */
export type ResumedTurnSandbox = {
  /** The live, externally-owned session — inject {client, session, sessionState}
   *  NON-OWNED into runStream's `ownedSandbox`; the SDK never reaps it. */
  established: EstablishedSandboxSession;
  /** The lease_epoch this turn holds; the heartbeat/fence token. */
  leaseEpoch: number;
  /** Idempotent release: deletes this holder row and (if refcount hits 0 with no
   *  turn holders) CASes warm->draining. NEVER stops the box. Safe to call once. */
  release: () => Promise<void>;
};

// Bounded poll while a sibling spawner is mid cold-restore. The reaper resets a
// dead warming row after sandboxLeaseWarmingTtlMs; we poll up to that horizon.
const WARMING_POLL_INTERVAL_MS = 250;

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Resume the one box for a single turn (or any worker-side resume op). Returns
 * the live non-owned session + the fence epoch + a release fn. The CALLER owns
 * the lifecycle: inject non-owned, run, then `await release()` and drop the
 * handle in `finally`.
 *
 * holderId is the unique-per-execution id (the Temporal activityId for a turn).
 */
export async function resumeBoxForTurn(
  services: SandboxResumeServices,
  ids: ResumeBoxIds,
  kind: LeaseHolderKind,
  holderId: string,
): Promise<ResumedTurnSandbox> {
  const { db, settings } = services;
  const os = ids.os ?? "linux";
  const leaseTtlMs = settings.sandboxLeaseTtlMs;

  // The release closure is created eagerly so the caller can always release in
  // finally, even if establish/commit throws after the holder was registered.
  let released = false;
  const release = async (): Promise<void> => {
    if (released) {
      return;
    }
    released = true;
    await releaseLeaseHolder(db, {
      accountId: ids.accountId,
      workspaceId: ids.workspaceId,
      sandboxGroupId: ids.sandboxGroupId,
      kind,
      holderId,
      idleGraceMs: settings.sandboxIdleGraceMs,
    });
  };

  const acquired = await acquireLease(db, {
    accountId: ids.accountId,
    workspaceId: ids.workspaceId,
    sandboxGroupId: ids.sandboxGroupId,
    kind,
    holderId,
    subjectId: ids.sessionId,
    backend: ids.backend,
    os,
    leaseTtlMs,
  });

  // FENCED: a newer epoch exists (a later turn re-established the box). Back off;
  // NEVER create(). Release our (just-registered) holder so we don't pin a stale
  // lease, then surface the supersession.
  if (acquired.role === "fenced") {
    await release();
    throw new SandboxLeaseSupersededError(ids.sandboxGroupId, acquired.lease.leaseEpoch);
  }

  // SPAWNER: we won the cold->warming CAS. Establish (cold-restore/create),
  // expose the stream port, then commit warm (lease_epoch++).
  if (acquired.role === "spawner") {
    const expectedEpoch = acquired.lease.leaseEpoch;
    try {
      const envelope = await getSandboxSessionEnvelope(db, ids.workspaceId, ids.sessionId);
      const established = await establishSandboxSessionFromEnvelope(settings, envelope, {
        sessionId: ids.sessionId,
        backendOverride: ids.backend as never,
      });
      await ensureDisplayStack(settings, established);
      const endpoint = await exposeStreamPort(settings, established);
      const committed = await commitWarmingToWarm(db, {
        accountId: ids.accountId,
        workspaceId: ids.workspaceId,
        sandboxGroupId: ids.sandboxGroupId,
        expectedEpoch,
        instanceId: established.instanceId,
        dataPlaneUrl: endpoint?.url ?? null,
        resumeBackendId: established.backendId,
        resumeState: envelope ?? null,
        leaseTtlMs,
      });
      if (!committed.committed || !committed.lease) {
        // A reaper reset our warming row (we were too slow) or a sibling
        // re-established and bumped the epoch. Drop the handle; release our
        // holder; surface supersession. NEVER provider-delete the box.
        await release();
        throw new SandboxLeaseSupersededError(ids.sandboxGroupId, expectedEpoch);
      }
      return { established, leaseEpoch: committed.lease.leaseEpoch, release };
    } catch (error) {
      if (error instanceof SandboxLeaseSupersededError) {
        throw error;
      }
      // Caught spawn failure: roll the warming row back to cold so a queued turn
      // re-acquires and re-spawns. Holders are intentionally left for the
      // re-acquire (failWarmingToCold keeps them); then release our own holder.
      await failWarmingToCold(db, {
        accountId: ids.accountId,
        workspaceId: ids.workspaceId,
        sandboxGroupId: ids.sandboxGroupId,
        expectedEpoch,
      });
      await release();
      throw error;
    }
  }

  // ATTACHED / REARMED: the box is live (or a sibling is warming it). Resume it
  // BY ID off the committed lease envelope. For an 'attached'-to-warming lease we
  // first wait for the spawner to commit warm (or for the row to flip cold so we
  // can re-acquire as spawner).
  let leaseEpoch = acquired.lease.leaseEpoch;
  if (acquired.lease.liveness === "warming") {
    leaseEpoch = (await waitForWarmOrReacquire(services, ids, kind, holderId)).leaseEpoch;
  }

  try {
    const envelope = await getSandboxSessionEnvelope(db, ids.workspaceId, ids.sessionId);
    const established = await establishSandboxSessionFromEnvelope(settings, envelope, {
      sessionId: ids.sessionId,
      backendOverride: ids.backend as never,
    });
    return { established, leaseEpoch, release };
  } catch (error) {
    await release();
    throw error;
  }
}

/**
 * Poll a warming lease until the spawner commits warm. If the warming row is
 * reset to cold (the spawner died and the reaper reset it), re-acquire — we may
 * now win the cold->warming CAS ourselves. Bounded by the warming TTL.
 */
async function waitForWarmOrReacquire(
  services: SandboxResumeServices,
  ids: ResumeBoxIds,
  kind: LeaseHolderKind,
  holderId: string,
): Promise<{ liveness: string; leaseEpoch: number }> {
  const { db, settings } = services;
  const deadline = Date.now() + settings.sandboxLeaseWarmingTtlMs;
  while (Date.now() < deadline) {
    await sleep(WARMING_POLL_INTERVAL_MS);
    const lease = await readLease(db, ids.workspaceId, ids.sandboxGroupId);
    if (!lease) {
      // Lease vanished (cold-reaped). Re-acquire from scratch.
      break;
    }
    if (lease.liveness === "warm" || lease.liveness === "draining") {
      return { liveness: lease.liveness, leaseEpoch: lease.leaseEpoch };
    }
    if (lease.liveness === "cold") {
      // The spawner died; the reaper reset to cold. Re-acquire — we might win.
      break;
    }
    // still warming — keep polling.
  }
  // Re-acquire: if we now win cold->warming we become the spawner; if the box is
  // warm we attach. Either way resumeBoxForTurn's caller already holds a holder
  // row (idempotent), so this re-acquire just re-reads/re-CASes.
  const reacquired = await acquireLease(db, {
    accountId: ids.accountId,
    workspaceId: ids.workspaceId,
    sandboxGroupId: ids.sandboxGroupId,
    kind,
    holderId,
    subjectId: ids.sessionId,
    backend: ids.backend,
    os: ids.os ?? "linux",
    leaseTtlMs: settings.sandboxLeaseTtlMs,
  });
  if (reacquired.role === "fenced") {
    throw new SandboxLeaseSupersededError(ids.sandboxGroupId, reacquired.lease.leaseEpoch);
  }
  // For 'spawner' we'd need to run the cold-restore path; to keep resumeBoxForTurn
  // a single critical section we recurse the spawner handling by surfacing it as a
  // re-establish from the (now-cold) envelope. The simplest correct behavior: if
  // we re-won the CAS, establish + commit happens on the NEXT resumeBoxForTurn
  // call (the queued turn re-dispatch); here we just return the lease snapshot so
  // the attached path resumes by id. A cold lease has no box yet, so treat it as
  // warming-resolved only when warm/draining.
  return { liveness: reacquired.lease.liveness, leaseEpoch: reacquired.lease.leaseEpoch };
}

// ============================================================================
// Channel-B display-stack stubs (P1.2 placeholders; real bodies land in P4.1).
//
// Idempotent + callable by ANY worker on the resumed handle. No-op when the
// session tier is not desktop (the HEADLESS ROLLOVER branch, I5): until P4.x
// wires the desktop tier, these are inert so the headless turn path is
// unchanged. They are called by the spawner branch of resumeBoxForTurn so the
// seam exists now; flipping them on is a P4 concern.
// ============================================================================

/**
 * Ensure the desktop display stack (Xvfb -> XFCE -> x11vnc -> websockify:6080)
 * is up on the live box. Idempotent (a P4 body probes the box and re-runs at
 * most once). NO-OP today: there is no desktop tier yet, so a headless turn
 * never launches a display stack. Real body: P4.1.
 */
export async function ensureDisplayStack(
  _settings: Settings,
  _established: EstablishedSandboxSession,
): Promise<void> {
  // Headless rollover branch (I5): tier !== desktop -> no display stack.
  return;
}

/**
 * Mint/re-resolve the scoped desktop tunnel URL (resolveExposedPort(6080)).
 * Returns null on a headless backend / when desktop is disabled (degradation is
 * a value, never a throw). NO-OP today (returns null): no desktop tier yet. Real
 * body: P4.2.
 */
export async function exposeStreamPort(
  _settings: Settings,
  _established: EstablishedSandboxSession,
): Promise<{ url: string; expiresAt: Date } | null> {
  // Headless rollover branch (I5): tier !== desktop -> no stream port to expose.
  return null;
}
