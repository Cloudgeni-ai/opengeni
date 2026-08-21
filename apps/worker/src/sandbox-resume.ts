// apps/worker/src/sandbox-resume.ts — the stateless per-turn resume-by-id path.
//
// This is the turn-side half of the P1.2 ownership inversion. There is NO class,
// NO timers, NO per-session owner, NO Map<id, owner> — every turn is a
// self-contained critical section run by ANY pool worker:
//
//   1. acquireLease (group-keyed) under the DB FOR UPDATE + cold->warming CAS —
//      the SOLE double-spawn guard (P1.1).
//   2. The cold->warming winner may create/restore. Every attached caller is
//      resume-only; a missing provider box retires the exact warm epoch and
//      re-enters admission instead of creating a rival.
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

import {
  effectiveSandboxLifecycle,
  sandboxArchiveCaptureTimeoutMs,
  sandboxLifecycleTransitionWaitMs,
  type Settings,
} from "@opengeni/config";
import { randomUUID } from "node:crypto";
import {
  acquireLease,
  adoptLegacyModalCheckpointArtifact,
  beginSandboxRematerialization,
  claimWorkspaceArchiveCapture,
  commitWarmingToWarm,
  failSandboxRematerialization,
  failWarmingToCold,
  getSandboxSessionEnvelope,
  heartbeatLeaseHolder,
  markSandboxRestoreVerifying,
  markWarmLeaseInstanceLost,
  markSandboxCheckpointArtifactDeletePending,
  persistWarmSnapshot,
  readLease,
  registerSandboxCheckpointArtifact,
  recordWarmingSandboxCreated,
  releaseWorkspaceArchiveCapture,
  releaseLeaseHolder,
  touchLeaseHolder,
  SandboxLeaseRecoveryBlockedError,
  SandboxLeaseSupersededError,
  SandboxLeaseTransitionError,
  type Database,
  type LeaseHolderKind,
} from "@opengeni/db";
import {
  captureVerifiedWorkspaceArchive,
  describeLegacyNativeSnapshotArchive,
  inlineWorkspaceArchiveForRestore,
  MODAL_EXEC_READINESS_TIMEOUT_MS,
  SandboxExecReadinessError,
  WorkspaceArchiveIntegrityError,
  establishSandboxSessionFromEnvelope,
  isProviderSandboxNotFoundError,
  parseWorkspaceArchiveDescriptor,
  providerWorkspaceCapturePolicy,
  SandboxProviderContinuityUnavailableError,
  requirePersistableReplacementSandboxEnvelope,
  renewSandboxProviderExpiration,
  modalSessionMatchesCheckpointProviderBinding,
  resolveModalCheckpointProviderBindingForSession,
  serializeReplacementSandboxEnvelope,
  tagModalSandbox,
  terminateUnpublishedSandboxSession,
  verifySandboxExecReadiness,
  withoutSandboxProviderIdentity,
  type EstablishedSandboxSession,
  type RuntimeMetricsHooks,
  type WorkspaceArchiveDescriptor,
} from "@opengeni/runtime";
import type { ObjectStorage } from "@opengeni/storage";
import { parseWorkspaceArchiveObjectRef } from "@opengeni/contracts";
import {
  collectWorkspaceArchiveObjectKeys,
  deleteUnpublishedWorkspaceArchiveObject,
  deleteWorkspaceArchiveObjectKeys,
  putVersion1TarArchiveOrInline,
} from "./sandbox-archive-storage";

// Re-exported for callers that just want the ack-kind union.
export type ResumeHolderKind = LeaseHolderKind;

/**
 * The durable identity of a turn holding a shared sandbox lease.
 *
 * Temporal activity ids cannot satisfy this type: they are workflow-local
 * sequence numbers and collide across sessions that share a sandbox group.
 */
export type TurnSandboxLeaseHolderId = `turn-attempt:${string}`;

export function sandboxLeaseHolderIdForAttempt(attemptId: string): TurnSandboxLeaseHolderId {
  const normalized = attemptId.trim();
  if (!normalized) {
    throw new Error("Sandbox lease holder requires a turn attempt id");
  }
  return `turn-attempt:${normalized}`;
}

export function isRetryableDegradedRestore(restore: {
  status: string;
  retryable?: boolean;
}): boolean {
  return restore.status === "degraded" && restore.retryable === true;
}

/** The minimal services surface resumeBoxForTurn needs. A subset of
 *  ActivityServices so a test (and the API later) can pass a lean bag. */
export type SandboxResumeServices = {
  db: Database;
  settings: Settings;
  objectStorage?: ObjectStorage | null;
  /** Exact settings before a verified rig provider image overlaid the logical
   * pack/deployment image. Fresh-create NotFound fallback must preserve an
   * ID-only logical base instead of selecting the provider default. */
  logicalFallbackSettings?: Settings;
  sandboxMetrics?: RuntimeMetricsHooks;
  /**
   * The logical turn-attempt lifetime, not merely the provider request lifetime.
   * Some provider SDK calls cannot be interrupted. Aborting this signal still
   * releases the durable holder immediately and fences any late provider result.
   */
  cancellationSignal?: AbortSignal;
  /** Test seam for the attached/resumed path. Production uses the one runtime
   * resume primitive; callers must not use this to create a replacement box. */
  establishAttachedSandbox?: typeof establishSandboxSessionFromEnvelope;
  /** Test seam for the bounded command-readiness proof performed before an
   * attached provider box is handed to the agent. */
  verifyAttachedSandboxReadiness?: (established: EstablishedSandboxSession) => Promise<void>;
  /** Called only by the observer that wins the exact warm->cold loss CAS. */
  onSandboxLost?: (input: {
    sandboxGroupId: string;
    instanceId: string;
    leaseEpoch: number;
  }) => Promise<void>;
};

export type ResumeBoxIds = {
  accountId: string;
  workspaceId: string;
  sandboxGroupId: string;
  /** The attributing session within the group (holders carry session_id for
   *  disclosure/attribution). For a singleton group this == sandboxGroupId. */
  sessionId: string;
  /** The backend the box runs on (sessions.sandbox_backend). */
  backend: Settings["sandboxBackend"];
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
   * conflicts on a live box already running a DIFFERENT image (a solo holder requests
   * capture-and-drain rotation; N-holders throw SandboxImageConflictError). Omitted ->
   * image is not enforced (the selfhosted path never passes it; a legacy/null-image box
   * never conflicts).
   */
  image?: string;
  /**
   * RIG IS SHARED STATE (M3): the frozen rig version this run rides. Threaded to
   * acquireLease, which stamps it on the cold-create and conflicts on a live box
   * set up under a DIFFERENT rig version (a solo holder requests capture-and-drain
   * rotation; N-holders throw SandboxRigConflictError). Omitted for a rig-less
   * session -> rig is never stamped or enforced (shares exactly as today).
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
  /** Staged idempotent release. The ordinary form immediately prevents a
   * holder/timer leak. The quiesced form may be called later—even after the
   * ordinary form—to repair null-outcome admissions only after every exact
   * attempt-owned workspace writer has physically drained. NEVER stops the box. */
  release: (options?: { workspaceWritersQuiesced?: boolean }) => Promise<void>;
};

/**
 * Structural ownership of the provider boundary that failed while establishing
 * a logical sandbox provision. Object errors retain their identity and receive
 * an out-of-band stage; primitive thrown values use a typed wrapper. In both
 * cases the source diagnostic is unchanged and the stage is never guessed from
 * prose.
 */
export type SandboxProvisionFailureStage = "create" | "resume" | "archive_recovery";

export class SandboxProvisionStageError extends Error {
  readonly name = "SandboxProvisionStageError";

  constructor(
    public readonly stage: SandboxProvisionFailureStage,
    public readonly source: unknown,
  ) {
    super(source instanceof Error ? source.message : String(source), { cause: source });
  }
}

const sandboxProvisionFailureStages = new WeakMap<object, SandboxProvisionFailureStage>();

