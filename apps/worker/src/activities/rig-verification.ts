import type {
  AccessGrant,
  Rig,
  RigChange,
  RigProviderImage,
  RigVersion,
  SandboxBackend,
} from "@opengeni/contracts";
import { sandboxLifecycleTransitionWaitMs } from "@opengeni/config";
import {
  appendRigSetupCommand,
  recordRigAuditEvent,
  classifyRigVerificationOutcome,
  promoteSetupAppendChange,
  rigProviderImageBuildRequestId,
  rigProviderImageContentHash,
  rigProviderImageProviderBindingKeyHash,
  rigProviderImageSetupHash,
  type RigProviderImageDefinition,
} from "@opengeni/core";
import {
  acquireLease,
  beginRigChangeVerificationAttempt,
  claimRigVersionProviderImageBuild,
  commitWarmingToWarm,
  failWarmingToCold,
  finalizeRigVersionProviderImageBuild,
  getRig,
  getRigChange,
  getRigVersionById,
  markWarmLeaseInstanceLost,
  markSandboxCheckpointArtifactDeletePending,
  recordWarmingSandboxCreated,
  registerSandboxCheckpointArtifact,
  releaseLeaseHolder,
  touchLeaseHolder,
  updateRigChangeStatus,
  type Database,
} from "@opengeni/db";
import {
  buildImmutableProviderImage,
  createTurnToolCancellationController,
  deleteModalCheckpointSnapshot,
  describeNativeSnapshotArchive,
  encodeNativeSnapshotRef,
  establishSandboxSessionFromEnvelope,
  sandboxCommandExitCode,
  sandboxCommandOutput,
  serializeEstablishedSandboxEnvelope,
  providerSupportsImmutableImageBuild,
  tagModalSandbox,
  terminateManagedSandboxSession,
  type EstablishedSandboxSession,
  type TurnSandboxCommandArgs,
  type TurnSandboxCommandSession,
} from "@opengeni/runtime/sandbox";
import type { Context } from "@temporalio/activity";
import type { ControlActivityServices } from "./types";
import {
  rigProviderImageSourceImage,
  settingsWithPackSandboxImage,
  settingsWithRigImage,
} from "./sandbox-images";
import { resolveWorkspacePackRuntime, type WorkspacePackRuntime } from "./packs";
import { currentActivityContext } from "./streaming";

type RigSetupHook = typeof import("@opengeni/runtime").runRigSetupHook;
let rigSetupHookPromise: Promise<RigSetupHook> | null = null;

async function runRigSetupHook(...args: Parameters<RigSetupHook>): Promise<void> {
  rigSetupHookPromise ??= import("@opengeni/runtime").then((runtime) => runtime.runRigSetupHook);
  const hook = await rigSetupHookPromise;
  await hook(...args);
}

type SandboxLifecycleCommandRunner = (
  session: TurnSandboxCommandSession,
  args: TurnSandboxCommandArgs,
) => Promise<unknown>;

export type RigVerificationWorkflowInput =
  | { workspaceId: string; changeId: string; versionId?: never }
  | { workspaceId: string; versionId: string; changeId?: never };

type CommandResult = {
  exitCode: number | null;
  output: string;
};

const RIG_VERIFICATION_CLEANUP_RESERVE_MAX_MS = 2 * 60_000;
const RIG_VERIFICATION_CLEANUP_OPERATION_MAX_MS = 60_000;
const RIG_VERIFICATION_HEARTBEAT_MAX_INTERVAL_MS = 10_000;
const RIG_VERIFICATION_HEARTBEAT_MIN_INTERVAL_MS = 250;
// The Temporal activity has a 15-minute start-to-close timeout. Keep ownership
// through that complete contract plus five minutes for cancellation delivery
// and finally cleanup; a dead process then becomes sweep-eligible without any
// lease-holder fiction or manual recovery.
export const RIG_VERIFICATION_OWNER_TTL_MS = 20 * 60_000;
export const RIG_VERIFICATION_OWNERS_DISABLED_MESSAGE =
  "Rig verification lease ownership is disabled; refusing to create an unowned verifier sandbox";
const RIG_VERIFICATION_HOLDER_TOUCH_INTERVAL_MS = 10_000;
const RIG_VERIFICATION_RELEASE_GRACE_MS = 1;

export class RigVerificationActivityDeadlineError extends Error {
  readonly name = "RigVerificationActivityDeadlineError";

  constructor(
    readonly startToCloseTimeoutMs: number,
    readonly cleanupReserveMs: number,
  ) {
    super(
      `Rig verification activity-local deadline reached with ${cleanupReserveMs}ms reserved for cleanup before the ${startToCloseTimeoutMs}ms Temporal start-to-close timeout`,
    );
  }
}

export type RigVerificationActivityLifecycle = {
  signal: AbortSignal;
  /** Absolute wall-clock boundary before which immediate cleanup may wait. */
  cleanupDeadlineAtMs: number | null;
  dispose(): void;
};

function computeCleanupReserveMs(startToCloseTimeoutMs: number): number {
  return Math.min(
    RIG_VERIFICATION_CLEANUP_RESERVE_MAX_MS,
    Math.max(100, Math.floor(startToCloseTimeoutMs / 4)),
    Math.max(1, startToCloseTimeoutMs - 1),
  );
}

/**
 * Start the verifier's real Temporal liveness/cancellation contract.
 *
 * The activity-local deadline is deliberately earlier than start-to-close. In
 * production a 15-minute server deadline becomes a 13-minute work deadline,
 * retaining two minutes for command quiescence, exact deactivation, and
 * provider termination. Short integration-test deadlines use the same bounded
 * one-quarter rule instead of a production-only magic value.
 */
