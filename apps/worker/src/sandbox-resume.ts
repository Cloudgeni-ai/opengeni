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
//   3. (spawner) commitWarmingToWarm (the lease_epoch++ fence + folds the resume
//      envelope onto the lease). Optional desktop work is deliberately absent:
//      the viewer and the first actual computer-use action initialize :0 lazily.
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
  persistWarmSnapshot,
  readLease,
  recordWarmingSandboxCreated,
  releaseLeaseHolder,
  touchLeaseHolder,
  SandboxLeaseSupersededError,
  type Database,
  type LeaseHolderKind,
} from "@opengeni/db";
import {
  establishSandboxSessionFromEnvelope,
  serializeEstablishedSandboxEnvelope,
  deletePriorPersistedSnapshot,
  tagModalSandbox,
  type EstablishedSandboxSession,
  type RuntimeMetricsHooks,
} from "@opengeni/runtime";

// Re-exported for callers that just want the ack-kind union.
export type ResumeHolderKind = LeaseHolderKind;

/** The minimal services surface resumeBoxForTurn needs. A subset of
 *  ActivityServices so a test (and the API later) can pass a lean bag. */
export type SandboxResumeServices = {
  db: Database;
  settings: Settings;
  sandboxMetrics?: RuntimeMetricsHooks;
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
  /**
   * IMAGE IS SHARED STATE (B3): the container image this run resolves (Modal image ref
   * / docker image). Threaded to acquireLease, which stamps it on the cold-create and
   * conflicts on a live box already running a DIFFERENT image (solo holder recreates;
   * N-holders throw SandboxImageConflictError). Omitted -> image is not enforced (the
   * selfhosted path never passes it; a legacy/null-image box never conflicts).
   */
  image?: string;
  /**
   * RIG IS SHARED STATE (M3): the frozen rig version this run rides. Threaded to
   * acquireLease, which stamps it on the cold-create and conflicts on a live box
   * set up under a DIFFERENT rig version (solo holder recreates cold on the new
   * rig; N-holders throw SandboxRigConflictError). Omitted for a rig-less session
   * -> rig is never stamped or enforced (shares exactly as today).
   */
  rigVersionId?: string;
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

export class SandboxWarmingTimeoutError extends Error {
  readonly code = "sandbox_warming_timeout";

  constructor(
    public readonly backend: string,
    public readonly timeoutMs: number,
  ) {
    super(
      `Sandbox backend "${backend}" capacity or creation timed out after ${Math.ceil(timeoutMs / 1000)}s while warming the sandbox lease. Please try again; if this persists, sandbox capacity may be exhausted.`,
    );
    this.name = "SandboxWarmingTimeoutError";
  }
}

// Bounded poll while a sibling spawner is mid cold-restore. The wait budget is
// user-facing and separate from the lease TTL heartbeat/reaper horizon.
const WARMING_POLL_INTERVAL_MS = 250;
const MODAL_EXEC_READINESS_TIMEOUT_MS = 15_000;

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Modal may return a sandbox handle before its command router accepts the first
 * exec. The upstream session's yieldTimeMs starts only after sandbox.exec()
 * returns, so it cannot bound that initial RPC. Probe it before publishing the
 * lease as warm and enforce our own wall-clock deadline.
 */
export async function waitForSandboxExecReadiness(
  established: EstablishedSandboxSession,
  timeoutMs = MODAL_EXEC_READINESS_TIMEOUT_MS,
): Promise<void> {
  if (established.backendId !== "modal") return;

  const session = established.session as {
    exec?: (args: {
      cmd: string;
      yieldTimeMs?: number;
      maxOutputTokens?: number;
    }) => Promise<unknown>;
    execCommand?: (args: {
      cmd: string;
      yieldTimeMs?: number;
      maxOutputTokens?: number;
    }) => Promise<unknown>;
  };
  const run = session.exec ?? session.execCommand;
  if (!run) {
    throw new Error("Modal sandbox session does not expose exec");
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      run.call(session, {
        cmd: "true",
        yieldTimeMs: 1_000,
        maxOutputTokens: 1_000,
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new SandboxWarmingTimeoutError(established.backendId, timeoutMs)),
          timeoutMs,
        );
        if (timer && "unref" in timer && typeof timer.unref === "function") timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class SnapshotTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`workspace snapshot timed out after ${timeoutMs}ms`);
    this.name = "SnapshotTimeoutError";
  }
}

