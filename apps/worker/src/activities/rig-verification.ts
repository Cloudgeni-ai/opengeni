import type { AccessGrant, Rig, RigChange, RigVersion } from "@opengeni/contracts";
import {
  recordRigAuditEvent,
  classifyRigVerificationOutcome,
  promoteSetupAppendChange,
} from "@opengeni/core";
import {
  beginRigChangeVerificationAttempt,
  deactivateSandboxEphemeralOwner,
  getRig,
  getRigChange,
  getRigVersionById,
  registerSandboxEphemeralOwner,
  sanitizeEventPayload,
  sanitizeEventString,
  sanitizeMemoryText,
  updateRigChangeStatus,
  type Database,
} from "@opengeni/db";
import {
  createTurnToolCancellationController,
  establishSandboxSessionFromEnvelope,
  runRigSetupHook,
  sandboxCommandExitCode,
  sandboxCommandOutput,
  tagModalSandboxEphemeralOwner,
  type EstablishedSandboxSession,
  type SandboxLifecycleCommandRunner,
  type TurnSandboxCommandSession,
} from "@opengeni/runtime";
import type { Context } from "@temporalio/activity";
import type { ActivityServices } from "./types";
import { settingsWithRigImage } from "./packs";
import { currentActivityContext } from "./streaming";

export type RigVerificationWorkflowInput =
  | { workspaceId: string; changeId: string; versionId?: never }
  | { workspaceId: string; versionId: string; changeId?: never };

type CommandResult = {
  exitCode: number | null;
  output: string;
};

const OUTPUT_TAIL_LIMIT = 64 * 1024;
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
  "Rig verification ephemeral ownership is disabled; refusing to create an unowned verifier sandbox";

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

function tail(value: string, limit = OUTPUT_TAIL_LIMIT): string {
  return value.length > limit ? value.slice(-limit) : value;
}

function scrubVerificationOutput(value: string): string {
  return sanitizeMemoryText(sanitizeEventString(value)).text;
}

function scrubVerificationPayload<T>(value: T): T {
  return sanitizeEventPayload(value);
}

function systemGrant(rig: Rig): AccessGrant {
  return {
    accountId: rig.accountId,
    workspaceId: rig.workspaceId,
    subjectId: "system:rig-verification",
    permissions: ["rigs:use", "rigs:manage"],
  };
}

async function terminateThrowaway(established: EstablishedSandboxSession | null): Promise<void> {
  if (!established) {
    return;
  }
  const client = established.client as { delete?: (state: unknown) => Promise<unknown> };
  if (typeof client.delete === "function" && established.sessionState !== undefined) {
    await client.delete(established.sessionState);
    return;
  }
  const session = established.session as {
    terminate?: () => Promise<unknown>;
    kill?: () => Promise<unknown>;
    close?: () => Promise<unknown>;
    closed?: boolean;
  };
  if (session.terminate) {
    await session.terminate();
  } else if (session.kill) {
    await session.kill();
  } else if (session.close && !session.closed) {
    await session.close();
  }
}

export type RigVerificationOwnershipDependencies = {
  establish: typeof establishSandboxSessionFromEnvelope;
  register: typeof registerSandboxEphemeralOwner;
  deactivate: typeof deactivateSandboxEphemeralOwner;
  tag: typeof tagModalSandboxEphemeralOwner;
  terminate: typeof terminateThrowaway;
  createCancellationController: typeof createTurnToolCancellationController;
  randomUUID: () => string;
  now: () => number;
};

const defaultOwnershipDependencies: RigVerificationOwnershipDependencies = {
  establish: establishSandboxSessionFromEnvelope,
  register: registerSandboxEphemeralOwner,
  deactivate: deactivateSandboxEphemeralOwner,
  tag: tagModalSandboxEphemeralOwner,
  terminate: terminateThrowaway,
  createCancellationController: createTurnToolCancellationController,
  randomUUID: () => crypto.randomUUID(),
  now: () => Date.now(),
};

export type RigVerificationSandboxRunContext = {
  signal: AbortSignal;
  commandRunner: SandboxLifecycleCommandRunner;
};

/**
 * Run one verifier against one exactly attributed standalone sandbox.
 *
 * Ordering is deliberate and source-of-truth safe:
 *   create callback -> durable owner row -> best-effort provider tags -> setup.
 * Every exact create callback is remembered before the registration await, so
 * commit-then-lost-response ambiguity still has enough identity for finally to
 * issue idempotent exact deactivation. All candidate deactivations and provider
 * termination are started independently, so failure or timeout of one can
 * never suppress another. Temporal cancellation and the activity-local
 * deadline first cancel and drain every setup/check command. Cleanup waits are
 * bounded inside the server reserve; expiry and the global provider reaper are
 * the explicit process-death, never-returned-create, or cleanup-timeout
 * backstops because JavaScript finally cannot run after hard worker loss.
 */