export function createRigVerificationActivityLifecycle(
  context: Context | null = currentActivityContext(),
): RigVerificationActivityLifecycle {
  const controller = new AbortController();
  const temporalSignal = context?.cancellationSignal;
  const forwardTemporalCancellation = (): void => {
    if (!controller.signal.aborted) {
      controller.abort(temporalSignal?.reason ?? new Error("Rig verification cancelled"));
    }
  };
  if (temporalSignal?.aborted) {
    forwardTemporalCancellation();
  } else {
    temporalSignal?.addEventListener("abort", forwardTemporalCancellation, { once: true });
  }

  const startedAtMs = Date.now();
  const startToCloseTimeoutMs = context?.info.startToCloseTimeoutMs;
  const reserveMs =
    typeof startToCloseTimeoutMs === "number" && startToCloseTimeoutMs > 0
      ? computeCleanupReserveMs(startToCloseTimeoutMs)
      : null;
  const serverDeadlineAtMs =
    reserveMs === null || startToCloseTimeoutMs === undefined
      ? null
      : startedAtMs + startToCloseTimeoutMs;
  // Keep an additional margin after our bounded cleanup waits. If a DB or
  // provider promise remains unresolved, the activity must still report its
  // local deadline before Temporal imposes the hard timeout.
  const serverReportingMarginMs =
    reserveMs === null ? 0 : Math.min(30_000, Math.max(1, Math.floor(reserveMs / 4)));
  const cleanupDeadlineAtMs =
    serverDeadlineAtMs === null ? null : serverDeadlineAtMs - serverReportingMarginMs;

  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  if (reserveMs !== null && startToCloseTimeoutMs !== undefined && !controller.signal.aborted) {
    deadlineTimer = setTimeout(
      () => {
        if (!controller.signal.aborted) {
          controller.abort(
            new RigVerificationActivityDeadlineError(startToCloseTimeoutMs, reserveMs),
          );
        }
      },
      Math.max(1, startToCloseTimeoutMs - reserveMs),
    );
  }

  const heartbeat = (): void => {
    if (!context) return;
    try {
      context.heartbeat({
        activity: "rig_verification",
        at: new Date().toISOString(),
        cleanup: controller.signal.aborted,
        cleanupDeadlineAt: cleanupDeadlineAtMs ? new Date(cleanupDeadlineAtMs).toISOString() : null,
      });
    } catch (error) {
      // Context.heartbeat reports delivered cancellation synchronously on some
      // SDK paths. Feed that failure into the same cooperative abort fence, but
      // keep the interval alive through bounded cleanup: the abort signal stops
      // verifier work, not the activity's liveness reporting.
      if (!controller.signal.aborted) controller.abort(error);
    }
  };
  heartbeat();
  const heartbeatTimeoutMs = context?.info.heartbeatTimeoutMs;
  const heartbeatIntervalMs =
    typeof heartbeatTimeoutMs === "number" && heartbeatTimeoutMs > 0
      ? Math.min(
          RIG_VERIFICATION_HEARTBEAT_MAX_INTERVAL_MS,
          Math.max(RIG_VERIFICATION_HEARTBEAT_MIN_INTERVAL_MS, Math.floor(heartbeatTimeoutMs / 3)),
        )
      : RIG_VERIFICATION_HEARTBEAT_MAX_INTERVAL_MS;
  const heartbeatTimer = context ? setInterval(heartbeat, heartbeatIntervalMs) : null;
  if (heartbeatTimer && "unref" in heartbeatTimer && typeof heartbeatTimer.unref === "function") {
    heartbeatTimer.unref();
  }

  return {
    signal: controller.signal,
    cleanupDeadlineAtMs,
    dispose: () => {
      temporalSignal?.removeEventListener("abort", forwardTemporalCancellation);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      deadlineTimer = null;
    },
  };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Rig verification cancelled");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

async function waitForAbortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  let removeAbortListener = (): void => undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal));
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, cancellation]);
  } finally {
    removeAbortListener();
  }
}

type BoundedSettlement<T> = { status: "completed"; value: T } | { status: "timed_out" };

