// apps/worker/src/activities/sandbox-lease.ts — the SOLE liveness/GC/cost-stop
// driver (P1.3 / OD-3).
//
// There is exactly ONE reaper activity: `reapSandboxLeases`. It is fired by the
// ONE global reaper Temporal Schedule (registered in apps/worker/src/index.ts).
// There is NO ownerHeartbeat, NO per-session timer, NO per-RPC workflow, NO
// *ForViewer activity, NO resolveOwnerTaskQueue. Turn-holder lifecycle is bound
// to Temporal *activity* liveness (the turn activity acquires/releases the turn
// holder); a crashed founder's leaked turn holder becomes reapable via the lease
// TTL — TTL-exemption means a *live* turn is never idle-reaped, NOT that a dead
// turn's holder is immortal.
//
// One pass per fire:
//   1. reapStaleLeaseHoldersGlobal (the P1.1 SECURITY-DEFINER cross-workspace
//      sweep): TTL-reaps stale viewer holders, resets warming-death rows to cold,
//      recomputes refcounts + enters draining at refcount 0, and RETURNS the
//      drainable rows (workspace, group, instance, epoch) whose drain grace has
//      elapsed at refcount 0. DB-only — no provider call inside the sweep.
//   2. For each drainable row: resume/attach the provider box BY ID (off the
//      lease's resume envelope, via createSandboxClientForBackend +
//      establishSandboxSessionFromEnvelope), call the provider terminate, then
//      confirmDrainCold (the CAS draining->cold under the epoch fence).
//
// IDEMPOTENT + safe to run concurrently with itself: the drain CAS is guarded on
// (draining AND refcount=0 AND lease_epoch=expected). If another sweep already
// drained the row, or a late re-arm flipped it warm, or a newer epoch snuck in,
// confirmDrainCold returns wentCold:false and we skip — provider stop() fires
// ONLY when the CAS proves the box is still the draining box we observed. We
// confirm the CAS would still pass (re-read the lease) BEFORE the provider call
// so a box that was re-armed mid-sweep is never terminated out from under a live
// holder.

import {
  accrueWarmSeconds,
  confirmDrainCold,
  countQueuedTurns,
  countSandboxLeasesByLiveness,
  forceDrainOverLimitViewerOnlyBoxes,
  getBillingBalance,
  listCreditBalancesByAccount,
  listLiveModalSandboxLeaseAttributions,
  listMeterableWarmLeases,
  persistDrainSnapshot,
  readLease,
  reapStaleLeaseHoldersGlobal,
  rlsContextForWorkspace,
  type MeterableWarmLease,
  type ReapDrainable,
} from "@opengeni/db";
import { sandboxWarmRateMicrosPerSecond } from "@opengeni/config";
import {
  // The reaper attaches to the box by id to terminate it. It does NOT use
  // establishSandboxSessionFromEnvelope (which cold-RESTORES via create() on a
  // NotFound) — restoring a box just to immediately kill it is wrong. Instead it
  // builds the client + resumes the envelope DIRECTLY: a live box resumes, gets
  // its /workspace PERSISTED (snapshot/tar), then is terminated; a gone box
  // (NotFound on resume) is already down, a clean no-op.
  createSandboxClientForBackend,
  deletePriorPersistedSnapshot,
  deserializeSandboxSessionStateEnvelope,
  isProviderSandboxNotFoundError,
  sweepModalOrphanSandboxes,
  terminateModalSandboxById,
} from "@opengeni/runtime";
import type { ActivityServices } from "./types";
import {
  recordCreditBalanceGauges,
  recordCreditMicros,
  recordSandboxLeaseGauges,
  recordSandboxOrphansTerminated,
  recordTurnsQueuedGauge,
} from "../observability-metrics";