export async function waitForWarmSnapshot(
  snapshot: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      snapshot,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new SnapshotTimeoutError(timeoutMs)), timeoutMs);
        if (timeout && "unref" in timeout && typeof timeout.unref === "function") {
          timeout.unref();
        }
      }),
    ]);
    return true;
  } catch (error) {
    if (error instanceof SnapshotTimeoutError) {
      console.error("mid-session workspace snapshot wait timed out (turn unaffected)", error);
      return false;
    }
    return true;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function terminateEstablishedSandbox(
  established: EstablishedSandboxSession | null,
): Promise<boolean> {
  if (!established) {
    return true;
  }
  const client = established.client as {
    delete?: (state: unknown) => Promise<unknown>;
  };
  if (typeof client.delete === "function" && established.sessionState !== undefined) {
    try {
      await client.delete(established.sessionState);
      return true;
    } catch {
      return false;
    }
  }
  const session = established.session as {
    close?: () => Promise<unknown>;
    terminate?: () => Promise<unknown>;
    kill?: () => Promise<unknown>;
    closed?: boolean;
  };
  try {
    if (session.terminate) {
      await session.terminate();
      return true;
    } else if (session.kill) {
      await session.kill();
      return true;
    } else if (session.close) {
      if (!session.closed) {
        await session.close();
      }
      return true;
    }
    return false;
  } catch {
    // Best-effort cleanup. A provider-side orphan sweep is the backstop.
    return false;
  }
}

function asSandboxWarmingError(error: unknown, backend: string, timeoutMs: number): unknown {
  const message = error instanceof Error ? error.message : String(error);
  return /sandbox creation timed out|warming timed out|capacity.*timed out/i.test(message)
    ? new SandboxWarmingTimeoutError(backend, timeoutMs)
    : error;
}

function recordSandboxWarmingTimeout(
  metrics: RuntimeMetricsHooks | undefined,
  error: unknown,
): void {
  if (!(error instanceof SandboxWarmingTimeoutError)) {
    return;
  }
  try {
    metrics?.onSandboxWarmingTimeout?.({ backend: error.backend });
  } catch {
    // Metrics emission must never affect sandbox recovery or error propagation.
  }
}

function workspaceArchiveFromEnvelope(
  envelope: Record<string, unknown> | null | undefined,
): string | null {
  const sessionState =
    envelope && typeof envelope.sessionState === "object" && envelope.sessionState !== null
      ? (envelope.sessionState as Record<string, unknown>)
      : null;
  const archive = sessionState?.workspaceArchive;
  return typeof archive === "string" && archive.length > 0 ? archive : null;
}

function preserveWorkspaceArchiveOnInterimResumeState(
  resumeState: Record<string, unknown> | null,
  archiveSource: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const archive = workspaceArchiveFromEnvelope(archiveSource);
  if (!archive) {
    return resumeState;
  }
  const existingSessionState =
    resumeState && typeof resumeState.sessionState === "object" && resumeState.sessionState !== null
      ? (resumeState.sessionState as Record<string, unknown>)
      : {};
  return {
    ...(resumeState ?? {}),
    ...(resumeState?.backendId === undefined && archiveSource?.backendId !== undefined
      ? { backendId: archiveSource.backendId }
      : {}),
    sessionState: {
      ...existingSessionState,
      workspaceArchive: archive,
    },
  };
}

/**
 * MID-SESSION /workspace snapshot (sandbox-file-persistence). The reaper's
 * drain-persist only protects boxes the reaper itself kills; anything else —
 * Modal's hard creation-time timeout catching a session busy past it, provider
 * OOM/infra death — loses everything since the last clean drain (staging
 * session e644e8a8, 2026-07-06: mid-turn box termination cost an unpushed
 * branch + 2 commits). While a turn HOLDS the live box, this folds a fresh
 * snapshot onto the lease through persistWarmSnapshot (the warm sibling of the
 * drain seam: epoch-fenced CAS + atomic throttle re-check) and GCs the
 * superseded snapshot image, bounding worst-case loss of ANY unclean box death
 * to sandboxSnapshotIntervalMs.
 *
 * Never throws and never blocks turn progress semantics: every failure path
 * returns false (the snapshot is protection, not a turn dependency). No-ops
 * when the interval is 0, the backend has no persistWorkspace (selfhosted =
 * the user's machine IS the persistence), or a snapshot newer than the
 * interval already rides the lease.
 */
export async function maybePersistWarmWorkspaceSnapshot(
  services: SandboxResumeServices,
  ids: { accountId: string; workspaceId: string; sandboxGroupId: string },
  session: unknown,
  leaseEpoch: number,
): Promise<boolean> {
  const { db, settings } = services;
  const intervalMs = settings.sandboxSnapshotIntervalMs;
  if (intervalMs <= 0) {
    return false;
  }
  const persistable = session as {
    persistWorkspace?: () => Promise<Uint8Array | undefined>;
  };
  if (typeof persistable.persistWorkspace !== "function") {
    return false;
  }
  try {
    // Cheap throttle pre-check before the (potentially slow) capture;
    // persistWarmSnapshot re-checks atomically under the row lock, so this is
    // purely a cost optimization, not the correctness guard.
    const lease = await readLease(db, ids.workspaceId, ids.sandboxGroupId);
    if (!lease || lease.leaseEpoch !== leaseEpoch || lease.liveness !== "warm") {
      return false;
    }
    const sessionState =
      lease.resumeState && typeof lease.resumeState === "object"
        ? (lease.resumeState as { sessionState?: Record<string, unknown> }).sessionState
        : undefined;
    const priorAtRaw =
      sessionState && typeof sessionState === "object"
        ? sessionState.workspaceArchiveAt
        : undefined;
    const priorAtMs = typeof priorAtRaw === "string" ? Date.parse(priorAtRaw) : Number.NaN;
    if (Number.isFinite(priorAtMs) && Date.now() - priorAtMs < intervalMs) {
      return false;
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    // Stamp WHEN this capture started: persistWarmSnapshot orders warm snapshots
    // by capture-initiation, not land time, so a slower heartbeat capture that
    // started earlier can never overwrite a fresher turn-end capture that landed
    // first (the bounded-wait race Bugbot flagged).
    const capturedAtMs = Date.now();
    // On timeout the race settles on `undefined` while persistWorkspace() keeps
    // running orphaned. Swallow its LATE settlement: an un-awaited rejection
    // after the race resolved would surface as an unhandledRejection and can
    // take down the whole worker process — which would defeat the very hang-
    // guard this timeout exists to provide.
    const capture = persistable.persistWorkspace();
    capture.catch(() => undefined);
    const bytes = await Promise.race([
      capture,
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), settings.sandboxSnapshotTimeoutMs);
        if (timeout && "unref" in timeout && typeof timeout.unref === "function") {
          timeout.unref();
        }
      }),
    ]).finally(() => {
      if (timeout) {
        clearTimeout(timeout);
      }
    });
    if (!bytes || bytes.length === 0) {
      return false;
    }
    const { wrote, priorArchiveForGc } = await persistWarmSnapshot(db, {
      accountId: ids.accountId,
      workspaceId: ids.workspaceId,
      sandboxGroupId: ids.sandboxGroupId,
      expectedEpoch: leaseEpoch,
      workspaceArchive: Buffer.from(bytes).toString("base64"),
      minIntervalMs: intervalMs,
      capturedAtMs,
    });
    if (!wrote) {
      return false;
    }
    // Warm snapshots retain a 2-deep restore window. Only the two-ago archive
    // returned by persistWarmSnapshot is GC-eligible.
    await deletePriorPersistedSnapshot(persistable, priorArchiveForGc);
    return true;
  } catch (error) {
    // Protection, not a dependency: a failed snapshot must never fail (or slow
    // down retrying) the turn. The next heartbeat/turn-end tick retries.
    console.error("mid-session workspace snapshot failed (turn unaffected)", error);
    return false;
  }
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
  let holderLivenessTimer: ReturnType<typeof setInterval> | undefined;
  const release = async (): Promise<void> => {
    if (released) {
      return;
    }
    released = true;
    if (holderLivenessTimer) {
      clearInterval(holderLivenessTimer);
    }
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
    // IMAGE IS SHARED STATE (B3): thread the resolved image so the lease stamps it +
    // conflicts on a live box already running a different image. A SandboxImageConflictError
    // propagates to the turn activity (an actionable error); a solo image change is handled
    // by acquireLease recreating the box cold on the new image.
    ...(ids.image ? { image: ids.image } : {}),
    // RIG IS SHARED STATE (M3): thread the frozen rig version so the lease stamps it
    // + conflicts on a live box under a different rig. A SandboxRigConflictError
    // propagates to the turn activity (actionable); a solo rig change recreates cold.
    ...(ids.rigVersionId ? { rigVersionId: ids.rigVersionId } : {}),
    leaseTtlMs,
    warmingLeaseTtlMs: settings.sandboxWarmingTimeoutMs,
  });

  // HOLDER-LIVENESS loop: touch OUR holder row every 10s from the moment it is
  // registered until release. The dead-worker turn-holder reap judges liveness
  // by last_heartbeat_at, and the full turn heartbeat (heartbeatLeaseHolder in
  // agent-turn) only starts AFTER this function returns — while waitForWarm and
  // establish/cold-restore can legitimately run for many minutes in here,
  // COMPOUNDING past any fixed reap horizon. With this
  // loop no live holder is ever silent for more than one tick, so the reap
  // horizon is pure defense-in-depth, not a tuned guess about path lengths.
  // Epoch-free by design (touch only refreshes our own row's timestamp);
  // best-effort (a transient DB error must never fail the resume).
  holderLivenessTimer = setInterval(() => {
    void touchLeaseHolder(db, {
      accountId: ids.accountId,
      workspaceId: ids.workspaceId,
      sandboxGroupId: ids.sandboxGroupId,
      kind,
      holderId,
    }).catch(() => undefined);
  }, 10_000);
  if ("unref" in holderLivenessTimer && typeof holderLivenessTimer.unref === "function") {
    holderLivenessTimer.unref();
  }

  // FENCED: a newer epoch exists (a later turn re-established the box). Back off;
  // NEVER create(). Release our (just-registered) holder so we don't pin a stale
  // lease, then surface the supersession.
  if (acquired.role === "fenced") {
    await release();
    throw new SandboxLeaseSupersededError(ids.sandboxGroupId, acquired.lease.leaseEpoch);
  }

  // SPAWNER: we won the cold->warming CAS. Establish (cold-restore/create),
  // then commit warm (lease_epoch++). Optional desktop setup is lazy.
  if (acquired.role === "spawner") {
    const expectedEpoch = acquired.lease.leaseEpoch;
    let createdEstablished: EstablishedSandboxSession | null = null;
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
        ...(services.sandboxMetrics ? { metrics: services.sandboxMetrics } : {}),
        onSandboxCreated: async (created) => {
          createdEstablished = created;
          const resumeEnvelope = preserveWorkspaceArchiveOnInterimResumeState(
            (await serializeEstablishedSandboxEnvelope(created)) ?? null,
            spawnEnvelope,
          );
          const recorded = await recordWarmingSandboxCreated(db, {
            accountId: ids.accountId,
            workspaceId: ids.workspaceId,
            sandboxGroupId: ids.sandboxGroupId,
            expectedEpoch,
            instanceId: created.instanceId,
            resumeBackendId: created.backendId,
            resumeState: resumeEnvelope,
            leaseTtlMs,
            // Keep the warming budget after create(): manifest setup and
            // commitWarmingToWarm still run, and can exceed the 90s turn TTL.
            warmingLeaseTtlMs: settings.sandboxWarmingTimeoutMs,
          });
          if (!recorded.recorded) {
            throw new SandboxLeaseSupersededError(ids.sandboxGroupId, expectedEpoch);
          }
          if (created.backendId === "modal") {
            await tagModalSandbox(settings, created.instanceId, {
              leaseId: acquired.lease.id,
              workspaceId: ids.workspaceId,
              sandboxGroupId: ids.sandboxGroupId,
            }).catch(() => undefined);
          }
        },
      });
      createdEstablished = established;
      // A sandbox handle is not sufficient evidence that Modal's command router
      // is live. Do not publish a warm lease until one bounded no-op exec works.
      // On timeout the catch below terminates the box and rolls warming -> cold,
      // so the next turn cold-creates instead of hanging forever on first use.
      await waitForSandboxExecReadiness(established);
      // Fold the LIVE box into a re-resumable envelope and persist it as the
      // lease's resume_state — exactly like the API-direct paths (channel-a.ts /
      // viewer.ts). Without this the turn committed the ORIGINAL session manifest
      // as resume_state, so every LATER op off this lease (Channel-A fs/git/
      // terminal, the desktop viewer, the reaper) cold-restored a FRESH rival box
      // and never saw the turn's live box. Fall back to the session envelope only
      // when the client cannot serialize live state.
      const resumeEnvelope =
        (await serializeEstablishedSandboxEnvelope(established)) ?? envelope ?? null;
      const committed = await commitWarmingToWarm(db, {
        accountId: ids.accountId,
        workspaceId: ids.workspaceId,
        sandboxGroupId: ids.sandboxGroupId,
        expectedEpoch,
        instanceId: established.instanceId,
        // Viewer attach resolves and records the tunnel URL lazily. A headless
        // turn must not touch the optional desktop data plane.
        dataPlaneUrl: null,
        resumeBackendId: established.backendId,
        resumeState: resumeEnvelope,
        leaseTtlMs,
      });
      if (!committed.committed || !committed.lease) {
        // A reaper reset our warming row (we were too slow) or a sibling
        // re-established and bumped the epoch. Drop the handle; release our
        // holder; surface supersession. This spawner created the box, so stop it
        // before retrying to avoid an untracked running sandbox.
        await terminateEstablishedSandbox(established);
        await release();
        throw new SandboxLeaseSupersededError(ids.sandboxGroupId, expectedEpoch);
      }
      return { established, leaseEpoch: committed.lease.leaseEpoch, release };
    } catch (error) {
      if (error instanceof SandboxLeaseSupersededError) {
        await terminateEstablishedSandbox(createdEstablished);
        await release();
        throw error;
      }
      const terminated = await terminateEstablishedSandbox(createdEstablished);
      // Caught spawn failure: if the just-created sandbox was actually stopped,
      // roll the warming row back to cold so a queued turn can re-acquire and
      // re-spawn. If termination itself failed, keep the recorded instance_id on
      // the warming row; the lease TTL/reaper and Modal orphan sweep are the
      // tracked backstops, and we must not erase the only provider pointer.
      if (terminated) {
        await failWarmingToCold(db, {
          accountId: ids.accountId,
          workspaceId: ids.workspaceId,
          sandboxGroupId: ids.sandboxGroupId,
          expectedEpoch,
        });
      }
      await release();
      const warmingError = asSandboxWarmingError(
        error,
        ids.backend,
        settings.sandboxWarmingTimeoutMs,
      );
      recordSandboxWarmingTimeout(services.sandboxMetrics, warmingError);
      throw warmingError;
    }
  }

  // ATTACHED / REARMED: the box is live (or a sibling is warming it). Resume it
  // BY ID off the committed lease envelope. For an 'attached'-to-warming lease we
  // first wait for the spawner to commit warm, bounded by the explicit warming
  // budget. A cold reset means the spawner died; recover the same turn instead
  // of trying to enter the spawner create path from the attached branch.
  try {
    let leaseEpoch = acquired.lease.leaseEpoch;
    if (acquired.lease.liveness === "warming") {
      leaseEpoch = (await waitForWarm(services, ids)).leaseEpoch;
    }

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
      ...(services.sandboxMetrics ? { metrics: services.sandboxMetrics } : {}),
    });
    return { established, leaseEpoch, release };
  } catch (error) {
    await release();
    const warmingError = asSandboxWarmingError(
      error,
      ids.backend,
      settings.sandboxWarmingTimeoutMs,
    );
    recordSandboxWarmingTimeout(services.sandboxMetrics, warmingError);
    throw warmingError;
  }
}