async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<BoundedSettlement<T>> {
  if (timeoutMs <= 0) return { status: "timed_out" };
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise.then((value) => ({ status: "completed" as const, value })),
      new Promise<{ status: "timed_out" }>((resolve) => {
        timer = setTimeout(() => resolve({ status: "timed_out" }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function cleanupWaitMs(lifecycle: RigVerificationActivityLifecycle | undefined): number {
  if (lifecycle?.cleanupDeadlineAtMs == null) {
    return RIG_VERIFICATION_CLEANUP_OPERATION_MAX_MS;
  }
  return Math.max(
    0,
    Math.min(RIG_VERIFICATION_CLEANUP_OPERATION_MAX_MS, lifecycle.cleanupDeadlineAtMs - Date.now()),
  );
}

function systemGrant(rig: Rig): AccessGrant {
  return {
    accountId: rig.accountId,
    workspaceId: rig.workspaceId,
    subjectId: "system:rig-verification",
    permissions: ["rigs:use", "rigs:manage"],
  };
}

async function terminateThrowaway(established: EstablishedSandboxSession | null): Promise<boolean> {
  if (!established) return true;
  try {
    await terminateManagedSandboxSession(
      established.client,
      established.sessionState,
      established.session,
    );
    return true;
  } catch {
    return false;
  }
}

export type RigVerificationOwnershipDependencies = {
  acquire: typeof acquireLease;
  establish: typeof establishSandboxSessionFromEnvelope;
  recordCreated: typeof recordWarmingSandboxCreated;
  commitWarm: typeof commitWarmingToWarm;
  touchHolder: typeof touchLeaseHolder;
  releaseHolder: typeof releaseLeaseHolder;
  failWarming: typeof failWarmingToCold;
  markWarmLost: typeof markWarmLeaseInstanceLost;
  serialize: typeof serializeEstablishedSandboxEnvelope;
  tag: typeof tagModalSandbox;
  terminate: typeof terminateThrowaway;
  createCancellationController: typeof createTurnToolCancellationController;
  randomUUID: () => string;
};

const defaultOwnershipDependencies: RigVerificationOwnershipDependencies = {
  acquire: acquireLease,
  establish: establishSandboxSessionFromEnvelope,
  recordCreated: recordWarmingSandboxCreated,
  commitWarm: commitWarmingToWarm,
  touchHolder: touchLeaseHolder,
  releaseHolder: releaseLeaseHolder,
  failWarming: failWarmingToCold,
  markWarmLost: markWarmLeaseInstanceLost,
  serialize: serializeEstablishedSandboxEnvelope,
  tag: tagModalSandbox,
  terminate: terminateThrowaway,
  createCancellationController: createTurnToolCancellationController,
  randomUUID: () => crypto.randomUUID(),
};

export type RigVerificationSandboxRunContext = {
  signal: AbortSignal;
  commandRunner: SandboxLifecycleCommandRunner;
  ownership: {
    leaseId: string;
    leaseEpoch: number;
    workspaceGeneration: number;
    instanceId: string;
  };
};

export class RigVerificationLeaseUnavailableError extends Error {
  readonly name = "RigVerificationLeaseUnavailableError";

  constructor(
    readonly sandboxGroupId: string,
    readonly role: "attached" | "blocked" | "rearmed" | "fenced",
  ) {
    super(`Rig verification requires a new clean sandbox, but lease ${sandboxGroupId} was ${role}`);
  }
}

/**
 * Run one verifier against one exactly attributed standalone sandbox.
 *
 * Ordering is deliberate and source-of-truth safe:
 *   acquire spawner -> create callback -> warming instance record -> warm commit
 *   -> setup/checks. The canonical sandbox lease, not provider tags, is durable
 * ownership. Every exact create callback is retained before its DB write so an
 * ambiguous acknowledgement can still be terminated in finally. Provider
 * termination precedes clearing that exact durable pointer; when termination
 * fails the pointer is retained and the holder is released with a one-millisecond
 * drain grace so the normal reaper retries. Temporal cancellation first drains
 * every verifier command. Cleanup waits are bounded inside the server reserve;
 * lease expiry and the provider reaper remain the hard-worker-loss backstops.
 */
export async function runWithOwnedRigVerificationSandbox<T>(
  input: {
    settings: ControlActivityServices["settings"];
    db: Database;
    observability: ControlActivityServices["observability"];
    accountId: string;
    workspaceId: string;
    sandboxGroupId: string;
    rigVersionId: string;
    sessionIdPrefix: string;
    lifecycle?: RigVerificationActivityLifecycle;
  },
  run: (
    established: EstablishedSandboxSession,
    context: RigVerificationSandboxRunContext,
  ) => Promise<T>,
  dependencies: RigVerificationOwnershipDependencies = defaultOwnershipDependencies,
): Promise<T> {
  // Phase B must remain inert throughout its code rollout. A disabled or
  // omitted flag rejects before establish() can invoke any provider create;
  // falling back to the legacy unowned verifier is never safe.
  if (!input.settings.rigVerificationLeaseOwnershipEnabled) {
    throw new Error(RIG_VERIFICATION_OWNERS_DISABLED_MESSAGE);
  }

  const holderId = `rig-verification:${dependencies.randomUUID()}`;
  const fallbackController = new AbortController();
  const signal = input.lifecycle?.signal ?? fallbackController.signal;
  const commandController = dependencies.createCancellationController(signal);
  const commandRunner = commandController.runSandboxCommand.bind(commandController);
  let cleanupTarget: EstablishedSandboxSession | null = null;
  let acquired = false;
  let ownsWarmingEpoch = false;
  let expectedEpoch: number | null = null;
  let holderLivenessTimer: ReturnType<typeof setInterval> | null = null;
  let establishmentSettled = false;
  let establishmentPromise: Promise<EstablishedSandboxSession> | null = null;

  const warnCleanupTimeout = (operation: string, instanceId: string | null): void => {
    input.observability.warn("rig verifier: ownership cleanup timed out", {
      holderId,
      instanceId,
      operation,
      error:
        "cleanup did not settle inside the activity reserve; exact owner expiry and the global provider reaper are the bounded delayed backstop",
    });
  };

  const warnCleanupFailure = (
    operation: string,
    instanceId: string | null,
    error: unknown,
  ): void => {
    input.observability.warn("rig verifier: ownership cleanup failed", {
      holderId,
      instanceId,
      operation,
      error: error instanceof Error ? error.message : String(error),
    });
  };

  const clearTerminatedLeasePointer = async (instanceId: string): Promise<void> => {
    if (expectedEpoch === null) return;
    const cleanupEpoch = expectedEpoch;
    // Exactly one transition can match. Running both covers a commit whose DB
    // acknowledgement was lost: expectedEpoch is still warming, while
    // expectedEpoch+1 is the only possible committed warm epoch.
    const results = await Promise.allSettled([
      Promise.resolve().then(() =>
        dependencies.markWarmLost(input.db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sandboxGroupId: input.sandboxGroupId,
          expectedEpoch: cleanupEpoch + 1,
          expectedInstanceId: instanceId,
        }),
      ),
      Promise.resolve().then(() =>
        dependencies.failWarming(input.db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sandboxGroupId: input.sandboxGroupId,
          expectedEpoch: cleanupEpoch,
        }),
      ),
    ]);
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") {
        warnCleanupFailure(
          index === 0 ? "mark_warm_lost" : "fail_warming",
          instanceId,
          result.reason,
        );
      }
    }
  };

  const terminateAndClear = async (created: EstablishedSandboxSession): Promise<boolean> => {
    let terminated = false;
    try {
      terminated = await dependencies.terminate(created);
    } catch (error) {
      warnCleanupFailure("terminate", created.instanceId, error);
    }
    if (!terminated) {
      warnCleanupFailure(
        "terminate",
        created.instanceId,
        new Error("provider termination was not confirmed; durable lease cleanup remains pending"),
      );
      return false;
    }
    await clearTerminatedLeasePointer(created.instanceId);
    return true;
  };

  try {
    throwIfAborted(signal);
    const lease = await dependencies.acquire(input.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sandboxGroupId: input.sandboxGroupId,
      kind: "turn",
      holderId,
      subjectId: null,
      backend: input.settings.sandboxBackend,
      image: input.settings.modalImageRef ?? input.settings.dockerImage,
      rigVersionId: input.rigVersionId,
      leaseTtlMs: RIG_VERIFICATION_OWNER_TTL_MS,
      warmingLeaseTtlMs: RIG_VERIFICATION_OWNER_TTL_MS,
      captureWaitMs: sandboxLifecycleTransitionWaitMs(input.settings),
      waitSignal: signal,
    });
    acquired = true;
    expectedEpoch = lease.lease.leaseEpoch;
    holderLivenessTimer = setInterval(() => {
      void dependencies
        .touchHolder(input.db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sandboxGroupId: input.sandboxGroupId,
          kind: "turn",
          holderId,
        })
        .catch(() => undefined);
    }, RIG_VERIFICATION_HOLDER_TOUCH_INTERVAL_MS);
    if ("unref" in holderLivenessTimer && typeof holderLivenessTimer.unref === "function") {
      holderLivenessTimer.unref();
    }
    if (lease.role !== "spawner") {
      throw new RigVerificationLeaseUnavailableError(input.sandboxGroupId, lease.role);
    }
    ownsWarmingEpoch = true;

    establishmentPromise = Promise.resolve().then(() =>
      dependencies.establish(input.settings, null, {
        sessionId: `${input.sessionIdPrefix}-${holderId}`,
        recovery: "create-or-restore",
        environment: {},
        onSandboxCreated: async (created) => {
          // Retain the exact handle before the durable write. If registration
          // throws after commit, finally still has the provider identity.
          cleanupTarget = created;
          const resumeState =
            created.backendId === "modal" ? null : await dependencies.serialize(created);
          const recorded = await dependencies.recordCreated(input.db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sandboxGroupId: input.sandboxGroupId,
            expectedEpoch: lease.lease.leaseEpoch,
            instanceId: created.instanceId,
            resumeBackendId: created.backendId,
            resumeState,
            leaseTtlMs: RIG_VERIFICATION_OWNER_TTL_MS,
            warmingLeaseTtlMs: RIG_VERIFICATION_OWNER_TTL_MS,
          });
          if (!recorded.recorded) {
            throw new RigVerificationLeaseUnavailableError(input.sandboxGroupId, "fenced");
          }

          if (created.backendId === "modal" && !signal.aborted) {
            try {
              await waitForAbortable(
                dependencies.tag(input.settings, created.instanceId, {
                  leaseId: lease.lease.id,
                  workspaceId: input.workspaceId,
                  sandboxGroupId: input.sandboxGroupId,
                }),
                signal,
              );
            } catch (error) {
              if (!signal.aborted) {
                input.observability.warn("rig verifier: Modal ownership tag failed", {
                  holderId,
                  instanceId: created.instanceId,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }
          }

          // Provider create is not abortable. If it returns after cancellation
          // won the outer race, the callback owns an independent exact cleanup
          // path before it throws and triggers the runtime's fail-closed delete.
          if (signal.aborted) {
            await terminateAndClear(created);
            throw abortReason(signal);
          }
        },
      }),
    );
    void establishmentPromise.then(
      () => {
        establishmentSettled = true;
      },
      () => {
        establishmentSettled = true;
      },
    );
    // The losing provider promise retains the callback above and a rejection
    // handler, so a late create can still deactivate/terminate without an
    // unhandled rejection after the activity has reported cancellation.
    void establishmentPromise.catch(() => undefined);
    const established = await waitForAbortable(establishmentPromise, signal);
    cleanupTarget = established;
    const resumeState =
      established.backendId === "modal" ? null : await dependencies.serialize(established);
    const committed = await dependencies.commitWarm(input.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sandboxGroupId: input.sandboxGroupId,
      expectedEpoch: lease.lease.leaseEpoch,
      instanceId: established.instanceId,
      dataPlaneUrl: null,
      resumeBackendId: established.backendId,
      resumeState,
      leaseTtlMs: RIG_VERIFICATION_OWNER_TTL_MS,
    });
    if (!committed.committed || !committed.lease) {
      throw new RigVerificationLeaseUnavailableError(input.sandboxGroupId, "fenced");
    }
    const result = await run(established, {
      signal,
      commandRunner,
      ownership: {
        leaseId: committed.lease.id,
        leaseEpoch: committed.lease.leaseEpoch,
        workspaceGeneration: committed.lease.workspaceGeneration,
        instanceId: established.instanceId,
      },
    });
    throwIfAborted(signal);
    return result;
  } catch (error) {
    if (signal.aborted) throw abortReason(signal);
    throw error;
  } finally {
    if (signal.aborted && establishmentPromise && !establishmentSettled) {
      const lateEstablishment = await settleWithin(
        Promise.allSettled([establishmentPromise]),
        cleanupWaitMs(input.lifecycle),
      );
      if (lateEstablishment.status === "timed_out") {
        warnCleanupTimeout("establish_after_abort", cleanupTarget?.instanceId ?? null);
      }
    }

    if (holderLivenessTimer) {
      clearInterval(holderLivenessTimer);
      holderLivenessTimer = null;
    }

    // Physical command quiescence precedes provider teardown. If the provider
    // control plane itself hangs, bound the wait so termination still starts
    // inside the server reserve; terminating the throwaway box is then the
    // stronger final process fence.
    commandController.cancel(signal.aborted ? abortReason(signal) : new Error("Verifier complete"));
    const quiescence = commandController.waitForQuiescence();
    void quiescence.catch(() => undefined);
    const quiescenceResult = await settleWithin(quiescence, cleanupWaitMs(input.lifecycle));
    if (quiescenceResult.status === "timed_out") {
      warnCleanupTimeout("command_quiescence", cleanupTarget?.instanceId ?? null);
    }

    const providerCleanup = Promise.resolve().then(async () => {
      if (!cleanupTarget) {
        // A provider create that rejects before onSandboxCreated leaves no box
        // pointer to terminate. Roll back only our exact warming epoch so the
        // next verification does not wait for the 20-minute death reaper. If a
        // non-abortable create returns after this transition, its callback is
        // fenced and the runtime's create-failure path terminates that box.
        if (ownsWarmingEpoch && expectedEpoch !== null) {
          await dependencies.failWarming(input.db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sandboxGroupId: input.sandboxGroupId,
            expectedEpoch,
          });
        }
        return true;
      }
      return await terminateAndClear(cleanupTarget);
    });
    void providerCleanup.catch(() => undefined);
    const providerSettlement = await settleWithin(
      Promise.allSettled([providerCleanup]),
      cleanupWaitMs(input.lifecycle),
    );
    if (providerSettlement.status === "timed_out") {
      warnCleanupTimeout("terminate_and_clear", cleanupTarget?.instanceId ?? null);
    } else if (providerSettlement.value[0]?.status === "rejected") {
      warnCleanupFailure(
        "terminate_and_clear",
        cleanupTarget?.instanceId ?? null,
        providerSettlement.value[0].reason,
      );
    }

    // Release is independent from provider/DB cleanup. A failed direct
    // termination therefore leaves the exact pointer intact and immediately
    // makes the zero-holder lease eligible for the normal drain/reaper path.
    if (acquired) {
      const release = Promise.resolve().then(() =>
        dependencies.releaseHolder(input.db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sandboxGroupId: input.sandboxGroupId,
          kind: "turn",
          holderId,
          idleGraceMs: RIG_VERIFICATION_RELEASE_GRACE_MS,
        }),
      );
      void release.catch(() => undefined);
      const released = await settleWithin(
        Promise.allSettled([release]),
        cleanupWaitMs(input.lifecycle),
      );
      if (released.status === "timed_out") {
        warnCleanupTimeout("release_holder", cleanupTarget?.instanceId ?? null);
      } else if (released.value[0]?.status === "rejected") {
        warnCleanupFailure(
          "release_holder",
          cleanupTarget?.instanceId ?? null,
          released.value[0].reason,
        );
      }
    }
    // Cancellation may be delivered by a heartbeat while finally is already
    // draining. WAIT_CANCELLATION_COMPLETED must observe cancellation only
    // after cleanup, but it must not turn that late cancellation into success.
    throwIfAborted(signal);
  }
}