export function sandboxProvisionFailureStage(error: unknown): SandboxProvisionFailureStage | null {
  if (!error || typeof error !== "object") return null;
  return (
    sandboxProvisionFailureStages.get(error) ??
    (error instanceof SandboxProvisionStageError ? error.stage : null)
  );
}

function sandboxProvisionStageError(stage: SandboxProvisionFailureStage, error: unknown): unknown {
  if (error && typeof error === "object") {
    sandboxProvisionFailureStages.set(error, stage);
    return error;
  }
  return new SandboxProvisionStageError(stage, error);
}

export abstract class SandboxWarmingTimeoutError extends Error {
  abstract readonly code: "sandbox_exec_readiness_timeout" | "sandbox_sibling_warming_timeout";

  protected constructor(
    public readonly backend: string,
    public readonly timeoutMs: number,
    public readonly stage: "exec_readiness" | "sibling_warming",
    public readonly sandboxGroupId: string | null,
    public readonly instanceId: string | null,
  ) {
    const timeoutSeconds = Math.ceil(timeoutMs / 1000);
    const identity = [
      sandboxGroupId ? `group ${sandboxGroupId}` : null,
      instanceId ? `sandbox ${instanceId}` : null,
    ]
      .filter((part): part is string => part !== null)
      .join(", ");
    const target = identity ? ` (${identity})` : "";
    super(
      stage === "exec_readiness"
        ? `Sandbox backend "${backend}"${target} did not become command-ready within ${timeoutSeconds}s after creation or restore.`
        : `Sandbox backend "${backend}"${target} did not finish warming within ${timeoutSeconds}s while waiting for the elected sandbox creator.`,
    );
    this.name = "SandboxWarmingTimeoutError";
  }
}

export class SandboxExecReadinessTimeoutError extends SandboxWarmingTimeoutError {
  readonly code = "sandbox_exec_readiness_timeout" as const;

  constructor(
    backend: string,
    timeoutMs: number,
    identity: { sandboxGroupId?: string | null; instanceId?: string | null } = {},
  ) {
    super(
      backend,
      timeoutMs,
      "exec_readiness",
      identity.sandboxGroupId ?? null,
      identity.instanceId ?? null,
    );
    this.name = "SandboxExecReadinessTimeoutError";
  }
}

export class SandboxSiblingWarmingTimeoutError extends SandboxWarmingTimeoutError {
  readonly code = "sandbox_sibling_warming_timeout" as const;

  constructor(
    backend: string,
    timeoutMs: number,
    identity: { sandboxGroupId: string; instanceId?: string | null },
  ) {
    super(
      backend,
      timeoutMs,
      "sibling_warming",
      identity.sandboxGroupId,
      identity.instanceId ?? null,
    );
    this.name = "SandboxSiblingWarmingTimeoutError";
  }
}

/** The exact attached caller that won warm->cold after proving the provider
 * instance gone. It is a lease supersession (the same logical turn recovers),
 * plus the lost id needed for one durable observability event. */
export class SandboxLeaseInstanceLostError extends SandboxLeaseSupersededError {
  constructor(
    sandboxGroupId: string,
    leaseEpoch: number,
    public readonly lostInstanceId: string,
  ) {
    super(sandboxGroupId, leaseEpoch);
    this.name = "SandboxLeaseInstanceLostError";
  }
}

// Bounded poll while a sibling spawner is mid cold-restore. The wait budget is
// user-facing and separate from the lease TTL heartbeat/reaper horizon.
const WARMING_POLL_INTERVAL_MS = 250;

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * A remote provider may return a sandbox handle before its command router
 * accepts the first exec. The upstream session's yieldTimeMs starts only after
 * sandbox.exec() returns, so it cannot bound that initial RPC. Probe it before
 * publishing the lease as warm and enforce our own wall-clock deadline.
 */
export async function waitForSandboxExecReadiness(
  established: EstablishedSandboxSession,
  timeoutMs = MODAL_EXEC_READINESS_TIMEOUT_MS,
  identity: { sandboxGroupId?: string | null } = {},
): Promise<void> {
  try {
    await verifySandboxExecReadiness(established, timeoutMs);
  } catch (error) {
    if (error instanceof SandboxExecReadinessError && error.code === "exec_probe_timeout") {
      throw new SandboxExecReadinessTimeoutError(established.backendId, timeoutMs, {
        sandboxGroupId: identity.sandboxGroupId ?? null,
        instanceId: established.instanceId,
      });
    }
    throw error;
  }
}

class SnapshotTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`workspace snapshot timed out after ${timeoutMs}ms`);
    this.name = "SnapshotTimeoutError";
  }
}

export function safeSnapshotError(error: unknown): {
  errorClass: "SnapshotOperationError";
  errorCode: "snapshot_operation_failed";
  status?: number;
  origin: "sandbox-resume";
  causeName?: string;
  integrityCode?: string;
} {
  const fields: {
    errorClass: "SnapshotOperationError";
    errorCode: "snapshot_operation_failed";
    status?: number;
    origin: "sandbox-resume";
    causeName?: string;
    integrityCode?: string;
  } = {
    errorClass: "SnapshotOperationError",
    errorCode: "snapshot_operation_failed",
    origin: "sandbox-resume",
  };
  try {
    if (error && typeof error === "object") {
      const candidate = error as {
        name?: unknown;
        code?: unknown;
        status?: unknown;
        statusCode?: unknown;
      };
      if (typeof candidate.name === "string" && /^[A-Z][A-Za-z0-9]{2,62}Error$/u.test(candidate.name)) {
        fields.causeName = candidate.name;
      }
      if (typeof candidate.code === "string" && /^[a-z0-9_]{1,64}$/u.test(candidate.code)) {
        fields.integrityCode = candidate.code;
      }
      const rawStatus = candidate.status ?? candidate.statusCode;
      const status = Number(rawStatus);
      if (Number.isInteger(status) && status >= 100 && status <= 599) fields.status = status;
    }
  } catch {
    // Public diagnostics are best-effort and must never replace the exact
    // internal snapshot failure.
  }
  return fields;
}

export async function waitForWarmSnapshot(
  snapshot: Promise<unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let cancelListener: (() => void) | undefined;
  try {
    await Promise.race([
      snapshot,
      ...(signal
        ? [
            new Promise<never>((_resolve, reject) => {
              cancelListener = () =>
                reject(signal.reason ?? new Error("workspace snapshot wait cancelled"));
              signal.addEventListener("abort", cancelListener, { once: true });
              if (signal.aborted) cancelListener();
            }),
          ]
        : []),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new SnapshotTimeoutError(timeoutMs)), timeoutMs);
        if (timeout && "unref" in timeout && typeof timeout.unref === "function") {
          timeout.unref();
        }
      }),
    ]);
    return true;
  } catch (error) {
    if (signal?.aborted) return false;
    if (error instanceof SnapshotTimeoutError) {
      console.error(
        "mid-session workspace snapshot wait timed out (turn unaffected)",
        safeSnapshotError(error),
      );
      return false;
    }
    return true;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    if (cancelListener) signal?.removeEventListener("abort", cancelListener);
  }
}

async function resolveModalCheckpointBindingBeforeCapture(
  settings: SandboxResumeServices["settings"],
  session: unknown,
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<typeof resolveModalCheckpointProviderBindingForSession>>> {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("workspace snapshot identity lookup cancelled");
  }
  const pending = resolveModalCheckpointProviderBindingForSession(settings, session);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let cancelListener: (() => void) | undefined;
  try {
    return await Promise.race([
      pending,
      ...(signal
        ? [
            new Promise<never>((_resolve, reject) => {
              cancelListener = () =>
                reject(signal.reason ?? new Error("workspace snapshot identity lookup cancelled"));
              signal.addEventListener("abort", cancelListener, { once: true });
              if (signal.aborted) cancelListener();
            }),
          ]
        : []),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new SnapshotTimeoutError(settings.sandboxSnapshotTimeoutMs)),
          settings.sandboxSnapshotTimeoutMs,
        );
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (cancelListener) signal?.removeEventListener("abort", cancelListener);
  }
}

