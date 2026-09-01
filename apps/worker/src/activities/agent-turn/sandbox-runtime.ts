import {
  advanceWorkspaceGeneration,
  verifyWorkspaceMutationSettlement,
  heartbeatLeaseHolder,
  readLease,
  accrueWarmSeconds,
  SandboxWorkspaceMutationFencedError,
} from "@opengeni/db";
import {
  RoutingMutationOutcomeUnknownError,
  type EstablishedSandboxSession,
} from "@opengeni/runtime";
import {
  sandboxLifecycleTransitionWaitMs,
  sandboxWarmRateMicrosPerSecond,
  type Settings,
} from "@opengeni/config";
import { createRuntimeBatcher, currentActivityContext } from "../streaming";
import type { TurnActivityServices as ActivityServices, RunAgentTurnInput } from "../types";
import {
  maybePersistWarmWorkspaceSnapshot,
  persistSandboxDeadlineRotationCheckpoint,
  waitForWarmSnapshot,
  type ResumedTurnSandbox,
} from "../../sandbox-resume";
import { recordCreditMicros } from "../../observability-metrics";
import { ChannelAPartialMutationError } from "@opengeni/runtime/sandbox";

import { safeErrorDiagnostic } from "./errors";
import {
  shouldStartPeriodicWorkspaceSnapshot,
  releaseTurnSandboxAfterWriterDrain,
  finalizeDurableTurnOpStreams,
} from "./quiescence";
import { SandboxDeadlineRotationError } from "./sandbox-provision";
import type { AttemptIdentityState, EventingState, SandboxRuntimeState } from "./turn-context";

export type SandboxTurnRuntimeDeps = {
  input: RunAgentTurnInput;
  settings: Settings;
  db: ActivityServices["db"];
  objectStorage: ActivityServices["objectStorage"];
  observability: ActivityServices["observability"];
  cancellationSignal: AbortSignal | undefined;
  activityContext: ReturnType<typeof currentActivityContext>;
  sandboxRotationController: AbortController;
  sandboxState: SandboxRuntimeState;
  eventing: EventingState;
  attempt: AttemptIdentityState;
};

export type SandboxTurnRuntime = ReturnType<typeof createSandboxTurnRuntime>;