async function runCommand(
  session: TurnSandboxCommandSession,
  command: string,
  timeoutMs: number,
  commandRunner: SandboxLifecycleCommandRunner,
): Promise<CommandResult> {
  const args = {
    cmd: command,
    workdir: "/workspace",
    runAs: "root",
    yieldTimeMs: timeoutMs,
    maxOutputTokens: 40_000,
  };
  const result = await commandRunner(session, args);
  return {
    exitCode: sandboxCommandExitCode(result),
    output: sandboxCommandOutput(result),
  };
}

function setupAppendCommand(change: RigChange): string | null {
  if (change.kind !== "setup_append") {
    return null;
  }
  const command = (change.payload as { command?: unknown }).command;
  return typeof command === "string" ? command : null;
}

function candidateVersionForChange(baseVersion: RigVersion, change: RigChange): RigVersion {
  if (change.kind !== "definition_edit") {
    return { ...baseVersion, providerImages: {} };
  }
  const payload = change.payload as {
    image?: unknown;
    setupScript?: unknown;
    checks?: unknown;
    credentialHooks?: unknown;
    defaultVariableSetIds?: unknown;
    changelog?: unknown;
  };
  return {
    ...baseVersion,
    image: payload.image === undefined ? baseVersion.image : (payload.image as string | null),
    setupScript:
      payload.setupScript === undefined
        ? baseVersion.setupScript
        : (payload.setupScript as string | null),
    checks: Array.isArray(payload.checks)
      ? (payload.checks as RigVersion["checks"])
      : baseVersion.checks,
    credentialHooks: Array.isArray(payload.credentialHooks)
      ? (payload.credentialHooks as string[])
      : baseVersion.credentialHooks,
    defaultVariableSetIds: Array.isArray(payload.defaultVariableSetIds)
      ? (payload.defaultVariableSetIds as string[])
      : baseVersion.defaultVariableSetIds,
    changelog: typeof payload.changelog === "string" ? payload.changelog : baseVersion.changelog,
    providerImages: {},
  };
}