/**
 * Stage D machine-primary: acquire the group lease for a turn whose ACTIVE sandbox
 * is a connected machine (selfhosted) WITHOUT establishing a provider box. The
 * "box" is the user's physical machine reached over NATS; there is NOTHING to
 * spawn, snapshot, expose, or serialize — so we take the lease (the SAME group-keyed
 * refcount/idle/epoch bookkeeping resumeBoxForTurn uses) but skip every box step.
 *
 * The lease is keyed backend "selfhosted": the reaper's terminateProviderBox
 * short-circuits a selfhosted lease (it is the user's machine — NEVER provider-stop),
 * draining it to cold with no stop; and the reaper's warm-meter rate for "selfhosted"
 * is 0 (no cloud seconds billed for a box that does not exist). Returns the lease
 * epoch + an idempotent release so the turn's lease-heartbeat + `finally` release are
 * identical to the cloud path.
 *
 * holderId is the unique-per-execution id (the Temporal activityId for a turn).
 */
export async function acquireSelfhostedLeaseForTurn(
  services: SandboxResumeServices,
  ids: {
    accountId: string;
    workspaceId: string;
    sandboxGroupId: string;
    sessionId: string;
  },
  kind: LeaseHolderKind,
  holderId: string,
): Promise<{ leaseEpoch: number; release: () => Promise<void> }> {
  const { db, settings } = services;
  const leaseTtlMs = settings.sandboxLeaseTtlMs;

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
    backend: "selfhosted",
    os: "linux",
    leaseTtlMs,
    warmingLeaseTtlMs: settings.sandboxWarmingTimeoutMs,
  });

  // FENCED: a newer epoch re-established the group concurrently. Release our
  // just-registered holder + surface the supersession (the outer turn catch
  // requeues, mirroring resumeBoxForTurn).
  if (acquired.role === "fenced") {
    await release();
    throw new SandboxLeaseSupersededError(ids.sandboxGroupId, acquired.lease.leaseEpoch);
  }

  // SPAWNER: we won the cold->warming CAS. There is NO box to establish — commit
  // warm immediately so the lease does not linger in 'warming' (no box id, no
  // resume_state; selfhosted is re-addressed by enrollment via the active pointer,
  // never resumed from an envelope). resume_backend_id "selfhosted" keeps the
  // reaper's never-provider-stop short-circuit correct.
  if (acquired.role === "spawner") {
    const expectedEpoch = acquired.lease.leaseEpoch;
    const committed = await commitWarmingToWarm(db, {
      accountId: ids.accountId,
      workspaceId: ids.workspaceId,
      sandboxGroupId: ids.sandboxGroupId,
      expectedEpoch,
      // No provider box id; stamp a clearly non-box marker for diagnostics.
      instanceId: `selfhosted:${ids.sessionId}`,
      resumeBackendId: "selfhosted",
      resumeState: null,
      leaseTtlMs,
    });
    if (!committed.committed || !committed.lease) {
      // A reaper reset our warming row, or a sibling re-established + bumped the
      // epoch. Release our holder; surface supersession (NEVER touch any box).
      await release();
      throw new SandboxLeaseSupersededError(ids.sandboxGroupId, expectedEpoch);
    }
    return { leaseEpoch: committed.lease.leaseEpoch, release };
  }

  // ATTACHED / REARMED: the lease is live. There is no box to resume — just carry
  // the lease epoch (same-session turns are serialized, so a concurrent 'warming'
  // spawner on this group is not expected; the machine session is independent of the
  // lease state regardless).
  return { leaseEpoch: acquired.lease.leaseEpoch, release };
}