export type ReapSandboxLeasesResult = {
  /** Stale viewer holders + warming-death rows the sweep touched is folded into
   *  the DB pass; here we report the terminate outcomes. */
  examined: number;
  /** Boxes whose provider terminate fired AND whose lease went cold. */
  terminated: number;
  /** Drainable rows skipped because the CAS no longer held (re-armed / newer
   *  epoch / already drained by a concurrent sweep) — provider stop() did NOT
   *  fire. */
  skipped: number;
  /** Warm viewer-only leases that accrued warm-seconds this tick (P2.1). */
  metered: number;
  /** Viewer-only boxes force-drained because their workspace is over a limit
   *  (0 balance / over the warm cap) — turn-held boxes are never drained (P2.1). */
  forceDrained: number;
  /** Provider-side Modal orphan sandboxes terminated by the defensive sweep. */
  modalOrphansTerminated: number;
};

// The structural slice of a provider SandboxClient we need to resume-by-id and
// terminate a box. `delete(state)` is the provider's stop()/terminate (the
// runtime SandboxClient maps it to the per-provider teardown). Narrowed so this
// stays agent-loop-free.
type TerminableClient = {
  backendId: string;
  resume?: (state: unknown) => Promise<unknown>;
  deserializeSessionState?: (state: Record<string, unknown>) => Promise<unknown>;
  delete?: (state: unknown) => Promise<unknown>;
};

// A live session handle may expose a kill/terminate/close itself (some providers
// tear the box down from the session, not the client). We try the client.delete
// first (the canonical teardown), then fall back to a session-level terminator.
type TerminableSession = {
  kill?: () => Promise<unknown>;
  terminate?: () => Promise<unknown>;
  close?: () => Promise<unknown>;
  closed?: boolean;
};

type CreateSandboxClientForBackendFn = typeof createSandboxClientForBackend;

/**
 * The CAS-write the terminate seam calls to PERSIST the captured /workspace
 * archive onto the lease under the epoch fence, BEFORE the box is terminated
 * (sandbox-file-persistence). The caller (`terminateDrainableBox`) closes over
 * db/accountId/row and delegates to persistDrainSnapshot. Returns:
 *   - wrote:false  -> the CAS missed (re-armed / newer epoch / vanished). The box
 *                     is wanted again; the seam MUST NOT terminate it.
 *   - priorArchive -> the superseded archive (if any) to GC the prior snapshot.
 *
 * Pass null for archiveBase64 to CAS-check WITHOUT writing (re-arm guard for
 * backends with no persistWorkspace — ensures a re-arm during the snapshot window
 * aborts the terminate before client.delete()). priorArchive is always null in
 * this case.
 */
export type PersistArchiveFn = (
  archiveBase64: string | null,
) => Promise<{ wrote: boolean; priorArchive: string | null }>;

/** The provider-terminate seam. Production wires the real resume-by-id ->
 *  persistWorkspace -> persist-onto-lease (epoch-fenced) -> snapshot-GC ->
 *  provider stop() (`terminateProviderBox`); a unit test injects a spy so the
 *  drain/CAS logic is exercised against a real DB without a live provider box.
 *  Returns true when the box was terminated (or already gone), false when persist
 *  found the lease re-armed and the box was deliberately LEFT RUNNING. */
export type TerminateBoxFn = (
  settings: ActivityServices["settings"],
  lease: NonNullable<Awaited<ReturnType<typeof readLease>>>,
  observability: ActivityServices["observability"],
  persistArchive: PersistArchiveFn,
) => Promise<boolean>;

export type SweepModalOrphansFn = (
  settings: ActivityServices["settings"],
  db: ActivityServices["db"],
  observability: ActivityServices["observability"],
) => Promise<number>;

export type SandboxLeaseActivityOptions = {
  /** Override the provider terminate (tests spy this; defaults to the real
   *  resume-by-id + provider stop()). */
  terminateBox?: TerminateBoxFn;
  /** Override the provider-side Modal orphan sweep (tests spy this; defaults to
   *  Modal list+tag comparison when Modal is configured). */
  sweepModalOrphans?: SweepModalOrphansFn;
};

