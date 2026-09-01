import type {
  AccessGrant,
  Rig,
  RigChange,
  RigCheck,
  RigProviderImage,
  RigPlatformSurfaceValidationReceipt,
  RigVersion,
  SandboxBackend,
} from "@opengeni/contracts";
import { createHash } from "node:crypto";
import { RIG_PROVIDER_IMAGE_COLD_BOOT_VALIDATION_VERSION } from "@opengeni/contracts";
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
  beginRigProviderImageCleanupObligation,
  claimRigVersionProviderImageBuild,
  completeRigVersionVerification,
  commitWarmingToWarm,
  failWarmingToCold,
  finalizeRigVersionProviderImageBuild,
  failRigVersionVerification,
  getRig,
  getRigChange,
  getRigVersionById,
  isCurrentRigChangeVerificationAttempt,
  isCurrentRigVersionVerificationAttempt,
  markWarmLeaseInstanceLost,
  markRigProviderImageCleanupObligationBuildFailed,
  markRigProviderImageCleanupObligationOutcomeUnknown,
  markSandboxCheckpointArtifactDeletePending,
  recordWarmingSandboxCreated,
  recordRigProviderImageCleanupObject,
  registerSandboxCheckpointArtifact,
  releaseLeaseHolder,
  settleRigProviderImageCleanupObligation,
  touchLeaseHolder,
  updateRigChangeStatusForVerificationAttempt,
  type Database,
} from "@opengeni/db";
import {
  attachProviderTrustedRigPlatformSurface,
  buildImmutableProviderImage,
  classifyModalImmutableProviderImageBuildFailure,
  createTurnToolCancellationController,
  describeNativeSnapshotArchive,
  encodeNativeSnapshotRef,
  establishSandboxSessionFromEnvelope,
  sandboxCommandExitCode,
  sandboxCommandOutput,
  serializeEstablishedSandboxEnvelope,
  providerSupportsImmutableImageBuild,
  resolveModalCheckpointProviderBindingForSession,
  tagModalSandbox,
  terminateManagedSandboxSession,
  verifySandboxExecReadiness,
  type EstablishedSandboxSession,
  type BrowserControlPlacementSession,
  type TurnSandboxCommandArgs,
  type TurnSandboxCommandSession,
} from "@opengeni/runtime/sandbox";
import type { Context } from "@temporalio/activity";
import type { ControlActivityServices } from "./types";
import { rigProviderImageSourceImage } from "./sandbox-images";
import { resolveWorkspacePackRuntime, type WorkspacePackRuntime } from "./packs";
import { currentActivityContext } from "./streaming";
import { runRigPlatformSurfaceValidation } from "./rig-platform-surface-validation";
import { reconcileRigProviderImageCleanupObligationsForSource } from "./rig-provider-image-cleanup";

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
  | {
      workspaceId: string;
      changeId: string;
      attemptId: string;
      executionGeneration: number;
      versionId?: never;
    }
  | {
      workspaceId: string;
      versionId: string;
      attemptId: string;
      executionGeneration: number;
      changeId?: never;
    };

type CommandResult = {
  exitCode: number | null;
  output: string;
};

export type RigPlatformCheckResult = CommandResult & RigCheck;

/**
 * Platform-owned checks run after Rig setup and independently of user-declared
 * checks. They prove that a Rig layered on the deployment image did not remove
 * or replace the Browser, Terminal, or Computer/Desktop services. The commands
 * start each enabled service on its canonical loopback port, wait for its own
 * readiness contract, probe it, and tear it down before provider snapshotting.
 */
export function rigPlatformChecksForSettings(
  settings: ControlActivityServices["settings"],
): RigCheck[] {
  const checks: RigCheck[] = [
    {
      name: "opengeni-platform-browser",
      command: [
        "set -eu",
        "test -x /usr/local/bin/opengeni-browserd",
        "test -x /usr/local/bin/opengeni-browserd-up",
        "test -x /usr/local/bin/opengeni-browserd-down",
        "test -r /etc/opengeni/browser-engine",
        '__og_browser_engine="$(head -n 1 /etc/opengeni/browser-engine)"',
        'test -n "$__og_browser_engine"',
        'test -x "$__og_browser_engine"',
        '__og_browser_token="$(mktemp)"',
        "trap 'opengeni-browserd-down >/dev/null 2>&1 || true; rm -f \"$__og_browser_token\"' EXIT",
        "printf '%s\\n' 'rig-platform-check' > \"$__og_browser_token\"",
        'chmod 0600 "$__og_browser_token"',
        'OPENGENI_BROWSERD_ADMIN_TOKEN_FILE="$__og_browser_token" OPENGENI_BROWSERD_PORT=7682 OPENGENI_BROWSERD_ALLOWED_ORIGINS= opengeni-browserd-up',
        "curl --noproxy '*' -fsS http://127.0.0.1:7682/healthz >/dev/null",
        "curl --noproxy '*' -fsS -H 'Authorization: Bearer rig-platform-check' http://127.0.0.1:7682/v1/browser-sessions >/dev/null",
      ].join("\n"),
    },
  ];

  if (settings.sandboxTerminalEnabled) {
    checks.push({
      name: "opengeni-platform-terminal",
      command: [
        "set -eu",
        "test -x /usr/local/bin/opengeni-terminal-up",
        "test -x /usr/local/bin/opengeni-terminal-down",
        "command -v ttyd >/dev/null",
        "trap 'opengeni-terminal-down >/dev/null 2>&1 || true' EXIT",
        "TERMINAL_PORT=7681 opengeni-terminal-up",
        "curl --noproxy '*' -fsS http://127.0.0.1:7681/ >/dev/null",
      ].join("\n"),
    });
  }

  if (settings.sandboxDesktopEnabled) {
    checks.push({
      name: "opengeni-platform-computer-desktop",
      command: [
        "set -eu",
        "test -x /usr/local/bin/opengeni-desktop-up",
        "test -x /usr/local/bin/opengeni-desktop-down",
        "command -v Xvfb >/dev/null",
        "command -v x11vnc >/dev/null",
        "command -v websockify >/dev/null",
        "command -v scrot >/dev/null",
        "command -v xdotool >/dev/null",
        '__og_desktop_home="$(mktemp -d)"',
        "trap 'opengeni-desktop-down >/dev/null 2>&1 || true; rm -rf \"$__og_desktop_home\"' EXIT",
        'HOME="$__og_desktop_home" STREAM_PORT=6080 DESKTOP_W=1280 DESKTOP_H=800 opengeni-desktop-up',
        "curl --noproxy '*' -fsS http://127.0.0.1:6080/vnc.html >/dev/null",
        "nc -z 127.0.0.1 5900",
      ].join("\n"),
    });
  }

  return checks;
}

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