/**
 * Poll a warming lease until the spawner commits warm. If the warming row is
 * reset to cold (the spawner died and the reaper reset it), surface supersession
 * so the turn is re-dispatched and can enter the normal spawner branch from
 * acquireLease. Bounded by OPENGENI_SANDBOX_WARMING_TIMEOUT_MS, not the lease TTL.
 */
async function waitForWarm(
  services: SandboxResumeServices,
  ids: ResumeBoxIds,
): Promise<{ leaseEpoch: number }> {
  const { db, settings } = services;
  const deadline = Date.now() + settings.sandboxWarmingTimeoutMs;
  while (Date.now() < deadline) {
    await sleep(WARMING_POLL_INTERVAL_MS);
    const lease = await readLease(db, ids.workspaceId, ids.sandboxGroupId);
    if (!lease) {
      // Lease vanished (cold-reaped). Re-dispatch from scratch.
      throw new SandboxLeaseSupersededError(ids.sandboxGroupId, 0);
    }
    if (lease.liveness === "warm") {
      return { leaseEpoch: lease.leaseEpoch };
    }
    if (lease.liveness === "draining") {
      // The warming attempt either failed into drain or committed+released before
      // this waiter observed it. Re-dispatch so acquireLease can re-arm or spawn
      // through the normal path.
      throw new SandboxLeaseSupersededError(ids.sandboxGroupId, lease.leaseEpoch);
    }
    if (lease.liveness === "cold") {
      // The spawner died; re-dispatch so the normal acquireLease path can win
      // cold->warming and run the full spawner branch.
      throw new SandboxLeaseSupersededError(ids.sandboxGroupId, lease.leaseEpoch);
    }
    // still warming — keep polling.
  }
  throw new SandboxWarmingTimeoutError(ids.backend, settings.sandboxWarmingTimeoutMs);
}