function providerImageDefinitionForChange(
  baseVersion: RigVersion,
  change: RigChange,
  candidateVersion: RigVersion,
): RigProviderImageDefinition {
  if (change.kind !== "setup_append") return candidateVersion;
  const command = setupAppendCommand(change);
  return {
    image: baseVersion.image,
    setupScript: command
      ? appendRigSetupCommand(baseVersion.setupScript, command)
      : baseVersion.setupScript,
    checks: baseVersion.checks,
    credentialHooks: baseVersion.credentialHooks,
    defaultVariableSetIds: baseVersion.defaultVariableSetIds,
  };
}

export function rigProviderImageContentMarkerCommand(
  contentHash: string,
  markerRoot = "/var/opengeni",
): string {
  if (!/^sha256:[0-9a-f]{64}$/u.test(contentHash)) {
    throw new Error("Rig provider image content marker requires a canonical SHA-256 value");
  }
  if (!/^\/[A-Za-z0-9._/-]+$/u.test(markerRoot)) {
    throw new Error("Rig provider image marker root must be a safe absolute path");
  }
  const normalizedRoot = markerRoot.replace(/\/+$/u, "");
  const marker = `${normalizedRoot}/rig-setup-content-${contentHash.slice("sha256:".length)}.done`;
  return `mkdir -p '${normalizedRoot}' && touch '${marker}'`;
}