export class RigProviderImageBuildDeadlineError extends Error {
  readonly name = "RigProviderImageBuildDeadlineError";

  constructor() {
    super("Rig provider image build exceeded the remaining verification work deadline");
  }
}

export type RigVerificationActivityLifecycle = {
  signal: AbortSignal;
  /** Absolute boundary for verifier work; cleanup begins when this is reached. */
  workDeadlineAtMs: number | null;
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
  const workDeadlineAtMs =
    serverDeadlineAtMs === null || reserveMs === null ? null : serverDeadlineAtMs - reserveMs;

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
    workDeadlineAtMs,
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
  attachTrustedSurface: typeof attachProviderTrustedRigPlatformSurface;
  reconcileProviderImageBuilds: typeof reconcileRigProviderImageCleanupObligationsForSource;
  createCancellationController: typeof createTurnToolCancellationController;
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
  attachTrustedSurface: attachProviderTrustedRigPlatformSurface,
  reconcileProviderImageBuilds: reconcileRigProviderImageCleanupObligationsForSource,
  createCancellationController: createTurnToolCancellationController,
};

export function rigVerificationLeaseHolderId(input: {
  targetKind: "change" | "version" | "provider_image";
  targetId: string;
  attemptId: string;
  executionGeneration: number;
}): string {
  const digest = createHash("sha256")
    .update(
      `${input.targetKind}:${input.targetId}:${input.attemptId}:${input.executionGeneration}`,
      "utf8",
    )
    .digest("hex")
    .slice(0, 32);
  return `rig-verification:${digest}`;
}

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
    holderId: string;
    /** Assertion-only immutable image identity. Provider-owned validation
     * still discovers its authority from the exact live sandbox instance. */
    expectedProviderImageId?: string;
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

  const holderId = input.holderId;
  const fallbackController = new AbortController();
  const signal = input.lifecycle?.signal ?? fallbackController.signal;
  const commandController = dependencies.createCancellationController(signal);
  const commandRunner = commandController.runSandboxCommand.bind(commandController);
  let cleanupTarget: EstablishedSandboxSession | null = null;
  let acquired = false;
  let ownsWarmingEpoch = false;
  let expectedEpoch: number | null = null;
  let committedLeaseId: string | null = null;
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
      image: rigProviderImageSourceImage(input.settings, input.settings.sandboxBackend),
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
    await waitForAbortable(verifySandboxExecReadiness(established), signal);
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
    committedLeaseId = committed.lease.id;
    const providerImage = requiredRigVerificationProviderImage(input.settings);
    const trustedSurfaceAttached = await dependencies.attachTrustedSurface({
      backend: established.backendId as SandboxBackend,
      settings: input.settings,
      session: established.session,
      instanceId: established.instanceId,
      providerImage,
      ...(input.expectedProviderImageId
        ? { expectedProviderImageId: input.expectedProviderImageId }
        : {}),
      leaseId: committed.lease.id,
      leaseEpoch: committed.lease.leaseEpoch,
      workspaceGeneration: committed.lease.workspaceGeneration,
      sandboxGroupId: input.sandboxGroupId,
      rigVersionId: input.rigVersionId,
    });
    if (!trustedSurfaceAttached) {
      throw new Error(
        `sandbox backend ${established.backendId} has no deployment-owned Rig platform validation authority`,
      );
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
      try {
        if (!committedLeaseId) return await terminateAndClear(cleanupTarget);
        await dependencies.reconcileProviderImageBuilds({
          db: input.db,
          settings: input.settings,
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sourceLeaseId: committedLeaseId,
          sourceInstanceId: cleanupTarget.instanceId,
          timeoutMs: cleanupWaitMs(input.lifecycle),
        });
      } catch (error) {
        warnCleanupFailure("provider_image_build_reconciliation", cleanupTarget.instanceId, error);
        return false;
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

async function runRigChecks(
  session: TurnSandboxCommandSession,
  checks: readonly RigCheck[],
  timeoutMs: number,
  commandRunner: SandboxLifecycleCommandRunner,
): Promise<RigPlatformCheckResult[]> {
  const results: RigPlatformCheckResult[] = [];
  for (const check of checks) {
    results.push({
      name: check.name,
      command: check.command,
      ...(await runCommand(session, check.command, timeoutMs, commandRunner)),
    });
  }
  return results;
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
    return { ...baseVersion, id: change.id, image: null, providerImages: {}, active: false };
  }
  const payload = change.payload as {
    setupScript?: unknown;
    checks?: unknown;
    credentialHooks?: unknown;
    defaultVariableSetIds?: unknown;
    changelog?: unknown;
  };
  return {
    ...baseVersion,
    id: change.id,
    active: false,
    image: null,
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
  const { marker, normalizedRoot } = rigProviderImageContentMarker(contentHash, markerRoot);
  return `mkdir -p '${normalizedRoot}' && touch '${marker}'`;
}

function requiredRigVerificationProviderImage(
  settings: ControlActivityServices["settings"],
): string {
  const image = rigProviderImageSourceImage(settings, settings.sandboxBackend);
  if (!image) {
    throw new Error("Rig verification requires one exact deployment provider image");
  }
  return image;
}

function observedProviderImageId(established: EstablishedSandboxSession): string {
  const imageId = (established.session as BrowserControlPlacementSession).trustedRigPlatformSurface
    ?.binding.providerImageId;
  if (!imageId) {
    throw new Error("Rig verification has no immutable trusted platform image binding");
  }
  return imageId;
}

function rigProviderImageContentMarker(
  contentHash: string,
  markerRoot = "/var/opengeni",
): { marker: string; normalizedRoot: string } {
  if (!/^sha256:[0-9a-f]{64}$/u.test(contentHash)) {
    throw new Error("Rig provider image content marker requires a canonical SHA-256 value");
  }
  if (!/^\/[A-Za-z0-9._/-]+$/u.test(markerRoot)) {
    throw new Error("Rig provider image marker root must be a safe absolute path");
  }
  const normalizedRoot = markerRoot.replace(/\/+$/u, "") || "/";
  const marker = `${normalizedRoot === "/" ? "" : normalizedRoot}/rig-setup-content-${contentHash.slice("sha256:".length)}.done`;
  return { marker, normalizedRoot };
}

export type RigProviderImageColdBootDependencies = {
  runOwnedSandbox: typeof runWithOwnedRigVerificationSandbox;
  runSurfaceValidation: typeof runRigPlatformSurfaceValidation;
  now: () => Date;
};

const defaultRigProviderImageColdBootDependencies: RigProviderImageColdBootDependencies = {
  runOwnedSandbox: runWithOwnedRigVerificationSandbox,
  runSurfaceValidation: runRigPlatformSurfaceValidation,
  now: () => new Date(),
};

/** Prove a provider image from a second clean sandbox before runtime selection. */
export async function verifyRigProviderImageColdBoot(
  input: {
    settings: ControlActivityServices["settings"];
    db: Database;
    observability: ControlActivityServices["observability"];
    accountId: string;
    workspaceId: string;
    buildRequestId: string;
    rigVersionId: string;
    verificationAttemptId: string;
    verificationExecutionGeneration: number;
    sessionIdPrefix: string;
    imageId: string;
    contentHash: string;
    checks: RigProviderImageDefinition["checks"];
    lifecycle: RigVerificationActivityLifecycle;
  },
  dependencies: RigProviderImageColdBootDependencies = defaultRigProviderImageColdBootDependencies,
): Promise<{
  checkedAt: string;
  platformSurfaceValidation: RigPlatformSurfaceValidationReceipt;
}> {
  const { marker } = rigProviderImageContentMarker(input.contentHash);
  const platformSurfaceValidation = await dependencies.runOwnedSandbox(
    {
      settings: {
        ...input.settings,
        modalImageId: input.imageId,
        // The full-machine provider image is the immutable rig base. Any future
        // workspace recovery must layer /workspace onto it, never replace it.
        modalWorkspacePersistence: "snapshot_directory",
      },
      db: input.db,
      observability: input.observability,
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sandboxGroupId: input.buildRequestId,
      rigVersionId: input.rigVersionId,
      sessionIdPrefix: input.sessionIdPrefix,
      holderId: rigVerificationLeaseHolderId({
        targetKind: "provider_image",
        targetId: input.buildRequestId,
        attemptId: input.verificationAttemptId,
        executionGeneration: input.verificationExecutionGeneration,
      }),
      expectedProviderImageId: input.imageId,
      lifecycle: input.lifecycle,
    },
    async (established, runContext) => {
      const markerResult = await runCommand(
        established.session as TurnSandboxCommandSession,
        `test -f '${marker}'`,
        input.settings.rigSetupTimeoutMs,
        runContext.commandRunner,
      );
      if (markerResult.exitCode !== 0) {
        throw new Error("built provider image is missing its exact rig-content marker");
      }
      for (const check of rigPlatformChecksForSettings(input.settings)) {
        const result = await runCommand(
          established.session as TurnSandboxCommandSession,
          check.command,
          input.settings.rigSetupTimeoutMs,
          runContext.commandRunner,
        );
        if (result.exitCode !== 0) {
          throw new Error(
            `built provider image failed mandatory platform check ${JSON.stringify(check.name)}: ${result.output.slice(-2000)}`,
          );
        }
      }
      const receipt = await dependencies.runSurfaceValidation({
        settings: input.settings,
        db: input.db,
        workspaceId: input.workspaceId,
        sandboxGroupId: input.buildRequestId,
        rigVersionId: input.rigVersionId,
        providerImage: input.imageId,
        providerImageId: input.imageId,
        established,
        ownership: runContext.ownership,
        lifecycle: input.lifecycle,
      });
      for (const check of input.checks) {
        const result = await runCommand(
          established.session as TurnSandboxCommandSession,
          check.command,
          input.settings.rigSetupTimeoutMs,
          runContext.commandRunner,
        );
        if (result.exitCode !== 0) {
          throw new Error(
            `built provider image failed check ${JSON.stringify(check.name)}: ${result.output.slice(-2000)}`,
          );
        }
      }
      return receipt;
    },
  );
  return {
    checkedAt: dependencies.now().toISOString(),
    platformSurfaceValidation,
  };
}

export type RigProviderImageBuildVerification = {
  image: RigProviderImage;
  platformSurfaceValidation: RigPlatformSurfaceValidationReceipt | null;
};

export async function buildVerifiedRigProviderImage(
  input: {
    settings: ControlActivityServices["settings"];
    db: Database;
    observability: ControlActivityServices["observability"];
    accountId: string;
    workspaceId: string;
    existingVersionId?: string;
    definition: RigProviderImageDefinition;
    target: { kind: "change" | "version"; id: string };
    verificationAttemptId: string;
    verificationExecutionGeneration: number;
    established: EstablishedSandboxSession;
    ownership: RigVerificationSandboxRunContext["ownership"];
    lifecycle: RigVerificationActivityLifecycle;
    signal: AbortSignal;
  },
  dependencies: {
    buildImmutableProviderImage: typeof buildImmutableProviderImage;
    resolveProviderBinding: typeof resolveModalCheckpointProviderBindingForSession;
    beginCleanupObligation: typeof beginRigProviderImageCleanupObligation;
    recordCleanupObject: typeof recordRigProviderImageCleanupObject;
    settleCleanupObligation: typeof settleRigProviderImageCleanupObligation;
    markCleanupBuildFailed: typeof markRigProviderImageCleanupObligationBuildFailed;
    markCleanupOutcomeUnknown: typeof markRigProviderImageCleanupObligationOutcomeUnknown;
  } = {
    buildImmutableProviderImage,
    resolveProviderBinding: resolveModalCheckpointProviderBindingForSession,
    beginCleanupObligation: beginRigProviderImageCleanupObligation,
    recordCleanupObject: recordRigProviderImageCleanupObject,
    settleCleanupObligation: settleRigProviderImageCleanupObligation,
    markCleanupBuildFailed: markRigProviderImageCleanupObligationBuildFailed,
    markCleanupOutcomeUnknown: markRigProviderImageCleanupObligationOutcomeUnknown,
  },
): Promise<RigProviderImageBuildVerification> {
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
    if (claim.status === "in_progress" || claim.status === "unsupported") {
      return { image: claim.image, platformSurfaceValidation: null };
    }
    if (claim.status === "ready") {
      if (!claim.image.imageId) {
        throw new Error("ready provider image has no cold-bootable immutable image id");
      }
      const validation = await verifyRigProviderImageColdBoot({
        settings: input.settings,
        db: input.db,
        observability: input.observability,
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        buildRequestId: claim.image.buildRequestId,
        rigVersionId: input.target.id,
        verificationAttemptId: input.verificationAttemptId,
        verificationExecutionGeneration: input.verificationExecutionGeneration,
        sessionIdPrefix: `rig-provider-image-${input.target.id}`,
        imageId: claim.image.imageId,
        contentHash,
        checks: input.definition.checks,
        lifecycle: input.lifecycle,
      });
      return {
        image: claim.image,
        platformSurfaceValidation: validation.platformSurfaceValidation,
      };
    }
    if (claim.status === "conflict") {
      return {
        image: {
          ...building,
          status: "failed",
          finishedAt: new Date().toISOString(),
          error: {
            code: "provider_image_content_conflict",
            message:
              "this exact rig version already records a provider image for different effective content; mint and verify a new version",
            retryable: false,
          },
        },
        platformSurfaceValidation: null,
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
    const image = await finalize({
      ...building,
      status: "unsupported",
      finishedAt: new Date().toISOString(),
      error: {
        code: "provider_image_build_unsupported",
        message: `sandbox backend ${backend} does not support immutable provider image builds`,
        retryable: false,
      },
    });
    return { image, platformSurfaceValidation: null };
  }

  throwIfAborted(input.signal);
  let cleanupObligation: Awaited<ReturnType<typeof beginRigProviderImageCleanupObligation>> | null =
    null;
  let artifactId: string | null = null;
  let coldBootVerification: Awaited<ReturnType<typeof verifyRigProviderImageColdBoot>> | null =
    null;
  try {
    throwIfAborted(input.signal);
    const remainingWorkMs =
      input.lifecycle.workDeadlineAtMs == null
        ? input.settings.sandboxSnapshotTimeoutMs
        : Math.floor(input.lifecycle.workDeadlineAtMs - Date.now());
    if (remainingWorkMs <= 0) {
      throw new RigProviderImageBuildDeadlineError();
    }
    const buildTimeoutMs = Math.max(
      1,
      Math.min(input.settings.sandboxSnapshotTimeoutMs, remainingWorkMs),
    );
    if (backend === "modal") {
      const providerBinding = await dependencies.resolveProviderBinding(
        input.settings,
        input.established.session,
      );
      cleanupObligation = await dependencies.beginCleanupObligation(input.db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sandboxGroupId: input.target.id,
        sourceLeaseId: input.ownership.leaseId,
        sourceLeaseEpoch: input.ownership.leaseEpoch,
        sourceInstanceId: input.ownership.instanceId,
        sourceWorkspaceGeneration: input.ownership.workspaceGeneration,
        providerBindingKey: providerBinding.key,
        providerBinding: providerBinding.binding,
        buildRequestId: building.buildRequestId,
      });
    }
    const buildPromise = dependencies.buildImmutableProviderImage({
      backend,
      settings: input.settings,
      session: input.established.session,
      requestId: building.buildRequestId,
      timeoutMs: buildTimeoutMs,
    });
    let providerBuildRejected = false;
    const trackedBuildPromise = buildPromise.then(
      (result) => {
        if (
          backend === "modal" &&
          cleanupObligation &&
          result?.imageId &&
          result.providerBindingKey === cleanupObligation.providerBindingKey
        ) {
          void dependencies
            .recordCleanupObject(input.db, {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              obligationId: cleanupObligation.id,
              buildRequestId: cleanupObligation.buildRequestId,
              providerBindingKey: cleanupObligation.providerBindingKey,
              objectId: result.imageId,
            })
            .catch(() => false);
        }
        return result;
      },
      (error) => {
        providerBuildRejected = true;
        throw error;
      },
    );
    void trackedBuildPromise.catch(() => undefined);
    const deadlineSignal =
      input.lifecycle.workDeadlineAtMs == null
        ? input.signal
        : AbortSignal.any([input.signal, AbortSignal.timeout(buildTimeoutMs)]);
    let built: Awaited<ReturnType<typeof buildImmutableProviderImage>>;
    try {
      built = await waitForAbortable(trackedBuildPromise, deadlineSignal);
    } catch (error) {
      if (providerBuildRejected && cleanupObligation?.state === "building") {
        const markCleanupFailure =
          classifyModalImmutableProviderImageBuildFailure(error) === "definitive_rejection"
            ? dependencies.markCleanupBuildFailed
            : dependencies.markCleanupOutcomeUnknown;
        await markCleanupFailure(input.db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          obligationId: cleanupObligation.id,
          buildRequestId: cleanupObligation.buildRequestId,
          providerBindingKey: cleanupObligation.providerBindingKey,
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => false);
      }
      if (!input.signal.aborted && deadlineSignal.aborted) {
        throw new RigProviderImageBuildDeadlineError();
      }
      throw error;
    }
    if (!built || (!built.imageId && !built.imageDigest)) {
      throw new Error("provider image builder returned no immutable image identity");
    }
    if (backend === "modal") {
      if (!built.imageId || !built.providerBindingKey || !built.providerBinding) {
        throw new Error("Modal provider image build returned incomplete ownership identity");
      }
      if (!cleanupObligation || cleanupObligation.providerBindingKey !== built.providerBindingKey) {
        throw new Error("Modal provider image build returned another provider binding");
      }
      const objectRecorded = await dependencies.recordCleanupObject(input.db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        obligationId: cleanupObligation.id,
        buildRequestId: cleanupObligation.buildRequestId,
        providerBindingKey: cleanupObligation.providerBindingKey,
        objectId: built.imageId,
      });
      if (!objectRecorded) {
        throw new Error("Modal provider image build could not persist its exact image id");
      }
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
        registrationIdentity: "provider_object",
      });
      artifactId = artifact.id;
      const obligationSettled = await dependencies.settleCleanupObligation(input.db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        obligationId: cleanupObligation.id,
        objectId: built.imageId,
      });
      if (!obligationSettled) {
        throw new Error("Modal provider image cleanup ownership could not be transferred");
      }

      // A snapshot receipt is not proof that the artifact can cold-start. Boot
      // a second, independently owned sandbox from the exact image before it
      // can become runtime-selectable.
      coldBootVerification = await verifyRigProviderImageColdBoot({
        settings: input.settings,
        db: input.db,
        observability: input.observability,
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        buildRequestId: building.buildRequestId,
        rigVersionId: input.target.id,
        verificationAttemptId: input.verificationAttemptId,
        verificationExecutionGeneration: input.verificationExecutionGeneration,
        sessionIdPrefix: `rig-provider-image-${input.target.id}`,
        imageId: built.imageId,
        contentHash,
        checks: input.definition.checks,
        lifecycle: input.lifecycle,
      });
    }
    if (!coldBootVerification) {
      throw new Error(`${backend} provider image build has no independent cold-boot validator`);
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
    const image = await finalize({
      ...building,
      provider: built.provider,
      status: "ready",
      imageId: built.imageId,
      imageDigest: built.imageDigest,
      artifactId,
      providerBindingKeyHash: built.providerBindingKey
        ? rigProviderImageProviderBindingKeyHash(built.providerBindingKey)
        : null,
      coldBootValidation: {
        version: RIG_PROVIDER_IMAGE_COLD_BOOT_VALIDATION_VERSION,
        checkedAt: coldBootVerification.checkedAt,
      },
      finishedAt: new Date().toISOString(),
      error: null,
    });
    return {
      image,
      platformSurfaceValidation:
        image.status === "ready" && image.imageId === built.imageId
          ? coldBootVerification.platformSurfaceValidation
          : null,
    };
  } catch (error) {
    if (input.signal.aborted) throw abortReason(input.signal);
    if (error instanceof RigProviderImageBuildDeadlineError) throw error;
    if (artifactId) {
      await markSandboxCheckpointArtifactDeletePending(input.db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        artifactId,
        reason: "rig_provider_image_build_failed",
      }).catch(() => false);
    }
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
    const image = await finalize({
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
    return { image, platformSurfaceValidation: null };
  }
}