async function terminateEstablishedSandbox(
  established: EstablishedSandboxSession | null,
): Promise<boolean> {
  if (!established) return true;
  try {
    await terminateUnpublishedSandboxSession(established);
    return true;
  } catch (error) {
    if (isProviderSandboxNotFoundError(established.backendId, error)) {
      return true;
    }
    // Best-effort cleanup. A provider-side orphan sweep is the backstop.
    return false;
  }
}

function recordSandboxWarmingTimeout(
  metrics: RuntimeMetricsHooks | undefined,
  error: unknown,
): void {
  if (!(error instanceof SandboxWarmingTimeoutError)) {
    return;
  }
  try {
    metrics?.onSandboxWarmingTimeout?.({ backend: error.backend, stage: error.stage });
  } catch {
    // Metrics emission must never affect sandbox recovery or error propagation.
  }
}

function workspaceArchiveFieldsFromEnvelope(
  envelope: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  const sessionState =
    envelope && typeof envelope.sessionState === "object" && envelope.sessionState !== null
      ? (envelope.sessionState as Record<string, unknown>)
      : null;
  const archive = sessionState?.workspaceArchive;
  const archiveRef = parseWorkspaceArchiveObjectRef(sessionState?.workspaceArchiveRef);
  const hasInline = typeof archive === "string" && archive.length > 0;
  if (!hasInline && !archiveRef) {
    return null;
  }
  const previous = sessionState?.workspaceArchivePrev;
  const previousRef = parseWorkspaceArchiveObjectRef(sessionState?.workspaceArchivePrevRef);
  const metadata = sessionState?.workspaceArchiveMeta;
  const previousMetadata = sessionState?.workspaceArchivePrevMeta;
  const capturedAt = sessionState?.workspaceArchiveAt;
  return {
    ...(hasInline && !archiveRef ? { workspaceArchive: archive } : {}),
    ...(archiveRef ? { workspaceArchiveRef: archiveRef } : {}),
    ...(metadata !== undefined ? { workspaceArchiveMeta: metadata } : {}),
    ...(typeof previous === "string" && previous.length > 0 && !previousRef
      ? { workspaceArchivePrev: previous }
      : {}),
    ...(previousRef ? { workspaceArchivePrevRef: previousRef } : {}),
    ...(previousMetadata !== undefined ? { workspaceArchivePrevMeta: previousMetadata } : {}),
    ...(typeof capturedAt === "string" && capturedAt.length > 0
      ? { workspaceArchiveAt: capturedAt }
      : {}),
  };
}

async function materializeSpawnEnvelopeArchive(
  envelope: unknown,
  objectStorage: ObjectStorage | null | undefined,
): Promise<unknown> {
  if (!envelope || typeof envelope !== "object") return envelope;
  const record = envelope as Record<string, unknown>;
  const sessionState =
    record.sessionState && typeof record.sessionState === "object" && !Array.isArray(record.sessionState)
      ? (record.sessionState as Record<string, unknown>)
      : null;
  if (!sessionState || !parseWorkspaceArchiveObjectRef(sessionState.workspaceArchiveRef)) {
    return envelope;
  }
  if (!objectStorage) {
    throw new WorkspaceArchiveIntegrityError(
      "archive_base64_invalid",
      "workspace archive object storage is not configured",
    );
  }
  return {
    ...record,
    sessionState: await inlineWorkspaceArchiveForRestore(sessionState, (key) =>
      objectStorage.getObjectBytes(key),
    ),
  };
}