export async function buildVerifiedRigProviderImage(input: {
  settings: ControlActivityServices["settings"];
  db: Database;
  accountId: string;
  workspaceId: string;
  existingVersionId?: string;
  definition: RigProviderImageDefinition;
  target: { kind: "change" | "version"; id: string };
  established: EstablishedSandboxSession;
  ownership: RigVerificationSandboxRunContext["ownership"];
  signal: AbortSignal;
}): Promise<RigProviderImage> {
  const backend = input.settings.sandboxBackend as SandboxBackend;
  const providerSupportsBuild = providerSupportsImmutableImageBuild(backend);
  const sourceImage = rigProviderImageSourceImage(input.settings, backend);
  const contentHash = rigProviderImageContentHash({
    backend,
    sourceImage,
    definition: input.definition,
  });
  const startedAt = new Date().toISOString();
  let building: RigProviderImage = {
    backend,
    provider: backend,
    status: "building",
    contentHash,
    setupHash: rigProviderImageSetupHash(input.definition),
    sourceImage,
    buildRequestId: rigProviderImageBuildRequestId({
      targetId: input.target.id,
      backend,
      contentHash,
    }),
    imageId: null,
    imageDigest: null,
    artifactId: null,
    providerBindingKeyHash: null,
    provenance: {
      kind: "rig_verification",
      targetKind: input.target.kind,
      targetId: input.target.id,
    },
    startedAt,
    finishedAt: null,
    error: null,
  };

  if (input.existingVersionId) {
    const claim = await claimRigVersionProviderImageBuild(input.db, {
      workspaceId: input.workspaceId,
      versionId: input.existingVersionId,
      image: building,
      staleAfterMs: RIG_VERIFICATION_OWNER_TTL_MS,
      retryUnsupported: providerSupportsBuild,
    });
    if (
      claim.status === "ready" ||
      claim.status === "in_progress" ||
      claim.status === "unsupported"
    ) {
      return claim.image;
    }
    if (claim.status === "conflict") {
      return {
        ...building,
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: {
          code: "provider_image_content_conflict",
          message:
            "this exact rig version already records a provider image for different effective content; mint and verify a new version",
          retryable: false,
        },
      };
    }
    building = claim.image;
  }

  const finalize = async (image: RigProviderImage): Promise<RigProviderImage> => {
    if (input.existingVersionId) {
      const persisted = await finalizeRigVersionProviderImageBuild(input.db, {
        workspaceId: input.workspaceId,
        versionId: input.existingVersionId,
        image,
      });
      if (!persisted) {
        if (image.artifactId) {
          await markSandboxCheckpointArtifactDeletePending(input.db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            artifactId: image.artifactId,
            reason: "rig_provider_image_publication_fenced",
          }).catch(() => false);
        }
        return {
          ...image,
          status: "failed",
          imageId: null,
          imageDigest: null,
          artifactId: null,
          providerBindingKeyHash: null,
          finishedAt: new Date().toISOString(),
          error: {
            code: "provider_image_publication_fenced",
            message: "provider image ownership changed before this build could be published",
            retryable: true,
          },
        };
      }
    }
    return image;
  };

  if (!providerSupportsBuild) {
    return await finalize({
      ...building,
      status: "unsupported",
      finishedAt: new Date().toISOString(),
      error: {
        code: "provider_image_build_unsupported",
        message: `sandbox backend ${backend} does not support immutable provider image builds`,
        retryable: false,
      },
    });
  }

  throwIfAborted(input.signal);
  let builtIdentity: {
    imageId: string;
    providerBindingKey: string;
  } | null = null;
  let artifactId: string | null = null;
  try {
    const built = await buildImmutableProviderImage({
      backend,
      settings: input.settings,
      session: input.established.session,
      requestId: building.buildRequestId,
      timeoutMs: input.settings.sandboxSnapshotTimeoutMs,
    });
    if (!built || (!built.imageId && !built.imageDigest)) {
      throw new Error("provider image builder returned no immutable image identity");
    }
    if (backend === "modal") {
      if (!built.imageId || !built.providerBindingKey || !built.providerBinding) {
        throw new Error("Modal provider image build returned incomplete ownership identity");
      }
      builtIdentity = {
        imageId: built.imageId,
        providerBindingKey: built.providerBindingKey,
      };
      const archiveBytes = encodeNativeSnapshotRef({
        provider: "modal_snapshot_filesystem",
        snapshotId: built.imageId,
        workspacePersistence: "snapshot_filesystem",
      });
      const descriptor = describeNativeSnapshotArchive(archiveBytes);
      if (!descriptor) {
        throw new Error("Modal provider image build returned an invalid snapshot identity");
      }
      const artifact = await registerSandboxCheckpointArtifact(input.db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sandboxGroupId: input.target.id,
        sourceLeaseId: input.ownership.leaseId,
        sourceLeaseEpoch: input.ownership.leaseEpoch,
        sourceInstanceId: input.ownership.instanceId,
        sourceWorkspaceGeneration: input.ownership.workspaceGeneration,
        providerBindingKey: built.providerBindingKey,
        providerBinding: built.providerBinding,
        workspaceArchive: Buffer.from(archiveBytes).toString("base64"),
        workspaceArchiveMeta: descriptor,
      });
      artifactId = artifact.id;
    }
    if (input.signal.aborted) {
      if (artifactId) {
        await markSandboxCheckpointArtifactDeletePending(input.db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          artifactId,
          reason: "rig_provider_image_build_cancelled",
        }).catch(() => false);
      }
      throw abortReason(input.signal);
    }
    return await finalize({
      ...building,
      provider: built.provider,
      status: "ready",
      imageId: built.imageId,
      imageDigest: built.imageDigest,
      artifactId,
      providerBindingKeyHash: built.providerBindingKey
        ? rigProviderImageProviderBindingKeyHash(built.providerBindingKey)
        : null,
      finishedAt: new Date().toISOString(),
      error: null,
    });
  } catch (error) {
    if (input.signal.aborted) throw abortReason(input.signal);
    if (artifactId) {
      await markSandboxCheckpointArtifactDeletePending(input.db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        artifactId,
        reason: "rig_provider_image_build_failed",
      }).catch(() => false);
    } else if (backend === "modal" && builtIdentity) {
      await deleteModalCheckpointSnapshot(
        input.settings,
        builtIdentity.providerBindingKey,
        builtIdentity.imageId,
      ).catch(() => "not_found" as const);
    }
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
    return await finalize({
      ...building,
      status: "failed",
      artifactId: null,
      finishedAt: new Date().toISOString(),
      error: {
        code: "provider_image_build_failed",
        message: message || "provider image build failed",
        retryable: true,
      },
    });
  }
}

export function settingsForRigVerification(
  settings: ControlActivityServices["settings"],
  packRuntime: WorkspacePackRuntime,
  rigImage: string | null,
): ControlActivityServices["settings"] {
  return settingsWithRigImage(
    settingsWithPackSandboxImage(
      settings,
      packRuntime.sandboxImage,
      packRuntime.sandboxProviderImages,
    ),
    rigImage,
  );
}

