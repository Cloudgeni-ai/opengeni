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
//   3. (spawner) ensureDisplayStack + exposeStreamPort, then commitWarmingToWarm
//      (the lease_epoch++ fence + folds the resume envelope onto the lease). The
//      ATTACHED/REARMED path RE-ensures the display stack too (idempotent) so a
//      computer-use turn always finds a live :0 even on a box first warmed by a
//      non-desktop op or after a snapshot rollover dropped the X stack.
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
  ensureDisplayStack as ensureDisplayStackOnBox,
  desktopCapableBackend,
  serializeEstablishedSandboxEnvelope,
  DisplayStackError,
  DisplayStackUnsupportedError,
  buildStreamUrl,
  StreamPortUnavailableError,
  type EstablishedSandboxSession,
  type ExposedPortEndpoint,
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
  /**
   * The FULL environment the agent will declare for this run (the SAME object
   * passed to runtime.buildAgent's `sandboxEnvironment`). The box's manifest is
   * created with this environment so that when the SDK applies the agent's
   * manifest to this NON-OWNED provided session, the environments match exactly
   * and `validateNoEnvironmentDelta` finds an empty delta (otherwise it throws
   * "Live sandbox sessions cannot change manifest environment variables" and the
   * turn dies). Omitted → the leaf falls back to collectSandboxEnvironment(settings)
   * (the legacy default; only the resume/spawn-without-an-agent callers rely on it).
   */
  environment?: Record<string, string>;
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
      // Prefer the COLD lease's preserved resume_state when it carries a persisted
      // /workspace snapshot (confirmDrainCold keeps a minimal archive-only envelope
      // across draining->cold for exactly this re-warm). establishSandboxSessionFromEnvelope
      // cold-creates a fresh box and replays the archive via hydrateWorkspace, so
      // /workspace survives box churn (sandbox-file-persistence). No archive ->
      // the bare session envelope (a never-warmed cold start). Mirrors channel-a.ts's
      // spawner branch: the lease's resume_state is authoritative; the session
      // `_sandbox` envelope is the per-session fallback. Without this a turn-first
      // re-warm after a drain->cold would ignore the archive and start an EMPTY box.
      const spawnEnvelope = acquired.lease.resumeState ?? envelope;
      const established = await establishSandboxSessionFromEnvelope(settings, spawnEnvelope, {
        sessionId: ids.sessionId,
        backendOverride: ids.backend as never,
        ...(ids.environment ? { environment: ids.environment } : {}),
      });
      await ensureDisplayStack(settings, established);
      const endpoint = await exposeStreamPort(settings, established);
      // Fold the LIVE box into a re-resumable envelope and persist it as the
      // lease's resume_state — exactly like the API-direct paths (channel-a.ts /
      // viewer.ts). Without this the turn committed the ORIGINAL session manifest
      // as resume_state, so every LATER op off this lease (Channel-A fs/git/
      // terminal, the desktop viewer, the reaper) cold-restored a FRESH rival box
      // and never saw the turn's live box. Fall back to the session envelope only
      // when the client cannot serialize live state.
      const resumeEnvelope = (await serializeEstablishedSandboxEnvelope(established)) ?? envelope ?? null;
      const committed = await commitWarmingToWarm(db, {
        accountId: ids.accountId,
        workspaceId: ids.workspaceId,
        sandboxGroupId: ids.sandboxGroupId,
        expectedEpoch,
        instanceId: established.instanceId,
        dataPlaneUrl: endpoint?.url ?? null,
        resumeBackendId: established.backendId,
        resumeState: resumeEnvelope,
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
    // Prefer the lease's resume_state (the LIVE box the spawner committed) so we
    // re-attach to the SAME box by id, not cold-restore the original session
    // manifest into a rival. Fall back to the session envelope only when the
    // lease carries no resume_state (matches channel-a.ts's attached branch).
    const live = await readLease(db, ids.workspaceId, ids.sandboxGroupId);
    const envelope =
      live?.resumeState ?? (await getSandboxSessionEnvelope(db, ids.workspaceId, ids.sessionId));
    const established = await establishSandboxSessionFromEnvelope(settings, envelope, {
      sessionId: ids.sessionId,
      backendOverride: ids.backend as never,
      ...(ids.environment ? { environment: ids.environment } : {}),
    });
    // Re-ensure the desktop display stack on the ATTACHED/REARMED path too — NOT
    // just the spawner path. A turn attaching to a warm box whose :0 was never
    // brought up (the box was first warmed by a Channel-A op, or a snapshot
    // rollover dropped the X stack) would otherwise drive computer-use against a
    // dead display: scrot yields an empty PNG, the SDK builds `image_url: ''`,
    // and the model rejects the turn with "400 Invalid input[N].output.image_url".
    // ensureDisplayStack is idempotent + flock-guarded (cheap no-op when up) and
    // NO-OPs when the desktop tier is off or the backend is headless-only, so the
    // headless turn path stays byte-for-byte unchanged.
    await ensureDisplayStack(settings, established);
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
// Channel-B display-stack launch (P4.1 — ensureDisplayStack is now real).
//
// Idempotent + callable by ANY worker on the resumed handle (and by the API on a
// viewer op). When the desktop tier is OFF (sandboxDesktopEnabled=false) or the
// backend is headless-only, this is a NO-OP — the HEADLESS ROLLOVER branch (I5),
// so the headless turn path is byte-for-byte unchanged. When the tier is ON for
// a desktop-capable backend, it execs the canonical opengeni-desktop-up under an
// in-box flock (re-establishes after a rollover; safe to call N times).
// `exposeStreamPort` real body remains a P4.2 concern.
// ============================================================================

/**
 * Ensure the desktop display stack (Xvfb -> XFCE -> x11vnc ->
 * websockify:6080 -> noVNC) is up on the live box. Idempotent: the lock-free
 * pre-check + the in-box flock + the up-script's per-stage PID guards make a
 * second call a cheap no-op. NO-OP when the desktop tier is disabled or the
 * backend cannot serve a desktop (degradation is a value: a headless-only session
 * simply skips the stack). Delegates to the agent-loop-free leaf
 * (@opengeni/runtime/sandbox display-stack).
 *
 * BEST-EFFORT — NEVER fails the turn. The display stack powers the OPTIONAL
 * Channel-B desktop / computer-use surface; it is NOT load-bearing for the
 * agent's work. A `DisplayStackError` (a real stage failure, OR — the regression
 * this guards — a timeout-derived exit -1 when a viewer attach already holds /
 * contends the up-script's flock and the turn's ensure waits ~45s and times out)
 * is CAUGHT + logged and swallowed, so a slow/contended/failed stack degrades to
 * Channel-A-only rather than killing the turn. The fast lock-free pre-check
 * upstream means the already-up case resolves in milliseconds and never reaches
 * this catch in the first place. `DisplayStackUnsupportedError` (a box that can't
 * run commands at all) is likewise swallowed.
 */
export async function ensureDisplayStack(
  settings: Settings,
  established: EstablishedSandboxSession,
): Promise<void> {
  // Headless rollover branch (I5): the tier is off OR the backend is
  // headless-only -> no display stack. Behavior-preserving for the headless path.
  // This is ALSO the "is the desktop relevant to this turn?" gate: we only touch
  // the box when the desktop tier is enabled for a desktop-capable backend.
  if (!settings.sandboxDesktopEnabled) {
    return;
  }
  if (!desktopCapableBackend(established.backendId)) {
    return;
  }
  try {
    await ensureDisplayStackOnBox(established.session);
  } catch (error) {
    // The desktop is a value-add, not load-bearing for the agent's work, so NO
    // display-stack failure may fail the turn:
    //  - DisplayStackUnsupportedError: the box genuinely can't run commands ->
    //    Channel-A-only.
    //  - DisplayStackError: a stage failure OR a contended-lock timeout (exit -1)
    //    after a viewer attach already brought the stack up / is mid-launch. The
    //    pre-check makes the already-up case fast; if we still time out or a stage
    //    really failed, degrade — don't die.
    if (error instanceof DisplayStackUnsupportedError || error instanceof DisplayStackError) {
      console.warn(
        `[sandbox-resume] ensureDisplayStack degraded to Channel-A-only (turn continues): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    // An unexpected non-display error (e.g. the session blew up entirely) still
    // propagates — that is not a desktop-surface degradation.
    throw error;
  }
}

// The structural slice of a provider session we need to resolve the tunnel.
type PortResolvableSession = {
  resolveExposedPort?: (port: number) => Promise<ExposedPortEndpoint>;
};

/**
 * Resolve the desktop tunnel URL (resolveExposedPort(6080)) and assemble the
 * direct-to-provider WS URL, recorded on the lease as `data_plane_url` at
 * commit. The per-viewer scoped token is minted at viewer-attach time (the
 * handshake), NOT here — the spawner records only the box-scoped tunnel URL so
 * the lease carries a fresh value across a rollover. P4.2 productionizes the
 * P4.1 stub.
 *
 * Returns null (degradation is a value, NEVER a throw):
 *   - the desktop tier is off (sandboxDesktopEnabled=false), or
 *   - the backend is headless-only (no desktop), or
 *   - the provider session cannot resolve the port (no resolveExposedPort), or
 *   - the tunnel lookup transiently failed.
 * In every null case the lease's data_plane_url stays null and the next
 * API-direct viewer op re-mints it; the turn never fails on a desktop hiccup.
 */
export async function exposeStreamPort(
  settings: Settings,
  established: EstablishedSandboxSession,
): Promise<{ url: string; expiresAt: Date } | null> {
  // Headless rollover branch (I5): tier !== desktop -> no stream port to expose.
  if (!settings.sandboxDesktopEnabled) {
    return null;
  }
  if (!desktopCapableBackend(established.backendId)) {
    return null;
  }
  const session = established.session as PortResolvableSession;
  if (typeof session?.resolveExposedPort !== "function") {
    return null;
  }
  try {
    const endpoint = await session.resolveExposedPort(DESKTOP_STREAM_PORT);
    const url = buildStreamUrl(endpoint);
    // The provider tunnel URL is box-lifetime-valid (Modal raw TLS) or
    // provider-TTL-signed (Daytona/Blaxel); the per-viewer token's TTL bounds the
    // viewer's freshness. We record only the URL on the lease; expiresAt here is a
    // soft hint (the box's idle horizon), not a hard token expiry.
    return { url, expiresAt: new Date(Date.now() + settings.sandboxLeaseTtlMs) };
  } catch (error) {
    // Degradation is a value: a transient resolve failure leaves data_plane_url
    // null and the next viewer op re-mints. Never fail the turn on a desktop op.
    if (error instanceof StreamPortUnavailableError) {
      return null;
    }
    return null;
  }
}
