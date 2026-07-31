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

import { randomUUID } from "node:crypto";
import {
  accrueWarmSeconds,
  adoptLegacyModalCheckpointArtifact,
  confirmDrainCold,
  appendSessionEventToSandboxGroup,
  bindRetainedProcessProviderIdentity,
  claimWorkspaceArchiveCapture,
  claimSandboxCheckpointArtifactsForGc,
  claimTerminalRetainedProcesses,
  countActiveRetainedProcessesByOwnerState,
  countSandboxCheckpointArtifactsByState,
  countExpiredDrainingSandboxLeases,
  countQueuedTurns,
  countSandboxLeasesByLiveness,
  deferRetainedProcessReconciliation,
  forceDrainOverLimitViewerOnlyBoxes,
  getBillingBalance,
  listCreditBalancesByAccount,
  listLegacyModalCheckpointSlots,
  listLiveModalSandboxLeaseAttributions,
  listMeterableWarmLeases,
  listSandboxViewerForceDrainWorkspaceIds,
  markSandboxCheckpointArtifactDeletePending,
  persistDrainSnapshot,
  pruneDeletedSandboxCheckpointArtifacts,
  registerSandboxCheckpointArtifact,
  recordRetainedProcessReconciliationProof,
  releaseWorkspaceArchiveCapture,
  replaceExpiredWorkspaceArchiveCapture,
  readLease,
  reapExpiredSessionListSnapshots,
  reapStaleLeaseHoldersGlobal,
  requestDueSandboxRotationsGlobal,
  readSandboxRotationBacklog,
  retainedProcessReconciliationProof,
  retainedProcessSettlementIdentity,
  settleSandboxCheckpointArtifactGc,
  rlsContextForWorkspace,
  settleRetainedProcess,
  type MeterableWarmLease,
  type ReapDrainable,
  type RetainedProcessProviderProof,
  type SandboxRetainedProcess,
  type LeaseSnapshot,
} from "@opengeni/db";
import { sandboxArchiveCaptureTimeoutMs, sandboxWarmRateMicrosPerSecond } from "@opengeni/config";
import {
  // Normal drain teardown builds the client and resumes the envelope directly:
  // a live box gets its /workspace persisted before termination, while a gone
  // box is typed as provider loss. Stale capture reconciliation separately uses
  // establishSandboxSessionFromEnvelope in strict resume-only mode so it can
  // reuse the runtime's provider-ready proof without ever cold-restoring.
  captureVerifiedWorkspaceArchive,
  createSandboxClientForBackend,
  deleteModalCheckpointSnapshot,
  deserializeSandboxSessionStateEnvelope,
  establishSandboxSessionFromEnvelope,
  inspectModalSandboxLifecycle,
  isExecSessionLostBanner,
  isProviderSandboxNotFoundError,
  parseExecBannerExitCode,
  resolveModalCheckpointProviderBindingForLiveSandbox,
  resolveModalCheckpointProviderBinding,
  resolveModalCheckpointProviderBindingForSession,
  sandboxCommandExitCode,
  sandboxCommandStillRunning,
  sweepModalOrphanSandboxes,
  terminateModalSandboxById,
  verifySandboxExecReadiness,
  type ModalOrphanSweepTermination,
  type ModalCheckpointProviderBinding,
  type WorkspaceArchiveDescriptor,
} from "@opengeni/runtime";
import type { ActivityServices } from "./types";
import { reconcilePendingParentSystemUpdates } from "./parent-wake";
import {
  recordCreditBalanceGauges,
  recordCreditMicros,
  recordExpiredDrainingSandboxLeaseGauges,
  recordRetainedProcessInventoryGauges,
  recordRetainedProcessReconciliation,
  recordSandboxCheckpointArtifactGauges,
  recordSandboxCheckpointArtifactOutcome,
  recordSandboxDeadlineRotationsRequested,
  type RetainedProcessReconciliationOutcome,
  recordSandboxLeaseGauges,
  recordSandboxOrphansTerminated,
  recordSandboxRotationBacklogGauges,
  recordTurnsQueuedGauge,
} from "../observability-metrics";
import { providerIdentityFromResumeState } from "../sandbox-routing";

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
 * `wrote:false` means the CAS missed (re-armed / newer epoch / vanished). The
 * box is wanted again, so the seam MUST NOT terminate it. Provider-native
 * deletion is owned independently by artifact-ledger GC.
 *
 * Pass null for archiveBase64 to CAS-check WITHOUT writing (re-arm guard for
 * backends with no persistWorkspace — ensures a re-arm during the snapshot window
 * aborts the terminate before client.delete()).
 */
export type PersistArchiveFn = (
  archiveBase64: string | null,
  archiveMetadata?: WorkspaceArchiveDescriptor,
  providerSession?: unknown,
  providerBinding?: Awaited<
    ReturnType<typeof resolveModalCheckpointProviderBindingForSession>
  > | null,
) => Promise<{
  wrote: boolean;
  archiveRevision?: string | null;
}>;

export type ProviderTerminationOutcome = {
  /** false means an epoch/refcount CAS proved the box was re-armed, so it was
   *  deliberately left running and the cold commit must not execute. */
  terminated: boolean;
  /** True only when a definitive provider NotFound proved the cloud box had
   *  already vanished before this drain could capture its workspace. */
  providerMissingBeforeCapture: boolean;
};

/** The provider-terminate seam. Production wires the real resume-by-id ->
 *  persistWorkspace -> persist-onto-lease (epoch-fenced) -> snapshot-GC ->
 *  provider stop() (`terminateProviderBox`); a unit test injects a spy so the
 *  drain/CAS logic is exercised against a real DB without a live provider box.
 *  Test seams may return the legacy boolean shorthand. Production returns the
 *  typed outcome so the cold commit can distinguish a clean stop from definitive
 *  provider disappearance before capture. */
export type TerminateBoxFn = (
  settings: ActivityServices["settings"],
  lease: NonNullable<Awaited<ReturnType<typeof readLease>>>,
  observability: ActivityServices["observability"],
  persistArchive: PersistArchiveFn,
) => Promise<boolean | ProviderTerminationOutcome>;

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
  /** Override only the read-only provider process probe. The canonical DB
   * settlement remains real in tests and production. */
  probeRetainedProcess?: RetainedProcessProbeFn;
  /** Observe a historical Modal box after its lease row has advanced to a
   * successor identity. Lifecycle-only; a live box remains ambiguous. */
  inspectHistoricalModalSandbox?: HistoricalModalSandboxLifecycleProbeFn;
  /** Override the read-only exact-instance readiness probe used before the
   * reaper settles blockers for a provider that has definitively vanished. */
  probeDrainableProvider?: DrainableProviderProbeFn;
};

export type RetainedProcessProbeResult =
  | { status: "proved"; proof: RetainedProcessProviderProof }
  | {
      status: "binding";
      providerBindingKey: string;
      providerBinding: ModalCheckpointProviderBinding;
    }
  | {
      status: "deferred";
      reason:
        | "identity_mismatch"
        | "resume_state_missing"
        | "backend_unsupported"
        | "provider_running"
        | "provider_unknown"
        | "provider_timeout"
        | "provider_error"
        | "provider_binding_missing"
        | "provider_binding_mismatch";
    };

export type RetainedProcessProbeFn = (
  settings: ActivityServices["settings"],
  lease: LeaseSnapshot,
  process: SandboxRetainedProcess,
) => Promise<RetainedProcessProbeResult>;