async function loadChangeTarget(
  db: Database,
  workspaceId: string,
  changeId: string,
): Promise<{ rig: Rig; baseVersion: RigVersion; change: RigChange }> {
  const change = await getRigChange(db, workspaceId, changeId);
  if (!change) {
    throw new Error(`Rig change not found: ${changeId}`);
  }
  const rig = await getRig(db, workspaceId, change.rigId);
  if (!rig) {
    throw new Error(`Rig not found for change: ${change.rigId}`);
  }
  if (!change.baseVersionId) {
    throw new Error(`Rig change ${change.id} has no base version`);
  }
  const baseVersion = await getRigVersionById(db, workspaceId, change.baseVersionId);
  if (!baseVersion || baseVersion.rigId !== rig.id) {
    throw new Error(`Base rig version not found: ${change.baseVersionId}`);
  }
  return { rig, baseVersion, change };
}

async function loadVersionTarget(
  db: Database,
  workspaceId: string,
  versionId: string,
): Promise<{ rig: Rig; version: RigVersion }> {
  const version = await getRigVersionById(db, workspaceId, versionId);
  if (!version) {
    throw new Error(`Rig version not found: ${versionId}`);
  }
  const rig = await getRig(db, workspaceId, version.rigId);
  if (!rig) {
    throw new Error(`Rig not found for version: ${version.rigId}`);
  }
  return { rig, version };
}

async function withRigVerificationActivityLifecycle<T>(
  run: (lifecycle: RigVerificationActivityLifecycle) => Promise<T>,
): Promise<T> {
  // Context.current() and the immediate heartbeat happen before lazy service
  // construction, so Temporal can deliver cancellation even while the worker
  // is opening its first database/provider dependencies.
  const lifecycle = createRigVerificationActivityLifecycle();
  try {
    throwIfAborted(lifecycle.signal);
    return await run(lifecycle);
  } finally {
    lifecycle.dispose();
  }
}