export async function runWithOwnedRigVerificationSandbox<T>(
  input: {
    settings: ActivityServices["settings"];
    db: Database;
    observability: ActivityServices["observability"];
    accountId: string;
    workspaceId: string;
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
  if (!input.settings.rigVerificationEphemeralOwnersEnabled) {
    throw new Error(RIG_VERIFICATION_OWNERS_DISABLED_MESSAGE);
  }

  const executionId = dependencies.randomUUID();
  const fallbackController = new AbortController();
  const signal = input.lifecycle?.signal ?? fallbackController.signal;
  const commandController = dependencies.createCancellationController(signal);
  const commandRunner = commandController.runSandboxCommand.bind(commandController);
  let cleanupTarget: EstablishedSandboxSession | null = null;
  const createdInstanceIds = new Set<string>();
  let establishmentSettled = false;
  let establishmentPromise: Promise<EstablishedSandboxSession> | null = null;

  const warnCleanupTimeout = (operation: string, instanceId: string | null): void => {
    input.observability.warn("rig verifier: ownership cleanup timed out", {
      executionId,
      instanceId,
      operation,
      error:
        "cleanup did not settle inside the activity reserve; exact owner expiry and the global provider reaper are the bounded delayed backstop",
    });
  };

  const cleanupLateCreatedSandbox = async (created: EstablishedSandboxSession): Promise<void> => {
    const operations = [
      Promise.resolve().then(() =>
        dependencies.deactivate(input.db, {
          executionId,
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          kind: "rig_verification",
          backend: input.settings.sandboxBackend,
          instanceId: created.instanceId,
        }),
      ),
      Promise.resolve().then(() => dependencies.terminate(created)),
    ];
    // Retain rejection handlers even if one operation never returns. The
    // runtime establishment seam also terminates when this callback throws.
    for (const operation of operations) void operation.catch(() => undefined);
    const settled = await settleWithin(
      Promise.allSettled(operations),
      cleanupWaitMs(input.lifecycle),
    );
    if (settled.status === "timed_out") {
      warnCleanupTimeout("late_create", created.instanceId);
      return;
    }
    for (const [index, result] of settled.value.entries()) {
      if (result.status === "rejected") {
        input.observability.warn("rig verifier: ownership cleanup failed", {
          executionId,
          instanceId: created.instanceId,
          operation: index === 0 ? "deactivate_late_create" : "terminate_late_create",
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }
  };

  try {
    throwIfAborted(signal);
    establishmentPromise = Promise.resolve().then(() =>
      dependencies.establish(input.settings, null, {
        sessionId: `${input.sessionIdPrefix}-${executionId}`,
        recovery: "create-or-restore",
        environment: {},
        onSandboxCreated: async (created) => {
          // Retain the exact handle even if durable attribution fails. The
          // runtime establishment seam also terminates fail-closed; finally
          // retries the provider cleanup independently.
          cleanupTarget = created;
          // Record before awaiting register(). A database commit followed by a
          // lost response is indistinguishable from a failed write to this
          // process, but exact cleanup remains safe in both cases.
          createdInstanceIds.add(created.instanceId);
          await dependencies.register(input.db, {
            executionId,
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            kind: "rig_verification",
            backend: input.settings.sandboxBackend,
            instanceId: created.instanceId,
            expiresAt: new Date(dependencies.now() + RIG_VERIFICATION_OWNER_TTL_MS),
          });

          if (input.settings.sandboxBackend === "modal" && !signal.aborted) {
            try {
              await waitForAbortable(
                dependencies.tag(input.settings, created.instanceId, {
                  ownerKind: "rig_verification",
                  ownerId: executionId,
                  workspaceId: input.workspaceId,
                }),
                signal,
              );
            } catch (error) {
              if (!signal.aborted) {
                input.observability.warn("rig verifier: Modal ownership tag failed", {
                  executionId,
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
            await cleanupLateCreatedSandbox(created);
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
    createdInstanceIds.add(established.instanceId);
    const result = await run(established, { signal, commandRunner });
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

    const instanceIds = [...createdInstanceIds];
    // Start every operation from its own microtask. Even an injected dependency
    // that throws synchronously cannot suppress any sibling cleanup operation.
    const deactivationOperations = instanceIds.map((instanceId) =>
      Promise.resolve().then(() =>
        dependencies.deactivate(input.db, {
          executionId,
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          kind: "rig_verification",
          backend: input.settings.sandboxBackend,
          instanceId,
        }),
      ),
    );
    const cleanupOperations = [
      ...deactivationOperations,
      Promise.resolve().then(() => dependencies.terminate(cleanupTarget)),
    ];
    for (const operation of cleanupOperations) void operation.catch(() => undefined);
    const cleanupSettlement = await settleWithin(
      Promise.allSettled(cleanupOperations),
      cleanupWaitMs(input.lifecycle),
    );
    if (cleanupSettlement.status === "timed_out") {
      warnCleanupTimeout("deactivate_and_terminate", cleanupTarget?.instanceId ?? null);
    } else {
      const cleanupResults = cleanupSettlement.value;

      let deactivatedExactOwner = false;
      let deactivationRejected = false;
      for (const [index, instanceId] of instanceIds.entries()) {
        const result = cleanupResults[index]!;
        if (result.status === "fulfilled" && result.value === true) {
          deactivatedExactOwner = true;
        } else if (result.status === "rejected") {
          deactivationRejected = true;
          input.observability.warn("rig verifier: ownership cleanup failed", {
            executionId,
            instanceId,
            operation: "deactivate",
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          });
        }
      }
      // False is expected for stale candidates after a successful replacement
      // rebind. It is actionable only when no candidate matched and no more
      // specific database error was already reported.
      if (instanceIds.length > 0 && !deactivatedExactOwner && !deactivationRejected) {
        input.observability.warn("rig verifier: ownership cleanup failed", {
          executionId,
          instanceId: instanceIds[instanceIds.length - 1]!,
          candidateInstanceIds: instanceIds.join(","),
          operation: "deactivate",
          error:
            "no exact active ownership row was deactivated; registration may not have committed or expiry remains the backstop",
        });
      }

      const terminateResult = cleanupResults[instanceIds.length]!;
      if (terminateResult.status === "rejected") {
        input.observability.warn("rig verifier: ownership cleanup failed", {
          executionId,
          instanceId: cleanupTarget?.instanceId ?? null,
          operation: "terminate",
          error:
            terminateResult.reason instanceof Error
              ? terminateResult.reason.message
              : String(terminateResult.reason),
        });
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
    output: scrubVerificationOutput(tail(sandboxCommandOutput(result))),
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
    return baseVersion;
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
  };
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

export function createRigVerificationActivities(services: () => Promise<ActivityServices>) {
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
          const runSettings = settingsWithRigImage(settings, candidateVersion.image);
          return await runWithOwnedRigVerificationSandbox(
            {
              settings: runSettings,
              db,
              observability,
              accountId: rig.accountId,
              workspaceId: input.workspaceId,
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
                    verification: scrubVerificationPayload(verification),
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
                  command: scrubVerificationOutput(check.command),
                  ...result,
                });
              }
              verification.checkResults = checkResults;
              const passed = checkResults.every((result) => result.exitCode === 0);
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
                  verification: scrubVerificationPayload(verification),
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
                verification: scrubVerificationPayload(verification),
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
          verification.error = scrubVerificationOutput(
            error instanceof Error ? error.message : String(error),
          );
          const updated = await updateRigChangeStatus(db, input.workspaceId, change.id, {
            status: "failed",
            verification: scrubVerificationPayload(verification),
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
          const runSettings = settingsWithRigImage(settings, version.image);
          return await runWithOwnedRigVerificationSandbox(
            {
              settings: runSettings,
              db,
              observability,
              accountId: rig.accountId,
              workspaceId: input.workspaceId,
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
                  },
                });
              }
              const checkResults = [];
              for (const check of version.checks) {
                checkResults.push({
                  name: check.name,
                  command: scrubVerificationOutput(check.command),
                  ...(await runCommand(
                    established.session as TurnSandboxCommandSession,
                    check.command,
                    settings.rigSetupTimeoutMs,
                    runContext.commandRunner,
                  )),
                });
              }
              const passed = checkResults.every((result) => result.exitCode === 0);
              await recordRigAuditEvent(db, {
                grant,
                action: passed ? "rig.verification.passed" : "rig.verification.failed",
                rigId: rig.id,
                metadata: scrubVerificationPayload({
                  versionId: version.id,
                  startedAt,
                  finishedAt: new Date().toISOString(),
                  passed,
                  checkResults,
                }),
              });
              return { versionId: version.id, passed, checkResults };
            },
          );
        } catch (error) {
          // Infra failure (sandbox establish / setup / check exec threw) — record
          // rig.verification.failed so activeVersionHealth reflects the failed
          // re-run instead of staying stale, symmetric to verifyRigChange. Then
          // rethrow so the Temporal activity still surfaces the failure.
          const detail = tail(
            scrubVerificationOutput(error instanceof Error ? error.message : String(error)),
            4096,
          );
          await recordRigAuditEvent(db, {
            grant,
            action: "rig.verification.failed",
            rigId: rig.id,
            metadata: scrubVerificationPayload({
              versionId: version.id,
              startedAt,
              finishedAt: new Date().toISOString(),
              passed: false,
              error: detail,
            }),
          });
          throw error;
        }
      }),
  };
}