export function settingsForRigVerification(
  settings: ControlActivityServices["settings"],
  packRuntime: WorkspacePackRuntime,
  rigImage: string | null,
): ControlActivityServices["settings"] {
  // Rig verification must prove setup and provider-image materialization on
  // the deployment-owned platform base. Legacy Pack and historical Rig image
  // values are intentionally ignored here.
  void packRuntime;
  void rigImage;
  return settings;
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

export async function handleRigVersionVerificationActivityFailure(input: {
  error: unknown;
  terminalStateCommitted: boolean;
  failVerification: (detail: string) => Promise<{ applied: boolean; stale: boolean }>;
  recordFailureAudit: (detail: string) => Promise<void>;
}): Promise<never> {
  if (input.error instanceof RigVerificationLeaseUnavailableError) {
    throw input.error;
  }
  const detail = input.error instanceof Error ? input.error.message : String(input.error);
  if (!input.terminalStateCommitted) {
    const failure = await input
      .failVerification(detail)
      .catch(() => ({ applied: false, stale: true }));
    if (failure.applied) await input.recordFailureAudit(detail);
  }
  throw input.error;
}

export function createRigVerificationActivities(services: () => Promise<ControlActivityServices>) {
  return {
    verifyRigChange: (input: {
      workspaceId: string;
      changeId: string;
      attemptId: string;
      executionGeneration: number;
    }) =>
      withRigVerificationActivityLifecycle(async (lifecycle) => {
        const { settings, db, observability } = await services();
        throwIfAborted(lifecycle.signal);
        const { rig, baseVersion, change } = await loadChangeTarget(
          db,
          input.workspaceId,
          input.changeId,
        );
        if (
          !(await isCurrentRigChangeVerificationAttempt(db, {
            workspaceId: input.workspaceId,
            changeId: change.id,
            attemptId: input.attemptId,
            executionGeneration: input.executionGeneration,
          }))
        ) {
          throw new Error(`Rig change verification attempt is stale: ${input.attemptId}`);
        }
        const grant = systemGrant(rig);
        const startedAt = new Date().toISOString();
        await recordRigAuditEvent(db, {
          grant,
          action: "rig.verification.started",
          rigId: rig.id,
          metadata: {
            changeId: change.id,
            attemptId: input.attemptId,
            executionGeneration: input.executionGeneration,
          },
        });

        const verification: Record<string, unknown> = {
          attemptId: input.attemptId,
          executionGeneration: input.executionGeneration,
          startedAt,
          checkResults: [],
        };
        const settle = async (status: RigChange["status"]) =>
          await updateRigChangeStatusForVerificationAttempt(
            db,
            input.workspaceId,
            change.id,
            input.attemptId,
            input.executionGeneration,
            { status, verification },
          );
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
              holderId: rigVerificationLeaseHolderId({
                targetKind: "change",
                targetId: change.id,
                attemptId: input.attemptId,
                executionGeneration: input.executionGeneration,
              }),
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
                  const settlement = await settle("rejected");
                  if (!settlement.applied) return settlement.change;
                  await recordRigAuditEvent(db, {
                    grant,
                    action: "rig.verification.failed",
                    rigId: rig.id,
                    metadata: {
                      changeId: change.id,
                      status: "rejected",
                      attemptId: input.attemptId,
                      executionGeneration: input.executionGeneration,
                    },
                  });
                  await recordRigAuditEvent(db, {
                    grant,
                    action: "rig.change.rejected",
                    rigId: rig.id,
                    metadata: {
                      changeId: change.id,
                      attemptId: input.attemptId,
                      executionGeneration: input.executionGeneration,
                    },
                  });
                  return settlement.change;
                }
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
              const platformCheckResults = await runRigChecks(
                established.session as TurnSandboxCommandSession,
                rigPlatformChecksForSettings(runSettings),
                settings.rigSetupTimeoutMs,
                runContext.commandRunner,
              );
              verification.platformCheckResults = platformCheckResults;
              verification.platformSurfacePreflight = await runRigPlatformSurfaceValidation({
                settings: runSettings,
                db,
                workspaceId: input.workspaceId,
                sandboxGroupId: change.id,
                rigVersionId: candidateVersion.id,
                providerImage: requiredRigVerificationProviderImage(runSettings),
                providerImageId: observedProviderImageId(established),
                established,
                ownership: runContext.ownership,
                lifecycle,
              });
              const checkResults = await runRigChecks(
                established.session as TurnSandboxCommandSession,
                candidateVersion.checks,
                settings.rigSetupTimeoutMs,
                runContext.commandRunner,
              );
              verification.checkResults = checkResults;
              const checksPassed =
                platformCheckResults.every((result) => result.exitCode === 0) &&
                checkResults.every((result) => result.exitCode === 0);
              const providerImageBuild = checksPassed
                ? await buildVerifiedRigProviderImage({
                    settings: runSettings,
                    db,
                    observability,
                    accountId: rig.accountId,
                    workspaceId: input.workspaceId,
                    definition: providerImageDefinition,
                    target: { kind: "change", id: change.id },
                    verificationAttemptId: input.attemptId,
                    verificationExecutionGeneration: input.executionGeneration,
                    established,
                    ownership: runContext.ownership,
                    lifecycle,
                    signal: runContext.signal,
                  })
                : null;
              if (providerImageBuild) {
                verification.providerImage = providerImageBuild.image;
                if (providerImageBuild.platformSurfaceValidation) {
                  verification.platformSurfaceValidation =
                    providerImageBuild.platformSurfaceValidation;
                }
              }
              const passed =
                checksPassed &&
                providerImageBuild?.image.status === "ready" &&
                providerImageBuild.platformSurfaceValidation !== null;
              verification.finishedAt = new Date().toISOString();
              verification.passed = passed;
              const classified = classifyRigVerificationOutcome({
                kind: change.kind,
                passed,
                infraError: checksPassed && !passed,
              });
              if (classified.action === "auto_promote") {
                // Keep the change `verifying` (NOT `proposed`) across the write→promote
                // gap: promoteSetupAppendChange accepts `verifying`, and leaving it
                // `verifying` keeps beginRigChangeVerificationAttempt blocking a
                // concurrent /verify — resetting to `proposed` would reopen that race
                // (a second run could reject a change whose first verification passed).
                const settlement = await settle("verifying");
                if (!settlement.applied) return settlement.change;
                const { change: merged } = await promoteSetupAppendChange({ db }, grant, rig, {
                  ...change,
                  verification,
                });
                await recordRigAuditEvent(db, {
                  grant,
                  action: "rig.verification.passed",
                  rigId: rig.id,
                  metadata: {
                    changeId: change.id,
                    attemptId: input.attemptId,
                    executionGeneration: input.executionGeneration,
                  },
                });
                return merged;
              }
              const settlement = await settle(classified.status);
              if (!settlement.applied) return settlement.change;
              await recordRigAuditEvent(db, {
                grant,
                action: passed ? "rig.verification.passed" : "rig.verification.failed",
                rigId: rig.id,
                metadata: {
                  changeId: change.id,
                  status: classified.status,
                  attemptId: input.attemptId,
                  executionGeneration: input.executionGeneration,
                },
              });
              if (!passed) {
                await recordRigAuditEvent(db, {
                  grant,
                  action: "rig.change.rejected",
                  rigId: rig.id,
                  metadata: {
                    changeId: change.id,
                    attemptId: input.attemptId,
                    executionGeneration: input.executionGeneration,
                  },
                });
              }
              return settlement.change;
            },
          );
        } catch (error) {
          if (error instanceof RigVerificationLeaseUnavailableError) throw error;
          verification.finishedAt = new Date().toISOString();
          verification.passed = false;
          verification.error = error instanceof Error ? error.message : String(error);
          const settlement = await settle("failed");
          if (settlement.applied) {
            await recordRigAuditEvent(db, {
              grant,
              action: "rig.verification.failed",
              rigId: rig.id,
              metadata: {
                changeId: change.id,
                status: "failed",
                attemptId: input.attemptId,
                executionGeneration: input.executionGeneration,
              },
            });
            await recordRigAuditEvent(db, {
              grant,
              action: "rig.change.failed",
              rigId: rig.id,
              metadata: {
                changeId: change.id,
                attemptId: input.attemptId,
                executionGeneration: input.executionGeneration,
              },
            });
          }
          if (lifecycle.signal.aborted) throw abortReason(lifecycle.signal);
          return settlement.change;
        }
      }),

    verifyRigVersion: (input: {
      workspaceId: string;
      versionId: string;
      attemptId: string;
      executionGeneration: number;
    }) =>
      withRigVerificationActivityLifecycle(async (lifecycle) => {
        const { settings, db, observability } = await services();
        throwIfAborted(lifecycle.signal);
        const { rig, version } = await loadVersionTarget(db, input.workspaceId, input.versionId);
        if (
          !(await isCurrentRigVersionVerificationAttempt(db, {
            workspaceId: input.workspaceId,
            rigId: rig.id,
            versionId: version.id,
            attemptId: input.attemptId,
            executionGeneration: input.executionGeneration,
          }))
        ) {
          throw new Error(`Rig version verification attempt is stale: ${input.attemptId}`);
        }
        const grant = systemGrant(rig);
        const startedAt = new Date().toISOString();
        await recordRigAuditEvent(db, {
          grant,
          action: "rig.verification.started",
          rigId: rig.id,
          metadata: {
            versionId: version.id,
            attemptId: input.attemptId,
            executionGeneration: input.executionGeneration,
          },
        });
        let terminalStateCommitted = false;
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
              holderId: rigVerificationLeaseHolderId({
                targetKind: "version",
                targetId: version.id,
                attemptId: input.attemptId,
                executionGeneration: input.executionGeneration,
              }),
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
              const platformCheckResults = await runRigChecks(
                established.session as TurnSandboxCommandSession,
                rigPlatformChecksForSettings(runSettings),
                settings.rigSetupTimeoutMs,
                runContext.commandRunner,
              );
              const platformSurfacePreflight = await runRigPlatformSurfaceValidation({
                settings: runSettings,
                db,
                workspaceId: input.workspaceId,
                sandboxGroupId: version.id,
                rigVersionId: version.id,
                providerImage: requiredRigVerificationProviderImage(runSettings),
                providerImageId: observedProviderImageId(established),
                established,
                ownership: runContext.ownership,
                lifecycle,
              });
              const checkResults = await runRigChecks(
                established.session as TurnSandboxCommandSession,
                version.checks,
                settings.rigSetupTimeoutMs,
                runContext.commandRunner,
              );
              const checksPassed =
                platformCheckResults.every((result) => result.exitCode === 0) &&
                checkResults.every((result) => result.exitCode === 0);
              const providerImageBuild = checksPassed
                ? await buildVerifiedRigProviderImage({
                    settings: runSettings,
                    db,
                    observability,
                    accountId: rig.accountId,
                    workspaceId: input.workspaceId,
                    existingVersionId: version.id,
                    definition: version,
                    target: { kind: "version", id: version.id },
                    verificationAttemptId: input.attemptId,
                    verificationExecutionGeneration: input.executionGeneration,
                    established,
                    ownership: runContext.ownership,
                    lifecycle,
                    signal: runContext.signal,
                  })
                : null;
              const providerImage = providerImageBuild?.image ?? null;
              const platformSurfaceValidation =
                providerImageBuild?.platformSurfaceValidation ?? null;
              const passed =
                checksPassed &&
                providerImage?.status === "ready" &&
                platformSurfaceValidation !== null;
              const activation = passed
                ? await completeRigVersionVerification(db, {
                    workspaceId: input.workspaceId,
                    rigId: rig.id,
                    versionId: version.id,
                    attemptId: input.attemptId,
                    executionGeneration: input.executionGeneration,
                    receipt: platformSurfaceValidation,
                  })
                : null;
              const failure = passed
                ? null
                : await failRigVersionVerification(db, {
                    workspaceId: input.workspaceId,
                    rigId: rig.id,
                    versionId: version.id,
                    attemptId: input.attemptId,
                    executionGeneration: input.executionGeneration,
                    error: checksPassed
                      ? `immutable provider image validation did not pass (${providerImage?.error?.message ?? providerImage?.status ?? "no image result"})`
                      : "one or more mandatory Rig checks failed",
                  });
              terminalStateCommitted = activation?.applied ?? failure?.applied ?? false;
              const staleAttempt = activation?.applied === false || failure?.applied === false;
              if (staleAttempt) {
                return {
                  versionId: version.id,
                  passed,
                  platformCheckResults,
                  platformSurfacePreflight,
                  platformSurfaceValidation,
                  checkResults,
                  providerImage,
                  activated: false,
                  stale: true,
                };
              }
              await recordRigAuditEvent(db, {
                grant,
                action: passed ? "rig.verification.passed" : "rig.verification.failed",
                rigId: rig.id,
                metadata: {
                  versionId: version.id,
                  attemptId: input.attemptId,
                  executionGeneration: input.executionGeneration,
                  startedAt,
                  finishedAt: new Date().toISOString(),
                  passed,
                  platformCheckResults,
                  platformSurfacePreflight,
                  platformSurfaceValidation,
                  checkResults,
                  providerImage,
                  activated: activation?.activated ?? false,
                  stale: activation?.stale ?? failure?.stale ?? false,
                },
              });
              if (activation?.activated) {
                await recordRigAuditEvent(db, {
                  grant,
                  action: "rig.version.activated",
                  rigId: rig.id,
                  metadata: {
                    versionId: version.id,
                    version: version.version,
                    verification: true,
                  },
                });
              }
              return {
                versionId: version.id,
                passed,
                platformCheckResults,
                platformSurfacePreflight,
                platformSurfaceValidation,
                checkResults,
                providerImage,
                activated: activation?.activated ?? false,
                stale: activation?.stale ?? failure?.stale ?? false,
              };
            },
          );
        } catch (error) {
          // Infra failure (sandbox establish / setup / check exec threw) — record
          // rig.verification.failed so activeVersionHealth reflects the failed
          // re-run instead of staying stale, symmetric to verifyRigChange. Then
          // rethrow so the Temporal activity still surfaces the failure.
          return await handleRigVersionVerificationActivityFailure({
            error,
            terminalStateCommitted,
            failVerification: async (detail) =>
              await failRigVersionVerification(db, {
                workspaceId: input.workspaceId,
                rigId: rig.id,
                versionId: version.id,
                attemptId: input.attemptId,
                executionGeneration: input.executionGeneration,
                error: detail,
              }),
            recordFailureAudit: async (detail) =>
              await recordRigAuditEvent(db, {
                grant,
                action: "rig.verification.failed",
                rigId: rig.id,
                metadata: {
                  versionId: version.id,
                  attemptId: input.attemptId,
                  executionGeneration: input.executionGeneration,
                  startedAt,
                  finishedAt: new Date().toISOString(),
                  passed: false,
                  error: detail,
                },
              }),
          });
        }
      }),
  };
}