export function createRigVerificationActivities(services: () => Promise<ControlActivityServices>) {
  return {
    verifyRigChange: (input: { workspaceId: string; changeId: string }) =>
      withRigVerificationActivityLifecycle(async (lifecycle) => {
        const { settings, db, observability } = await services();
        throwIfAborted(lifecycle.signal);
        const { rig, baseVersion, change } = await loadChangeTarget(
          db,
          input.workspaceId,
          input.changeId,
        );
        const grant = systemGrant(rig);
        const startedAt = new Date().toISOString();
        await beginRigChangeVerificationAttempt(db, input.workspaceId, change.id, {
          startedAt,
          allowAlreadyVerifying: true,
        });
        await recordRigAuditEvent(db, {
          grant,
          action: "rig.verification.started",
          rigId: rig.id,
          metadata: { changeId: change.id },
        });

        const verification: Record<string, unknown> = { startedAt, checkResults: [] };
        try {
          const candidateVersion = candidateVersionForChange(baseVersion, change);
          const providerImageDefinition = providerImageDefinitionForChange(
            baseVersion,
            change,
            candidateVersion,
          );
          const packRuntime = await resolveWorkspacePackRuntime(db, input.workspaceId);
          const runSettings = settingsForRigVerification(
            settings,
            packRuntime,
            candidateVersion.image,
          );
          const providerImageContentHash = rigProviderImageContentHash({
            backend: runSettings.sandboxBackend,
            sourceImage: rigProviderImageSourceImage(runSettings, runSettings.sandboxBackend),
            definition: providerImageDefinition,
          });
          return await runWithOwnedRigVerificationSandbox(
            {
              settings: runSettings,
              db,
              observability,
              accountId: rig.accountId,
              workspaceId: input.workspaceId,
              sandboxGroupId: change.id,
              rigVersionId: candidateVersion.id,
              sessionIdPrefix: `rig-verification-${change.id}`,
              lifecycle,
            },
            async (established, runContext) => {
              if ((candidateVersion.setupScript ?? "").trim()) {
                await runRigSetupHook(established.session as never, {
                  environment: {},
                  runAs: "root",
                  commandRunner: runContext.commandRunner,
                  rigSetup: {
                    rigId: rig.id,
                    rigName: rig.name,
                    versionId: candidateVersion.id,
                    script: candidateVersion.setupScript ?? "",
                    timeoutMs: settings.rigSetupTimeoutMs,
                    contentHash: providerImageContentHash,
                  },
                });
                verification.setupResult = { exitCode: 0, output: "" };
              }
              const command = setupAppendCommand(change);
              if (command) {
                const commandResult = await runCommand(
                  established.session as TurnSandboxCommandSession,
                  command,
                  settings.rigSetupTimeoutMs,
                  runContext.commandRunner,
                );
                verification.commandResult = commandResult;
                if (commandResult.exitCode !== 0) {
                  verification.finishedAt = new Date().toISOString();
                  verification.passed = false;
                  const updated = await updateRigChangeStatus(db, input.workspaceId, change.id, {
                    status: "rejected",
                    verification,
                  });
                  await recordRigAuditEvent(db, {
                    grant,
                    action: "rig.verification.failed",
                    rigId: rig.id,
                    metadata: { changeId: change.id, status: "rejected" },
                  });
                  await recordRigAuditEvent(db, {
                    grant,
                    action: "rig.change.rejected",
                    rigId: rig.id,
                    metadata: { changeId: change.id },
                  });
                  return updated;
                }
                const markerResult = await runCommand(
                  established.session as TurnSandboxCommandSession,
                  rigProviderImageContentMarkerCommand(providerImageContentHash),
                  settings.rigSetupTimeoutMs,
                  runContext.commandRunner,
                );
                if (markerResult.exitCode !== 0) {
                  throw new Error(
                    `Failed to seal rig provider image content marker: ${markerResult.output.slice(-2000)}`,
                  );
                }
              }
              const checkResults = [];
              for (const check of candidateVersion.checks) {
                const result = await runCommand(
                  established.session as TurnSandboxCommandSession,
                  check.command,
                  settings.rigSetupTimeoutMs,
                  runContext.commandRunner,
                );
                checkResults.push({
                  name: check.name,
                  command: check.command,
                  ...result,
                });
              }
              verification.checkResults = checkResults;
              const passed = checkResults.every((result) => result.exitCode === 0);
              if (passed) {
                verification.providerImage = await buildVerifiedRigProviderImage({
                  settings: runSettings,
                  db,
                  accountId: rig.accountId,
                  workspaceId: input.workspaceId,
                  definition: providerImageDefinition,
                  target: { kind: "change", id: change.id },
                  established,
                  ownership: runContext.ownership,
                  signal: runContext.signal,
                });
              }
              verification.finishedAt = new Date().toISOString();
              verification.passed = passed;
              const classified = classifyRigVerificationOutcome({ kind: change.kind, passed });
              if (classified.action === "auto_promote") {
                // Keep the change `verifying` (NOT `proposed`) across the write→promote
                // gap: promoteSetupAppendChange accepts `verifying`, and leaving it
                // `verifying` keeps beginRigChangeVerificationAttempt blocking a
                // concurrent /verify — resetting to `proposed` would reopen that race
                // (a second run could reject a change whose first verification passed).
                await updateRigChangeStatus(db, input.workspaceId, change.id, {
                  status: "verifying",
                  verification,
                });
                const { change: merged } = await promoteSetupAppendChange({ db }, grant, rig, {
                  ...change,
                  verification,
                });
                await recordRigAuditEvent(db, {
                  grant,
                  action: "rig.verification.passed",
                  rigId: rig.id,
                  metadata: { changeId: change.id },
                });
                return merged;
              }
              const updated = await updateRigChangeStatus(db, input.workspaceId, change.id, {
                status: classified.status,
                verification,
              });
              await recordRigAuditEvent(db, {
                grant,
                action: passed ? "rig.verification.passed" : "rig.verification.failed",
                rigId: rig.id,
                metadata: { changeId: change.id, status: classified.status },
              });
              if (!passed) {
                await recordRigAuditEvent(db, {
                  grant,
                  action: "rig.change.rejected",
                  rigId: rig.id,
                  metadata: { changeId: change.id },
                });
              }
              return updated;
            },
          );
        } catch (error) {
          verification.finishedAt = new Date().toISOString();
          verification.passed = false;
          verification.error = error instanceof Error ? error.message : String(error);
          const updated = await updateRigChangeStatus(db, input.workspaceId, change.id, {
            status: "failed",
            verification,
          });
          await recordRigAuditEvent(db, {
            grant,
            action: "rig.verification.failed",
            rigId: rig.id,
            metadata: { changeId: change.id, status: "failed" },
          });
          await recordRigAuditEvent(db, {
            grant,
            action: "rig.change.failed",
            rigId: rig.id,
            metadata: { changeId: change.id },
          });
          if (lifecycle.signal.aborted) throw abortReason(lifecycle.signal);
          return updated;
        }
      }),

    verifyRigVersion: (input: { workspaceId: string; versionId: string }) =>
      withRigVerificationActivityLifecycle(async (lifecycle) => {
        const { settings, db, observability } = await services();
        throwIfAborted(lifecycle.signal);
        const { rig, version } = await loadVersionTarget(db, input.workspaceId, input.versionId);
        const grant = systemGrant(rig);
        const startedAt = new Date().toISOString();
        await recordRigAuditEvent(db, {
          grant,
          action: "rig.verification.started",
          rigId: rig.id,
          metadata: { versionId: version.id },
        });
        try {
          const packRuntime = await resolveWorkspacePackRuntime(db, input.workspaceId);
          const runSettings = settingsForRigVerification(settings, packRuntime, version.image);
          const providerImageContentHash = rigProviderImageContentHash({
            backend: runSettings.sandboxBackend,
            sourceImage: rigProviderImageSourceImage(runSettings, runSettings.sandboxBackend),
            definition: version,
          });
          return await runWithOwnedRigVerificationSandbox(
            {
              settings: runSettings,
              db,
              observability,
              accountId: rig.accountId,
              workspaceId: input.workspaceId,
              sandboxGroupId: version.id,
              rigVersionId: version.id,
              sessionIdPrefix: `rig-version-verification-${version.id}`,
              lifecycle,
            },
            async (established, runContext) => {
              if ((version.setupScript ?? "").trim()) {
                await runRigSetupHook(established.session as never, {
                  environment: {},
                  runAs: "root",
                  commandRunner: runContext.commandRunner,
                  rigSetup: {
                    rigId: rig.id,
                    rigName: rig.name,
                    versionId: version.id,
                    script: version.setupScript ?? "",
                    timeoutMs: settings.rigSetupTimeoutMs,
                    contentHash: providerImageContentHash,
                  },
                });
              }
              const checkResults = [];
              for (const check of version.checks) {
                checkResults.push({
                  name: check.name,
                  command: check.command,
                  ...(await runCommand(
                    established.session as TurnSandboxCommandSession,
                    check.command,
                    settings.rigSetupTimeoutMs,
                    runContext.commandRunner,
                  )),
                });
              }
              const passed = checkResults.every((result) => result.exitCode === 0);
              const providerImage = passed
                ? await buildVerifiedRigProviderImage({
                    settings: runSettings,
                    db,
                    accountId: rig.accountId,
                    workspaceId: input.workspaceId,
                    existingVersionId: version.id,
                    definition: version,
                    target: { kind: "version", id: version.id },
                    established,
                    ownership: runContext.ownership,
                    signal: runContext.signal,
                  })
                : null;
              await recordRigAuditEvent(db, {
                grant,
                action: passed ? "rig.verification.passed" : "rig.verification.failed",
                rigId: rig.id,
                metadata: {
                  versionId: version.id,
                  startedAt,
                  finishedAt: new Date().toISOString(),
                  passed,
                  checkResults,
                  providerImage,
                },
              });
              return { versionId: version.id, passed, checkResults, providerImage };
            },
          );
        } catch (error) {
          // Infra failure (sandbox establish / setup / check exec threw) — record
          // rig.verification.failed so activeVersionHealth reflects the failed
          // re-run instead of staying stale, symmetric to verifyRigChange. Then
          // rethrow so the Temporal activity still surfaces the failure.
          const detail = error instanceof Error ? error.message : String(error);
          await recordRigAuditEvent(db, {
            grant,
            action: "rig.verification.failed",
            rigId: rig.id,
            metadata: {
              versionId: version.id,
              startedAt,
              finishedAt: new Date().toISOString(),
              passed: false,
              error: detail,
            },
          });
          throw error;
        }
      }),
  };
}