export type HistoricalModalSandboxLifecycleProbeFn = typeof inspectModalSandboxLifecycle;

export type DrainableProviderProbeFn = (
  settings: ActivityServices["settings"],
  lease: LeaseSnapshot,
) => Promise<"ready" | "missing">;

export const RETAINED_PROCESS_RECONCILIATION_LIMIT = 20;
export const RETAINED_PROCESS_RECONCILIATION_CLAIM_TTL_MS = 5 * 60_000;
export const RETAINED_PROCESS_PROVIDER_PROBE_TIMEOUT_MS = 5_000;

export function createSandboxLeaseActivities(
  services: () => Promise<ActivityServices>,
  options: SandboxLeaseActivityOptions = {},
) {
  const terminateBox: TerminateBoxFn = options.terminateBox ?? terminateProviderBox;
  const sweepModalOrphans: SweepModalOrphansFn =
    options.sweepModalOrphans ?? sweepModalOrphansForConfiguredBackend;
  const probeRetainedProcess = options.probeRetainedProcess ?? probeRetainedProcessAtProvider;
  const probeDrainableProvider = options.probeDrainableProvider ?? probeDrainableProviderReadiness;
  /**
   * The one global reaper sweep. Idempotent; concurrency-safe with itself.
   * Gated by the caller (the Schedule is only registered when
   * sandboxOwnershipEnabled); a defensive no-op here too so a manual trigger
   * with the flag off can never terminate a box.
   */
  async function reapSandboxLeases(): Promise<ReapSandboxLeasesResult> {
    const service = await services();
    const { db, settings, observability } = service;
    const parentUpdates = await reconcilePendingParentSystemUpdates(service, 100).catch((error) => {
      observability.warn("system-update outbox reconciliation failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { claimed: 0, delivered: 0, failed: 1 };
    });
    const expiredSessionListSnapshots = await reapExpiredSessionListSnapshots(db, 500).catch(
      (error) => {
        observability.warn("session-list snapshot reconciliation failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return 0;
      },
    );
    if (expiredSessionListSnapshots > 0) {
      observability.info("expired session-list snapshots reaped", {
        deleted: expiredSessionListSnapshots,
      });
    }
    if (!settings.sandboxOwnershipEnabled) {
      if (parentUpdates.claimed > 0) {
        observability.info("system-update outbox reconciled", parentUpdates);
      }
      return {
        examined: 0,
        terminated: 0,
        skipped: 0,
        metered: 0,
        forceDrained: 0,
        modalOrphansTerminated: 0,
      };
    }
    await refreshQueueLeaseAndCreditGauges(db, observability);

    const rotationsRequested = await requestDueSandboxRotationsGlobal(
      db,
      settings.sandboxRotationLeadMs,
      settings.sandboxRotationBatchSize,
    ).catch((error) => {
      observability.warn("sandbox reaper: provider-deadline rotation request failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    });
    recordSandboxDeadlineRotationsRequested(observability, rotationsRequested);

    // (0) Warm-meter tick (P2.1) — accrue warm-seconds for every WARM viewer-only
    // box (turn-held boxes meter on the turn heartbeat, so the list fn excludes
    // them). GROUP+epoch+tick idempotent → a shared box is one stream; an
    // overlapping/re-fired sweep cannot double-charge. Best-effort per row.
    const metered = await accrueWarmTick(db, settings, observability);

    // (0b) Per-workspace warm-cap + force-drain (P2.1) — under the usage lock, a
    // workspace at 0 balance / over its warm cap force-drains its VIEWER-ONLY
    // boxes (guarded turn_holders=0 — a paying turn is NEVER killed). The newly
    // draining rows are caught by the same sweep's terminate below.
    const forceDrainWorkspaceIds = new Set<string>();
    if (
      settings.billingMode === "stripe" ||
      settings.usageLimitsMode === "managed" ||
      settings.sandboxMaxWarmSecondsPerWorkspace > 0
    ) {
      for (const workspaceId of metered.workspaceIds) {
        forceDrainWorkspaceIds.add(workspaceId);
      }
    }
    try {
      for (const workspaceId of await listSandboxViewerForceDrainWorkspaceIds(db)) {
        forceDrainWorkspaceIds.add(workspaceId);
      }
    } catch (error) {
      observability.warn("sandbox reaper: viewer force-drain workspace read failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const forceDrained = await forceDrainOverLimitWorkspaces(
      db,
      settings,
      forceDrainWorkspaceIds,
      observability,
    );

    // (0c) Terminal-owner retained-process reconciliation. Owner state selects
    // only a bounded inspection batch; exact provider exit/loss proof is
    // checkpointed before canonical settlement. Ambiguous, running, timed-out,
    // unsupported, and transient provider states preserve every durable row.
    await reconcileTerminalRetainedProcesses(
      db,
      settings,
      observability,
      probeRetainedProcess,
      options.inspectHistoricalModalSandbox ?? inspectModalSandboxLifecycle,
    );

    // (1) The DB-only cross-workspace sweep. Returns the drainable rows.
    const drainable: ReapDrainable[] = await reapStaleLeaseHoldersGlobal(db, {
      viewerHolderTtlMs: settings.sandboxViewerHolderTtlMs,
      // Dead-worker turn holders: a live holder is touched every 10s from the
      // moment it is registered (resumeBoxForTurn's holder-liveness loop covers
      // the whole warmup — waitForWarm/establish/display-stack — and the turn
      // heartbeat covers the run), so NO live path is ever silent for more than
      // one tick. The horizon is deliberately generous defense-in-depth (not a
      // tuned guess about path lengths): a killed worker's frozen holder —
      // which would otherwise pin refcount >= 1 FOREVER, so the lease never
      // drains and the box dies at the provider hard-timeout UNPERSISTED —
      // clears within ~12 minutes.
      turnHolderTtlMs: settings.sandboxWarmingTimeoutMs + settings.sandboxLeaseTtlMs,
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
        const drainedCold = await terminateDrainableBox(
          db,
          settings,
          row,
          observability,
          terminateBox,
          probeDrainableProvider,
        );
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

    const checkpointGc = await gcSandboxCheckpointArtifacts(db, settings, observability).catch(
      (error) => {
        observability.warn("sandbox reaper: checkpoint artifact GC failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return { claimed: 0, deleted: 0, failed: 0 };
      },
    );

    await refreshQueueLeaseAndCreditGauges(db, observability);

    if (
      drainable.length > 0 ||
      metered.accrued > 0 ||
      forceDrained > 0 ||
      modalOrphansTerminated > 0 ||
      rotationsRequested > 0 ||
      checkpointGc.claimed > 0
    ) {
      observability.info("sandbox reaper swept", {
        drainable: drainable.length,
        terminated,
        skipped,
        metered: metered.accrued,
        forceDrained,
        modalOrphansTerminated,
        rotationsRequested,
        checkpointArtifactsClaimed: checkpointGc.claimed,
        checkpointArtifactsDeleted: checkpointGc.deleted,
        checkpointArtifactsFailed: checkpointGc.failed,
      });
    }

    return {
      examined: drainable.length,
      terminated,
      skipped,
      metered: metered.accrued,
      forceDrained,
      modalOrphansTerminated,
    };
  }

  return { reapSandboxLeases };
}

const CHECKPOINT_GC_LIMIT = 50;
const CHECKPOINT_GC_CLAIM_TTL_MS = 10 * 60_000;
const CHECKPOINT_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60_000;
const CHECKPOINT_TOMBSTONE_PRUNE_LIMIT = 500;

async function gcSandboxCheckpointArtifacts(
  db: ActivityServices["db"],
  settings: ActivityServices["settings"],
  observability: ActivityServices["observability"],
): Promise<{ claimed: number; deleted: number; failed: number }> {
  // Explicit OPENGENI_MODAL_TOKEN_* settings are optional: the SDK also supports
  // an operator-provisioned Modal profile. Durable artifacts must not become
  // immortal merely because credentials arrive through that supported path.
  const adopted = await adoptLegacyModalCheckpointReceipts(db, settings, observability).catch(
    (error) => {
      observability.warn("sandbox reaper: legacy Modal checkpoint discovery failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    },
  );
  if (adopted > 0) {
    recordSandboxCheckpointArtifactOutcome(observability, "legacy_adopted", adopted);
    observability.info("sandbox reaper: adopted legacy Modal checkpoint receipts", { adopted });
  }
  const claimId = crypto.randomUUID();
  const claims = await claimSandboxCheckpointArtifactsForGc(db, {
    claimId,
    limit: CHECKPOINT_GC_LIMIT,
    claimTtlMs: CHECKPOINT_GC_CLAIM_TTL_MS,
  });
  recordSandboxCheckpointArtifactOutcome(observability, "claimed", claims.length);
  let deleted = 0;
  let failed = 0;
  for (const claim of claims) {
    try {
      if (claim.providerBackend !== "modal") {
        throw new Error(`Unsupported checkpoint provider ${claim.providerBackend}`);
      }
      await deleteModalCheckpointSnapshot(settings, claim.providerBindingKey, claim.objectId);
      const settled = await settleSandboxCheckpointArtifactGc(db, {
        artifactId: claim.id,
        claimId,
        deleted: true,
        retryAfterMs: 1_000,
      });
      if (settled) {
        deleted += 1;
        recordSandboxCheckpointArtifactOutcome(observability, "deleted");
      }
    } catch (error) {
      failed += 1;
      recordSandboxCheckpointArtifactOutcome(observability, "delete_failed");
      const retryAfterMs = Math.min(
        6 * 60 * 60_000,
        5_000 * 2 ** Math.min(claim.deleteAttempts, 17),
      );
      await settleSandboxCheckpointArtifactGc(db, {
        artifactId: claim.id,
        claimId,
        deleted: false,
        error: error instanceof Error ? error.message : String(error),
        retryAfterMs,
      }).catch(() => false);
      observability.warn("sandbox reaper: checkpoint artifact delete failed", {
        artifactId: claim.id,
        providerBackend: claim.providerBackend,
        objectKind: claim.objectKind,
        attempt: claim.deleteAttempts,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const pruned = await pruneDeletedSandboxCheckpointArtifacts(
    db,
    CHECKPOINT_TOMBSTONE_RETENTION_MS,
    CHECKPOINT_TOMBSTONE_PRUNE_LIMIT,
  );
  recordSandboxCheckpointArtifactOutcome(observability, "tombstone_pruned", pruned);
  return { claimed: claims.length, deleted, failed };
}

async function adoptLegacyModalCheckpointReceipts(
  db: ActivityServices["db"],
  settings: ActivityServices["settings"],
  observability: ActivityServices["observability"],
): Promise<number> {
  const slots = await listLegacyModalCheckpointSlots(db, 25);
  if (slots.length === 0) return 0;
  const bindings = new Map<
    string,
    Promise<Awaited<ReturnType<typeof resolveModalCheckpointProviderBindingForLiveSandbox>>>
  >();
  let adopted = 0;
  for (const slot of slots) {
    try {
      let binding = bindings.get(slot.instanceId);
      if (!binding) {
        binding = resolveModalCheckpointProviderBindingForLiveSandbox(settings, slot.instanceId);
        bindings.set(slot.instanceId, binding);
      }
      const resolvedBinding = await binding;
      if (
        await adoptLegacyModalCheckpointArtifact(db, {
          accountId: slot.accountId,
          workspaceId: slot.workspaceId,
          sandboxGroupId: slot.sandboxGroupId,
          leaseId: slot.leaseId,
          leaseEpoch: slot.leaseEpoch,
          workspaceGeneration: slot.workspaceGeneration,
          slot: slot.slot,
          archiveBase64: slot.archiveBase64,
          descriptor: slot.descriptor,
          providerBindingKey: resolvedBinding.key,
          providerBinding: resolvedBinding.binding,
        })
      ) {
        adopted += 1;
      }
    } catch (error) {
      observability.warn("sandbox reaper: legacy Modal checkpoint adoption failed", {
        workspaceId: slot.workspaceId,
        sandboxGroupId: slot.sandboxGroupId,
        slot: slot.slot,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return adopted;
}

async function reconcileTerminalRetainedProcesses(
  db: ActivityServices["db"],
  settings: ActivityServices["settings"],
  observability: ActivityServices["observability"],
  probe: RetainedProcessProbeFn,
  inspectHistoricalModalSandbox: HistoricalModalSandboxLifecycleProbeFn,
): Promise<void> {
  const claimId = crypto.randomUUID();
  let claims: Awaited<ReturnType<typeof claimTerminalRetainedProcesses>>;
  try {
    claims = await claimTerminalRetainedProcesses(db, {
      claimId,
      limit: RETAINED_PROCESS_RECONCILIATION_LIMIT,
      claimTtlMs: RETAINED_PROCESS_RECONCILIATION_CLAIM_TTL_MS,
    });
  } catch (error) {
    recordRetainedProcessReconciliation(observability, "claim_failed");
    observability.warn("sandbox reaper: retained-process claim failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  for (const claim of claims) {
    let process = claim.process;
    const expected = retainedProcessSettlementIdentity(process);
    let proof = retainedProcessReconciliationProof(process);
    if (!proof) {
      let observation: RetainedProcessProbeResult | null = null;

      // Legacy rows created before provider bindings existed are adoptable only
      // when the exact historical sandbox resolves in the configured Modal
      // namespace. NotFound is ambiguous here: it can mean either deletion or
      // credential rotation, so it never creates ownership or loss proof.
      if (
        process.providerBackend === "modal" &&
        process.routeTargetId === null &&
        !process.providerBindingKey
      ) {
        try {
          const lifecycle = await withRetainedProcessProbeTimeout(
            inspectHistoricalModalSandbox(settings, process.providerInstanceId, null),
          );
          if (lifecycle.status === "not_found") {
            observation = { status: "deferred", reason: "provider_binding_missing" };
          } else {
            process = await bindRetainedProcessProviderIdentity(db, {
              accountId: process.accountId,
              workspaceId: process.workspaceId,
              sessionId: process.sessionId,
              processId: process.id,
              expected,
              claimId: claim.claimId,
              providerBindingKey: lifecycle.providerBindingKey,
              providerBinding: lifecycle.providerBinding,
            });
            recordRetainedProcessReconciliation(observability, "provider_binding_adopted");
            if (lifecycle.status === "terminated") {
              observation = {
                status: "proved",
                proof: {
                  outcome: "lost",
                  exitCode: null,
                  reason: "provider_instance_terminated",
                },
              };
            }
          }
        } catch (error) {
          observation = {
            status: "deferred",
            reason:
              error === RETAINED_PROCESS_PROBE_TIMEOUT ? "provider_timeout" : "provider_error",
          };
        }
      }

      if (observation === null) {
        const lease = await readLease(db, process.workspaceId, process.sandboxGroupId).catch(
          () => null,
        );
        const currentLeaseIdentityMatches =
          Boolean(lease) &&
          lease!.id === process.leaseId &&
          lease!.leaseEpoch === process.leaseEpoch &&
          lease!.backend === process.providerBackend &&
          lease!.instanceId === process.providerInstanceId &&
          process.routeTargetId === null;
        if (!currentLeaseIdentityMatches) {
          // The lease may already be cold or belong to a successor. Its current
          // resume envelope cannot interrogate the historical process, but a
          // bound process can safely inspect the exact old Modal sandbox id.
          if (process.providerBackend !== "modal" || process.routeTargetId !== null) {
            observation = { status: "deferred", reason: "identity_mismatch" };
          } else {
            try {
              const lifecycle = await withRetainedProcessProbeTimeout(
                inspectHistoricalModalSandbox(
                  settings,
                  process.providerInstanceId,
                  process.providerBindingKey,
                ),
              );
              observation =
                lifecycle.status === "not_found"
                  ? {
                      status: "proved",
                      proof: {
                        outcome: "lost",
                        exitCode: null,
                        reason: "provider_instance_not_found",
                      },
                    }
                  : lifecycle.status === "terminated"
                    ? {
                        status: "proved",
                        proof: {
                          outcome: "lost",
                          exitCode: null,
                          reason: "provider_instance_terminated",
                        },
                      }
                    : { status: "deferred", reason: "identity_mismatch" };
            } catch (error) {
              observation = {
                status: "deferred",
                reason:
                  error === RETAINED_PROCESS_PROBE_TIMEOUT ? "provider_timeout" : "provider_error",
              };
            }
          }
        } else {
          try {
            observation = await probe(settings, lease!, process);
          } catch (error) {
            observability.warn("sandbox reaper: retained-process provider probe failed", {
              processId: process.id,
              providerBackend: process.providerBackend,
              error: error instanceof Error ? error.message : String(error),
            });
            observation = { status: "deferred", reason: "provider_error" };
          }
        }
      }
      if (observation.status === "binding") {
        try {
          process = await bindRetainedProcessProviderIdentity(db, {
            accountId: process.accountId,
            workspaceId: process.workspaceId,
            sessionId: process.sessionId,
            processId: process.id,
            expected,
            claimId: claim.claimId,
            providerBindingKey: observation.providerBindingKey,
            providerBinding: observation.providerBinding,
          });
          recordRetainedProcessReconciliation(observability, "provider_binding_adopted");
          observation = { status: "deferred", reason: "provider_running" };
        } catch (error) {
          observability.warn("sandbox reaper: retained-process binding adoption failed", {
            processId: process.id,
            error: error instanceof Error ? error.message : String(error),
          });
          observation = { status: "deferred", reason: "provider_error" };
        }
      }
      if (observation.status === "deferred") {
        await deferRetainedProcessClaim(
          db,
          settings,
          observability,
          process,
          expected,
          claim.claimId,
          observation.reason,
        );
        continue;
      }
      try {
        process = await recordRetainedProcessReconciliationProof(db, {
          accountId: process.accountId,
          workspaceId: process.workspaceId,
          sessionId: process.sessionId,
          processId: process.id,
          expected,
          claimId: claim.claimId,
          proof: observation.proof,
        });
        proof = observation.proof;
        recordRetainedProcessReconciliation(observability, `proof_${proof.outcome}`);
      } catch (error) {
        recordRetainedProcessReconciliation(observability, "proof_checkpoint_failed");
        observability.warn("sandbox reaper: retained-process proof checkpoint failed", {
          processId: process.id,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
    }

    try {
      await settleRetainedProcess(db, {
        accountId: process.accountId,
        workspaceId: process.workspaceId,
        sessionId: process.sessionId,
        processId: process.id,
        expected,
        reconciliationClaimId: claim.claimId,
        outcome: proof.outcome,
        exitCode: proof.exitCode,
        reason: proof.reason,
        idleGraceMs: settings.sandboxIdleGraceMs,
      });
      recordRetainedProcessReconciliation(observability, `settled_${proof.outcome}`);
    } catch (error) {
      recordRetainedProcessReconciliation(observability, "settlement_failed");
      observability.warn("sandbox reaper: retained-process settlement failed", {
        processId: process.id,
        error: error instanceof Error ? error.message : String(error),
      });
      await deferRetainedProcessClaim(
        db,
        settings,
        observability,
        process,
        expected,
        claim.claimId,
        "settlement_failed",
      );
    }
  }
}

async function deferRetainedProcessClaim(
  db: ActivityServices["db"],
  settings: ActivityServices["settings"],
  observability: ActivityServices["observability"],
  process: SandboxRetainedProcess,
  expected: ReturnType<typeof retainedProcessSettlementIdentity>,
  claimId: string,
  outcome: RetainedProcessReconciliationOutcome,
): Promise<void> {
  const exponent = Math.min(4, Math.max(0, process.reconcileAttempts - 1));
  const retryAfterMs = Math.min(
    5 * 60_000,
    Math.max(settings.sandboxLeaseReaperPeriodMs, 30_000) * 2 ** exponent,
  );
  try {
    await deferRetainedProcessReconciliation(db, {
      accountId: process.accountId,
      workspaceId: process.workspaceId,
      sessionId: process.sessionId,
      processId: process.id,
      expected,
      claimId,
      outcome,
      retryAfterMs,
    });
    recordRetainedProcessReconciliation(observability, outcome);
  } catch (error) {
    recordRetainedProcessReconciliation(observability, "defer_failed");
    observability.warn("sandbox reaper: retained-process defer failed", {
      processId: process.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

type RetainedProcessProbeClient = {
  backendId: string;
  resume?: (state: unknown) => Promise<unknown>;
  deserializeSessionState?: (state: Record<string, unknown>) => Promise<unknown>;
};

type RetainedProcessProbeSession = {
  writeStdin?: (args: {
    sessionId: number;
    chars: string;
    yieldTimeMs: number;
    maxOutputTokens: number;
  }) => Promise<unknown>;
};

const RETAINED_PROCESS_PROBE_TIMEOUT = Symbol("retained-process-provider-probe-timeout");

async function withRetainedProcessProbeTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(RETAINED_PROCESS_PROBE_TIMEOUT),
          RETAINED_PROCESS_PROVIDER_PROBE_TIMEOUT_MS,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function probeRetainedProcessAtProvider(
  settings: ActivityServices["settings"],
  lease: LeaseSnapshot,
  process: SandboxRetainedProcess,
): Promise<RetainedProcessProbeResult> {
  if (
    lease.id !== process.leaseId ||
    lease.sandboxGroupId !== process.sandboxGroupId ||
    lease.leaseEpoch !== process.leaseEpoch ||
    lease.backend !== process.providerBackend ||
    lease.instanceId !== process.providerInstanceId ||
    lease.resumeBackendId !== process.providerBackend ||
    process.routeTargetId !== null
  ) {
    return { status: "deferred", reason: "identity_mismatch" };
  }
  if (!lease.resumeState) {
    return { status: "deferred", reason: "resume_state_missing" };
  }
  const envelopeBackend = (lease.resumeState as { backendId?: unknown }).backendId;
  if (envelopeBackend !== undefined && envelopeBackend !== process.providerBackend) {
    return { status: "deferred", reason: "identity_mismatch" };
  }
  if (providerIdentityFromResumeState(lease.resumeState) !== process.providerInstanceId) {
    return { status: "deferred", reason: "identity_mismatch" };
  }

  let configuredModalBinding: Awaited<
    ReturnType<typeof resolveModalCheckpointProviderBinding>
  > | null = null;
  if (process.providerBackend === "modal" && process.providerBindingKey) {
    try {
      configuredModalBinding = await withRetainedProcessProbeTimeout(
        resolveModalCheckpointProviderBinding(settings),
      );
    } catch (error) {
      return {
        status: "deferred",
        reason: error === RETAINED_PROCESS_PROBE_TIMEOUT ? "provider_timeout" : "provider_error",
      };
    }
    if (configuredModalBinding.key !== process.providerBindingKey) {
      return { status: "deferred", reason: "provider_binding_mismatch" };
    }
  }

  let client: RetainedProcessProbeClient | undefined;
  try {
    client = createSandboxClientForBackend(process.providerBackend as never, settings) as
      | RetainedProcessProbeClient
      | undefined;
  } catch {
    return { status: "deferred", reason: "provider_error" };
  }
  if (!client || client.backendId !== process.providerBackend || !client.resume) {
    return { status: "deferred", reason: "backend_unsupported" };
  }
  const envelopeSessionState =
    (lease.resumeState as { sessionState?: unknown }).sessionState ?? lease.resumeState;
  let resumedState: unknown;
  try {
    resumedState = await deserializeSandboxSessionStateEnvelope(
      client as never,
      envelopeSessionState,
    );
  } catch {
    return { status: "deferred", reason: "provider_error" };
  }
  if (resumedState === undefined) {
    return { status: "deferred", reason: "resume_state_missing" };
  }

  let session: RetainedProcessProbeSession;
  try {
    session = (await withRetainedProcessProbeTimeout(
      client.resume(resumedState),
    )) as RetainedProcessProbeSession;
  } catch (error) {
    if (error === RETAINED_PROCESS_PROBE_TIMEOUT) {
      return { status: "deferred", reason: "provider_timeout" };
    }
    if (isProviderSandboxNotFoundError(client.backendId, error)) {
      if (process.providerBackend === "modal" && !process.providerBindingKey) {
        return { status: "deferred", reason: "provider_binding_missing" };
      }
      return {
        status: "proved",
        proof: {
          outcome: "lost",
          exitCode: null,
          reason: "provider_instance_not_found",
        },
      };
    }
    return { status: "deferred", reason: "provider_error" };
  }
  if (typeof session.writeStdin !== "function") {
    return { status: "deferred", reason: "backend_unsupported" };
  }
  if (process.providerBackend === "modal") {
    let liveBinding: Awaited<ReturnType<typeof resolveModalCheckpointProviderBindingForSession>>;
    try {
      liveBinding = await withRetainedProcessProbeTimeout(
        resolveModalCheckpointProviderBindingForSession(settings, session),
      );
    } catch (error) {
      return {
        status: "deferred",
        reason: error === RETAINED_PROCESS_PROBE_TIMEOUT ? "provider_timeout" : "provider_error",
      };
    }
    if (!process.providerBindingKey) {
      return {
        status: "binding",
        providerBindingKey: liveBinding.key,
        providerBinding: liveBinding.binding,
      };
    }
    if (
      liveBinding.key !== process.providerBindingKey ||
      configuredModalBinding?.key !== process.providerBindingKey
    ) {
      return { status: "deferred", reason: "provider_binding_mismatch" };
    }
  }

  let result: unknown;
  try {
    result = await withRetainedProcessProbeTimeout(
      session.writeStdin({
        sessionId: process.providerSessionId,
        chars: "",
        yieldTimeMs: 1_000,
        maxOutputTokens: 2_000,
      }),
    );
  } catch (error) {
    if (error === RETAINED_PROCESS_PROBE_TIMEOUT) {
      return { status: "deferred", reason: "provider_timeout" };
    }
    if (isProviderSandboxNotFoundError(client.backendId, error)) {
      if (process.providerBackend === "modal" && !process.providerBindingKey) {
        return { status: "deferred", reason: "provider_binding_missing" };
      }
      return {
        status: "proved",
        proof: {
          outcome: "lost",
          exitCode: null,
          reason: "provider_instance_not_found",
        },
      };
    }
    return { status: "deferred", reason: "provider_error" };
  }
  const observation = classifyRetainedProcessPollResult(result, process.providerSessionId);
  if (
    observation.status === "deferred" &&
    observation.reason === "provider_running" &&
    lease.rotationRequestedAt !== null
  ) {
    // A background PTY cannot outlive the finite provider box. Interrupt only
    // this exact durable provider session after rotation admission is fenced;
    // settlement still requires an exit/loss banner on this or a later sweep.
    try {
      const interrupted = await withRetainedProcessProbeTimeout(
        session.writeStdin({
          sessionId: process.providerSessionId,
          chars: "\u0003",
          yieldTimeMs: 1_000,
          maxOutputTokens: 2_000,
        }),
      );
      return classifyRetainedProcessPollResult(interrupted, process.providerSessionId);
    } catch (error) {
      if (isProviderSandboxNotFoundError(client.backendId, error)) {
        if (process.providerBackend === "modal" && !process.providerBindingKey) {
          return { status: "deferred", reason: "provider_binding_missing" };
        }
        return {
          status: "proved",
          proof: {
            outcome: "lost",
            exitCode: null,
            reason: "provider_instance_not_found",
          },
        };
      }
      return {
        status: "deferred",
        reason: error === RETAINED_PROCESS_PROBE_TIMEOUT ? "provider_timeout" : "provider_error",
      };
    }
  }
  return observation;
}

/** Classify only exact SDK control banners. Arbitrary output, malformed text,
 * and a running marker are observations to retry; none is physical exit proof. */
export function classifyRetainedProcessPollResult(
  result: unknown,
  providerSessionId: number,
): RetainedProcessProbeResult {
  if (typeof result !== "string") {
    return { status: "deferred", reason: "provider_unknown" };
  }
  if (isExecSessionLostBanner(result, providerSessionId)) {
    return {
      status: "proved",
      proof: {
        outcome: "lost",
        exitCode: null,
        reason: "provider_session_lost_banner",
      },
    };
  }
  const exitCode = parseExecBannerExitCode(result);
  if (exitCode !== null) {
    return {
      status: "proved",
      proof: { outcome: "exited", exitCode, reason: "provider_exit_banner" },
    };
  }
  return {
    status: "deferred",
    reason: result.includes("Process running with session ID")
      ? "provider_running"
      : "provider_unknown",
  };
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
    recordSandboxCheckpointArtifactGauges(
      observability,
      await countSandboxCheckpointArtifactsByState(db),
    );
  } catch (error) {
    observability.warn("sandbox reaper: checkpoint-artifact gauge refresh failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    recordSandboxRotationBacklogGauges(observability, await readSandboxRotationBacklog(db));
  } catch (error) {
    observability.warn("sandbox reaper: rotation-backlog gauge refresh failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    recordRetainedProcessInventoryGauges(
      observability,
      await countActiveRetainedProcessesByOwnerState(db),
    );
  } catch (error) {
    observability.warn("sandbox reaper: retained-process gauge refresh failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    recordExpiredDrainingSandboxLeaseGauges(
      observability,
      await countExpiredDrainingSandboxLeases(db),
    );
  } catch (error) {
    observability.warn("sandbox reaper: expired-draining gauge refresh failed", {
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
  const enforceBalance =
    settings.billingMode === "stripe" || settings.usageLimitsMode === "managed";
  const cap = settings.sandboxMaxWarmSecondsPerWorkspace;
  let forceDrained = 0;
  for (const workspaceId of workspaceIds) {
    try {
      const { accountId } = await rlsContextForWorkspace(db, workspaceId);
      const balance = enforceBalance
        ? await getBillingBalance(db, accountId)
        : ({ balanceMicros: 1 } as { balanceMicros: number });
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

export function modalOrphanTerminationStillEligible(
  latest: Awaited<ReturnType<typeof listLiveModalSandboxLeaseAttributions>>,
  candidate: ModalOrphanSweepTermination,
): boolean {
  if (latest.some((lease) => lease.instanceId === candidate.sandboxId)) {
    return false;
  }
  const leaseId = candidate.tags.opengeni_lease_id;
  const workspaceId = candidate.tags.opengeni_workspace_id;
  const sandboxGroupId = candidate.tags.opengeni_sandbox_group_id;
  if (!leaseId || !workspaceId || !sandboxGroupId) {
    return true;
  }
  const activeAttribution = latest.find(
    (lease) =>
      lease.leaseId === leaseId &&
      lease.workspaceId === workspaceId &&
      lease.sandboxGroupId === sandboxGroupId,
  );
  return Boolean(
    !activeAttribution ||
    (activeAttribution.instanceId !== null && activeAttribution.instanceId !== candidate.sandboxId),
  );
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

  const result = await sweepModalOrphanSandboxes(settings, liveLeases, {
    revalidateTermination: async (candidate) => {
      const latest = await listLiveModalSandboxLeaseAttributions(db);
      return modalOrphanTerminationStillEligible(latest, candidate);
    },
  });
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
 * A capture claim whose owning worker disappeared must not fence a workspace
 * forever. The drain reaper reaches this seam only after every holder is gone.
 * It resumes the exact attributed provider without replacement and proves that
 * a no-op command can execute. A paused snapshot cannot pass that proof; a
 * missing provider is returned as typed loss; every ambiguous error preserves
 * the old claim for the next sweep.
 */
async function probeDrainableProviderReadiness(
  settings: ActivityServices["settings"],
  lease: LeaseSnapshot,
): Promise<"ready" | "missing"> {
  if (!lease.instanceId || !lease.resumeState) {
    throw new Error("Expired workspace capture has no resumable provider identity");
  }
  const backend = (lease.resumeBackendId ?? lease.backend) as string;
  let established: Awaited<ReturnType<typeof establishSandboxSessionFromEnvelope>>;
  try {
    established = await establishSandboxSessionFromEnvelope(settings, lease.resumeState, {
      sessionId: `sandbox-capture-recovery:${lease.sandboxGroupId}`,
      recovery: "resume-only",
      backendOverride: backend as never,
    });
  } catch (error) {
    if (isProviderSandboxNotFoundError(backend, error)) return "missing";
    throw error;
  }
  if (established.instanceId !== lease.instanceId) {
    throw new Error("Expired workspace capture resumed a different provider instance");
  }
  try {
    if (established.backendId === "modal") {
      await verifySandboxExecReadiness(established, RETAINED_PROCESS_PROVIDER_PROBE_TIMEOUT_MS);
      return "ready";
    }
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
    if (!run) throw new Error("Expired workspace capture provider has no readiness command");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      run.call(session, { cmd: "true", yieldTimeMs: 1_000, maxOutputTokens: 1_000 }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Expired workspace capture readiness probe timed out")),
          RETAINED_PROCESS_PROVIDER_PROBE_TIMEOUT_MS,
        );
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    if (sandboxCommandStillRunning(result) || sandboxCommandExitCode(result) !== 0) {
      throw new Error("Expired workspace capture provider is not command-ready");
    }
    return "ready";
  } catch (error) {
    if (isProviderSandboxNotFoundError(backend, error)) return "missing";
    throw error;
  }
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
  probeDrainableProvider: DrainableProviderProbeFn,
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
    lease.liveness !== "draining" ||
    lease.refcount !== 0 ||
    lease.leaseEpoch !== row.leaseEpoch
  ) {
    // Re-armed (warm again) / a newer epoch / already drained by a concurrent
    // sweep. Skip — provider stop() must fire ONLY past the drain grace at
    // refcount=0 on the box we observed, never while a turn or viewer holds it.
    return false;
  }

  const captureTimeoutMs = sandboxArchiveCaptureTimeoutMs(settings);
  let captureClaim:
    | NonNullable<
        Extract<Awaited<ReturnType<typeof claimWorkspaceArchiveCapture>>, { status: "claimed" }>
      >["claim"]
    | null = null;
  let providerMissingBeforeCapture = false;
  if (lease.instanceId) {
    if (lease.archiveCapture) {
      if (lease.archiveCapture.deadlineAt.getTime() > Date.now()) {
        // A live owner still holds the provider pause gate. It will release the
        // exact claim on settlement; this sweep must not compete.
        return false;
      }
      // A deadline is never evidence that a non-cancellable provider capture
      // stopped. Without an exact resume envelope there is no safe way to prove
      // the attributed provider is command-ready, so preserve the gate.
      if (!lease.resumeState) return false;
      const providerState = await probeDrainableProvider(settings, lease);
      if (providerState === "missing") {
        providerMissingBeforeCapture = true;
        captureClaim = {
          ...lease.archiveCapture,
          leaseId: lease.id,
          leaseEpoch: lease.leaseEpoch,
          instanceId: lease.instanceId,
          archiveGeneration: lease.archiveGeneration,
          archiveComplete: lease.archiveComplete,
        };
      } else {
        const replacement = await replaceExpiredWorkspaceArchiveCapture(db, {
          accountId,
          workspaceId: row.workspaceId,
          sandboxGroupId: row.sandboxGroupId,
          priorCaptureId: lease.archiveCapture.id,
          captureId: randomUUID(),
          expectedEpoch: row.leaseEpoch,
          expectedInstanceId: lease.instanceId,
          captureTimeoutMs,
        });
        if (!replacement) return false;
        captureClaim = replacement;
      }
    } else {
      const claimed = await claimWorkspaceArchiveCapture(db, {
        accountId,
        workspaceId: row.workspaceId,
        sandboxGroupId: row.sandboxGroupId,
        captureId: randomUUID(),
        expectedEpoch: row.leaseEpoch,
        expectedInstanceId: lease.instanceId,
        liveness: "draining",
        captureTimeoutMs,
        minIntervalMs: 0,
      });
      if (claimed.status === "claimed") {
        captureClaim = claimed.claim;
      } else if (claimed.status === "mutation_in_progress") {
        // An admission is normally authoritative proof that a provider
        // operation may still be running. It cannot, however, pin a draining
        // lease forever after the exact provider has disappeared. Probe the
        // attributed instance without replacement. Only typed NotFound permits
        // the cold commit to reject the exact stale admissions; a live or
        // ambiguous provider remains fenced for a later sweep.
        const providerState = await probeDrainableProvider(settings, lease);
        if (providerState !== "missing") return false;
        providerMissingBeforeCapture = true;
      } else {
        return false;
      }
    }
  }

  // The epoch-fenced PERSIST-onto-lease CAS the terminate seam calls AFTER it has
  // snapshotted the live box and BEFORE it terminates (sandbox-file-persistence).
  // Same guard as confirmDrainCold (draining AND refcount=0 AND lease_epoch=
  // expected): a re-arm or newer epoch that snuck in writes ZERO rows → wrote:false
  // → the seam leaves the box RUNNING and we skip the cold-commit below.
  // `persisted` tracks whether a real archive landed on the lease this drain —
  // the durable sandbox.box.terminated event below carries it, so a "terminated
  // with NOTHING persisted" (box already dead at drain) is visible in the DB.
  let persisted = false;
  let archiveRevision: string | null = null;
  const persistArchive: PersistArchiveFn = async (
    archiveBase64: string | null,
    archiveMetadata?: WorkspaceArchiveDescriptor,
    _providerSession?: unknown,
    providerBinding?: Awaited<
      ReturnType<typeof resolveModalCheckpointProviderBindingForSession>
    > | null,
  ) => {
    // A live persistable provider must own the exact durable capture claim.
    // Without it we cannot prove that these bytes came from a provider that was
    // admission-fenced for the full pause/capture interval.
    if (!lease.instanceId || !captureClaim) {
      return { wrote: false, archiveRevision: null };
    }
    let checkpointArtifactId: string | null = null;
    if (
      archiveBase64 &&
      archiveMetadata?.version === 2 &&
      (archiveMetadata.provider === "modal_snapshot_filesystem" ||
        archiveMetadata.provider === "modal_snapshot_directory")
    ) {
      if (!providerBinding) {
        throw new Error("Modal native snapshot has no exact session provider identity");
      }
      const candidate = await registerSandboxCheckpointArtifact(db, {
        accountId,
        workspaceId: row.workspaceId,
        sandboxGroupId: row.sandboxGroupId,
        sourceLeaseId: lease.id,
        sourceLeaseEpoch: row.leaseEpoch,
        sourceInstanceId: lease.instanceId,
        sourceWorkspaceGeneration: captureClaim.workspaceGeneration,
        providerBindingKey: providerBinding.key,
        providerBinding: providerBinding.binding,
        workspaceArchive: archiveBase64,
        workspaceArchiveMeta: archiveMetadata,
      });
      checkpointArtifactId = candidate.id;
    }
    const baseInput = {
      accountId,
      workspaceId: row.workspaceId,
      sandboxGroupId: row.sandboxGroupId,
      expectedEpoch: row.leaseEpoch,
      expectedInstanceId: lease.instanceId,
      expectedWorkspaceGeneration: captureClaim.workspaceGeneration,
      captureId: captureClaim.id,
    };
    let result: Awaited<ReturnType<typeof persistDrainSnapshot>>;
    if (archiveBase64 === null) {
      result = await persistDrainSnapshot(db, { ...baseInput, workspaceArchive: null });
    } else {
      if (!archiveMetadata) {
        throw new Error("Sandbox snapshot publication requires a verified archive descriptor");
      }
      result = await persistDrainSnapshot(db, {
        ...baseInput,
        workspaceArchive: archiveBase64,
        workspaceArchiveMeta: archiveMetadata,
        ...(checkpointArtifactId ? { checkpointArtifactId } : {}),
      });
    }
    if (!result.wrote && checkpointArtifactId) {
      await markSandboxCheckpointArtifactDeletePending(db, {
        accountId,
        workspaceId: row.workspaceId,
        artifactId: checkpointArtifactId,
        reason: "drain_snapshot_publication_fenced",
      }).catch(() => undefined);
    }
    if (result.wrote && archiveBase64 !== null) {
      persisted = true;
      archiveRevision = result.archiveRevision;
    }
    return result;
  };

  // Resume-by-id -> verified capture -> persist-onto-lease -> provider
  // terminate. Persisting atomically hands any displaced provider snapshot to
  // the provider-bound artifact ledger; its global GC worker owns deletion.
  // Definitive NotFound before capture is a typed loss, not ordinary teardown
  // success: confirmDrainCold preserves any prior archive or marks recovery
  // unrecoverable when none exists. A genuine capture/resume failure leaves the
  // lease draining for a later sweep (NEVER terminate a box whose files we
  // could not capture). A persist CAS miss means the box was re-armed and left
  // running, so the cold commit is skipped.
  try {
    const termination: ProviderTerminationOutcome | boolean = providerMissingBeforeCapture
      ? { terminated: true, providerMissingBeforeCapture: true }
      : await terminateBox(settings, lease, observability, persistArchive);
    const terminated = typeof termination === "boolean" ? termination : termination.terminated;
    if (!terminated) {
      return false;
    }

    const providerMissing =
      providerMissingBeforeCapture ||
      (typeof termination === "boolean" ? false : termination.providerMissingBeforeCapture);
    // The authoritative commit: CAS draining->cold under the epoch fence. If a
    // late re-arm or newer epoch raced in after our re-read, wentCold:false and we
    // report a skip (the box is down; a fresh acquire cold-restores it).
    const { wentCold } = await confirmDrainCold(db, {
      accountId,
      workspaceId: row.workspaceId,
      sandboxGroupId: row.sandboxGroupId,
      expectedEpoch: row.leaseEpoch,
      providerMissingBeforeCapture: providerMissing,
    });
    if (wentCold) {
      // Durable termination record (sandbox-file-persistence observability): who
      // ended this box and whether its /workspace was captured first, appended to
      // every session sharing the group's box. Best-effort: attribution must
      // never affect the drain outcome.
      try {
        await appendSessionEventToSandboxGroup(db, row.workspaceId, row.sandboxGroupId, {
          type: "sandbox.box.terminated",
          payload: {
            actor: "reaper",
            persisted,
            archiveRevision,
            instanceId: lease.instanceId,
            providerMissingBeforeCapture: providerMissing,
          },
        });
      } catch (eventError) {
        observability.warn(
          "sandbox reaper: box-terminated event write failed (drain outcome unaffected)",
          {
            sandboxGroupId: row.sandboxGroupId,
            error: eventError instanceof Error ? eventError.message : String(eventError),
          },
        );
      }
    }
    return wentCold;
  } finally {
    if (captureClaim && lease.instanceId) {
      await releaseWorkspaceArchiveCapture(db, {
        accountId,
        workspaceId: row.workspaceId,
        sandboxGroupId: row.sandboxGroupId,
        captureId: captureClaim.id,
        expectedEpoch: row.leaseEpoch,
        expectedInstanceId: lease.instanceId,
      }).catch((error) => {
        observability.warn("sandbox reaper: archive capture gate release failed", {
          sandboxGroupId: row.sandboxGroupId,
          leaseEpoch: row.leaseEpoch,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }
}

// The persist-capable slice of a live provider session. persistWorkspace()
// snapshots /workspace (snapshot_filesystem → a Modal snapshot-ref; tar → a tar
// archive) and returns the archive bytes. The session also carries the Modal SDK
// client used to bind the snapshot receipt to the exact provider namespace.
type PersistableSession = TerminableSession & {
  persistWorkspace?: () => Promise<Uint8Array | undefined>;
};

/**
 * Resume/attach the box by id, PERSIST its /workspace, fold the snapshot onto the
 * lease under the epoch fence, hand the superseded snapshot to durable GC, THEN
 * terminate. Resumes DIRECTLY (no cold-restore fallback) so a gone box is a clean
 * no-op, never a wasteful create-then-kill:
 *   - build the client for the lease's backend;
 *   - deserialize + resume the envelope (warm reattach by id, R4-safe);
 *   - session.persistWorkspace() -> capture the /workspace archive;
 *   - persistArchive(base64) -> CAS-fold it onto the lease and atomically mark
 *     the displaced artifact delete-pending;
 *   - the provider-bound global GC deletes that object asynchronously;
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
): Promise<ProviderTerminationOutcome> {
  const backend = (lease.resumeBackendId ?? lease.backend) as string;
  // 'none' / no backend -> nothing to terminate.
  if (!backend || backend === "none") {
    return { terminated: true, providerMissingBeforeCapture: false };
  }

  // CRITICAL SAFETY (bring-your-own-compute): NEVER provider-stop
  // a selfhosted box. The "box" is a user's PHYSICAL machine — you cannot kill it,
  // and a delete()/kill() reaching the agent would be catastrophic. The reaper
  // DRAINS the lease to cold only (refcount→0 → draining → this returns true so
  // the caller's confirmDrainCold flips draining→cold) but issues NO provider stop:
  // no client is built, no resume, no persistWorkspace (the machine IS the
  // persistence — nothing to snapshot), no delete/kill. The session simply detaches;
  // the machine stays up under the agent's own process lifetime (§23.0). Checked on
  // BOTH the lease backend and the resume envelope's backend so neither path leaks.
  if (
    backend === "selfhosted" ||
    lease.backend === "selfhosted" ||
    lease.resumeBackendId === "selfhosted"
  ) {
    observability.info(
      "sandbox reaper: selfhosted lease drained to cold (NEVER provider-stopped — it is the user's machine)",
      {
        sandboxGroupId: lease.sandboxGroupId,
        backend,
      },
    );
    return { terminated: true, providerMissingBeforeCapture: false };
  }

  // A warming-death row can have a provider instance id recorded immediately
  // after create() but no resumable envelope yet. For Modal, instance_id is
  // enough to terminate directly; CAS-check first so a re-arm during the sweep
  // leaves the box running.
  if (backend === "modal" && !lease.resumeState && lease.instanceId) {
    const { wrote } = await persistArchive(null);
    if (!wrote) {
      observability.info(
        "sandbox reaper: Modal lease re-armed before direct terminate — leaving sandbox RUNNING",
        {
          sandboxGroupId: lease.sandboxGroupId,
          backend,
          instanceId: lease.instanceId,
        },
      );
      return { terminated: false, providerMissingBeforeCapture: false };
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
    // This branch is a warming-death box recorded before any resumable envelope
    // was published. It was never a ready workspace, so a missing instance does
    // not imply loss of a previously exposed workspace revision.
    return { terminated: true, providerMissingBeforeCapture: false };
  }

  // resume_state is the folded group box-envelope (the provider sessionState the
  // box was last persisted as). No envelope -> no live box to stop.
  if (!lease.resumeState) {
    return { terminated: true, providerMissingBeforeCapture: false };
  }

  const client = createClientForBackend(backend as never, settings) as TerminableClient | undefined;
  if (!client) {
    // 'none' backend resolved to no client.
    return { terminated: true, providerMissingBeforeCapture: false };
  }

  // Resume by id (warm reattach) — NO cold-restore. A NotFound here = the box is
  // already gone; success.
  let session: PersistableSession | undefined;
  let sessionState: unknown;
  try {
    if (!client.resume || !client.deserializeSessionState) {
      // A cloud backend that cannot prove provider state is not safely
      // terminable: treating this as success would cold the lease while the
      // provider may still be live. Leave it draining for a later retry.
      throw new Error(`sandbox backend ${backend} cannot resume a drainable provider box`);
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
    const resumedState = await deserializeSandboxSessionStateEnvelope(
      client as never,
      envelopeSessionState,
    );
    if (resumedState === undefined) {
      throw new Error(`sandbox backend ${backend} returned no resumable provider state`);
    }
    session = (await client.resume(resumedState)) as PersistableSession;
    sessionState = resumedState;
  } catch (error) {
    if (isProviderSandboxNotFoundError(client.backendId, error)) {
      observability.info("sandbox reaper: drainable box already gone before workspace capture", {
        sandboxGroupId: lease.sandboxGroupId,
        backend,
      });
      return { terminated: true, providerMissingBeforeCapture: true };
    }
    // Re-throw a non-NotFound resume failure so the caller SKIPS (the lease stays
    // draining for the next sweep) — never cold a box we could not prove is gone.
    throw error;
  }

  // PERSIST /workspace BEFORE terminating (sandbox-file-persistence). A failure to
  // snapshot must re-throw BEFORE any terminate so files are never lost — the next
  // sweep retries, the provider idle-timeout is the backstop. A NotFound here (the
  // box raced gone between resume and persist) is success: nothing to persist.
  let verifiedArchive: Awaited<ReturnType<typeof captureVerifiedWorkspaceArchive>> | undefined;
  const sessionWorkspacePersistence = (
    session as { state?: { workspacePersistence?: unknown } } | undefined
  )?.state?.workspacePersistence;
  const checkpointBinding =
    backend === "modal" &&
    (sessionWorkspacePersistence === "snapshot_filesystem" ||
      sessionWorkspacePersistence === "snapshot_directory")
      ? await withRetainedProcessProbeTimeout(
          resolveModalCheckpointProviderBindingForSession(settings, session),
        )
      : null;
  try {
    verifiedArchive = session?.persistWorkspace
      ? await captureVerifiedWorkspaceArchive(session)
      : undefined;
  } catch (error) {
    if (isProviderSandboxNotFoundError(client.backendId, error)) {
      observability.info("sandbox reaper: box gone during workspace capture", {
        sandboxGroupId: lease.sandboxGroupId,
        backend,
      });
      return { terminated: true, providerMissingBeforeCapture: true };
    }
    observability.warn(
      "sandbox reaper: persistWorkspace failed — leaving box draining (files NOT lost)",
      {
        sandboxGroupId: lease.sandboxGroupId,
        backend,
        error: error instanceof Error ? error.message : String(error),
      },
    );
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
  if (verifiedArchive) {
    const { wrote } = await persistArchive(
      verifiedArchive.base64,
      verifiedArchive.descriptor,
      session,
      checkpointBinding,
    );
    if (!wrote) {
      observability.info(
        "sandbox reaper: lease re-armed during persist — leaving box RUNNING (no terminate)",
        {
          sandboxGroupId: lease.sandboxGroupId,
          backend,
        },
      );
      return { terminated: false, providerMissingBeforeCapture: false };
    }
  } else {
    // A resumable cloud box that produces no verified archive cannot be safely
    // deleted: it may contain work newer than the lease's last durable revision.
    // Keep the lease draining and retry instead of knowingly discarding bytes.
    throw new Error(
      `sandbox backend ${backend} produced no verified workspace archive during drain`,
    );
  }

  // Provider terminate. Prefer the client.delete(state) teardown (the canonical
  // provider stop()); fall back to a session-level kill/terminate/close. A
  // terminate that fails because the box is already gone is success.
  try {
    if (client.delete && sessionState !== undefined) {
      await client.delete(sessionState);
      return { terminated: true, providerMissingBeforeCapture: false };
    }
    if (session?.kill) {
      await session.kill();
      return { terminated: true, providerMissingBeforeCapture: false };
    }
    if (session?.terminate) {
      await session.terminate();
      return { terminated: true, providerMissingBeforeCapture: false };
    }
    if (session?.close) {
      if (!session.closed) {
        await session.close();
      }
      return { terminated: true, providerMissingBeforeCapture: false };
    }
  } catch (error) {
    if (isProviderSandboxNotFoundError(client.backendId, error)) {
      observability.info("sandbox reaper: provider already gone during terminate", {
        sandboxGroupId: lease.sandboxGroupId,
        backend,
      });
      // Capture was already durably folded above, so this is not a
      // missing-before-capture outcome.
      return { terminated: true, providerMissingBeforeCapture: false };
    }
    throw error;
  }
  throw new Error(`sandbox backend ${backend} exposes no provider termination method`);
}