export function createSandboxTurnRuntime(deps: SandboxTurnRuntimeDeps) {
  const {
    input,
    settings,
    db,
    objectStorage,
    observability,
    cancellationSignal,
    activityContext,
    sandboxRotationController,
    sandboxState,
    eventing,
    attempt,
  } = deps;

  // P1.2 ownership inversion: when sandboxOwnershipEnabled, the turn resolves
  // the one box by id from the group lease and injects it NON-OWNED into the
  // run. null when the flag is off (byte-for-byte the legacy build-and-discard
  // path) OR when the backend is "none". Released + dropped in `finally`.
  const releaseLateSandbox = async (sandbox: ResumedTurnSandbox): Promise<void> => {
    sandboxState.lateSandboxesAwaitingWriterDrain.add(sandbox);
    // Drop the holder/timer immediately, but keep its null-outcome admissions
    // fenced until the shared attempt writer drain completes. The staged
    // release serializes a later proof-bearing call behind this one.
    await sandbox.release().catch(() => undefined);
    if (!sandboxState.attemptWritersDrained) return;
    try {
      await releaseTurnSandboxAfterWriterDrain(sandbox);
      sandboxState.lateSandboxesAwaitingWriterDrain.delete(sandbox);
    } catch (error) {
      console.error(
        "late sandbox quiesced release failed (turn outcome unaffected)",
        safeErrorDiagnostic(error),
      );
    }
  };
  const requireResolvedSandboxForMutation = (message: string): ResumedTurnSandbox => {
    if (!sandboxState.resolvedSandbox) throw new Error(message);
    return sandboxState.resolvedSandbox;
  };
  // The machine-primary SelfhostedSession (the UNWRAPPED backend, not the
  // routing proxy). Kept as a fallback finalizer; the routing proxy normally
  // aggregates it together with every machine reached after a mid-turn swap.
  // The UN-PROXIED established box session, captured BEFORE wrapTurnBoxWithRouting.
  // Platform setup (beforeAgentStart hooks + file materialization) execs against
  // THIS handle so a mid-turn sandbox_swap can never re-route those execs onto a
  // connected machine (the user's real computer).
  const finalizeTurnOpStreamOps = async (): Promise<void> => {
    await finalizeDurableTurnOpStreams(
      [sandboxState.lazyOwnedSandbox?.session, sandboxState.resolvedSandbox?.established.session],
      sandboxState.machinePrimarySession,
    );
  };
  // A same-target API repair can replace the home provider while this turn is
  // alive. Keep setup/snapshot persistence on the rebound raw session while
  // preserving the SDK-owned routing proxy for eager turns. Lazy turns hold the
  // proxy separately, so their worker-side handle may replace its raw session.
  const onHomeSandboxRebound = (rebound: {
    established: EstablishedSandboxSession;
    leaseEpoch: number;
  }): void => {
    const current = sandboxState.resolvedSandbox;
    const previousSession = current?.established.session;
    const preserveRoutingProxy =
      current !== null && previousSession !== sandboxState.setupBoxSession;
    sandboxState.setupBoxSession = rebound.established.session;
    if (!current) return;
    current.leaseEpoch = rebound.leaseEpoch;
    current.established = preserveRoutingProxy
      ? {
          ...current.established,
          client: rebound.established.client,
          // Keep the stable SDK-facing proxy; only its resolver changes the
          // underlying backend. The worker's setupBoxSession above is raw.
          session: previousSession,
          sessionState: rebound.established.sessionState,
          instanceId: rebound.established.instanceId,
          backendId: rebound.established.backendId,
          ...(rebound.established.origin ? { origin: rebound.established.origin } : {}),
          ...(rebound.established.restoredArchive
            ? { restoredArchive: rebound.established.restoredArchive }
            : {}),
        }
      : rebound.established;
  };
  // The globally unique durable turn-attempt holder id + the group id,
  // captured so the lease heartbeat can refresh the lease TTL epoch-fenced
  // (a superseded owner self-evicts) and finally can release.
  const runWorkspaceMutationForSandbox = async <T>(
    sandbox: ResumedTurnSandbox,
    operation: string,
    mutation: () => Promise<T>,
    observePhase?: (measurement: {
      phase: "admission" | "provider" | "settlement" | "snapshot_wait";
      outcome: "completed" | "failed";
      durationSeconds: number;
    }) => void,
  ): Promise<T> => {
    const observeMutationPhase = (
      phase: "admission" | "provider" | "settlement" | "snapshot_wait",
      outcome: "completed" | "failed",
      durationMs: number,
    ): void => {
      try {
        observePhase?.({
          phase,
          outcome,
          durationSeconds: Math.max(0, durationMs) / 1_000,
        });
      } catch {
        // Diagnostics must never alter workspace mutation authority.
      }
    };
    // Connected machines are the user's own persistence and never dirty the
    // cloud home archive. Every persistable raw-session write batch is fenced
    // against the exact current lease/provider before the provider sees it.
    if (sandbox.established.backendId === "selfhosted") {
      const providerStartedAt = performance.now();
      let providerOutcome: "completed" | "failed" = "failed";
      try {
        const result = await mutation();
        providerOutcome = "completed";
        return result;
      } catch (error) {
        if (error instanceof ChannelAPartialMutationError) {
          throw new RoutingMutationOutcomeUnknownError(
            operation,
            `Connected Machine workspace mutation "${operation}" partially applied before a later batch item failed; the complete operation was not replayed`,
            { cause: error },
          );
        }
        throw error;
      } finally {
        observeMutationPhase("provider", providerOutcome, performance.now() - providerStartedAt);
      }
    }
    if (
      !sandboxState.sandboxGroupId ||
      !sandboxState.sandboxHolderId ||
      !attempt.turnId ||
      attempt.executionGeneration <= 0
    ) {
      throw new Error("Workspace mutation attempted before exact turn sandbox admission");
    }
    let admissionCaptureWaitMs = 0;
    const identity = {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      turnId: attempt.turnId,
      executionGeneration: attempt.executionGeneration,
      attemptId: input.attemptId,
      holderId: sandboxState.sandboxHolderId,
      sandboxGroupId: sandboxState.sandboxGroupId,
      expectedEpoch: sandbox.leaseEpoch,
      expectedInstanceId: sandbox.established.instanceId,
      operation,
      captureWaitMs: sandboxLifecycleTransitionWaitMs(settings),
      ...(cancellationSignal ? { waitSignal: cancellationSignal } : {}),
      ...(observePhase
        ? {
            onCaptureWait: (observation: {
              durationMs: number;
              outcome: "completed" | "failed";
            }) => {
              admissionCaptureWaitMs += Math.max(0, observation.durationMs);
              observeMutationPhase("snapshot_wait", observation.outcome, observation.durationMs);
            },
          }
        : {}),
    };
    const admissionStartedAt = performance.now();
    let admissionOutcome: "completed" | "failed" = "failed";
    let admission: Awaited<ReturnType<typeof advanceWorkspaceGeneration>>;
    try {
      admission = await advanceWorkspaceGeneration(db, identity);
      admissionOutcome = "completed";
    } catch (admissionError) {
      if (
        admissionError instanceof SandboxWorkspaceMutationFencedError &&
        admissionError.code === "rotation_in_progress" &&
        sandboxState.sandboxGroupId
      ) {
        // The lease still matches this turn's exact epoch/instance but a
        // rotation was requested. Start the same orderly checkpoint the
        // heartbeat would start on its next tick, so the model is not fed
        // retry errors until then. Best-effort and single-flight; the
        // admission failure itself is still surfaced to the caller.
        void beginRotationCheckpoint(
          sandbox,
          sandbox.leaseEpoch,
          sandboxState.sandboxGroupId,
        ).catch(() => undefined);
      }
      throw admissionError;
    } finally {
      observeMutationPhase(
        "admission",
        admissionOutcome,
        Math.max(0, performance.now() - admissionStartedAt - admissionCaptureWaitMs),
      );
    }
    const settleMutation = async (outcome: "resolved" | "rejected"): Promise<void> => {
      const settlementStartedAt = performance.now();
      let settlementOutcome: "completed" | "failed" = "failed";
      try {
        await verifyWorkspaceMutationSettlement(db, {
          ...identity,
          admission,
          outcome,
        });
        settlementOutcome = "completed";
      } finally {
        observeMutationPhase(
          "settlement",
          settlementOutcome,
          performance.now() - settlementStartedAt,
        );
      }
    };
    let result: T;
    const providerStartedAt = performance.now();
    let providerOutcome: "completed" | "failed" = "failed";
    try {
      result = await mutation();
      providerOutcome = "completed";
    } catch (providerError) {
      observeMutationPhase("provider", providerOutcome, performance.now() - providerStartedAt);
      const partialMutation = providerError instanceof ChannelAPartialMutationError;
      try {
        await settleMutation(partialMutation ? "resolved" : "rejected");
      } catch (settlementError) {
        throw new RoutingMutationOutcomeUnknownError(
          operation,
          partialMutation
            ? `Platform workspace mutation "${operation}" partially applied at the provider but lost its durable physical settlement; its outcome is unknown and it was not replayed`
            : `Platform workspace mutation "${operation}" rejected at the provider but lost its durable physical settlement; its outcome is unknown and it was not replayed`,
          { cause: settlementError },
        );
      }
      if (partialMutation) {
        throw new RoutingMutationOutcomeUnknownError(
          operation,
          `Platform workspace mutation "${operation}" partially applied before a later batch item failed; the complete operation was not replayed`,
          { cause: providerError },
        );
      }
      throw providerError;
    }
    observeMutationPhase("provider", providerOutcome, performance.now() - providerStartedAt);
    try {
      await settleMutation("resolved");
    } catch (settlementError) {
      throw new RoutingMutationOutcomeUnknownError(
        operation,
        `Platform workspace mutation "${operation}" returned from the provider but lost its durable settlement fence; its outcome is unknown and it was not replayed`,
        { cause: settlementError },
      );
    }
    return result;
  };
  // Lease-TTL refresh timer (parallels the activity heartbeat): while the turn
  // runs it refreshes expires_at epoch-fenced so a legit multi-day turn is
  // never TTL-reaped. Cleared in finally. Only set when the flag resolved a box.
  const stopLeaseHeartbeat = (): void => {
    if (!sandboxState.leaseHeartbeatTimer) return;
    clearInterval(sandboxState.leaseHeartbeatTimer);
    sandboxState.leaseHeartbeatTimer = undefined;
  };
  // credential-renewal policy: the worker, not the model, owns renewal of run-scoped Git
  // credentials for a multi-day turn. The controller is attached only after
  // the initial seed reached a real cloud box and is drained before capture.
  // Generic host-owned run material has its own attempt-scoped renewal and
  // write handle. It is always drained and wiped before workspace capture.
  // The delegated Codemode bearer has a one-hour TTL. Renewal is attempt-
  // owned and attaches only after the initial token file reached a real
  // sandbox session; finalization drains an in-flight replacement.
  // MID-SESSION snapshot single-flight guard: the heartbeat tick fires every
  // 10s but a Modal filesystem snapshot can take longer — never overlap two
  // captures on one box. The in-flight capture's promise is held so the
  // turn-end persist can await it (its capture predates the turn's final
  // writes; landing after the fresher turn-end capture started would make
  // the atomic DB throttle discard the fresher one). Interval throttling
  // itself lives in maybePersistWarmWorkspaceSnapshot / persistWarmSnapshot.
  // The heartbeat snapshot is mid-session durability, not first-request
  // preparation. Keep it off the startup critical path until a provider
  // request has actually reached its transport boundary.
  // Turn-end capture needs the lease heartbeat to keep its holder alive, but
  // must prevent that same timer from starting another periodic snapshot
  // while it reads. This gate separates those two responsibilities.
  const flushRuntimeBatcher = async () => {
    const current = eventing.batcher as ReturnType<typeof createRuntimeBatcher> | null;
    await current?.flush().catch(() => undefined);
  };
  // Reconciliation is declared before provider routing so every turn-end path
  // can share one closure. It cannot run until `stream` exists, by which time
  // this value has been rebound to the turn's resolved model policy.
  const publishSandboxLifecycleEvents = async (sandbox: ResumedTurnSandbox): Promise<void> => {
    const established = sandbox.established;
    if (eventing.publish && established.origin && established.origin !== "resumed") {
      eventing.phaseTracker.markProvisionCompleted();
      const lifecycleEvents: Array<{
        type: "sandbox.box.lost" | "sandbox.box.created";
        payload: unknown;
      }> = [];
      if (established.lostInstanceId) {
        lifecycleEvents.push({
          type: "sandbox.box.lost",
          payload: { sandboxId: established.lostInstanceId },
        });
      }
      lifecycleEvents.push({
        type: "sandbox.box.created",
        payload: {
          sandboxId: established.instanceId,
          hydrated: established.origin === "restored" ? "archive" : "none",
        },
      });
      await eventing.publish(lifecycleEvents).catch(() => undefined);
    }
  };
  const publishSandboxLost = async (lostSandbox: { instanceId: string }): Promise<void> => {
    if (!eventing.publish) return;
    await eventing
      .publish([
        {
          type: "sandbox.box.lost",
          payload: { sandboxId: lostSandbox.instanceId },
        },
      ])
      .catch((publishError) => {
        // The lease transition is already authoritative. A fenced/failed audit
        // append must not prevent the same logical turn from recovering.
        console.error("sandbox box lost event publish failed", safeErrorDiagnostic(publishError));
      });
  };
  /**
   * Start (single-flight) the orderly provider-deadline rotation checkpoint for
   * the established box. Entered from the lease heartbeat once the lease is
   * rotation-fenced, and from a workspace-mutation admission that observed
   * `rotation_in_progress` at the same epoch/instance, so the model is not fed
   * retry errors for a whole heartbeat interval before the checkpoint runs.
   * `not_rotating` means the exact epoch/instance no longer carries a requested
   * rotation (holder reaped, attempt closed, epoch superseded, or draining).
   */
  const beginRotationCheckpoint = async (
    sandbox: ResumedTurnSandbox,
    rotationEpoch: number,
    rotationGroupId: string,
  ): Promise<"started" | "busy" | "not_rotating"> => {
    // A cancelled attempt never starts (or reinstates a holder for) a
    // checkpoint; its cancellation settlement owns the holder from here.
    if (
      sandboxState.rotationInFlight ||
      sandboxRotationController.signal.aborted ||
      cancellationSignal?.aborted
    ) {
      return "busy";
    }
    const rotatingLease = await readLease(db, input.workspaceId, rotationGroupId).catch(() => null);
    if (
      !rotatingLease ||
      rotatingLease.leaseEpoch !== rotationEpoch ||
      rotatingLease.instanceId !== sandbox.established.instanceId ||
      rotatingLease.rotationRequestedAt === null
    ) {
      return "not_rotating";
    }
    if (sandboxState.rotationInFlight || sandboxRotationController.signal.aborted) return "busy";
    sandboxState.rotationInFlight = (async () => {
      // Rotation admission already fenced all new workspace mutations.
      // Wait for an earlier periodic capture, then produce the exact
      // generation-complete checkpoint that licenses aborting this run.
      if (sandboxState.snapshotInFlight) {
        await waitForWarmSnapshot(
          sandboxState.snapshotInFlight,
          settings.sandboxSnapshotTimeoutMs,
          cancellationSignal,
        );
      }
      const snapshotSession = sandboxState.setupBoxSession;
      const snapshotTurnId = attempt.turnId;
      if (!snapshotSession || !snapshotTurnId) return;
      // The checkpoint helper first reinstates this turn's exact holder
      // when it was lost at the same epoch/instance (defense in depth:
      // the warm capture requires it), then forces the capture and
      // reports whether the established epoch now carries a complete
      // archive under its requested rotation.
      const checkpoint = await persistSandboxDeadlineRotationCheckpoint(
        { db, settings, objectStorage, observability },
        {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId: snapshotTurnId,
          attemptId: input.attemptId,
          sandboxGroupId: rotationGroupId,
        },
        snapshotSession,
        { leaseEpoch: rotationEpoch, instanceId: sandbox.established.instanceId },
        cancellationSignal,
      );
      if (checkpoint.checkpointed) {
        sandboxRotationController.abort(
          new SandboxDeadlineRotationError(rotationGroupId, rotationEpoch),
        );
        return;
      }
      if (checkpoint.holder === "attempt_fenced" || checkpoint.holder === "lease_fenced") {
        // This attempt is no longer the active writer, or the exact
        // epoch/instance is gone. Nothing left to checkpoint here.
        stopLeaseHeartbeat();
      }
    })()
      .catch((error) => {
        observability.warn("sandbox deadline rotation checkpoint failed; retrying", {
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          sandboxGroupId: rotationGroupId,
          leaseEpoch: rotationEpoch,
          ...safeErrorDiagnostic(error),
        });
      })
      .finally(() => {
        sandboxState.rotationInFlight = null;
      });
    await sandboxState.rotationInFlight;
    return "started";
  };
  const startLeaseHeartbeat = (
    sandbox: ResumedTurnSandbox,
    warmBackend: Settings["sandboxBackend"] | undefined,
  ): void => {
    if (sandboxState.leaseHeartbeatTimer) return;
    if (!sandboxState.sandboxHolderId || !sandboxState.sandboxGroupId) {
      return;
    }
    // Refresh the lease TTL on the activity-heartbeat cadence (10s, well
    // inside the 90s lease TTL). EPOCH-FENCED: a superseded owner's refresh
    // is rejected (returns false) and we stop refreshing — the box rides the
    // provider idle-timeout and the next dispatch re-establishes it. Best-
    // effort: a transient DB error must never fail the turn.
    const heartbeatEpoch = sandbox.leaseEpoch;
    const heartbeatHolderId = sandboxState.sandboxHolderId;
    const heartbeatGroupId = sandboxState.sandboxGroupId;
    // P2.1 warm-meter (tick A): while a turn runs, the heartbeat is also the
    // warm-seconds tick. GROUP+epoch+tick keyed (one box = one stream, shared
    // box metered once); epoch-fenced (a stale tick no-ops). Warm-cost is
    // metered when a per-backend rate is configured. Best-effort: a metering
    // failure must never fail the turn.
    //
    // Keyed off the EFFECTIVE backend (Stage D): a machine-primary turn has NO
    // Modal box, so it must accrue ZERO cloud warm-seconds — `selfhosted` has no
    // configured warm rate (0). Keying off turn.sandboxBackend (modal) would bill
    // cloud seconds for a box that does not exist (a real money bug). Non-machine
    // turns fall back to groupBoxBackend (the REAL box that ran): for a machine-
    // home turn that degraded to the cloud group box (swap-away / flag-off), that
    // is the deployment default (modal), so the fallback box is warm-metered at
    // the cloud rate instead of selfhosted's rate-0 (which would under-bill).
    const warmRate = sandboxWarmRateMicrosPerSecond(
      settings,
      warmBackend ?? (sandbox.established.backendId as Settings["sandboxBackend"]),
    );
    sandboxState.leaseHeartbeatTimer = setInterval(() => {
      void heartbeatLeaseHolder(db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sandboxGroupId: heartbeatGroupId,
        kind: "turn",
        holderId: heartbeatHolderId,
        leaseTtlMs: settings.sandboxLeaseTtlMs,
        expectedEpoch: heartbeatEpoch,
      })
        .then(async (alive) => {
          if (alive) return;
          const rotation = await beginRotationCheckpoint(sandbox, heartbeatEpoch, heartbeatGroupId);
          if (rotation === "not_rotating") {
            // The holder was reaped, the exact attempt closed, the epoch was
            // superseded, or the lease began draining. Do not leave a dead
            // interval issuing DB writes and snapshot probes forever.
            stopLeaseHeartbeat();
          }
        })
        .catch(() => undefined);
      void accrueWarmSeconds(db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sandboxGroupId: heartbeatGroupId,
        expectedEpoch: heartbeatEpoch,
        warmRateMicrosPerSecond: warmRate,
        subjectId: input.sessionId,
      })
        .then((result) => recordCreditMicros(observability, "usage", result.costMicros))
        .catch(() => undefined);
      // MID-SESSION snapshot (sandbox-file-persistence): while the turn holds
      // the box, fold a fresh /workspace snapshot onto the lease every
      // sandboxSnapshotIntervalMs, so a box death the reaper never sees
      // (Modal hard timeout mid-busy, OOM, infra) costs at most one interval
      // of work — a legit multi-day turn is otherwise completely unprotected
      // (the reaper only drain-persists IDLE leases). Uses the UN-proxied box
      // session (setupBoxSession): the routing veneer could swap mid-op and a
      // selfhosted target has no persistWorkspace anyway. Best-effort +
      // single-flight; throttling lives in the helper.
      const snapshotSession = sandboxState.setupBoxSession;
      const snapshotTurnId = attempt.turnId;
      if (
        snapshotSession &&
        snapshotTurnId &&
        shouldStartPeriodicWorkspaceSnapshot({
          firstProviderRequestStarted: sandboxState.firstProviderRequestStarted,
          snapshotInFlight: Boolean(sandboxState.snapshotInFlight),
          turnEndCaptureInProgress: sandboxState.turnEndCaptureInProgress,
        })
      ) {
        sandboxState.snapshotInFlight = maybePersistWarmWorkspaceSnapshot(
          { db, settings, objectStorage },
          {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId: snapshotTurnId,
            attemptId: input.attemptId,
            sandboxGroupId: heartbeatGroupId,
          },
          snapshotSession,
          heartbeatEpoch,
          activityContext?.cancellationSignal,
        )
          .then(async (persisted) => {
            if (persisted && eventing.publish) {
              await eventing.publish([
                {
                  type: "sandbox.box.snapshot",
                  payload: { trigger: "heartbeat" },
                },
              ]);
            }
          })
          .catch(() => undefined)
          .finally(() => {
            sandboxState.snapshotInFlight = null;
          });
      }
    }, 10_000);
    if (
      "unref" in sandboxState.leaseHeartbeatTimer &&
      typeof sandboxState.leaseHeartbeatTimer.unref === "function"
    ) {
      sandboxState.leaseHeartbeatTimer.unref();
    }
  };
  return {
    releaseLateSandbox,
    requireResolvedSandboxForMutation,
    finalizeTurnOpStreamOps,
    onHomeSandboxRebound,
    runWorkspaceMutationForSandbox,
    stopLeaseHeartbeat,
    flushRuntimeBatcher,
    publishSandboxLifecycleEvents,
    publishSandboxLost,
    startLeaseHeartbeat,
  };
}
