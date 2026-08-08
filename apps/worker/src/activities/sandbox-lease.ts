// apps/worker/src/activities/sandbox-lease.ts — the sole global lease inventory,
// GC and cost-stop activity set (P1.3 / OD-3).
//
// One scheduled workflow inventories at most the DB reaper's fair 500-row batch,
// then starts one durable child per exact (workspace, group, epoch). Each child
// claims, snapshots and terminates only its own provider box. Temporal's control
// worker bounds real provider concurrency; a slow or dead provider cannot hold
// the global scan or any sibling drain. Activity heartbeats make worker loss
// visible promptly, while the DB capture id remains the authoritative teardown
// fence through provider termination and the final draining->cold commit.
//
// The legacy `reapSandboxLeases` composite remains only as a direct/embedded test
// harness and executes admitted drains concurrently. There is no per-session
// timer, viewer activity, owner task queue, or provider-specific lifecycle path
// in the normal drain state machine.

import { createHash, randomUUID } from "node:crypto";
import { Context } from "@temporalio/activity";
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
  replaceWorkspaceArchiveCaptureAfterProof,
  readLease,
  reapExpiredSessionListSnapshots,
  reapStaleLeaseHoldersGlobal,
  requestDueSandboxRotationsGlobal,
  readSandboxRotationBacklog,
  workspaceArchiveCaptureDeadlineElapsed,
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
import { sandboxWarmRateMicrosPerSecond } from "@opengeni/config";
import { sandboxLeaseTelemetryKey } from "@opengeni/observability";
import {
  // Normal drain teardown builds the client and resumes the envelope directly:
  // a live box gets its /workspace persisted before termination, while a gone
  // box is typed as provider loss. Stale capture reconciliation separately uses
  // establishSandboxSessionFromEnvelope in strict resume-only mode so it can
  // reuse the runtime's provider-ready proof without ever cold-restoring.
  captureVerifiedWorkspaceArchive,
  assertConsistentSandboxProviderIdentity,
  createSandboxClientForBackend,
  deleteModalCheckpointSnapshot,
  deserializeSandboxSessionStateEnvelope,
  establishSandboxSessionFromEnvelope,
  inspectModalSandboxLifecycle,
  isExecSessionLostBanner,
  isProviderSandboxNotFoundError,
  parseExecBannerExitCode,
  prepareProviderForTeardownAfterCapture,
  providerWorkspaceCapturePolicy,
  resolveModalCheckpointProviderBindingForLiveSandbox,
  resolveModalCheckpointProviderBinding,
  resolveModalCheckpointProviderBindingForSession,
  resumeExactSandboxSession,
  sandboxProviderContinuityForState,
  sandboxBackendForSdkBackendId,
  sandboxProviderInstanceIdFromEnvelope,
  sandboxCommandExitCode,
  sandboxCommandStillRunning,
  sweepModalOrphanSandboxes,
  terminateManagedSandboxSession,
  terminateModalSandboxById,
  verifySandboxExecReadiness,
  type ModalOrphanSweepTermination,
  type ModalCheckpointProviderBinding,
  type ProviderWorkspaceCapturePolicy,
  type WorkspaceArchiveDescriptor,
} from "@opengeni/runtime/sandbox";
import {
  SANDBOX_REAPER_ACTIVITY_HEARTBEAT_INTERVAL_MS,
  SANDBOX_REAPER_CHILD_DISPATCH_LIMIT,
  type SandboxDrainActivityInput,
  type SandboxLeaseSweepMaintenanceInput,
} from "../sandbox-reaper-contract";
import { CONTROL_WORKER_MAX_CONCURRENT_ACTIVITIES } from "../concurrency";
import { assertSandboxDrainInputTiming, sandboxDrainTiming } from "../sandbox-reaper-timeout";
import type { ControlActivityServices as ActivityServices } from "./types";
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
  recordSandboxInventoryProjectionFailure,
  recordSandboxInventoryProjectionSuccess,
  type RetainedProcessReconciliationOutcome,
  type SandboxInventoryProjectionDomain,
  recordSandboxLeaseGauges,
  recordSandboxOrphansTerminated,
  recordSandboxRotationBacklogGauges,
  recordTurnsQueuedGauge,
} from "../observability-metrics";
import { providerIdentityFromResumeState } from "../sandbox-routing";

export { sandboxLeaseTelemetryKey } from "@opengeni/observability";

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

type CreateSandboxClientForBackendFn = typeof createSandboxClientForBackend;

type DrainSandboxClient = {
  backendId: string;
  resume?: (state: unknown) => Promise<unknown>;
  deserializeSessionState?: (state: Record<string, unknown>) => Promise<unknown>;
  delete?: (state: unknown) => Promise<void>;
};

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

export type DrainCaptureDisposition = "capture_required" | "archive_published";

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
  providerCaptureRequestId?: string,
  captureDisposition?: DrainCaptureDisposition,
  capturePolicy?: ProviderWorkspaceCapturePolicy | null,
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

export class SandboxProviderCaptureTimeoutError extends Error {
  readonly name = "SandboxProviderCaptureTimeoutError";

  constructor(
    public readonly sandboxGroupId: string,
    public readonly backend: string,
    public readonly timeoutMs: number,
    public readonly leaseEpoch: number,
    public readonly instanceId: string,
  ) {
    super(
      `sandbox ${sandboxGroupId} epoch ${leaseEpoch} ${backend} instance ${instanceId} ` +
        `workspace capture exceeded ${timeoutMs}ms; ` +
        "the exact durable claim remains fenced while its provider response settles",
    );
  }
}