export function createSandboxLeaseActivities(
  services: () => Promise<ActivityServices>,
  options: SandboxLeaseActivityOptions = {},
) {
  const terminateBox: TerminateBoxFn = options.terminateBox ?? terminateProviderBox;
  const sweepModalOrphans: SweepModalOrphansFn = options.sweepModalOrphans ?? sweepModalOrphansForConfiguredBackend;
  /**
   * The one global reaper sweep. Idempotent; concurrency-safe with itself.
   * Gated by the caller (the Schedule is only registered when
   * sandboxOwnershipEnabled); a defensive no-op here too so a manual trigger
   * with the flag off can never terminate a box.
   */
  async function reapSandboxLeases(): Promise<ReapSandboxLeasesResult> {
    const { db, settings, observability } = await services();
    if (!settings.sandboxOwnershipEnabled) {
      return { examined: 0, terminated: 0, skipped: 0, metered: 0, forceDrained: 0, modalOrphansTerminated: 0 };
    }
    await refreshQueueLeaseAndCreditGauges(db, observability);

    // (0) Warm-meter tick (P2.1) — accrue warm-seconds for every WARM viewer-only
    // box (turn-held boxes meter on the turn heartbeat, so the list fn excludes
    // them). GROUP+epoch+tick idempotent → a shared box is one stream; an
    // overlapping/re-fired sweep cannot double-charge. Best-effort per row.
    const metered = await accrueWarmTick(db, settings, observability);

    // (0b) Per-workspace warm-cap + force-drain (P2.1) — under the usage lock, a
    // workspace at 0 balance / over its warm cap force-drains its VIEWER-ONLY
    // boxes (guarded turn_holders=0 — a paying turn is NEVER killed). The newly
    // draining rows are caught by the same sweep's terminate below.
    const forceDrained = await forceDrainOverLimitWorkspaces(db, settings, metered.workspaceIds, observability);

    // (1) The DB-only cross-workspace sweep. Returns the drainable rows.
    const drainable: ReapDrainable[] = await reapStaleLeaseHoldersGlobal(db, {
      viewerHolderTtlMs: settings.sandboxViewerHolderTtlMs,
      idleGraceMs: settings.sandboxIdleGraceMs,
    });

    let terminated = 0;
    let skipped = 0;
    let modalOrphansTerminated = 0;

    // (2) Terminate each drainable box, then CAS draining->cold. Per-row failures
    // are isolated: one box's provider error must not abort the whole sweep (the
    // next sweep retries it; the provider idle-timeout is the backstop).
    for (const row of drainable) {
      try {
        const drainedCold = await terminateDrainableBox(db, settings, row, observability, terminateBox);
        if (drainedCold) {
          terminated += 1;
        } else {
          skipped += 1;
        }
      } catch (error) {
        skipped += 1;
        observability.warn("sandbox reaper: terminate failed for drainable lease", {
          workspaceId: row.workspaceId,
          sandboxGroupId: row.sandboxGroupId,
          leaseEpoch: row.leaseEpoch,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    try {
      modalOrphansTerminated = await sweepModalOrphans(settings, db, observability);
      recordSandboxOrphansTerminated(observability, modalOrphansTerminated);
    } catch (error) {
      observability.warn("sandbox reaper: Modal orphan sweep failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    await refreshQueueLeaseAndCreditGauges(db, observability);

    if (drainable.length > 0 || metered.accrued > 0 || forceDrained > 0 || modalOrphansTerminated > 0) {
      observability.info("sandbox reaper swept", {
        drainable: drainable.length,
        terminated,
        skipped,
        metered: metered.accrued,
        forceDrained,
        modalOrphansTerminated,
      });
    }

    return { examined: drainable.length, terminated, skipped, metered: metered.accrued, forceDrained, modalOrphansTerminated };
  }

  return { reapSandboxLeases };
}

/**
 * The reaper-tick warm-meter pass (P2.1). Accrues warm-seconds for every WARM
 * viewer-only lease cross-workspace (the list fn excludes turn-held boxes — those
 * meter on the turn heartbeat). Returns the count accrued + the distinct
 * workspaces touched (so the force-drain pass only checks workspaces that have a
 * live warm box, not the whole fleet). Per-row best-effort: one row's metering
 * error must not abort the sweep.
 */
async function accrueWarmTick(
  db: ActivityServices["db"],
  settings: ActivityServices["settings"],
  observability: ActivityServices["observability"],
): Promise<{ accrued: number; workspaceIds: Set<string> }> {
  const workspaceIds = new Set<string>();
  let accrued = 0;
  let leases: MeterableWarmLease[] = [];
  try {
    leases = await listMeterableWarmLeases(db);
  } catch (error) {
    observability.warn("sandbox reaper: warm-lease read failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { accrued, workspaceIds };
  }
  for (const lease of leases) {
    workspaceIds.add(lease.workspaceId);
    try {
      const rate = sandboxWarmRateMicrosPerSecond(settings, lease.backend);
      const result = await accrueWarmSeconds(db, {
        accountId: lease.accountId,
        workspaceId: lease.workspaceId,
        sandboxGroupId: lease.sandboxGroupId,
        expectedEpoch: lease.leaseEpoch,
        warmRateMicrosPerSecond: rate,
        subjectId: lease.sandboxGroupId,
      });
      if (result.accrued) {
        accrued += 1;
      }
      recordCreditMicros(observability, "usage", result.costMicros);
    } catch (error) {
      observability.warn("sandbox reaper: warm-seconds accrual failed for lease", {
        workspaceId: lease.workspaceId,
        sandboxGroupId: lease.sandboxGroupId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { accrued, workspaceIds };
}

async function refreshQueueLeaseAndCreditGauges(
  db: ActivityServices["db"],
  observability: ActivityServices["observability"],
): Promise<void> {
  try {
    recordTurnsQueuedGauge(observability, await countQueuedTurns(db));
  } catch (error) {
    observability.warn("sandbox reaper: queued-turn gauge refresh failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    recordSandboxLeaseGauges(observability, await countSandboxLeasesByLiveness(db));
  } catch (error) {
    observability.warn("sandbox reaper: sandbox-lease gauge refresh failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    recordCreditBalanceGauges(observability, await listCreditBalancesByAccount(db));
  } catch (error) {
    observability.warn("sandbox reaper: credit-balance gauge refresh failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * The per-workspace warm-cap + force-drain pass (P2.1). For each workspace with a
 * live warm box, under the usage lock: if it is at 0 balance (when a billing /
 * managed mode is on) or over its warm cap, force-drain its VIEWER-ONLY boxes
 * (guarded turn_holders=0 — a paying turn is never killed). Returns the count of
 * viewer-only boxes force-drained. Per-workspace best-effort.
 */
async function forceDrainOverLimitWorkspaces(
  db: ActivityServices["db"],
  settings: ActivityServices["settings"],
  workspaceIds: Set<string>,
  observability: ActivityServices["observability"],
): Promise<number> {
  const enforceBalance = settings.billingMode === "stripe" || settings.usageLimitsMode === "managed";
  const cap = settings.sandboxMaxWarmSecondsPerWorkspace;
  // Nothing to enforce → skip the whole pass (no lock churn).
  if (!enforceBalance && cap <= 0) {
    return 0;
  }
  let forceDrained = 0;
  for (const workspaceId of workspaceIds) {
    try {
      const { accountId } = await rlsContextForWorkspace(db, workspaceId);
      const balance = enforceBalance ? await getBillingBalance(db, accountId) : { balanceMicros: 1 } as { balanceMicros: number };
      const result = await forceDrainOverLimitViewerOnlyBoxes(db, {
        workspaceId,
        balanceMicros: balance.balanceMicros,
        enforceBalance,
        maxWarmSecondsPerWorkspace: cap,
        idleGraceMs: settings.sandboxIdleGraceMs,
      });
      if (result.overLimit && result.drained.length > 0) {
        forceDrained += result.drained.length;
        observability.info("sandbox reaper: force-drained viewer-only boxes (over limit)", {
          workspaceId,
          reason: result.reason,
          drained: result.drained.length,
        });
      }
    } catch (error) {
      observability.warn("sandbox reaper: force-drain check failed for workspace", {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return forceDrained;
}

async function sweepModalOrphansForConfiguredBackend(
  settings: ActivityServices["settings"],
  db: ActivityServices["db"],
  observability: ActivityServices["observability"],
): Promise<number> {
  // Keep the provider-side sweep tightly scoped to deployments that have a Modal
  // app path configured. Local/docker-only workers should not attempt Modal API
  // calls just because modalAppName has a default.
  if (settings.sandboxBackend !== "modal" && !settings.modalTokenId && !settings.modalTokenSecret) {
    return 0;
  }
  let liveLeases: Awaited<ReturnType<typeof listLiveModalSandboxLeaseAttributions>>;
  try {
    liveLeases = await listLiveModalSandboxLeaseAttributions(db);
  } catch (error) {
    observability.warn("sandbox reaper: live Modal lease attribution read failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }

  const result = await sweepModalOrphanSandboxes(settings, liveLeases);
  for (const terminated of result.terminated) {
    observability.warn("sandbox reaper: terminated Modal orphan sandbox", {
      sandboxId: terminated.sandboxId,
      reason: terminated.reason,
      tags: JSON.stringify(terminated.tags),
    });
  }
  if (result.examined > 0) {
    observability.info("sandbox reaper: Modal orphan sweep completed", {
      examined: result.examined,
      terminated: result.terminated.length,
      skipped: result.skipped,
      appName: settings.modalAppName,
    });
  }
  return result.terminated.length;
}

/**
 * Terminate one drainable box by id, then CAS its lease draining->cold under the
 * epoch fence. Returns true when the lease went cold (the box is ours to stop
 * and was stopped), false when a concurrent sweep / re-arm / newer epoch means
 * we must NOT stop it (provider terminate is skipped).
 *
 * The ordering is deliberately CAS-gated on BOTH ends:
 *   - BEFORE provider terminate: re-read the lease and assert it is STILL
 *     draining at refcount 0 at the SAME epoch we observed. A re-arm (a viewer
 *     or turn arrived during the grace window) flips it back to warm and bumps
 *     no epoch but changes liveness/refcount — we skip and never touch the box.
 *   - AFTER provider terminate: confirmDrainCold's CAS (draining AND refcount=0
 *     AND lease_epoch=expected) is the authoritative commit; if it returns false
 *     a late re-arm raced us between our re-read and the stop — but the box is
 *     already torn down, so we let the next acquire cold-restore it (NEVER a
 *     double-spawn: the lease is the singleton, the box is just gone).
 */
async function terminateDrainableBox(
  db: ActivityServices["db"],
  settings: ActivityServices["settings"],
  row: ReapDrainable,
  observability: ActivityServices["observability"],
  terminateBox: TerminateBoxFn,
): Promise<boolean> {
  // Resolve the account for the RLS-scoped confirmDrainCold (the global sweep
  // returns no account_id; the workspace->account map is the bootstrap read).
  const { accountId } = await rlsContextForWorkspace(db, row.workspaceId);

  // Re-read the lease for the resume envelope AND the pre-terminate CAS guard.
  const lease = await readLease(db, row.workspaceId, row.sandboxGroupId);
  if (!lease) {
    // Lease vanished (cold-reaped by a concurrent sweep). Nothing to stop.
    return false;
  }
  if (
    lease.liveness !== "draining"
    || lease.refcount !== 0
    || lease.leaseEpoch !== row.leaseEpoch
  ) {
    // Re-armed (warm again) / a newer epoch / already drained by a concurrent
    // sweep. Skip — provider stop() must fire ONLY past the drain grace at
    // refcount=0 on the box we observed, never while a turn or viewer holds it.
    return false;
  }

  // The epoch-fenced PERSIST-onto-lease CAS the terminate seam calls AFTER it has
  // snapshotted the live box and BEFORE it terminates (sandbox-file-persistence).
  // Same guard as confirmDrainCold (draining AND refcount=0 AND lease_epoch=
  // expected): a re-arm or newer epoch that snuck in writes ZERO rows → wrote:false
  // → the seam leaves the box RUNNING and we skip the cold-commit below.
  const persistArchive: PersistArchiveFn = async (archiveBase64: string | null) =>
    await persistDrainSnapshot(db, {
      accountId,
      workspaceId: row.workspaceId,
      sandboxGroupId: row.sandboxGroupId,
      expectedEpoch: row.leaseEpoch,
      workspaceArchive: archiveBase64,
    });

  // Resume-by-id -> persistWorkspace -> persist-onto-lease -> GC prior snapshot ->
  // provider terminate. A box that is already gone (NotFound) is success (the goal
  // is "box is not running"). A genuine PERSIST failure (could not snapshot) or a
  // resume failure on a box that IS alive re-throws -> the lease stays draining for
  // the next sweep (NEVER terminate a box whose files we could not capture). A
  // persist CAS-miss (re-armed) returns false -> the box was left running; skip the
  // cold-commit so the re-armed box is not cold-leaked.
  const terminated = await terminateBox(settings, lease, observability, persistArchive);
  if (!terminated) {
    return false;
  }

  // The authoritative commit: CAS draining->cold under the epoch fence. If a
  // late re-arm or newer epoch raced in after our re-read, wentCold:false and we
  // report a skip (the box is down; a fresh acquire cold-restores it).
  const { wentCold } = await confirmDrainCold(db, {
    accountId,
    workspaceId: row.workspaceId,
    sandboxGroupId: row.sandboxGroupId,
    expectedEpoch: row.leaseEpoch,
  });
  return wentCold;
}

// The persist-capable slice of a live provider session. persistWorkspace()
// snapshots /workspace (snapshot_filesystem → a Modal snapshot-ref; tar → a tar
// archive) and returns the archive bytes. modal carries the Modal SDK client used
// for snapshot-image GC (deletePriorPersistedSnapshot reads session.modal).
type PersistableSession = TerminableSession & {
  persistWorkspace?: () => Promise<Uint8Array | undefined>;
};

/**
 * Resume/attach the box by id, PERSIST its /workspace, fold the snapshot onto the
 * lease under the epoch fence, GC the superseded snapshot, THEN terminate. Resumes
 * DIRECTLY (no cold-restore fallback) so a gone box is a clean no-op, never a
 * wasteful create-then-kill:
 *   - build the client for the lease's backend;
 *   - deserialize + resume the envelope (warm reattach by id, R4-safe);
 *   - session.persistWorkspace() -> capture the /workspace archive;
 *   - persistArchive(base64) -> CAS-fold it onto the lease (epoch-fenced);
 *   - GC the PRIOR snapshot (keep-latest-per-lease);
 *   - terminate the live handle (client.delete / session kill|terminate|close).
 *
 * Returns true when the box was terminated (or was already gone), false when the
 * persist CAS found the lease re-armed and the box was deliberately LEFT RUNNING.
 *
 * Failure discipline (NEVER lose files, NEVER leak a box):
 *   - resume NotFound -> the box is already down; SUCCESS (return true), nothing
 *     to persist, the caller colds the lease.
 *   - a transient/auth/network resume failure on a box that may be ALIVE -> throw
 *     (the caller skips; the lease stays draining for the next sweep).
 *   - a persistWorkspace failure (snapshot timeout / provider error) -> throw
 *     BEFORE any terminate, so the box is NOT torn down with un-captured files;
 *     the next sweep retries, and the provider idle-timeout is the ultimate
 *     backstop. We never terminate a box whose snapshot we could not capture.
 * For a draining lease with no envelope (a warming-death row that committed no
 * box, or a 'none'-backed group) there is no live box — a no-op (return true).
 */
export async function terminateProviderBox(
  settings: ActivityServices["settings"],
  lease: NonNullable<Awaited<ReturnType<typeof readLease>>>,
  observability: ActivityServices["observability"],
  persistArchive: PersistArchiveFn,
  createClientForBackend: CreateSandboxClientForBackendFn = createSandboxClientForBackend,
): Promise<boolean> {
  const backend = (lease.resumeBackendId ?? lease.backend) as string;
  // 'none' / no backend -> nothing to terminate.
  if (!backend || backend === "none") {
    return true;
  }

  // CRITICAL SAFETY (bring-your-own-compute, dossier §19/§21): NEVER provider-stop
  // a selfhosted box. The "box" is a user's PHYSICAL machine — you cannot kill it,
  // and a delete()/kill() reaching the agent would be catastrophic. The reaper
  // DRAINS the lease to cold only (refcount→0 → draining → this returns true so
  // the caller's confirmDrainCold flips draining→cold) but issues NO provider stop:
  // no client is built, no resume, no persistWorkspace (the machine IS the
  // persistence — nothing to snapshot), no delete/kill. The session simply detaches;
  // the machine stays up under the agent's own process lifetime (§23.0). Checked on
  // BOTH the lease backend and the resume envelope's backend so neither path leaks.
  if (backend === "selfhosted" || lease.backend === "selfhosted" || lease.resumeBackendId === "selfhosted") {
    observability.info("sandbox reaper: selfhosted lease drained to cold (NEVER provider-stopped — it is the user's machine)", {
      sandboxGroupId: lease.sandboxGroupId,
      backend,
    });
    return true;
  }

  // A warming-death row can have a provider instance id recorded immediately
  // after create() but no resumable envelope yet. For Modal, instance_id is
  // enough to terminate directly; CAS-check first so a re-arm during the sweep
  // leaves the box running.
  if (backend === "modal" && !lease.resumeState && lease.instanceId) {
    const { wrote } = await persistArchive(null);
    if (!wrote) {
      observability.info("sandbox reaper: Modal lease re-armed before direct terminate — leaving sandbox RUNNING", {
        sandboxGroupId: lease.sandboxGroupId,
        backend,
        instanceId: lease.instanceId,
      });
      return false;
    }
    try {
      await terminateModalSandboxById(settings, lease.instanceId);
    } catch (error) {
      if (!isProviderSandboxNotFoundError("modal", error)) {
        throw error;
      }
      observability.info("sandbox reaper: Modal sandbox already gone during direct terminate", {
        sandboxGroupId: lease.sandboxGroupId,
        backend,
        instanceId: lease.instanceId,
      });
    }
    return true;
  }

  // resume_state is the folded group box-envelope (the provider sessionState the
  // box was last persisted as). No envelope -> no live box to stop.
  if (!lease.resumeState) {
    return true;
  }

  const client = createClientForBackend(backend as never, settings) as TerminableClient | undefined;
  if (!client) {
    // 'none' backend resolved to no client.
    return true;
  }

  // Resume by id (warm reattach) — NO cold-restore. A NotFound here = the box is
  // already gone; success.
  let session: PersistableSession | undefined;
  let sessionState: unknown;
  try {
    if (!client.resume || !client.deserializeSessionState) {
      // A backend that cannot resume cannot be attached-to for terminate; the
      // provider idle-timeout is the backstop. No-op.
      return true;
    }
    // resume_state is the lease ENVELOPE: `{ backendId, sessionState: {
    // providerState: { sandboxId, ... }, manifest, ... } }` (the shape
    // serializeEstablishedSandboxEnvelope folds onto the lease). The provider
    // payload deserializeSandboxSessionStateEnvelope re-hydrates is the INNER
    // `sessionState` — pass the WHOLE envelope and it reads `state.providerState`
    // at the top level, finds nothing (providerState is nested under
    // `sessionState`), drops `sandboxId`, and `client.resume(state)` throws
    // "requires a persisted sandboxId". This is exactly what the working
    // resume-by-id paths (establishSandboxSessionFromEnvelope) avoid: they unwrap
    // `envelope.sessionState` first. Mirror that. (`?? lease.resumeState` keeps a
    // legacy flat envelope — providerState at the top — resumable too.)
    const envelopeSessionState =
      (lease.resumeState as { sessionState?: unknown }).sessionState ?? lease.resumeState;
    const resumedState = await deserializeSandboxSessionStateEnvelope(client as never, envelopeSessionState);
    if (resumedState === undefined) {
      return true;
    }
    session = (await client.resume(resumedState)) as PersistableSession;
    sessionState = resumedState;
  } catch (error) {
    if (isProviderSandboxNotFoundError(client.backendId, error)) {
      observability.info("sandbox reaper: drainable box already gone (NotFound on resume) — proceeding to cold", {
        sandboxGroupId: lease.sandboxGroupId,
        backend,
      });
      return true;
    }
    // Re-throw a non-NotFound resume failure so the caller SKIPS (the lease stays
    // draining for the next sweep) — never cold a box we could not prove is gone.
    throw error;
  }

  // PERSIST /workspace BEFORE terminating (sandbox-file-persistence). A failure to
  // snapshot must re-throw BEFORE any terminate so files are never lost — the next
  // sweep retries, the provider idle-timeout is the backstop. A NotFound here (the
  // box raced gone between resume and persist) is success: nothing to persist.
  let archiveBytes: Uint8Array | undefined;
  try {
    archiveBytes = session?.persistWorkspace ? await session.persistWorkspace() : undefined;
  } catch (error) {
    if (isProviderSandboxNotFoundError(client.backendId, error)) {
      observability.info("sandbox reaper: box gone during persist (NotFound) — nothing to snapshot, proceeding to cold", {
        sandboxGroupId: lease.sandboxGroupId,
        backend,
      });
      return true;
    }
    observability.warn("sandbox reaper: persistWorkspace failed — leaving box draining (files NOT lost)", {
      sandboxGroupId: lease.sandboxGroupId,
      backend,
      error: error instanceof Error ? error.message : String(error),
    });
    // NEVER terminate a box whose snapshot we could not capture.
    throw error;
  }

  // Fold the captured archive onto the lease under the epoch fence, then GC the
  // superseded snapshot. A CAS miss (wrote:false) means the lease was re-armed
  // mid-drain: the box is wanted again — DO NOT terminate it (return false; the
  // caller skips confirmDrainCold).
  //
  // Re-arm guard for no-archive path: even when persistWorkspace returned no bytes
  // (a backend with no persistWorkspace, or an empty result), we MUST still CAS-
  // check before delete(). The snapshot window (resume → persistWorkspace) can be
  // long; a late acquireLease re-arm (draining→warm, same epoch) can land in it,
  // so without this check we would delete a box the lease now treats as live. The
  // null-archive path of persistArchive does exactly this: FOR UPDATE + liveness/
  // refcount/epoch guard, no write. wrote:false → abort the terminate.
  if (archiveBytes && archiveBytes.length > 0) {
    const archiveBase64 = Buffer.from(archiveBytes).toString("base64");
    const { wrote, priorArchive } = await persistArchive(archiveBase64);
    if (!wrote) {
      observability.info("sandbox reaper: lease re-armed during persist — leaving box RUNNING (no terminate)", {
        sandboxGroupId: lease.sandboxGroupId,
        backend,
      });
      return false;
    }
    // Keep-latest-per-lease GC: best-effort delete the prior snapshot image now,
    // while the session (and its Modal client) is still live. Never throws.
    const deleted = await deletePriorPersistedSnapshot(session, priorArchive);
    if (deleted) {
      observability.info("sandbox reaper: GC'd superseded workspace snapshot", {
        sandboxGroupId: lease.sandboxGroupId,
        backend,
        snapshotId: deleted,
      });
    }
  } else {
    // No archive produced (backend has no persistWorkspace or returned empty).
    // CAS-check via persistArchive(null): if the lease was re-armed during the
    // snapshot window, wrote:false → leave the box RUNNING (abort terminate).
    const { wrote } = await persistArchive(null);
    if (!wrote) {
      observability.info("sandbox reaper: lease re-armed during snapshot window (no-archive path) — leaving box RUNNING (no terminate)", {
        sandboxGroupId: lease.sandboxGroupId,
        backend,
      });
      return false;
    }
  }

  // Provider terminate. Prefer the client.delete(state) teardown (the canonical
  // provider stop()); fall back to a session-level kill/terminate/close. A
  // terminate that fails because the box is already gone is success.
  try {
    if (client.delete && sessionState !== undefined) {
      await client.delete(sessionState);
      return true;
    }
    if (session?.kill) {
      await session.kill();
      return true;
    }
    if (session?.terminate) {
      await session.terminate();
      return true;
    }
    if (session?.close && !session.closed) {
      await session.close();
    }
  } catch (error) {
    observability.warn("sandbox reaper: provider terminate raised (box may already be gone)", {
      sandboxGroupId: lease.sandboxGroupId,
      backend,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return true;
}