function legacyNativeArchiveFromEnvelope(envelope: Record<string, unknown> | null | undefined) {
  const sessionState =
    envelope && typeof envelope.sessionState === "object" && envelope.sessionState !== null
      ? (envelope.sessionState as Record<string, unknown>)
      : null;
  if (!sessionState) return null;
  const existing = parseWorkspaceArchiveDescriptor(sessionState.workspaceArchiveMeta);
  if (existing?.version === 2) return null;
  return describeLegacyNativeSnapshotArchive(
    sessionState.workspaceArchive,
    existing?.version === 1 ? Date.parse(existing.capturedAt) : Date.now(),
  );
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
  ids: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    attemptId: string;
    sandboxGroupId: string;
  },
  session: unknown,
  leaseEpoch: number,
  signal?: AbortSignal,
  force = false,
): Promise<boolean> {
  const { db, settings } = services;
  const intervalMs = settings.sandboxSnapshotIntervalMs;
  if (intervalMs <= 0 && !force) {
    return false;
  }
  const persistable = session as {
    persistWorkspace?: () => Promise<Uint8Array | undefined>;
    persistWorkspaceTar?: () => Promise<Uint8Array | undefined>;
    backendId?: unknown;
    state?: {
      workspacePersistence?: unknown;
      providerState?: { workspacePersistence?: unknown };
    };
  };
  if (
    typeof persistable.persistWorkspace !== "function" &&
    typeof persistable.persistWorkspaceTar !== "function"
  ) {
    console.error("mid-session workspace snapshot skipped (no persist primitive)", {
      backendId: typeof persistable.backendId === "string" ? persistable.backendId : null,
    });
    return false;
  }
  // Filesystem and directory snapshots create retained Images without
  // terminating the source Sandbox. (Modal's termination warning applies to
  // memory snapshots.) They are therefore the preferred warm-checkpoint path:
  // the durable capture gate pauses OpenGeni commands while the provider reads
  // the filesystem, then the same live instance continues serving the turn.
  const workspacePersistence =
    persistable.state?.workspacePersistence ??
    persistable.state?.providerState?.workspacePersistence;
  if (signal?.aborted) {
    return false;
  }
  try {
    // Resolve the provider namespace before taking the durable capture gate.
    // This work cannot pause or mutate the box, so keeping it outside the claim
    // minimizes the time that command admission must wait.
    const lease = await readLease(db, ids.workspaceId, ids.sandboxGroupId);
    const canWarmCapture =
      lease?.liveness === "warm" && lease.instanceId !== null && lease.leaseEpoch === leaseEpoch;
    const canForceDrainingCapture =
      force === true &&
      lease?.liveness === "draining" &&
      lease.instanceId !== null &&
      lease.leaseEpoch === leaseEpoch;
    if (!lease || (!canWarmCapture && !canForceDrainingCapture)) {
      console.error("mid-session workspace snapshot skipped (lease not warm)", {
        sandboxGroupId: ids.sandboxGroupId,
        expectedEpoch: leaseEpoch,
        liveness: lease?.liveness ?? null,
        leaseEpoch: lease?.leaseEpoch ?? null,
        hasInstance: lease?.instanceId !== null && lease?.instanceId !== undefined,
      });
      return false;
    }
    // A checkpoint of this exact mutation generation already protects every
    // settled operation admitted so far. Capturing it again cannot improve the
    // recovery point, even when the wall-clock interval has elapsed.
    if (lease.archiveComplete) {
      return false;
    }
    if (lease.instanceId === null) {
      return false;
    }
    const instanceId = lease.instanceId;
    const captureLiveness: "warm" | "draining" = canWarmCapture ? "warm" : "draining";
    const capturePolicy = providerWorkspaceCapturePolicy(lease.backend, session);
    if (!capturePolicy || capturePolicy.liveInstance !== "preserved") {
      console.error("mid-session workspace snapshot skipped (capture policy)", {
        sandboxGroupId: ids.sandboxGroupId,
        backend: lease.backend,
        liveInstance: capturePolicy?.liveInstance ?? null,
      });
      return false;
    }
    const nativeModalPersistence =
      workspacePersistence === "snapshot_filesystem" ||
      workspacePersistence === "snapshot_directory";
    const checkpointBinding = nativeModalPersistence
      ? await resolveModalCheckpointBindingBeforeCapture(settings, persistable, signal)
      : null;
    if (signal?.aborted) return false;

    const captureId = randomUUID();
    const captureTimeoutMs = sandboxArchiveCaptureTimeoutMs(settings);
    const claimed = await claimWorkspaceArchiveCapture(db, {
      accountId: ids.accountId,
      workspaceId: ids.workspaceId,
      sandboxGroupId: ids.sandboxGroupId,
      captureId,
      expectedEpoch: leaseEpoch,
      expectedInstanceId: instanceId,
      liveness: captureLiveness,
      captureTimeoutMs,
      minIntervalMs: force ? 0 : intervalMs,
      providerReplaySafe: capturePolicy.takeover === "same_request",
      takeoverSafe: capturePolicy.takeover !== "exclusive",
      ...(captureLiveness === "warm"
        ? {
            warmAttempt: {
              sessionId: ids.sessionId,
              turnId: ids.turnId,
              attemptId: ids.attemptId,
              holderId: sandboxLeaseHolderIdForAttempt(ids.attemptId),
            },
          }
        : {}),
    });
    if (claimed.status !== "claimed") {
      console.error("mid-session workspace snapshot skipped (capture claim)", {
        sandboxGroupId: ids.sandboxGroupId,
        status: claimed.status,
      });
      return false;
    }

    let timeout: ReturnType<typeof setTimeout> | undefined;
    // Stamp WHEN this capture started: persistWarmSnapshot orders warm snapshots
    // by capture-initiation, not land time, so a slower heartbeat capture that
    // started earlier can never overwrite a fresher turn-end capture that landed
    // first (the bounded-wait race Bugbot flagged).
    const capturedAtMs = Date.now();
    const registerCandidate = async (
      archive: Awaited<ReturnType<typeof captureVerifiedWorkspaceArchive>>,
    ): Promise<{ id: string } | null> => {
      if (
        archive.descriptor.version !== 2 ||
        (archive.descriptor.provider !== "modal_snapshot_filesystem" &&
          archive.descriptor.provider !== "modal_snapshot_directory")
      ) {
        return null;
      }
      if (!checkpointBinding) {
        throw new Error("Modal native snapshot has no exact session provider identity");
      }
      return await registerSandboxCheckpointArtifact(db, {
        accountId: ids.accountId,
        workspaceId: ids.workspaceId,
        sandboxGroupId: ids.sandboxGroupId,
        sourceLeaseId: claimed.claim.leaseId,
        sourceLeaseEpoch: leaseEpoch,
        sourceInstanceId: instanceId,
        sourceWorkspaceGeneration: claimed.claim.workspaceGeneration,
        providerBindingKey: checkpointBinding.key,
        providerBinding: checkpointBinding.binding,
        workspaceArchive: archive.base64,
        workspaceArchiveMeta: archive.descriptor,
      });
    };

    const abandonCandidate = async (artifactId: string, reason: string): Promise<void> => {
      await markSandboxCheckpointArtifactDeletePending(db, {
        accountId: ids.accountId,
        workspaceId: ids.workspaceId,
        artifactId,
        reason,
      }).catch(() => undefined);
    };
    // The SDK capture itself is not cancellable. Keep one owned continuation
    // alive through provider settlement even if this caller's bounded wait or
    // turn signal resolves first. Its finally block is the only normal release
    // of the exact admission gate; a late callback cannot release a successor.
    const captureAndPublish = (async (): Promise<boolean> => {
      let candidate: { id: string } | null = null;
      let workspaceArchiveRef: Awaited<
        ReturnType<typeof putVersion1TarArchiveOrInline>
      >["workspaceArchiveRef"];
      try {
        const archive = await captureVerifiedWorkspaceArchive(session, capturedAtMs, {
          requestId: claimed.claim.providerRequestId,
          strategy: capturePolicy.strategy,
        });
        candidate = await registerCandidate(archive);
        const priorLease = await readLease(db, ids.workspaceId, ids.sandboxGroupId);
        const priorKeys = collectWorkspaceArchiveObjectKeys(
          (priorLease?.resumeState as Record<string, unknown> | null | undefined) ?? null,
        );
        const published = await putVersion1TarArchiveOrInline({
          backend: lease.backend,
          objectStorage: services.objectStorage,
          accountId: ids.accountId,
          workspaceId: ids.workspaceId,
          sandboxGroupId: ids.sandboxGroupId,
          archive: {
            bytes: archive.bytes,
            descriptor: archive.descriptor,
            base64: archive.base64,
          },
          ...(services.sandboxMetrics ? { metrics: services.sandboxMetrics } : {}),
        });
        workspaceArchiveRef = published.workspaceArchiveRef;
        const { wrote } = await persistWarmSnapshot(db, {
          accountId: ids.accountId,
          workspaceId: ids.workspaceId,
          sessionId: ids.sessionId,
          turnId: ids.turnId,
          attemptId: ids.attemptId,
          sandboxGroupId: ids.sandboxGroupId,
          expectedEpoch: leaseEpoch,
          expectedInstanceId: instanceId,
          expectedWorkspaceGeneration: claimed.claim.workspaceGeneration,
          captureId,
          workspaceArchiveMeta: archive.descriptor,
          ...published,
          checkpointArtifactId: candidate?.id ?? null,
          minIntervalMs: force ? 0 : intervalMs,
          capturedAtMs,
        });
        if (published.workspaceArchiveRef && services.objectStorage) {
          if (!wrote) {
            await deleteUnpublishedWorkspaceArchiveObject(
              services.objectStorage,
              published.workspaceArchiveRef,
              services.sandboxMetrics,
            );
          } else {
            const afterLease = await readLease(db, ids.workspaceId, ids.sandboxGroupId);
            const afterKeys = collectWorkspaceArchiveObjectKeys(
              (afterLease?.resumeState as Record<string, unknown> | null | undefined) ?? null,
            );
            await deleteWorkspaceArchiveObjectKeys(
              services.objectStorage,
              [...priorKeys].filter((key) => !afterKeys.has(key)),
            ).catch(() => undefined);
          }
        }
        if (!wrote && candidate) {
          await abandonCandidate(candidate.id, "snapshot_publication_fenced");
        }
        return wrote;
      } catch (error) {
        await deleteUnpublishedWorkspaceArchiveObject(
          services.objectStorage,
          workspaceArchiveRef,
          services.sandboxMetrics,
        );
        if (candidate) await abandonCandidate(candidate.id, "snapshot_capture_failed");
        throw error;
      } finally {
        await releaseWorkspaceArchiveCapture(db, {
          accountId: ids.accountId,
          workspaceId: ids.workspaceId,
          sandboxGroupId: ids.sandboxGroupId,
          captureId,
          expectedEpoch: leaseEpoch,
          expectedInstanceId: instanceId,
        }).catch((error) => {
          console.error(
            "mid-session workspace capture gate release failed",
            safeSnapshotError(error),
          );
        });
      }
    })();
    const settled = captureAndPublish.then(
      (persisted) => ({ kind: "settled" as const, persisted }),
      (error) => {
        console.error(
          "mid-session workspace snapshot failed (turn unaffected)",
          safeSnapshotError(error),
        );
        return { kind: "settled" as const, persisted: false };
      },
    );
    let cancelListener: (() => void) | undefined;
    const outcome = await Promise.race([
      settled,
      ...(signal
        ? [
            new Promise<{ kind: "cancelled" }>((resolve) => {
              cancelListener = () => resolve({ kind: "cancelled" });
              signal.addEventListener("abort", cancelListener, { once: true });
              if (signal.aborted) cancelListener();
            }),
          ]
        : []),
      new Promise<{ kind: "timed_out" }>((resolve) => {
        timeout = setTimeout(
          () => resolve({ kind: "timed_out" }),
          settings.sandboxSnapshotTimeoutMs,
        );
      }),
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
      if (cancelListener) signal?.removeEventListener("abort", cancelListener);
    });
    // A timed-out/cancelled local waiter deliberately leaves the already-owned
    // provider continuation running; `settled` has both rejection handling and
    // exact claim cleanup, so it cannot leak an unhandled promise or artifact.
    return outcome.kind === "settled" ? outcome.persisted : false;
  } catch (error) {
    // Protection, not a dependency: a failed snapshot must never fail (or slow
    // down retrying) the turn. The next heartbeat/turn-end tick retries.
    console.error(
      "mid-session workspace snapshot failed (turn unaffected)",
      safeSnapshotError(error),
    );
    return false;
  }
}