async function awaitProviderCaptureWithLatePublication<T>(input: {
  capture: Promise<T>;
  timeoutMs: number;
  timeoutError: SandboxProviderCaptureTimeoutError;
  publishLate: (value: T) => Promise<void>;
  observeLateFailure: (error: unknown) => void;
}): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutError = input.timeoutError;
  try {
    return await Promise.race([
      input.capture,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(timeoutError), input.timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error !== timeoutError) throw error;
    // Promise cancellation is not a generic SandboxSession contract. Keep the
    // exact failed activity's result path alive in-process, but permit only the
    // durable archive publication: never provider teardown or a cold commit from
    // an activity Temporal has already rejected. A replaced claim fences this
    // callback; Modal candidates then flow to artifact-ledger GC.
    void input.capture.then(input.publishLate).catch(input.observeLateFailure);
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function startSandboxReaperHeartbeat(details: Record<string, string | number | null>): () => void {
  let context: Context;
  try {
    context = Context.current();
  } catch {
    // Direct unit/embedded harnesses intentionally run without Temporal.
    return () => undefined;
  }
  const heartbeat = (): void => {
    try {
      context.heartbeat({ ...details, heartbeatAt: new Date().toISOString() });
    } catch {
      // Heartbeat can synchronously surface Temporal cancellation. This timer
      // must never turn that into an uncaught process-level exception while an
      // already-issued provider capture/teardown is settling under its durable
      // DB claim. The activity result/cancellation boundary remains Temporal's;
      // claim recovery remains the database's.
    }
  };
  heartbeat();
  const timer = setInterval(heartbeat, SANDBOX_REAPER_ACTIVITY_HEARTBEAT_INTERVAL_MS);
  if ("unref" in timer && typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}

export type SandboxLeaseSweepPlan = {
  drainable: ReapDrainable[];
  timeoutClass: SandboxDrainActivityInput["timeoutClass"];
  snapshotTimeoutMs: number;
  captureTimeoutMs: number;
  /** Deadline rotations admitted immediately before inventory, so zero-holder
   * boxes enter the same sweep instead of paying another schedule period. */
  rotationsRequested: number;
};

export type SandboxLeaseSweepMaintenanceResult = {
  metered: number;
  forceDrained: number;
  rotationsRequested: number;
  modalOrphansTerminated: number;
};

export type SandboxDrainActivityResult = { status: "terminated" | "skipped" };

type SandboxDrainCaptureAttempt = {
  operationId: string;
  captureId: string;
  attempt: number;
  /** Durable child input, frozen when the workflow was created. Never
   * re-derive this from a later deployment's config/formula. */
  captureTimeoutMs: number;
};

class SandboxDrainRecoveryDeferredError extends Error {
  readonly name = "SandboxDrainRecoveryDeferredError";
}

/** Stable UUID per logical operation + Temporal attempt. Attempt one uses the
 * operation id itself; later attempts are SHA-256-derived UUIDv5-shaped values.
 * This makes the DB receipt idempotent even if an activity delivery is replayed. */
export function sandboxDrainCaptureId(operationId: string, attempt: number): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(operationId)) {
    throw new Error("Sandbox drain operation id is invalid");
  }
  if (!Number.isSafeInteger(attempt) || attempt <= 0) {
    throw new Error("Sandbox drain activity attempt is invalid");
  }
  if (attempt === 1) return operationId.toLowerCase();
  const bytes = createHash("sha256")
    .update(`opengeni:sandbox-drain:${operationId.toLowerCase()}:${attempt}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sandboxDrainActivityAttempt(): number {
  try {
    const attempt = Context.current().info.attempt;
    return Number.isSafeInteger(attempt) && attempt > 0 ? attempt : 1;
  } catch {
    return 1;
  }
}

export function createSandboxLeaseActivities(
  services: () => Promise<ActivityServices>,
  options: SandboxLeaseActivityOptions = {},
) {
  const terminateBox: TerminateBoxFn =
    options.terminateBox ??
    (async (
      settings,
      lease,
      observability,
      persistArchive,
      providerCaptureRequestId,
      captureDisposition,
      capturePolicy,
    ) =>
      await terminateProviderBox(
        settings,
        lease,
        observability,
        persistArchive,
        createSandboxClientForBackend,
        terminateModalSandboxById,
        providerCaptureRequestId,
        captureDisposition,
        capturePolicy,
      ));
  const sweepModalOrphans: SweepModalOrphansFn =
    options.sweepModalOrphans ?? sweepModalOrphansForConfiguredBackend;
  const probeRetainedProcess = options.probeRetainedProcess ?? probeRetainedProcessAtProvider;
  const probeDrainableProvider = options.probeDrainableProvider ?? probeDrainableProviderReadiness;
  async function prepareSandboxLeaseSweep(): Promise<SandboxLeaseSweepPlan> {
    const stopHeartbeat = startSandboxReaperHeartbeat({ phase: "prepare" });
    try {
      const { db, settings, observability } = await services();
      const timing = sandboxDrainTiming(settings);
      if (!settings.sandboxOwnershipEnabled) {
        return {
          drainable: [],
          timeoutClass: timing.timeoutClass,
          snapshotTimeoutMs: timing.snapshotTimeoutMs,
          captureTimeoutMs: timing.captureTimeoutMs,
          rotationsRequested: 0,
        };
      }

      // Admit finite-lifetime rotations immediately before inventory. The DB
      // function is bounded and provider-I/O-free; a due zero-holder box becomes
      // draining there and is therefore dispatched in THIS sweep, eliminating
      // the old extra schedule-period availability gap. Failure is isolated: the
      // inventory must still dispatch every row that was already drainable.
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

      // Keep the remaining dispatch-critical path to one bounded DB inventory.
      // Billing, reconciliation, provider-orphan cleanup, artifact GC, and gauges
      // run only after every drainable box has its own durable child.
      const drainableInventory = await reapStaleLeaseHoldersGlobal(db, {
        viewerHolderTtlMs: settings.sandboxViewerHolderTtlMs,
        // Dead-worker turn holders: a live holder is touched every 10s from the
        // moment it is registered (resumeBoxForTurn's holder-liveness loop covers
        // the whole warmup — waitForWarm/establish/display-stack — and the turn
        // heartbeat covers the run), so NO live path is ever silent for more than
        // one tick. The ordinary warm lease TTL is therefore already a generous
        // dead-worker horizon. Canonical holders whose turn is durably closed are
        // removed immediately by the DB function; no path-duration guess belongs
        // in this lifecycle contract.
        turnHolderTtlMs: settings.sandboxLeaseTtlMs,
        idleGraceMs: settings.sandboxIdleGraceMs,
      });
      const drainable = drainableInventory.slice(0, SANDBOX_REAPER_CHILD_DISPATCH_LIMIT);
      if (drainableInventory.length > drainable.length) {
        observability.info("sandbox reaper: drain inventory continues next sweep", {
          admitted: drainable.length,
          deferred: drainableInventory.length - drainable.length,
        });
      }
      return {
        drainable,
        timeoutClass: timing.timeoutClass,
        snapshotTimeoutMs: timing.snapshotTimeoutMs,
        captureTimeoutMs: timing.captureTimeoutMs,
        rotationsRequested,
      };
    } finally {
      stopHeartbeat();
    }
  }

  async function drainSandboxLease(
    input: SandboxDrainActivityInput,
  ): Promise<SandboxDrainActivityResult> {
    const stopHeartbeat = startSandboxReaperHeartbeat({
      phase: "drain",
      workspaceId: input.target.workspaceId,
      sandboxGroupId: input.target.sandboxGroupId,
      leaseEpoch: input.target.leaseEpoch,
      instanceId: input.target.instanceId,
    });
    try {
      const { db, settings, observability } = await services();
      if (!settings.sandboxOwnershipEnabled) return { status: "skipped" };
      assertSandboxDrainInputTiming(input);
      const drainSettings =
        settings.sandboxSnapshotTimeoutMs === input.snapshotTimeoutMs
          ? settings
          : { ...settings, sandboxSnapshotTimeoutMs: input.snapshotTimeoutMs };
      const row = input.target;
      const activityAttempt = sandboxDrainActivityAttempt();
      const captureAttempt: SandboxDrainCaptureAttempt = {
        operationId: input.operationId,
        captureId: sandboxDrainCaptureId(input.operationId, activityAttempt),
        attempt: activityAttempt,
        captureTimeoutMs: input.captureTimeoutMs,
      };
      try {
        const drainedCold = await terminateDrainableBox(
          db,
          drainSettings,
          row,
          observability,
          terminateBox,
          probeDrainableProvider,
          captureAttempt,
        );
        return { status: drainedCold ? "terminated" : "skipped" };
      } catch (error) {
        const lease = await readLease(db, row.workspaceId, row.sandboxGroupId).catch(() => null);
        const details = {
          sandboxLeaseKey: sandboxLeaseTelemetryKey(row.workspaceId, row.sandboxGroupId),
          workspaceId: row.workspaceId,
          sandboxGroupId: row.sandboxGroupId,
          leaseEpoch: row.leaseEpoch,
          backend: lease?.backend ?? "unknown",
          instanceId: lease?.instanceId ?? row.instanceId,
          captureId: lease?.archiveCapture?.id ?? null,
          captureOperationId: lease?.archiveCapture?.operationId ?? input.operationId,
          captureAttempt: lease?.archiveCapture?.attempt ?? activityAttempt,
          timeoutClass: input.timeoutClass,
          error: error instanceof Error ? error.message : String(error),
        };
        if (error instanceof SandboxDrainRecoveryDeferredError) {
          observability.info("sandbox reaper: per-sandbox recovery deferred safely", details);
        } else {
          observability.warn("sandbox reaper: per-sandbox drain failed", details);
        }
        throw error;
      }
    } finally {
      stopHeartbeat();
    }
  }

  async function maintainSandboxLeaseSweep(
    input: SandboxLeaseSweepMaintenanceInput,
  ): Promise<SandboxLeaseSweepMaintenanceResult> {
    const stopHeartbeat = startSandboxReaperHeartbeat({
      phase: "maintain",
      examined: input.examined,
      started: input.started,
    });
    try {
      const service = await services();
      const { db, settings, observability } = service;
      const parentUpdates = await reconcilePendingParentSystemUpdates(service, 100).catch(
        (error) => {
          observability.warn("system-update outbox reconciliation failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          return { claimed: 0, delivered: 0, failed: 1 };
        },
      );
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
      if (parentUpdates.claimed > 0) {
        observability.info("system-update outbox reconciled", parentUpdates);
      }

      let metered = 0;
      let forceDrained = 0;
      const rotationsRequested = input.rotationsRequested;
      let modalOrphansTerminated = 0;
      if (!settings.sandboxOwnershipEnabled) {
        // Inventory remains useful while provider ownership is intentionally
        // disabled, and this scheduled activity is its single projection owner.
        await refreshQueueLeaseAndCreditGauges(db, observability);
        return {
          metered,
          forceDrained,
          rotationsRequested,
          modalOrphansTerminated,
        };
      }

      // Warm metering and cost-stop run after current drain children launch.
      // Freshly force-drained billing rows are admission-fenced immediately and
      // receive their own provider child on the next bounded schedule tick.
      const meterResult = await accrueWarmTick(db, settings, observability);
      metered = meterResult.accrued;
      const forceDrainWorkspaceIds = new Set<string>();
      if (
        settings.billingMode === "stripe" ||
        settings.usageLimitsMode === "managed" ||
        settings.sandboxMaxWarmSecondsPerWorkspace > 0
      ) {
        for (const workspaceId of meterResult.workspaceIds) {
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
      forceDrained = await forceDrainOverLimitWorkspaces(
        db,
        settings,
        forceDrainWorkspaceIds,
        observability,
      );

      // Terminal-owner process reconciliation is ancillary to lease dispatch.
      // Exact provider proof is durably checkpointed before settlement; every
      // ambiguous outcome remains claimed/deferred for another sweep.
      await reconcileTerminalRetainedProcesses(
        db,
        settings,
        observability,
        probeRetainedProcess,
        options.inspectHistoricalModalSandbox ?? inspectModalSandboxLifecycle,
      );

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
        input.examined > 0 ||
        metered > 0 ||
        forceDrained > 0 ||
        modalOrphansTerminated > 0 ||
        rotationsRequested > 0 ||
        checkpointGc.claimed > 0
      ) {
        observability.info("sandbox reaper dispatched", {
          drainable: input.examined,
          childrenStarted: input.started,
          childrenAlreadyRunning: input.alreadyRunning,
          childrenStartFailed: input.startFailed,
          metered,
          forceDrained,
          modalOrphansTerminated,
          rotationsRequested,
          checkpointArtifactsClaimed: checkpointGc.claimed,
          checkpointArtifactsDeleted: checkpointGc.deleted,
          checkpointArtifactsFailed: checkpointGc.failed,
        });
      }

      return {
        metered,
        forceDrained,
        rotationsRequested,
        modalOrphansTerminated,
      };
    } finally {
      stopHeartbeat();
    }
  }

  /** Direct/embedded compatibility harness. Production uses the split Temporal
   * workflow above. The production activity is also the rolling-deploy bridge:
   * its workflow command stays byte-for-byte compatible while this activity
   * starts V2 through the injected client edge. Old workers may still execute
   * the bounded composite during rollout; exact DB claims keep both paths safe. */
  async function reapSandboxLeases(): Promise<ReapSandboxLeasesResult> {
    const service = await services();
    if (service.startSandboxReaperWorkflow) {
      const dispatch = await service.startSandboxReaperWorkflow();
      service.observability.info("sandbox reaper routed to versioned workflow", {
        dispatch,
      });
      return {
        examined: 0,
        terminated: 0,
        skipped: 0,
        metered: 0,
        forceDrained: 0,
        modalOrphansTerminated: 0,
      };
    }

    const plan = await prepareSandboxLeaseSweep();
    const admitted = plan.drainable.slice(0, CONTROL_WORKER_MAX_CONCURRENT_ACTIVITIES);
    const outcomes = await Promise.allSettled(
      admitted.map((target) =>
        drainSandboxLease({
          target,
          timeoutClass: plan.timeoutClass,
          snapshotTimeoutMs: plan.snapshotTimeoutMs,
          captureTimeoutMs: plan.captureTimeoutMs,
          operationId: randomUUID(),
        }),
      ),
    );
    const terminated = outcomes.filter(
      (outcome) => outcome.status === "fulfilled" && outcome.value.status === "terminated",
    ).length;
    const skipped = outcomes.length - terminated;
    const maintenance = await maintainSandboxLeaseSweep({
      examined: admitted.length,
      started: admitted.length,
      alreadyRunning: 0,
      startFailed: 0,
      rotationsRequested: plan.rotationsRequested,
    });
    return {
      examined: admitted.length,
      terminated,
      skipped,
      metered: maintenance.metered,
      forceDrained: maintenance.forceDrained,
      modalOrphansTerminated: maintenance.modalOrphansTerminated,
    };
  }

  return {
    prepareSandboxLeaseSweep,
    drainSandboxLease,
    maintainSandboxLeaseSweep,
    reapSandboxLeases,
  };
}

const CHECKPOINT_GC_LIMIT = 50;
const CHECKPOINT_GC_CLAIM_TTL_MS = 10 * 60_000;
const CHECKPOINT_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60_000;
const CHECKPOINT_TOMBSTONE_PRUNE_LIMIT = 500;
const SANDBOX_MAINTENANCE_ITEM_CONCURRENCY = 8;

async function forEachWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  visit: (value: T, index: number) => Promise<void>,
): Promise<void> {
  if (values.length === 0) return;
  const workerCount = Math.min(values.length, Math.max(1, Math.floor(concurrency)));
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        await visit(values[index]!, index);
      }
    }),
  );
}

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
  await forEachWithConcurrency(claims, SANDBOX_MAINTENANCE_ITEM_CONCURRENCY, async (claim) => {
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
  });
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
  await forEachWithConcurrency(slots, SANDBOX_MAINTENANCE_ITEM_CONCURRENCY, async (slot) => {
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
  });
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
            observation = {
              status: "deferred",
              reason: "provider_binding_missing",
            };
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
      process.providerInstanceId,
    );
  } catch {
    return { status: "deferred", reason: "provider_error" };
  }
  if (resumedState === undefined) {
    return { status: "deferred", reason: "resume_state_missing" };
  }

  let session: RetainedProcessProbeSession;
  try {
    const resumed = await withRetainedProcessProbeTimeout(
      resumeExactSandboxSession(
        client,
        process.providerBackend,
        resumedState,
        process.providerInstanceId,
      ),
    );
    session = resumed.session as RetainedProcessProbeSession;
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
  }
  await forEachWithConcurrency(leases, SANDBOX_MAINTENANCE_ITEM_CONCURRENCY, async (lease) => {
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
  });
  return { accrued, workspaceIds };
}

async function refreshQueueLeaseAndCreditGauges(
  db: ActivityServices["db"],
  observability: ActivityServices["observability"],
): Promise<void> {
  await Promise.all([
    (async () => {
      try {
        recordTurnsQueuedGauge(observability, await countQueuedTurns(db));
      } catch (error) {
        observability.warn("sandbox reaper: queued-turn gauge refresh failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })(),
    refreshSandboxInventoryGauge(observability, "leases", "sandbox-lease", async () => {
      recordSandboxLeaseGauges(observability, await countSandboxLeasesByLiveness(db));
    }),
    refreshSandboxInventoryGauge(
      observability,
      "checkpoint_artifacts",
      "checkpoint-artifact",
      async () => {
        recordSandboxCheckpointArtifactGauges(
          observability,
          await countSandboxCheckpointArtifactsByState(db),
        );
      },
    ),
    refreshSandboxInventoryGauge(
      observability,
      "rotation_backlog",
      "rotation-backlog",
      async () => {
        recordSandboxRotationBacklogGauges(observability, await readSandboxRotationBacklog(db));
      },
    ),
    refreshSandboxInventoryGauge(
      observability,
      "retained_processes",
      "retained-process",
      async () => {
        recordRetainedProcessInventoryGauges(
          observability,
          await countActiveRetainedProcessesByOwnerState(db),
        );
      },
    ),
    refreshSandboxInventoryGauge(observability, "expired_drains", "expired-draining", async () => {
      recordExpiredDrainingSandboxLeaseGauges(
        observability,
        await countExpiredDrainingSandboxLeases(db),
      );
    }),
    (async () => {
      try {
        recordCreditBalanceGauges(observability, await listCreditBalancesByAccount(db));
      } catch (error) {
        observability.warn("sandbox reaper: credit-balance gauge refresh failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })(),
  ]);
}

async function refreshSandboxInventoryGauge(
  observability: ActivityServices["observability"],
  domain: SandboxInventoryProjectionDomain,
  diagnosticName: string,
  refresh: () => Promise<void>,
): Promise<void> {
  try {
    await refresh();
    recordSandboxInventoryProjectionSuccess(observability, domain);
  } catch (error) {
    recordSandboxInventoryProjectionFailure(observability, domain);
    observability.warn(`sandbox reaper: ${diagnosticName} gauge refresh failed`, {
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
  await forEachWithConcurrency(
    [...workspaceIds],
    SANDBOX_MAINTENANCE_ITEM_CONCURRENCY,
    async (workspaceId) => {
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
    },
  );
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
 * a no-op command can execute. This distinguishes typed provider loss from a
 * still-addressable instance; it does not prove that an old capture RPC has
 * stopped. The caller applies the provider's durable takeover policy and the
 * claim deadline. Ambiguity preserves the old claim and therefore the files.
 */
async function probeDrainableProviderReadiness(
  settings: ActivityServices["settings"],
  lease: LeaseSnapshot,
): Promise<"ready" | "missing"> {
  if (!lease.instanceId || !lease.resumeState) {
    throw new Error("Expired workspace capture has no resumable provider identity");
  }
  const durableBackendId = (lease.resumeBackendId ?? lease.backend) as string;
  const backend = sandboxBackendForSdkBackendId(durableBackendId) ?? durableBackendId;
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
      run.call(session, {
        cmd: "true",
        yieldTimeMs: 1_000,
        maxOutputTokens: 1_000,
      }),
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
 * The ordering is deliberately receipt-gated on BOTH ends:
 *   - BEFORE provider I/O: re-read the exact draining epoch and acquire/retain
 *     its durable capture/teardown claim. Before that claim an arrival may
 *     re-arm for availability; afterward every arrival waits and cannot race
 *     provider termination.
 *   - AFTER provider terminate: confirmDrainCold commits only the exact current
 *     capture id together with draining->cold. A miss means a recovery attempt
 *     or epoch already replaced this callback; it says nothing about provider
 *     liveness, so only that durable successor may reconcile and commit cold.
 */
async function terminateDrainableBox(
  db: ActivityServices["db"],
  settings: ActivityServices["settings"],
  row: ReapDrainable,
  observability: ActivityServices["observability"],
  terminateBox: TerminateBoxFn,
  probeDrainableProvider: DrainableProviderProbeFn,
  attempt: SandboxDrainCaptureAttempt,
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

  const durableBackendId = (lease.resumeBackendId ?? lease.backend) as string;
  const backend = sandboxBackendForSdkBackendId(durableBackendId) ?? durableBackendId;
  const managedProvider = backend !== "none" && backend !== "selfhosted";
  const capturePolicy = providerWorkspaceCapturePolicy(backend, lease.resumeState);
  if (managedProvider && !capturePolicy) {
    throw new Error(`sandbox backend ${backend} declares no workspace capture policy`);
  }
  if (capturePolicy?.liveInstance === "replaced") {
    throw new Error(
      `sandbox backend ${backend} workspace capture would replace the fenced live instance`,
    );
  }

  const captureTimeoutMs = attempt.captureTimeoutMs;
  let captureClaim:
    | NonNullable<
        Extract<Awaited<ReturnType<typeof claimWorkspaceArchiveCapture>>, { status: "claimed" }>
      >["claim"]
    | null = null;
  let providerMissingBeforeCapture = false;
  let captureDisposition: DrainCaptureDisposition = "capture_required";
  if (lease.instanceId && managedProvider) {
    if (lease.archiveCapture) {
      const priorCapture = lease.archiveCapture;
      const instanceId = lease.instanceId;
      if (priorCapture.publishedAt) {
        // Publication is an irreversible durable phase transition. The archive
        // already represents this exact fenced generation, so a crash/retry
        // resumes teardown immediately: no deadline wait, provider probe, claim
        // replacement, or duplicate snapshot request.
        captureClaim = {
          ...priorCapture,
          leaseId: lease.id,
          leaseEpoch: lease.leaseEpoch,
          instanceId,
          archiveGeneration: lease.archiveGeneration,
          archiveComplete: lease.archiveComplete,
        };
        captureDisposition = "archive_published";
      } else {
        if (
          priorCapture.operationId === attempt.operationId &&
          priorCapture.attempt >= attempt.attempt
        ) {
          // Never let an accepted duplicate/stale delivery complete the durable
          // child while its exact claim still fences the lease. Throwing asks
          // Temporal for a strictly newer attempt; an actually stale task token is
          // rejected by Temporal and cannot affect the workflow either way.
          throw new SandboxDrainRecoveryDeferredError(
            `sandbox ${row.sandboxGroupId} capture ${priorCapture.id} is owned by attempt ${priorCapture.attempt}`,
          );
        }
        const deadlineExpired = await workspaceArchiveCaptureDeadlineElapsed(db, {
          accountId,
          workspaceId: row.workspaceId,
          sandboxGroupId: row.sandboxGroupId,
          captureId: priorCapture.id,
          expectedEpoch: row.leaseEpoch,
          expectedInstanceId: instanceId,
        });
        const unpublishedWarmingProvider =
          backend === "modal" &&
          !sandboxProviderInstanceIdFromEnvelope(lease.resumeState, backend) &&
          lease.recovery.provider.status === "creating" &&
          lease.recovery.provider.instanceId === instanceId &&
          lease.recovery.workspace.status === "not_ready";
        // Temporal knows that the prior activity attempt is no longer accepted,
        // but it cannot generically cancel provider I/O. Immediate replacement is
        // legal only when BOTH the durable claim and the current adapter declare
        // takeover safety: either the same idempotent request, or an independently
        // repeatable read-only capture. A readiness probe alone never proves an
        // unrelated exclusive snapshot RPC has settled.
        const replace = async () =>
          await replaceWorkspaceArchiveCaptureAfterProof(db, {
            accountId,
            workspaceId: row.workspaceId,
            sandboxGroupId: row.sandboxGroupId,
            priorCaptureId: priorCapture.id,
            captureId: attempt.captureId,
            operationId: attempt.operationId,
            attempt: attempt.attempt,
            expectedEpoch: row.leaseEpoch,
            expectedInstanceId: instanceId,
            captureTimeoutMs,
          });

        // If no durable complete archive exists, replacement is safe only when
        // this exact provider can be recaptured. A typed missing provider before
        // the old deadline may mean the dead worker still holds the sole archive
        // bytes in memory, so preserve its callback until that bounded window.
        const currentTakeoverSafe =
          capturePolicy !== null && capturePolicy.takeover !== "exclusive";
        if (!lease.resumeState) {
          if (unpublishedWarmingProvider && priorCapture.takeoverSafe && currentTakeoverSafe) {
            const replacement = await replace();
            if (!replacement) {
              throw new SandboxDrainRecoveryDeferredError(
                `sandbox ${row.sandboxGroupId} capture ${priorCapture.id} changed during safe warming takeover`,
              );
            }
            captureClaim = replacement;
          } else {
            if (!deadlineExpired) {
              throw new SandboxDrainRecoveryDeferredError(
                `sandbox ${row.sandboxGroupId} capture ${priorCapture.id} is still within its recovery window`,
              );
            }
            if (!unpublishedWarmingProvider) {
              throw new SandboxDrainRecoveryDeferredError(
                `sandbox ${row.sandboxGroupId} capture ${priorCapture.id} has no resumable provider state`,
              );
            }
            // Legacy/unrelated owner on a never-published Modal warming box. Its
            // deadline elapsed and no user-visible workspace ever existed. Fence
            // the old callback before the by-id termination below.
            const replacement = await replace();
            if (!replacement) {
              throw new SandboxDrainRecoveryDeferredError(
                `sandbox ${row.sandboxGroupId} capture ${priorCapture.id} changed during warming takeover`,
              );
            }
            captureClaim = replacement;
          }
        } else if (priorCapture.takeoverSafe && currentTakeoverSafe) {
          // The stable lineage reuses the exact external idempotency key where
          // supported. Parallel-read adapters may instead recapture independently;
          // both cases preserve the addressed instance and cannot overlap writes.
          const replacement = await replace();
          if (!replacement) {
            throw new SandboxDrainRecoveryDeferredError(
              `sandbox ${row.sandboxGroupId} takeover-safe capture ${priorCapture.id} changed during takeover`,
            );
          }
          captureClaim = replacement;
        } else {
          if (!deadlineExpired) {
            throw new SandboxDrainRecoveryDeferredError(
              `sandbox ${row.sandboxGroupId} capture ${priorCapture.id} is still within its recovery window`,
            );
          }
          const providerState = await probeDrainableProvider(settings, lease);
          if (providerState === "missing") {
            // Take over on the DB clock before committing loss. This fences an
            // old teardown callback. Its provider-request lineage remains
            // durable so a verified late archive can still repair the cold row.
            const replacement = await replace();
            if (!replacement) {
              throw new SandboxDrainRecoveryDeferredError(
                `sandbox ${row.sandboxGroupId} capture ${priorCapture.id} changed during missing-provider takeover`,
              );
            }
            providerMissingBeforeCapture = true;
            captureClaim = replacement;
          } else {
            // An exclusive provider operation can outlive both its Temporal
            // activity and its diagnostic deadline. A live command channel says
            // nothing about whether that operation is still reading/pausing the
            // workspace. Keep the durable fence; an operator/provider-specific
            // receipt is required to resolve this deliberately fail-closed case.
            throw new SandboxDrainRecoveryDeferredError(
              `sandbox ${row.sandboxGroupId} exclusive capture ${priorCapture.id} remains ambiguous on a live provider`,
            );
          }
        }
      }
    } else {
      const claimed = await claimWorkspaceArchiveCapture(db, {
        accountId,
        workspaceId: row.workspaceId,
        sandboxGroupId: row.sandboxGroupId,
        captureId: attempt.captureId,
        operationId: attempt.operationId,
        attempt: attempt.attempt,
        expectedEpoch: row.leaseEpoch,
        expectedInstanceId: lease.instanceId,
        liveness: "draining",
        captureTimeoutMs,
        minIntervalMs: 0,
        providerReplaySafe: capturePolicy?.takeover === "same_request",
        takeoverSafe: capturePolicy !== null && capturePolicy.takeover !== "exclusive",
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
      } else if (claimed.status === "capture_in_progress") {
        // A legacy activity or a racing delivery installed the durable claim.
        // Its owner may still complete; this child remains the repair owner if
        // it does not. Completing here would recreate a schedule-sized gap.
        throw new SandboxDrainRecoveryDeferredError(
          `sandbox ${row.sandboxGroupId} acquired a concurrent capture owner`,
        );
      } else {
        return false;
      }
    }
  }

  // The epoch-fenced PERSIST-onto-lease CAS the terminate seam calls AFTER it has
  // snapshotted the live box and BEFORE it terminates (sandbox-file-persistence).
  // Same exact lease/capture guard as confirmDrainCold. A stale capture owner or
  // newer epoch writes ZERO rows → wrote:false → the seam leaves the box RUNNING
  // and skips the cold-commit below.
  // `persisted` tracks whether a real archive landed on the lease this drain —
  // the durable sandbox.box.terminated event below carries it, so a "terminated
  // with NOTHING persisted" (box already dead at drain) is visible in the DB.
  let persisted = captureDisposition === "archive_published";
  let archiveRevision: string | null =
    captureDisposition === "archive_published"
      ? (lease.recovery.archive.current?.revision ?? null)
      : null;
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
      expectedLeaseId: lease.id,
      expectedEpoch: row.leaseEpoch,
      expectedInstanceId: lease.instanceId,
      expectedWorkspaceGeneration: captureClaim.workspaceGeneration,
      captureId: captureClaim.id,
      providerRequestId: captureClaim.providerRequestId,
    };
    let result: Awaited<ReturnType<typeof persistDrainSnapshot>>;
    if (archiveBase64 === null) {
      result = await persistDrainSnapshot(db, {
        ...baseInput,
        workspaceArchive: null,
      });
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
  const termination: ProviderTerminationOutcome | boolean = providerMissingBeforeCapture
    ? { terminated: true, providerMissingBeforeCapture: true }
    : await terminateBox(
        settings,
        lease,
        observability,
        persistArchive,
        captureClaim?.providerRequestId ?? attempt.operationId,
        captureDisposition,
        capturePolicy,
      );
  const terminated = typeof termination === "boolean" ? termination : termination.terminated;
  if (!terminated) {
    return false;
  }

  const providerMissing =
    providerMissingBeforeCapture ||
    (typeof termination === "boolean" ? false : termination.providerMissingBeforeCapture);
  // The authoritative commit clears the durable capture/teardown claim together
  // with draining->cold. Until this succeeds, arrivals remain fenced by that
  // exact claim; a timestamp or a failed provider call can never reopen a box
  // while termination may still be in flight.
  const { wentCold } = await confirmDrainCold(db, {
    accountId,
    workspaceId: row.workspaceId,
    sandboxGroupId: row.sandboxGroupId,
    expectedEpoch: row.leaseEpoch,
    ...(captureClaim ? { expectedCaptureId: captureClaim.id } : {}),
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
          leaseEpoch: row.leaseEpoch,
          backend: lease.backend,
          instanceId: lease.instanceId,
          error: eventError instanceof Error ? eventError.message : String(eventError),
        },
      );
    }
  }
  return wentCold;
}

// The persist-capable slice of a live provider session. persistWorkspace()
// snapshots /workspace (snapshot_filesystem → a Modal snapshot-ref; tar → a tar
// archive) and returns the archive bytes. The session also carries the Modal SDK
// client used to bind the snapshot receipt to the exact provider namespace.
type PersistableSession = {
  state?: { workspacePersistence?: unknown };
  persistWorkspace?: (options?: { requestId: string }) => Promise<Uint8Array | undefined>;
  runPreStopHooks?: () => Promise<void>;
  preStop?: (options?: { reason?: string }) => Promise<void>;
  stop?: (options?: { reason?: string }) => Promise<void>;
  shutdown?: (options?: { reason?: string }) => Promise<void>;
  delete?: (options?: { reason?: string }) => Promise<void>;
  close?: () => Promise<void>;
};

function providerDrainLogIdentity(
  lease: LeaseSnapshot,
  backend: string,
): {
  leaseId: string;
  sandboxGroupId: string;
  leaseEpoch: number;
  backend: string;
  instanceId: string | null;
} {
  return {
    leaseId: lease.id,
    sandboxGroupId: lease.sandboxGroupId,
    leaseEpoch: lease.leaseEpoch,
    backend,
    instanceId: lease.instanceId,
  };
}

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
 *   - terminate the live handle through the standard Agents SDK lifecycle.
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
 * A provider-backed row with instance_id but no envelope is never guessed away:
 * Modal has an explicit by-id rescue adapter above; every other backend stays
 * draining until its adapter can prove termination. A truly instance-less or
 * `none`-backed row is a no-op.
 */
export async function terminateProviderBox(
  settings: ActivityServices["settings"],
  lease: NonNullable<Awaited<ReturnType<typeof readLease>>>,
  observability: ActivityServices["observability"],
  persistArchive: PersistArchiveFn,
  createClientForBackend: CreateSandboxClientForBackendFn = createSandboxClientForBackend,
  terminateModalById: typeof terminateModalSandboxById = terminateModalSandboxById,
  providerCaptureRequestId?: string,
  captureDisposition: DrainCaptureDisposition = "capture_required",
  claimedCapturePolicy?: ProviderWorkspaceCapturePolicy | null,
): Promise<ProviderTerminationOutcome> {
  const durableBackendId = (lease.resumeBackendId ?? lease.backend) as string;
  const backend = sandboxBackendForSdkBackendId(durableBackendId) ?? durableBackendId;
  const logIdentity = providerDrainLogIdentity(lease, backend);
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
        ...logIdentity,
      },
    );
    return { terminated: true, providerMissingBeforeCapture: false };
  }

  const durableCapturePolicy =
    claimedCapturePolicy ?? providerWorkspaceCapturePolicy(backend, lease.resumeState);
  if (!durableCapturePolicy) {
    throw new Error(`sandbox backend ${backend} declares no workspace capture policy`);
  }
  if (durableCapturePolicy.liveInstance !== "preserved") {
    throw new Error(
      `sandbox backend ${backend} workspace capture would replace the fenced live instance`,
    );
  }

  const persistedInstanceId = assertConsistentSandboxProviderIdentity(backend, lease.resumeState);
  // `instance_id` is the lease's authoritative provider address. A recovery
  // envelope without it is archive/config state, never permission to target a
  // provider inferred only from stale JSON. Conversely, a provider identity in
  // the envelope with no authoritative lease identity is inconsistent state:
  // fail closed instead of silently leaving a live provider behind while the
  // caller commits the lease cold.
  if (!lease.instanceId) {
    if (persistedInstanceId) {
      throw new Error(
        `sandbox backend ${backend} has persisted provider identity ${persistedInstanceId} but no authoritative lease instance; refusing teardown`,
      );
    }
    return { terminated: true, providerMissingBeforeCapture: false };
  }
  if (persistedInstanceId && persistedInstanceId !== lease.instanceId) {
    throw new Error(
      `sandbox backend ${backend} lease instance ${lease.instanceId} does not match persisted provider identity ${persistedInstanceId}; refusing teardown`,
    );
  }

  // A warming-death row can have a provider instance id recorded immediately
  // after create() but no resumable envelope yet. For Modal, instance_id is
  // enough to terminate directly; CAS-check first so a re-arm during the sweep
  // leaves the box running.
  const isUnpublishedWarmingProvider =
    backend === "modal" &&
    !persistedInstanceId &&
    lease.recovery.provider.status === "creating" &&
    lease.recovery.provider.instanceId === lease.instanceId &&
    lease.recovery.workspace.status === "not_ready";
  if (isUnpublishedWarmingProvider) {
    const { wrote } = await persistArchive(null);
    if (!wrote) {
      observability.info(
        "sandbox reaper: Modal lease re-armed before direct terminate — leaving sandbox RUNNING",
        {
          ...logIdentity,
        },
      );
      return { terminated: false, providerMissingBeforeCapture: false };
    }
    try {
      await terminateModalById(settings, lease.instanceId);
    } catch (error) {
      if (!isProviderSandboxNotFoundError("modal", error)) {
        throw error;
      }
      observability.info("sandbox reaper: Modal sandbox already gone during direct terminate", {
        ...logIdentity,
      });
    }
    // This branch is a warming-death box recorded before any resumable envelope
    // was published. It was never a ready workspace, so a missing instance does
    // not imply loss of a previously exposed workspace revision.
    return { terminated: true, providerMissingBeforeCapture: false };
  }

  // resume_state is the folded group box-envelope (the provider sessionState the
  // box was last persisted as). An attributed provider with no envelope may
  // still be live. Only Modal exposes a verified by-id rescue adapter above;
  // never cold another backend merely because generic resume is impossible.
  if (!persistedInstanceId || !lease.resumeState) {
    throw new Error(
      `sandbox backend ${backend} instance ${lease.instanceId} has no resumable provider envelope; refusing unverified teardown`,
    );
  }

  const client = createClientForBackend(backend as never, settings) as
    | DrainSandboxClient
    | undefined;
  if (!client) {
    // 'none' backend resolved to no client.
    return { terminated: true, providerMissingBeforeCapture: false };
  }

  // Resume by id (warm reattach) — NO cold-restore. A NotFound here = the box is
  // already gone; success.
  let session: PersistableSession | undefined;
  let sessionState: Parameters<typeof terminateManagedSandboxSession>[1] | undefined;
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
      lease.instanceId,
    );
    if (resumedState === undefined) {
      throw new Error(`sandbox backend ${backend} returned no resumable provider state`);
    }
    const continuity = sandboxProviderContinuityForState(backend, resumedState, lease.instanceId);
    const resumed = await resumeExactSandboxSession(
      client,
      backend,
      resumedState,
      lease.instanceId,
      continuity ? { continuity } : undefined,
    );
    session = resumed.session as PersistableSession;
    sessionState = resumed.sessionState;
  } catch (error) {
    if (isProviderSandboxNotFoundError(client.backendId, error)) {
      observability.info("sandbox reaper: drainable box already gone before workspace capture", {
        ...logIdentity,
      });
      return {
        terminated: true,
        providerMissingBeforeCapture: captureDisposition !== "archive_published",
      };
    }
    // Re-throw a non-NotFound resume failure so the caller SKIPS (the lease stays
    // draining for the next sweep) — never cold a box we could not prove is gone.
    throw error;
  }

  const liveCapturePolicy = providerWorkspaceCapturePolicy(backend, session);
  if (
    !liveCapturePolicy ||
    liveCapturePolicy.takeover !== durableCapturePolicy.takeover ||
    liveCapturePolicy.strategy !== durableCapturePolicy.strategy ||
    liveCapturePolicy.liveInstance !== durableCapturePolicy.liveInstance
  ) {
    throw new Error(
      `sandbox backend ${backend} live workspace capture policy differs from its durable lease contract`,
    );
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
    captureDisposition === "capture_required" &&
    backend === "modal" &&
    (sessionWorkspacePersistence === "snapshot_filesystem" ||
      sessionWorkspacePersistence === "snapshot_directory")
      ? await withRetainedProcessProbeTimeout(
          resolveModalCheckpointProviderBindingForSession(settings, session),
        )
      : null;
  try {
    if (captureDisposition !== "archive_published" && session?.persistWorkspace) {
      const capture = captureVerifiedWorkspaceArchive(session, Date.now(), {
        requestId: providerCaptureRequestId ?? randomUUID(),
        strategy: liveCapturePolicy.strategy,
      });
      verifiedArchive = await awaitProviderCaptureWithLatePublication({
        capture,
        timeoutMs: settings.sandboxSnapshotTimeoutMs,
        timeoutError: new SandboxProviderCaptureTimeoutError(
          lease.sandboxGroupId,
          backend,
          settings.sandboxSnapshotTimeoutMs,
          lease.leaseEpoch,
          lease.instanceId,
        ),
        publishLate: async (archive) => {
          try {
            const result = await persistArchive(
              archive.base64,
              archive.descriptor,
              session,
              checkpointBinding,
            );
            observability.info(
              result.wrote
                ? "sandbox reaper: late workspace capture published under durable claim"
                : "sandbox reaper: late workspace capture fenced by successor",
              {
                ...logIdentity,
              },
            );
          } catch (error) {
            observability.warn("sandbox reaper: late workspace capture publication failed", {
              ...logIdentity,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
        observeLateFailure: (error) => {
          observability.warn("sandbox reaper: timed-out provider capture later failed", {
            ...logIdentity,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      });
    }
  } catch (error) {
    if (isProviderSandboxNotFoundError(client.backendId, error)) {
      observability.info("sandbox reaper: box gone during workspace capture", {
        ...logIdentity,
      });
      return { terminated: true, providerMissingBeforeCapture: true };
    }
    observability.warn(
      "sandbox reaper: persistWorkspace failed — leaving box draining (files NOT lost)",
      {
        ...logIdentity,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    // NEVER terminate a box whose snapshot we could not capture.
    throw error;
  }

  // Fold the captured archive onto the lease under the exact capture fence, then
  // GC the superseded snapshot. A CAS miss means this callback no longer owns
  // teardown — DO NOT terminate (the caller skips confirmDrainCold).
  //
  // Ownership guard for the no-archive path: even when persistWorkspace returns
  // no bytes, require the exact capture receipt before delete(). The null-archive
  // path performs that CAS without changing archive bytes; wrote:false aborts.
  if (captureDisposition === "archive_published") {
    observability.info("sandbox reaper: resuming teardown from durable archive publication", {
      ...logIdentity,
    });
  } else if (verifiedArchive) {
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
          ...logIdentity,
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

  // Provider terminate through the declared Agents SDK lifecycle. A terminate
  // that fails because the box is already gone is success.
  try {
    if (!session || !sessionState) {
      throw new Error(`sandbox backend ${backend} returned no terminable session state`);
    }
    prepareProviderForTeardownAfterCapture(backend, session);
    await terminateManagedSandboxSession(client, sessionState, session);
    return { terminated: true, providerMissingBeforeCapture: false };
  } catch (error) {
    if (isProviderSandboxNotFoundError(client.backendId, error)) {
      observability.info("sandbox reaper: provider already gone during terminate", {
        ...logIdentity,
      });
      // Capture was already durably folded above, so this is not a
      // missing-before-capture outcome.
      return { terminated: true, providerMissingBeforeCapture: false };
    }
    throw error;
  }
}