/**
 * Resume the one box for a single turn (or any worker-side resume op). Returns
 * the live non-owned session + the fence epoch + a release fn. The CALLER owns
 * the lifecycle: inject non-owned, run, then `await release()` and drop the
 * handle in `finally`.
 *
 * holderId is the globally unique durable turn-attempt id. It must not be a
 * Temporal activity id, because activity ids are only workflow-local and
 * collide when sibling sessions share one sandbox group.
 */
export async function resumeBoxForTurn(
  services: SandboxResumeServices,
  ids: ResumeBoxIds,
  kind: "turn",
  holderId: TurnSandboxLeaseHolderId,
): Promise<ResumedTurnSandbox> {
  const { db, settings } = services;
  const os = ids.os ?? "linux";
  const leaseTtlMs = settings.sandboxLeaseTtlMs;
  const cancellationSignal = services.cancellationSignal;

  // The release closure is created eagerly so the caller can always release in
  // finally, even if establish/commit throws after the holder was registered.
  // It is also bound directly to the logical attempt signal: an uninterruptible
  // provider promise must never keep its private warmup timer and holder alive
  // after Temporal has abandoned the activity.
  let releaseStarted = false;
  let holderRelease: Promise<void> | null = null;
  let quiescedRelease: Promise<void> | null = null;
  let holderLivenessTimer: ReturnType<typeof setInterval> | undefined;
  let cancellationListener: (() => void) | undefined;
  const release = (options?: { workspaceWritersQuiesced?: boolean }): Promise<void> => {
    const writersQuiesced = options?.workspaceWritersQuiesced === true;
    // First invocation synchronously closes every in-memory liveness source.
    // A later quiesced invocation is still allowed to enter the DB: cancellation
    // commonly wins this race and drops the holder before the physical writer
    // drain can prove that abandoned turn admissions are safe to settle.
    if (!releaseStarted) {
      releaseStarted = true;
      if (cancellationListener) {
        cancellationSignal?.removeEventListener("abort", cancellationListener);
        cancellationListener = undefined;
      }
      if (holderLivenessTimer) {
        clearInterval(holderLivenessTimer);
        holderLivenessTimer = undefined;
      }
    }
    const persistRelease = async (workspaceWritersQuiesced: boolean): Promise<void> => {
      await releaseLeaseHolder(db, {
        accountId: ids.accountId,
        workspaceId: ids.workspaceId,
        sandboxGroupId: ids.sandboxGroupId,
        kind,
        holderId,
        idleGraceMs: settings.sandboxIdleGraceMs,
        ...(workspaceWritersQuiesced ? { workspaceWritersQuiesced: true } : {}),
      });
    };
    if (writersQuiesced) {
      if (!quiescedRelease) {
        // Serialize behind an eager cancellation release when one exists. Its
        // failure is intentionally swallowed only as a predecessor: this exact
        // idempotent proof-bearing call retries both holder deletion and
        // admission settlement in one transaction.
        const predecessor = holderRelease;
        const attempt = (predecessor ? predecessor.catch(() => undefined) : Promise.resolve()).then(
          async () => await persistRelease(true),
        );
        const tracked = attempt.catch((error) => {
          if (quiescedRelease === tracked) quiescedRelease = null;
          throw error;
        });
        quiescedRelease = tracked;
        holderRelease = tracked;
      }
      return quiescedRelease;
    }
    if (!holderRelease) {
      const attempt = persistRelease(false);
      const tracked = attempt.catch((error) => {
        if (holderRelease === tracked) holderRelease = null;
        throw error;
      });
      holderRelease = tracked;
    }
    return holderRelease;
  };
  const cancellationError = (): Error =>
    cancellationSignal?.reason instanceof Error
      ? cancellationSignal.reason
      : new Error("Sandbox resume was cancelled with its owning turn attempt");
  const throwIfReleasedOrCancelled = (): void => {
    if (releaseStarted || cancellationSignal?.aborted) {
      throw cancellationError();
    }
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
    // conflicts on a live box already running a different image. A
    // SandboxImageConflictError propagates while another holder is active; a
    // solo change requests a capture-and-drain rotation and this attempt retries
    // after the cold successor can safely stamp the new image.
    ...(ids.image ? { image: ids.image } : {}),
    // RIG IS SHARED STATE (M3): thread the frozen rig version so the lease stamps it
    // + conflicts on a live box under a different rig. A SandboxRigConflictError
    // propagates while another holder is active; a solo change uses the same
    // durable capture-and-drain rotation as an image change.
    ...(ids.rigVersionId ? { rigVersionId: ids.rigVersionId } : {}),
    leaseTtlMs,
    warmingLeaseTtlMs: settings.sandboxLeaseWarmingTtlMs,
    captureWaitMs: sandboxLifecycleTransitionWaitMs(settings),
    ...(cancellationSignal ? { waitSignal: cancellationSignal } : {}),
  });

  if (cancellationSignal) {
    cancellationListener = () => {
      // release() flips `releaseStarted` and clears the timer synchronously
      // before its first await. This eager form deliberately carries no writer-
      // quiescence proof; the outer turn supplies that second stage after its
      // physical drain. The detached rejection handler is intentional: the
      // outer turn owns diagnostics, while this listener owns leak prevention.
      void release().catch(() => undefined);
    };
    cancellationSignal.addEventListener("abort", cancellationListener, { once: true });
  }
  if (cancellationSignal?.aborted) {
    await release();
    throw cancellationError();
  }

  // HOLDER-LIVENESS loop: refresh OUR holder every 10s from registration.
  // registered until release. The dead-worker turn-holder reap judges liveness
  // by last_heartbeat_at, and the full turn heartbeat (heartbeatLeaseHolder in
  // agent-turn) only starts AFTER this function returns — while waitForWarm and
  // establish/cold-restore can legitimately run for many minutes in here,
  // COMPOUNDING past any fixed reap horizon. With this
  // loop no live holder is ever silent for more than one tick, so the reap
  // horizon is pure defense-in-depth, not a tuned guess about path lengths.
  // The elected spawner also heartbeats the short rolling warming lease; this
  // makes warming expiry a crash detector rather than a fixed upper bound on a
  // legitimate provider create/restore. A warming waiter only touches its own
  // holder so it cannot keep a dead spawner's lease alive. Once the box is warm,
  // every owner uses the normal epoch-fenced lease heartbeat.
  let holderLeaseHeartbeat: { expectedEpoch: number; leaseTtlMs: number } | null =
    acquired.role === "spawner"
      ? {
          expectedEpoch: acquired.lease.leaseEpoch,
          leaseTtlMs: settings.sandboxLeaseWarmingTtlMs,
        }
      : (acquired.role === "attached" || acquired.role === "rearmed") &&
          acquired.lease.liveness === "warm"
        ? { expectedEpoch: acquired.lease.leaseEpoch, leaseTtlMs }
        : null;
  let providerRenewalTarget: { backend: Settings["sandboxBackend"]; instanceId: string } | null =
    acquired.lease.liveness === "warm" && acquired.lease.instanceId
      ? {
          backend: ids.backend,
          instanceId: acquired.lease.instanceId,
        }
      : null;
  let providerRenewedAtMs = Date.now();
  let providerRenewalInFlight: Promise<void> | null = null;
  const maybeRenewProviderExpiration = async (force = false): Promise<void> => {
    const target = providerRenewalTarget;
    if (!target || providerRenewalInFlight) return;
    const ttlSeconds = effectiveSandboxLifecycle(settings, target.backend).renewableTtlSeconds;
    if (ttlSeconds === null) return;
    const intervalMs = Math.max(10_000, Math.floor((ttlSeconds * 1000) / 3));
    if (!force && Date.now() - providerRenewedAtMs < intervalMs) return;
    providerRenewalInFlight = renewSandboxProviderExpiration({
      backend: target.backend,
      settings,
      instanceId: target.instanceId,
      ...(services.sandboxMetrics ? { metrics: services.sandboxMetrics } : {}),
    })
      .then(() => {
        providerRenewedAtMs = Date.now();
      })
      .finally(() => {
        providerRenewalInFlight = null;
      });
    await providerRenewalInFlight;
  };
  holderLivenessTimer = setInterval(() => {
    const heartbeat = holderLeaseHeartbeat;
    const refresh = heartbeat
      ? heartbeatLeaseHolder(db, {
          accountId: ids.accountId,
          workspaceId: ids.workspaceId,
          sandboxGroupId: ids.sandboxGroupId,
          kind,
          holderId,
          expectedEpoch: heartbeat.expectedEpoch,
          leaseTtlMs: heartbeat.leaseTtlMs,
        })
      : touchLeaseHolder(db, {
          accountId: ids.accountId,
          workspaceId: ids.workspaceId,
          sandboxGroupId: ids.sandboxGroupId,
          kind,
          holderId,
        });
    void refresh
      .then((touched) => {
        // A canonical turn holder is rejected once its exact attempt is no
        // longer the active writer. Stop this otherwise-unbounded provider
        // operation and idempotently drop any remaining holder state.
        if (!touched && heartbeat === holderLeaseHeartbeat) {
          void release().catch(() => undefined);
          return;
        }
        if (touched && heartbeat === holderLeaseHeartbeat) {
          void maybeRenewProviderExpiration().catch(() => undefined);
        }
      })
      .catch(() => undefined);
  }, 10_000);
  if ("unref" in holderLivenessTimer && typeof holderLivenessTimer.unref === "function") {
    holderLivenessTimer.unref();
  }

  // FENCED: a newer epoch exists (a later turn re-established the box). Back off;
  // NEVER create(). Release our (just-registered) holder so we don't pin a stale
  // lease, then surface the supersession.
  if (acquired.role === "blocked") {
    await release();
    throw new SandboxLeaseRecoveryBlockedError(
      ids.sandboxGroupId,
      acquired.lease.leaseEpoch,
      acquired.code,
      acquired.lease.recovery,
    );
  }
  if (acquired.role === "fenced") {
    await release();
    if (acquired.reason !== "superseded") {
      throw new SandboxLeaseTransitionError(
        ids.sandboxGroupId,
        acquired.lease.leaseEpoch,
        acquired.reason,
        acquired.lease.backend,
        acquired.lease.instanceId,
        acquired.lease.liveness,
      );
    }
    throw new SandboxLeaseSupersededError(ids.sandboxGroupId, acquired.lease.leaseEpoch, {
      backend: acquired.lease.backend,
      instanceId: acquired.lease.instanceId,
      liveness: acquired.lease.liveness,
    });
  }

  // SPAWNER: we won the cold->warming CAS. Establish (cold-restore/create),
  // then commit warm (lease_epoch++). Optional desktop setup is lazy.
  if (acquired.role === "spawner") {
    const expectedEpoch = acquired.lease.leaseEpoch;
    let createdEstablished: EstablishedSandboxSession | null = null;
    let rematerialization: {
      id: string;
      selectedRevision: string;
      workspaceGeneration: number;
      providerBindingKey: string | null;
      legacyCheckpoint: NonNullable<ReturnType<typeof legacyNativeArchiveFromEnvelope>> | null;
      legacyProviderBinding: Awaited<
        ReturnType<typeof resolveModalCheckpointProviderBindingForSession>
      > | null;
    } | null = null;
    try {
      const envelope = await getSandboxSessionEnvelope(db, ids.workspaceId, ids.sessionId);
      // The lease is authoritative. A legacy per-session fallback archive may
      // only be used after beginSandboxRematerialization imports its archive
      // fields under the warming-row lock and records one selected revision.
      // Select the fallback only when the lease has no archive truth at all. A
      // lease-carried unverified/invalid archive must fail closed rather than
      // silently substituting another revision.
      const fallbackArchiveEnvelope =
        acquired.lease.recovery.archive.status === "none" &&
        workspaceArchiveFieldsFromEnvelope(envelope) !== null
          ? withoutSandboxProviderIdentity(envelope)
          : null;
      let spawnEnvelope = fallbackArchiveEnvelope ?? acquired.lease.resumeState ?? envelope;
      const archiveSource =
        acquired.lease.recovery.archive.status === "none"
          ? fallbackArchiveEnvelope
          : acquired.lease.resumeState;
      const continuityRecovery = acquired.lease.recovery.continuity;
      if (
        (acquired.lease.recovery.archive.status === "available" &&
          acquired.lease.archiveComplete) ||
        (acquired.lease.recovery.archive.status === "none" &&
          workspaceArchiveFieldsFromEnvelope(archiveSource) !== null)
      ) {
        const rematerializationId = crypto.randomUUID();
        const legacyNativeArchive = legacyNativeArchiveFromEnvelope(archiveSource);
        const begun = await beginSandboxRematerialization(db, {
          accountId: ids.accountId,
          workspaceId: ids.workspaceId,
          sandboxGroupId: ids.sandboxGroupId,
          expectedEpoch,
          rematerializationId,
          archiveSource,
          legacyNativeArchive,
        });
        if (begun.status !== "started") {
          if (begun.code === "stale_epoch" || begun.code === "attempt_conflict") {
            throw new SandboxLeaseSupersededError(
              ids.sandboxGroupId,
              begun.lease?.leaseEpoch ?? expectedEpoch,
            );
          }
          throw new SandboxLeaseRecoveryBlockedError(
            ids.sandboxGroupId,
            begun.lease?.leaseEpoch ?? expectedEpoch,
            begun.code === "archive_unverified" ? "restore_degraded" : "restore_unrecoverable",
            begun.lease?.recovery ?? acquired.lease.recovery,
          );
        }
        spawnEnvelope = begun.lease.resumeState ?? spawnEnvelope;
        const selectedRevision = begun.lease.recovery.restore.selectedRevision;
        if (!selectedRevision) {
          throw new WorkspaceArchiveIntegrityError(
            "archive_metadata_invalid",
            "sandbox rematerialization selected no durable archive revision",
          );
        }
        rematerialization = {
          id: rematerializationId,
          selectedRevision,
          workspaceGeneration: begun.lease.workspaceGeneration,
          providerBindingKey: begun.checkpointArtifact?.providerBindingKey ?? null,
          legacyCheckpoint: begun.checkpointArtifact === null ? legacyNativeArchive : null,
          legacyProviderBinding: null,
        };
      } else if (acquired.lease.recovery.archive.status !== "none" && !continuityRecovery) {
        throw new SandboxLeaseRecoveryBlockedError(
          ids.sandboxGroupId,
          expectedEpoch,
          "restore_degraded",
          acquired.lease.recovery,
        );
      }
      // Prefer the COLD lease's preserved resume_state when it carries a persisted
      // /workspace snapshot (confirmDrainCold keeps a minimal archive-only envelope
      // across draining->cold for exactly this re-warm). establishSandboxSessionFromEnvelope
      // cold-creates a fresh box and replays the archive via hydrateWorkspace, so
      // /workspace survives box churn (sandbox-file-persistence). No archive ->
      // the bare session envelope (a never-warmed cold start). Mirrors channel-a.ts's
      // spawner branch: the lease's resume_state is authoritative; the session
      // `_sandbox` envelope is the per-session fallback. Without this a turn-first
      // re-warm after a drain->cold would ignore the archive and start an EMPTY box.
      const providerCreateStartedAt = new Date();
      const persistArchiveSource =
        spawnEnvelope && typeof spawnEnvelope === "object"
          ? (spawnEnvelope as Record<string, unknown>)
          : null;
      const hydrateEnvelopeRaw = await materializeSpawnEnvelopeArchive(
        persistArchiveSource,
        services.objectStorage,
      );
      const hydrateEnvelope =
        hydrateEnvelopeRaw && typeof hydrateEnvelopeRaw === "object"
          ? (hydrateEnvelopeRaw as Record<string, unknown>)
          : null;
      const established = await establishSandboxSessionFromEnvelope(settings, hydrateEnvelope, {
        sessionId: ids.sessionId,
        recovery: "create-or-restore",
        backendOverride: ids.backend as never,
        ...(ids.environment ? { environment: ids.environment } : {}),
        ...(services.sandboxMetrics ? { metrics: services.sandboxMetrics } : {}),
        ...(services.logicalFallbackSettings
          ? { logicalFallbackSettings: services.logicalFallbackSettings }
          : {}),
        onSandboxCreated: async (created) => {
          createdEstablished = created;
          providerRenewalTarget = {
            backend: ids.backend,
            instanceId: created.instanceId,
          };
          providerRenewedAtMs = Date.now();
          throwIfReleasedOrCancelled();
          if (
            rematerialization &&
            (rematerialization.providerBindingKey || rematerialization.legacyCheckpoint)
          ) {
            if (created.backendId !== "modal") {
              throw new WorkspaceArchiveIntegrityError(
                "native_snapshot_reference_invalid",
                "Modal checkpoint restore resolved a non-Modal sandbox backend",
              );
            }
            if (rematerialization.providerBindingKey) {
              if (
                !(await modalSessionMatchesCheckpointProviderBinding(
                  settings,
                  created.session,
                  rematerialization.providerBindingKey,
                ))
              ) {
                throw new WorkspaceArchiveIntegrityError(
                  "native_snapshot_reference_invalid",
                  "Modal checkpoint restore refused because the authenticated provider workspace changed",
                );
              }
            } else {
              const resolved = await resolveModalCheckpointProviderBindingForSession(
                settings,
                created.session,
              );
              if (
                rematerialization.legacyProviderBinding &&
                rematerialization.legacyProviderBinding.key !== resolved.key
              ) {
                throw new WorkspaceArchiveIntegrityError(
                  "native_snapshot_reference_invalid",
                  "Legacy Modal checkpoint restore crossed authenticated provider workspaces",
                );
              }
              rematerialization.legacyProviderBinding = resolved;
            }
          }
          const resumeEnvelope = requirePersistableReplacementSandboxEnvelope(
            await serializeReplacementSandboxEnvelope(created, persistArchiveSource),
            created.backendId,
          );
          const recorded = await recordWarmingSandboxCreated(db, {
            accountId: ids.accountId,
            workspaceId: ids.workspaceId,
            sandboxGroupId: ids.sandboxGroupId,
            expectedEpoch,
            rematerializationId: rematerialization?.id ?? null,
            ...(created.providerContinuity
              ? { continuityRecovery: created.providerContinuity }
              : {}),
            instanceId: created.instanceId,
            resumeBackendId: created.backendId,
            resumeState: resumeEnvelope,
            ...(created.backendId === "modal"
              ? {
                  providerCreatedAt: providerCreateStartedAt,
                  providerDeadlineAt: new Date(
                    providerCreateStartedAt.getTime() + settings.modalTimeoutSeconds * 1000,
                  ),
                }
              : {}),
            leaseTtlMs,
            // Keep the warming budget after create(): manifest setup and
            // commitWarmingToWarm still run, and can exceed the 90s turn TTL.
            warmingLeaseTtlMs: settings.sandboxLeaseWarmingTtlMs,
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
          throwIfReleasedOrCancelled();
        },
        onWorkspaceRestoreVerifying: async (descriptor: WorkspaceArchiveDescriptor) => {
          if (!rematerialization || descriptor.revision !== rematerialization.selectedRevision) {
            throw new WorkspaceArchiveIntegrityError(
              "archive_metadata_invalid",
              `hydrated archive revision ${descriptor.revision} does not match the selected rematerialization revision`,
            );
          }
          if (rematerialization.legacyCheckpoint) {
            const binding = rematerialization.legacyProviderBinding;
            if (!binding) {
              throw new WorkspaceArchiveIntegrityError(
                "native_snapshot_reference_invalid",
                "Legacy Modal checkpoint restore produced no authenticated provider identity",
              );
            }
            const adopted = await adoptLegacyModalCheckpointArtifact(db, {
              accountId: ids.accountId,
              workspaceId: ids.workspaceId,
              sandboxGroupId: ids.sandboxGroupId,
              leaseId: acquired.lease.id,
              leaseEpoch: expectedEpoch,
              workspaceGeneration: rematerialization.workspaceGeneration,
              slot: "current",
              archiveBase64: rematerialization.legacyCheckpoint.archiveBase64,
              descriptor: rematerialization.legacyCheckpoint.descriptor,
              providerBindingKey: binding.key,
              providerBinding: binding.binding,
              rematerializationId: rematerialization.id,
            });
            if (!adopted) {
              throw new SandboxLeaseSupersededError(ids.sandboxGroupId, expectedEpoch);
            }
            rematerialization.providerBindingKey = binding.key;
          }
          const verifying = await markSandboxRestoreVerifying(db, {
            accountId: ids.accountId,
            workspaceId: ids.workspaceId,
            sandboxGroupId: ids.sandboxGroupId,
            expectedEpoch,
            rematerializationId: rematerialization.id,
          });
          if (!verifying.wrote) {
            throw new SandboxLeaseSupersededError(ids.sandboxGroupId, expectedEpoch);
          }
        },
      });
      createdEstablished = established;
      throwIfReleasedOrCancelled();
      // A sandbox handle is not sufficient evidence that an asynchronous
      // provider's command router is live. Do not publish a warm lease until
      // one bounded no-op exec works.
      // On timeout the catch below terminates the box and rolls warming -> cold,
      // so the next turn cold-creates instead of hanging forever on first use.
      await waitForSandboxExecReadiness(established, MODAL_EXEC_READINESS_TIMEOUT_MS, {
        sandboxGroupId: ids.sandboxGroupId,
      });
      await maybeRenewProviderExpiration(true);
      throwIfReleasedOrCancelled();
      // Fold the LIVE box into a re-resumable envelope and persist it as the
      // lease's resume_state — exactly like the API-direct paths (channel-a.ts /
      // viewer.ts). Without this the turn committed the ORIGINAL session manifest
      // as resume_state, so every LATER op off this lease (Channel-A fs/git/
      // terminal, the desktop viewer, the reaper) cold-restored a FRESH rival box
      // and never saw the turn's live box. Historical state may contribute only
      // durable archive pointers: if live serialization fails, publishing its
      // dead provider identity would pair the replacement instance with the box
      // that initiated recovery.
      // A successful cold hydrate has already proved this archive usable and the
      // replacement box now contains its files. Keep the current + fallback
      // archive pointers on the committed live envelope until a later warm
      // snapshot replaces them. Without this merge, serialization publishes only
      // the new provider id; a second provider loss before the snapshot cadence
      // fires would otherwise make truthful recovery impossible. Failed hydrate
      // attempts terminate the replacement and fail closed; they never publish a
      // clean or mixed workspace.
      const resumeEnvelope = requirePersistableReplacementSandboxEnvelope(
        await serializeReplacementSandboxEnvelope(established, persistArchiveSource),
        established.backendId,
      );
      throwIfReleasedOrCancelled();
      if (
        rematerialization &&
        !established.providerContinuity &&
        established.restoredArchive?.revision !== rematerialization.selectedRevision
      ) {
        throw new WorkspaceArchiveIntegrityError(
          "workspace_fingerprint_mismatch",
          "sandbox restore completed without the exact selected durable archive revision",
        );
      }
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
        ...(established.providerContinuity
          ? { continuityRecovery: established.providerContinuity }
          : rematerialization
            ? {
                rematerialization: {
                  id: rematerialization.id,
                  verifiedRevision: rematerialization.selectedRevision,
                },
              }
            : {}),
        leaseTtlMs,
      });
      if (!committed.committed || !committed.lease) {
        // A reaper reset our warming row (we were too slow) or a sibling
        // re-established and bumped the epoch. Drop the handle; release our
        // holder; surface supersession. This spawner created the box, so stop it
        // before retrying to avoid an untracked running sandbox.
        const terminated = await terminateEstablishedSandbox(established);
        if (terminated && rematerialization && !established.providerContinuity) {
          await failSandboxRematerialization(db, {
            accountId: ids.accountId,
            workspaceId: ids.workspaceId,
            sandboxGroupId: ids.sandboxGroupId,
            expectedEpoch,
            rematerializationId: rematerialization.id,
            failureCode: committed.reason ?? "warm_commit_rejected",
            retryable: false,
          });
        } else if (terminated) {
          await failWarmingToCold(db, {
            accountId: ids.accountId,
            workspaceId: ids.workspaceId,
            sandboxGroupId: ids.sandboxGroupId,
            expectedEpoch,
          });
        }
        await release();
        throw new SandboxLeaseSupersededError(ids.sandboxGroupId, expectedEpoch);
      }
      holderLeaseHeartbeat = {
        expectedEpoch: committed.lease.leaseEpoch,
        leaseTtlMs,
      };
      throwIfReleasedOrCancelled();
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
        const continuityUnavailable = error instanceof SandboxProviderContinuityUnavailableError;
        if (rematerialization && !createdEstablished?.providerContinuity) {
          await failSandboxRematerialization(db, {
            accountId: ids.accountId,
            workspaceId: ids.workspaceId,
            sandboxGroupId: ids.sandboxGroupId,
            expectedEpoch,
            rematerializationId: rematerialization.id,
            failureCode: continuityUnavailable
              ? "provider_continuity_unavailable"
              : error instanceof WorkspaceArchiveIntegrityError
                ? error.code
                : "sandbox_rematerialization_failed",
            retryable: continuityUnavailable
              ? error.retryable
              : error instanceof WorkspaceArchiveIntegrityError
                ? error.retryable
                : true,
            ...(continuityUnavailable ? { discardContinuity: true } : {}),
          });
        } else {
          await failWarmingToCold(db, {
            accountId: ids.accountId,
            workspaceId: ids.workspaceId,
            sandboxGroupId: ids.sandboxGroupId,
            expectedEpoch,
            ...(continuityUnavailable ? { discardContinuity: true } : {}),
          });
        }
      }
      await release();
      recordSandboxWarmingTimeout(services.sandboxMetrics, error);
      throw sandboxProvisionStageError(rematerialization ? "archive_recovery" : "create", error);
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
      holderLeaseHeartbeat = { expectedEpoch: leaseEpoch, leaseTtlMs };
    }
    throwIfReleasedOrCancelled();

    // Prefer the lease's resume_state (the LIVE box the spawner committed) so we
    // re-attach to the SAME box by id, not cold-restore the original session
    // manifest into a rival. Fall back to the session envelope only when the
    // lease carries no resume_state (matches channel-a.ts's attached branch).
    const live = await readLease(db, ids.workspaceId, ids.sandboxGroupId);
    if (
      !live ||
      live.liveness !== "warm" ||
      live.leaseEpoch !== leaseEpoch ||
      live.instanceId === null
    ) {
      throw new SandboxLeaseSupersededError(ids.sandboxGroupId, live?.leaseEpoch ?? leaseEpoch);
    }
    let established: EstablishedSandboxSession;
    try {
      const establish = services.establishAttachedSandbox ?? establishSandboxSessionFromEnvelope;
      established = await establish(settings, live.resumeState, {
        sessionId: ids.sessionId,
        recovery: "resume-only",
        backendOverride: ids.backend as never,
        ...(ids.environment ? { environment: ids.environment } : {}),
        ...(services.sandboxMetrics ? { metrics: services.sandboxMetrics } : {}),
      });
      throwIfReleasedOrCancelled();
      // A durable `warm` row is an ownership assertion, not provider liveness.
      // A provider may have ended the exact box while OpenGeni was idle. Prove
      // the command router before handing the session to the
      // agent so terminal evidence enters the atomic warm->cold recovery path
      // below instead of surfacing inside a model-visible tool call.
      if (services.verifyAttachedSandboxReadiness) {
        await services.verifyAttachedSandboxReadiness(established);
      } else {
        await waitForSandboxExecReadiness(established, MODAL_EXEC_READINESS_TIMEOUT_MS, {
          sandboxGroupId: ids.sandboxGroupId,
        });
      }
      providerRenewalTarget = {
        backend: ids.backend,
        instanceId: established.instanceId,
      };
      await maybeRenewProviderExpiration(true);
      throwIfReleasedOrCancelled();
    } catch (error) {
      if (!isProviderSandboxNotFoundError(ids.backend, error)) {
        throw sandboxProvisionStageError("resume", error);
      }
      const marked = await markWarmLeaseInstanceLost(db, {
        accountId: ids.accountId,
        workspaceId: ids.workspaceId,
        sandboxGroupId: ids.sandboxGroupId,
        expectedEpoch: leaseEpoch,
        expectedInstanceId: live.instanceId,
      });
      if (marked.status === "marked") {
        await services.onSandboxLost?.({
          sandboxGroupId: ids.sandboxGroupId,
          instanceId: live.instanceId,
          leaseEpoch: marked.lease.leaseEpoch,
        });
        throw new SandboxLeaseInstanceLostError(
          ids.sandboxGroupId,
          marked.lease.leaseEpoch,
          live.instanceId,
        );
      }
      throw new SandboxLeaseSupersededError(
        ids.sandboxGroupId,
        marked.lease?.leaseEpoch ?? leaseEpoch,
      );
    }
    throwIfReleasedOrCancelled();
    return { established, leaseEpoch, release };
  } catch (error) {
    await release();
    recordSandboxWarmingTimeout(services.sandboxMetrics, error);
    throw error;
  }
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
  let instanceId: string | null = null;
  while (Date.now() < deadline) {
    await sleep(WARMING_POLL_INTERVAL_MS);
    const lease = await readLease(db, ids.workspaceId, ids.sandboxGroupId);
    if (!lease) {
      // Lease vanished (cold-reaped). Re-dispatch from scratch.
      throw new SandboxLeaseSupersededError(ids.sandboxGroupId, 0);
    }
    instanceId = lease.instanceId;
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
      if (isRetryableDegradedRestore(lease.recovery.restore)) {
        // The elected spawner hit a transient archive verification failure.
        // Re-enter admission so one caller can become the next fenced spawner;
        // the archive remains authoritative and must not become terminal.
        throw new SandboxLeaseSupersededError(ids.sandboxGroupId, lease.leaseEpoch);
      }
      if (
        lease.recovery.restore.status === "degraded" ||
        lease.recovery.restore.status === "unrecoverable"
      ) {
        throw new SandboxLeaseRecoveryBlockedError(
          ids.sandboxGroupId,
          lease.leaseEpoch,
          lease.recovery.restore.status === "degraded"
            ? "restore_degraded"
            : "restore_unrecoverable",
          lease.recovery,
        );
      }
      // The spawner died; re-dispatch so the normal acquireLease path can win
      // cold->warming and run the full spawner branch.
      throw new SandboxLeaseSupersededError(ids.sandboxGroupId, lease.leaseEpoch);
    }
    // still warming — keep polling.
  }
  throw new SandboxSiblingWarmingTimeoutError(ids.backend, settings.sandboxWarmingTimeoutMs, {
    sandboxGroupId: ids.sandboxGroupId,
    instanceId,
  });
}
