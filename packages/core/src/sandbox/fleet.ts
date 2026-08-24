// apps/api/src/sandbox/fleet.ts — the FLEET service backing the fleet MCP tools
// (M7): list / attach / swap / run_on / provision over the heterogeneous fleet
// (the session's Modal group box + the workspace's enrolled selfhosted machines).
//
// Each operation is workspace-scoped (the caller's grant) and, for the
// session-pointer mutations (attach/swap), session-scoped (the worker-signed
// sessionId claim). The swap is the epoch-fenced CAS `setActiveSandbox`: it bumps
// active_epoch + repoints active_sandbox_id, which the routing proxy reads on the
// NEXT tool call. Liveness for a selfhosted target is a real ControlRpc ping over
// the events bus (the subject IS the registry); a Modal box is "live" while its
// session group exists. `run_on` builds a one-off backend session and runs a
// single op WITHOUT touching the active pointer.

import type { Settings } from "@opengeni/config";
import {
  authorizePersonalMachineForAttempt,
  getEnrollment,
  getLiveEnrollmentConnection,
  getSandbox,
  listEnrollments,
  listSandboxes,
  readActiveSandbox,
  readLease,
  resolvePersonalMachineConnectionForAttempt,
  requireSession,
  setActiveSandbox,
  type Database,
  type EnrollmentRecord,
  type SandboxRecord,
} from "@opengeni/db";
import type { EventBus } from "@opengeni/events";
import {
  NatsControlRpc,
  NatsOpStreamTransport,
  selfhostedLiveness,
  SelfhostedSession,
  swapTargetEstablishability,
  type BackendUnresolvableCode,
  type ControlRpc,
  type NatsRequestConnection,
  type SelfhostedRelayConfig,
  type SelfhostedOpStreamDeps,
  type SelfhostedOperationAdmission,
  type SelfhostedOperationResourcePolicy,
} from "@opengeni/runtime/sandbox";
import { relayConfigFromSettings } from "./routing";

export type FleetServices = {
  db: Database;
  settings: Settings;
  bus?: EventBus;
  /** API-direct readiness owner for the session's home group. Production wires
   * this to the same viewer/provider verification + rematerialization path; core
   * tests may omit it when exercising pointer mechanics only. */
  ensureSessionGroupReady?: (ctx: FleetContext) => Promise<FleetReadinessHold>;
};

export type FleetReadinessHold = {
  /** Release target liveness only after route publication settles. */
  release: () => Promise<void>;
};

export type FleetContext = {
  accountId: string;
  workspaceId: string;
  subjectId?: string;
  attemptAuthority?: {
    turnId: string;
    attemptId: string;
    executionGeneration: number;
    initiatingHumanSubjectId: string;
  };
  /** The calling session (the pointer the attach/swap mutates + whose group box
   *  is the default fleet member). */
  sessionId: string;
  /** The session's own group sandbox backend (modal/selfhosted/…). */
  sessionBackend: string;
  /** The session's own group sandbox id (the lease group). */
  sessionGroupId: string;
};

/**
 * Build a session-scoped {@link FleetContext}: load the session (workspace-
 * scoped) and project its group backend/id. A backend:none session has no home
 * box, but it may still discover, run on, and attach an owned Connected Machine.
 * Shared
 * by the worker-signed MCP fleet tools and the user-authenticated swap REST
 * route so both resolve the SAME context (no drift). The `accountId`/`workspaceId`/
 * `sessionId` come from the trusted grant/route; the backend + group id come from
 * the session row.
 */
export async function buildFleetContextForSession(
  deps: { db: Database },
  ctx: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    subjectId?: string;
    attemptAuthority?: FleetContext["attemptAuthority"];
  },
): Promise<FleetContext> {
  const session = await requireSession(deps.db, ctx.workspaceId, ctx.sessionId);
  return {
    accountId: ctx.accountId,
    workspaceId: ctx.workspaceId,
    ...(ctx.subjectId ? { subjectId: ctx.subjectId } : {}),
    ...(ctx.attemptAuthority ? { attemptAuthority: ctx.attemptAuthority } : {}),
    sessionId: ctx.sessionId,
    sessionBackend: session.sandboxBackend,
    sessionGroupId: session.sandboxGroupId,
  };
}

/** The dominant liveness of a fleet member, surfaced to the dock + the agent. */
export type FleetLiveness = "online" | "reconnecting" | "offline";
export type FleetOperationAvailability = "ready" | "wakeable" | "recovering" | "unavailable";

/**
 * A fleet member as the agent + the dock see it (the M8b/M9 UI seam — the
 * `sandboxes_list` response entry the dock renders). STABLE shape: the dock keys
 * on `id`, renders `name`/`kind`/`liveness`, and marks `active`. The session's own
 * managed group box is a synthetic entry with `id: groupId`, its actual
 * provisioned backend kind, and a null `enrollmentId`; an enrolled machine
 * carries its sandbox + enrollment ids.
 */
export type FleetSandboxEntry = {
  /** The sandbox id used as the attach/swap/run_on `target`. For the session's
   *  own group box this is the group id (a null active pointer == this box). */
  id: string;
  kind: "modal" | "selfhosted" | "opensandbox";
  name: string;
  liveness: FleetLiveness;
  /** True for the session's currently-active sandbox (the routing target). */
  active: boolean;
  /** True for the session's own group box (the default/home sandbox). */
  isSessionGroup: boolean;
  enrollmentId: string | null;
  /** Whether this target can be attached/swapped to right now (live + addressable). */
  attachable: boolean;
  /** Whether an ordinary shell/files operation can use this target. This is
   * deliberately separate from `attachable`: an idle managed home sandbox can
   * be wakeable even while its holderless lease is cold/draining and therefore
   * not an already-live swap target. */
  operationAvailability: FleetOperationAvailability;
  /** Selfhosted only: whether whole-machine + screen-control consent is acked. */
  consented?: boolean;
  /** Selfhosted only: whether a display (real/Xvfb) is present. */
  hasDisplay?: boolean;
  lastSeenAt?: string | null;
  /** Orthogonal truth dimensions. `liveness` is only their conservative UI
   * projection and is never evidence for a specific dimension. */
  providerStatus: "not_created" | "creating" | "exists" | "missing" | "unknown";
  leaseLiveness: "cold" | "warming" | "warm" | "draining" | null;
  routeStatus: "attached" | "detached";
  archiveStatus: "none" | "available" | "unverified" | "invalid";
  restoreStatus:
    | "not_required"
    | "pending"
    | "restoring"
    | "verifying"
    | "ready"
    | "degraded"
    | "unrecoverable";
  workspaceStatus: "unknown" | "not_ready" | "ready" | "degraded" | "unrecoverable";
  leaseEpoch: number | null;
  routeEpoch: number;
  /** Numeric/boolean persistence truth only. Archive locations, content hashes,
   * provider identities, and storage handles are intentionally not projected. */
  workspaceGeneration: number | null;
  archiveGeneration: number | null;
  archiveComplete: boolean;
};

export type FleetListResult = {
  /** The session's currently-active sandbox id, or null == the group box. */
  activeSandboxId: string | null;
  activeEpoch: number;
  sandboxes: FleetSandboxEntry[];
};

/** A swap/attach outcome the tool returns. On a rejection, `code` carries the
 *  typed reason (issue #341 typed diagnostics) alongside the human `reason`. */
export type FleetSwapResult = {
  swapped: boolean;
  activeSandboxId: string | null;
  activeEpoch: number;
  reason?: string;
  code?:
    | BackendUnresolvableCode
    | "concurrent_swap"
    | "recovery_in_progress"
    | "recovery_degraded"
    | "recovery_unrecoverable";
};

const PROBE_TIMEOUT_MS = 5_000;

function controlRpc(bus: EventBus | undefined): ControlRpc {
  return new NatsControlRpc(async (): Promise<NatsRequestConnection | null> => {
    if (!bus) {
      return null;
    }
    return bus.getRequestConnection();
  });
}

/** Probe an enrolled machine's liveness: a real ControlRpc ping (the subject IS
 *  the registry), mapped through `selfhostedLiveness` (the enrollment row's
 *  status/consent/display + lastSeenAt disambiguate a probe-miss into
 *  reconnecting vs offline). A revoked/never-seen enrollment is offline without a
 *  probe. */
async function probeEnrollment(
  services: FleetServices,
  workspaceId: string,
  enrollment: EnrollmentRecord,
  liveConnection: EnrollmentRecord | null = enrollment,
): Promise<{
  liveness: FleetLiveness;
  consented: boolean;
  hasDisplay: boolean;
}> {
  const { settings, bus } = services;
  let probeResponded = false;
  if (liveConnection?.connectionInstanceId) {
    const session = new SelfhostedSession({
      workspaceId,
      agentId: enrollment.id,
      connectionInstanceId: liveConnection.connectionInstanceId,
      controlRpc: controlRpc(bus),
      relay: relayConfigFromSettings(settings),
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    try {
      probeResponded = await session.ping();
    } catch {
      probeResponded = false;
    }
  }
  const state = selfhostedLiveness({
    enrollment: {
      status: enrollment.status,
      exposure: enrollment.exposure,
      allowScreenControl: enrollment.allowScreenControl,
      hasDisplay: enrollment.hasDisplay,
      lastSeenAt: enrollment.lastSeenAt,
      wentOfflineAt: enrollment.wentOfflineAt,
      wentOfflineReason: enrollment.wentOfflineReason,
    },
    probeResponded,
  });
  return {
    liveness: state.state,
    consented: state.consented,
    hasDisplay: state.hasDisplay,
  };
}

/**
 * List the fleet: the session's own group box when it has one (a synthetic
 * entry) + the workspace's first-class selfhosted sandboxes (each probed for
 * liveness), each with an `active` marker derived from the session's active
 * pointer. A backend:none session has no synthetic home entry; a null pointer
 * then means no compute is attached.
 */
export async function listFleet(
  services: FleetServices,
  ctx: FleetContext,
): Promise<FleetListResult> {
  const { db } = services;
  const resourceAccess = ctx.subjectId
    ? {
        accountId: ctx.accountId,
        workspaceId: ctx.workspaceId,
        subjectId: ctx.subjectId,
      }
    : ctx.workspaceId;
  const pointer = (await readActiveSandbox(db, ctx.workspaceId, ctx.sessionId)) ?? {
    activeSandboxId: null,
    activeEpoch: 0,
  };

  const entries: FleetSandboxEntry[] = [];

  if (ctx.sessionBackend !== "none") {
    // The session's own group box (the default/home sandbox; null active pointer ==
    // this box). A session/group row is not provider existence. Online requires a
    // warm lease, observed provider existence, and verified workspace readiness.
    const groupActive = pointer.activeSandboxId === null;
    const groupLease = await readLease(db, ctx.workspaceId, ctx.sessionGroupId);
    const groupOnline = Boolean(
      groupLease?.liveness === "warm" &&
      groupLease.recovery.provider.status === "exists" &&
      groupLease.recovery.workspace.status === "ready",
    );
    const groupRecovering = Boolean(
      groupLease &&
      (groupLease.liveness === "warming" ||
        groupLease.recovery.restore.status === "pending" ||
        groupLease.recovery.restore.status === "restoring" ||
        groupLease.recovery.restore.status === "verifying"),
    );
    const groupRecoveryUnavailable = Boolean(
      groupLease &&
      (groupLease.recovery.restore.status === "degraded" ||
        groupLease.recovery.restore.status === "unrecoverable" ||
        groupLease.recovery.workspace.status === "degraded" ||
        groupLease.recovery.workspace.status === "unrecoverable"),
    );
    const groupOperationAvailability: FleetOperationAvailability = groupOnline
      ? "ready"
      : groupRecoveryUnavailable
        ? "unavailable"
        : groupRecovering
          ? "recovering"
          : ctx.sessionBackend === "selfhosted"
            ? "unavailable"
            : "wakeable";
    entries.push({
      id: ctx.sessionGroupId,
      kind:
        ctx.sessionBackend === "selfhosted"
          ? "selfhosted"
          : ctx.sessionBackend === "opensandbox"
            ? "opensandbox"
            : "modal",
      name: "session sandbox",
      liveness: groupOnline ? "online" : groupRecovering ? "reconnecting" : "offline",
      active: groupActive,
      isSessionGroup: true,
      enrollmentId: null,
      attachable: groupOnline,
      operationAvailability: groupOperationAvailability,
      providerStatus: groupLease?.recovery.provider.status ?? "not_created",
      leaseLiveness: groupLease?.liveness ?? null,
      routeStatus: groupActive ? "attached" : "detached",
      archiveStatus: groupLease?.recovery.archive.status ?? "none",
      restoreStatus: groupLease?.recovery.restore.status ?? "not_required",
      workspaceStatus: groupLease?.recovery.workspace.status ?? "unknown",
      leaseEpoch: groupLease?.leaseEpoch ?? null,
      routeEpoch: pointer.activeEpoch,
      workspaceGeneration: groupLease?.workspaceGeneration ?? null,
      archiveGeneration: groupLease?.archiveGeneration ?? null,
      archiveComplete: groupLease?.archiveComplete ?? false,
    });
  }

  // The workspace's first-class selfhosted sandboxes (enrolled machines). Probe
  // each for liveness; a missing enrollment is offline.
  const legacySandboxes = await listSandboxes(db, ctx.workspaceId);
  const enrollments = await listEnrollments(
    db,
    ctx.subjectId
      ? {
          accountId: ctx.accountId,
          workspaceId: ctx.workspaceId,
          subjectId: ctx.subjectId,
        }
      : ctx.workspaceId,
    { status: "active" },
  );
  const enrollmentById = new Map(enrollments.map((enrollment) => [enrollment.id, enrollment]));
  const scopedSandboxes: SandboxRecord[] = enrollments.flatMap((enrollment) =>
    enrollment.sandboxId
      ? [
          {
            id: enrollment.sandboxId,
            accountId: enrollment.accountId,
            workspaceId: enrollment.workspaceId,
            kind: "selfhosted" as const,
            name: enrollment.sandboxName ?? `${enrollment.os} machine`,
            enrollmentId: enrollment.id,
            createdAt: enrollment.createdAt,
            updatedAt: enrollment.updatedAt,
          },
        ]
      : [],
  );
  const sandboxes = [
    ...legacySandboxes.filter(
      (sandbox) => !scopedSandboxes.some((scoped) => scoped.id === sandbox.id),
    ),
    ...scopedSandboxes,
  ];
  for (const sandbox of sandboxes) {
    if (sandbox.kind !== "selfhosted" || !sandbox.enrollmentId) {
      continue;
    }
    const enrollment =
      enrollmentById.get(sandbox.enrollmentId) ??
      (await getEnrollment(db, resourceAccess, sandbox.enrollmentId));
    if (!enrollment || enrollment.status !== "active") {
      // Revoked enrollments remain durable audit/history records, but they are
      // intentionally absent from the normal attach/run picker.
      continue;
    }
    const liveConnection = await getLiveEnrollmentConnection(
      db,
      resourceAccess,
      sandbox.enrollmentId,
    );
    const probe = enrollment
      ? await probeEnrollment(services, sandbox.workspaceId, enrollment, liveConnection)
      : {
          liveness: "offline" as FleetLiveness,
          consented: false,
          hasDisplay: false,
        };
    entries.push({
      id: sandbox.id,
      kind: "selfhosted",
      name: sandbox.name,
      liveness: probe.liveness,
      active: pointer.activeSandboxId === sandbox.id,
      isSessionGroup: false,
      enrollmentId: sandbox.enrollmentId,
      attachable: probe.liveness === "online",
      operationAvailability:
        probe.liveness === "online"
          ? "ready"
          : probe.liveness === "reconnecting"
            ? "recovering"
            : "unavailable",
      consented: probe.consented,
      hasDisplay: probe.hasDisplay,
      lastSeenAt: enrollment?.lastSeenAt ?? null,
      providerStatus:
        probe.liveness === "online"
          ? "exists"
          : probe.liveness === "reconnecting"
            ? "unknown"
            : "missing",
      leaseLiveness: null,
      routeStatus: pointer.activeSandboxId === sandbox.id ? "attached" : "detached",
      archiveStatus: "none",
      restoreStatus: "not_required",
      workspaceStatus: probe.liveness === "online" ? "ready" : "not_ready",
      leaseEpoch: null,
      routeEpoch: pointer.activeEpoch,
      workspaceGeneration: null,
      archiveGeneration: null,
      archiveComplete: false,
    });
  }

  return {
    activeSandboxId: pointer.activeSandboxId,
    activeEpoch: pointer.activeEpoch,
    sandboxes: entries,
  };
}

/** Resolve a swap target id → the value `setActiveSandbox` writes. The session's
 *  own group id maps to NULL (the default pointer); a first-class sandbox id is
 *  validated (workspace ownership + liveness) and written verbatim. */
async function resolveTarget(
  services: FleetServices,
  ctx: FleetContext,
  target: string,
): Promise<
  | { ok: true; targetSandboxId: string | null }
  | { ok: false; reason: string; code: BackendUnresolvableCode }
> {
  // The session's own group box → the default pointer (null).
  if (target === ctx.sessionGroupId || target === "session" || target === "default") {
    if (ctx.sessionBackend === "none") {
      return {
        ok: false,
        reason: "this session has no home sandbox; attach a Connected Machine",
        code: "unsupported_backend_context",
      };
    }
    return { ok: true, targetSandboxId: null };
  }
  const sandbox = await getSandbox(
    services.db,
    ctx.subjectId
      ? {
          accountId: ctx.accountId,
          workspaceId: ctx.workspaceId,
          subjectId: ctx.subjectId,
        }
      : ctx.workspaceId,
    target,
  );
  if (!sandbox) {
    return {
      ok: false,
      reason: `sandbox ${target} not found in this workspace`,
      code: "stale_pointer",
    };
  }
  // ESTABLISHER-CAPABILITY GATE (issue #341 invariant A): a target must be
  // establishable by a turn's routing context BEFORE the epoch-fenced CAS commits
  // the pointer, or a "successful" swap strands every following op on a backend no
  // turn can resume. `swapTargetEstablishability` is the SAME predicate the turn
  // resolver consults, so admission and establishment never disagree. Any sandbox
  // reaching here is NOT the session's own group box (handled above), so a Modal
  // sibling is rejected pre-commit rather than admitted-then-stranded.
  const establishable = swapTargetEstablishability({
    kind: sandbox.kind,
    isSessionGroup: false,
  });
  if (!establishable.ok) {
    return {
      ok: false,
      reason: establishable.reason,
      code: establishable.code,
    };
  }
  if (sandbox.kind === "selfhosted") {
    if (!sandbox.enrollmentId) {
      return {
        ok: false,
        reason: `selfhosted sandbox ${target} has no enrollment`,
        code: "offline_enrollment",
      };
    }
    const enrollment = await getLiveEnrollmentConnection(
      services.db,
      ctx.subjectId
        ? {
            accountId: ctx.accountId,
            workspaceId: ctx.workspaceId,
            subjectId: ctx.subjectId,
          }
        : sandbox.workspaceId,
      sandbox.enrollmentId,
    );
    if (!enrollment) {
      return {
        ok: false,
        reason: `enrollment for sandbox ${target} not found`,
        code: "offline_enrollment",
      };
    }
    const probe = await probeEnrollment(services, sandbox.workspaceId, enrollment, enrollment);
    if (probe.liveness !== "online") {
      return {
        ok: false,
        reason: `sandbox ${target} is ${probe.liveness}; cannot attach to a non-online machine`,
        code: "offline_enrollment",
      };
    }
  }
  return { ok: true, targetSandboxId: sandbox.id };
}

/**
 * THE SWAP (and attach — identical mechanic). Validate the target's ownership +
 * liveness, then repoint the session via the epoch-fenced CAS `setActiveSandbox`:
 * read the current epoch, then CAS on it. A concurrent double-swap lets exactly
 * one win; the loser re-reads + may retry. The bumped epoch fences any in-flight
 * op cached against the old pointer, which then retries against the new active
 * sandbox (the routing proxy's fenced-retry role).
 */
export async function swapActiveSandbox(
  services: FleetServices,
  ctx: FleetContext,
  target: string,
  // The session's working directory to seed alongside the pointer (create-time
  // machine targeting). OMITTED ⇒ the column is left unchanged (a live swap/attach
  // never touches it); threaded straight into the epoch-fenced setActiveSandbox CAS.
  workingDir?: string | null,
): Promise<FleetSwapResult> {
  const resolved = await resolveTarget(services, ctx, target);
  if (!resolved.ok) {
    const pointer = (await readActiveSandbox(services.db, ctx.workspaceId, ctx.sessionId)) ?? {
      activeSandboxId: null,
      activeEpoch: 0,
    };
    // Fail BEFORE the CAS: the pointer + epoch are read back unchanged and echoed,
    // so an unestablishable target never mutates the session's routing state.
    return {
      swapped: false,
      activeSandboxId: pointer.activeSandboxId,
      activeEpoch: pointer.activeEpoch,
      reason: resolved.reason,
      code: resolved.code,
    };
  }

  let readinessHold: FleetReadinessHold | undefined;
  if (resolved.targetSandboxId === null && services.ensureSessionGroupReady) {
    try {
      readinessHold = await services.ensureSessionGroupReady(ctx);
    } catch (error) {
      const lease = await readLease(services.db, ctx.workspaceId, ctx.sessionGroupId);
      const restore = lease?.recovery.restore.status;
      const code =
        restore === "degraded"
          ? ("recovery_degraded" as const)
          : restore === "unrecoverable"
            ? ("recovery_unrecoverable" as const)
            : ("recovery_in_progress" as const);
      const pointer = (await readActiveSandbox(services.db, ctx.workspaceId, ctx.sessionId)) ?? {
        activeSandboxId: null,
        activeEpoch: 0,
      };
      return {
        swapped: false,
        activeSandboxId: pointer.activeSandboxId,
        activeEpoch: pointer.activeEpoch,
        reason:
          error instanceof Error
            ? error.message
            : "session sandbox did not reach verified readiness",
        code,
      };
    }
  }

  try {
    // Read the current epoch, then CAS on it (the fence). One retry on a lost race
    // (a concurrent swap bumped the epoch between read and write).
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const pointer = (await readActiveSandbox(services.db, ctx.workspaceId, ctx.sessionId)) ?? {
        activeSandboxId: null,
        activeEpoch: 0,
      };
      // Even a same-target attach advances active_epoch. It is a repair/fence
      // request, not a no-op acknowledgment: any cached stale route is invalidated
      // only after target readiness has been proved above.
      const result = await setActiveSandbox(services.db, {
        accountId: ctx.accountId,
        workspaceId: ctx.workspaceId,
        sessionId: ctx.sessionId,
        targetSandboxId: resolved.targetSandboxId,
        expectedEpoch: pointer.activeEpoch,
        ...(ctx.subjectId ? { subjectId: ctx.subjectId } : {}),
        ...(ctx.attemptAuthority ? { personalMachineAttempt: ctx.attemptAuthority } : {}),
        ...(workingDir !== undefined ? { workingDir } : {}),
      });
      if (result.swapped && result.pointer) {
        return {
          swapped: true,
          activeSandboxId: result.pointer.activeSandboxId,
          activeEpoch: result.pointer.activeEpoch,
        };
      }
      // CAS lost (a concurrent swap won) — re-read + retry once.
    }
    const pointer = (await readActiveSandbox(services.db, ctx.workspaceId, ctx.sessionId)) ?? {
      activeSandboxId: null,
      activeEpoch: 0,
    };
    return {
      swapped: false,
      activeSandboxId: pointer.activeSandboxId,
      activeEpoch: pointer.activeEpoch,
      reason: "a concurrent swap won the epoch fence; re-read and retry",
      code: "concurrent_swap",
    };
  } finally {
    // Do not let a cleanup failure turn an already-committed route CAS into a
    // false failure. Viewer holders are TTL-bounded and will be reaped if this
    // best-effort explicit release cannot complete.
    await readinessHold?.release().catch(() => undefined);
  }
}

export type RunOnOp =
  | { kind: "exec"; cmd: string; workdir?: string }
  | { kind: "read"; path: string }
  | { kind: "write"; path: string; content: string };

export type RunOnResult = {
  target: string;
  kind: string;
  ok: boolean;
  /** Display name of the target sandbox when known (from the sandboxes row). */
  targetName?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  /** Exec only: whether the machine killed the child at its process deadline. */
  timedOut?: boolean;
  /** Exec only: the effective clamped process deadline enforced by the machine. */
  deadlineMs?: number;
  content?: string;
  bytesWritten?: number;
  reason?: string;
};

export type RunOnSelfhostedMachine = {
  workspaceId: string;
  agentId: string;
  /** Exact live daemon pinned for this operation. */
  connectionInstanceId: string;
  controlRpc: ControlRpc;
  relay: SelfhostedRelayConfig;
  /** Short request/reply deadline for read/write and other control operations. */
  controlTimeoutMs: number;
  /** Longer agent-side process deadline for exec. */
  execTimeoutMs: number;
  /** Streaming transport required when execTimeoutMs is 0 (unbounded). */
  opStream?: SelfhostedOpStreamDeps;
  operationResourcePolicy?: SelfhostedOperationResourcePolicy;
  operationResourcePolicySupported?: boolean;
  operationCpuQuotaSupported?: boolean;
  /** Last-boundary authority/connection resolver invoked before every physical
   * provider operation. */
  resolveOperationAdmission?: () => Promise<SelfhostedOperationAdmission | null>;
  /**
   * Exact-attempt values for this one child process. Never persisted on the
   * enrollment or machine. The caller may supply these only after authenticating
   * the active attempt that owns the one-off operation.
   */
  transientExecEnvironment?: Readonly<Record<string, string>>;
};

export type RunOnOptions = {
  transientExecEnvironment?: Readonly<Record<string, string>>;
};

function runOnOperationAdmission(
  services: FleetServices,
  enrollment: EnrollmentRecord | null,
): SelfhostedOperationAdmission | null {
  if (!enrollment?.connectionInstanceId) return null;
  const opStream =
    services.settings.agentOpStreamEnabled === true &&
    enrollment.opStream === true &&
    services.bus?.getOpStreamConnection
      ? {
          transport: new NatsOpStreamTransport(
            async () => services.bus?.getOpStreamConnection?.() ?? null,
          ),
        }
      : undefined;
  return {
    workspaceId: enrollment.workspaceId,
    connectionInstanceId: enrollment.connectionInstanceId,
    ...(opStream ? { opStream } : {}),
    operationResourcePolicy: enrollment.operationPolicy,
    operationResourcePolicySupported: enrollment.agentCapabilities.operationResourcePolicy === true,
    operationCpuQuotaSupported: enrollment.agentCapabilities.operationCpuQuota === true,
  };
}

/**
 * Execute the one-off machine operation once the workspace/enrollment lookup has
 * succeeded. Kept separate from {@link runOnSandbox} so the command/deadline
 * contract is deterministic against an in-memory ControlRpc without weakening
 * the production ownership lookup or requiring a real machine.
 */
export async function executeRunOnSelfhostedMachine(
  machine: RunOnSelfhostedMachine,
  target: string,
  op: RunOnOp,
): Promise<RunOnResult> {
  const session = new SelfhostedSession({
    workspaceId: machine.workspaceId,
    agentId: machine.agentId,
    connectionInstanceId: machine.connectionInstanceId,
    controlRpc: machine.controlRpc,
    relay: machine.relay,
    timeoutMs: machine.controlTimeoutMs,
    execTimeoutMs: machine.execTimeoutMs,
    ...(machine.operationResourcePolicy !== undefined
      ? { operationResourcePolicy: machine.operationResourcePolicy }
      : {}),
    ...(machine.operationResourcePolicySupported !== undefined
      ? {
          operationResourcePolicySupported: machine.operationResourcePolicySupported,
        }
      : {}),
    ...(machine.operationCpuQuotaSupported !== undefined
      ? { operationCpuQuotaSupported: machine.operationCpuQuotaSupported }
      : {}),
    ...(machine.resolveOperationAdmission !== undefined
      ? { resolveOperationAdmission: machine.resolveOperationAdmission }
      : {}),
    ...(machine.transientExecEnvironment !== undefined
      ? { transientExecEnvironment: () => machine.transientExecEnvironment! }
      : {}),
    ...(machine.opStream !== undefined ? { opStream: machine.opStream } : {}),
  });

  try {
    if (op.kind === "exec") {
      const deadlineMs = session.effectiveExecDeadlineMs;
      const res = await session.exec({
        cmd: op.cmd,
        ...(op.workdir ? { workdir: op.workdir } : {}),
      });
      const timedOut = res.timedOut === true;
      const hasTerminalExit = res.exitCode !== null;
      return {
        target,
        kind: "exec",
        // `ok` means the one-off operation reached a terminal response. Preserve
        // the established non-zero-exit behavior, but never claim success when
        // the machine killed the child or returned no terminal exit proof.
        ok: !timedOut && hasTerminalExit,
        stdout: res.stdout,
        stderr: res.stderr,
        exitCode: res.exitCode,
        timedOut,
        deadlineMs,
        ...(timedOut
          ? {
              reason: `command exceeded the ${deadlineMs} ms execution deadline`,
            }
          : !hasTerminalExit
            ? { reason: "machine returned no terminal exit code" }
            : {}),
      };
    }
    if (op.kind === "read") {
      const bytes = await session.readFile({ path: op.path });
      return {
        target,
        kind: "read",
        ok: true,
        content: new TextDecoder().decode(bytes),
      };
    }
    const bytesWritten = await session.writeFile({
      path: op.path,
      content: op.content,
    });
    return { target, kind: "write", ok: true, bytesWritten };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      target,
      kind: op.kind,
      ok: false,
      reason,
      // A transport failure is not evidence that the process itself timed out,
      // so leave `timedOut` absent while still reporting the enforced deadline.
      ...(op.kind === "exec" ? { deadlineMs: session.effectiveExecDeadlineMs } : {}),
    };
  } finally {
    // This one-off has no turn journal. Once its result has been accepted by
    // this call, final-ack any settled stream so the runner can immediately
    // release replay/output retention instead of waiting for TTL cleanup.
    await session.finalizeOpStreamOps().catch(() => undefined);
  }
}

/**
 * Run a ONE-OFF op against a SPECIFIC target WITHOUT changing the active pointer
 * (the design `run_on`). Only selfhosted targets are routable as a one-off here
 * (a Modal target is the session's group box, reached via the normal Channel-A /
 * turn path — `run_on` is for reaching a NON-active enrolled machine without
 * swapping). The op is fenced under the target's enrollment, addressed to its
 * agent subject; an offline machine surfaces a clear reason, never a wrong-box
 * landing.
 */
export async function runOnSandbox(
  services: FleetServices,
  ctx: FleetContext,
  target: string,
  op: RunOnOp,
  options: RunOnOptions = {},
): Promise<RunOnResult> {
  const sandbox = await getSandbox(
    services.db,
    ctx.subjectId
      ? {
          accountId: ctx.accountId,
          workspaceId: ctx.workspaceId,
          subjectId: ctx.subjectId,
        }
      : ctx.workspaceId,
    target,
  );
  if (!sandbox) {
    return {
      target,
      kind: op.kind,
      ok: false,
      reason: `sandbox ${target} not found in this workspace`,
    };
  }
  if (sandbox.kind !== "selfhosted" || !sandbox.enrollmentId) {
    return {
      target,
      targetName: sandbox.name,
      kind: op.kind,
      ok: false,
      reason: `run_on routes one-off ops to enrolled selfhosted machines; ${sandbox.kind} targets are reached via the active sandbox (swap to it first)`,
    };
  }
  if (sandbox.scope === "user") {
    if (!ctx.subjectId || !ctx.attemptAuthority) {
      return {
        target,
        targetName: sandbox.name,
        kind: op.kind,
        ok: false,
        reason: "personal Connected Machine use requires an exact admitted agent attempt",
      };
    }
    try {
      const authorized = await authorizePersonalMachineForAttempt(services.db, {
        accountId: ctx.accountId,
        workspaceId: ctx.workspaceId,
        subjectId: ctx.subjectId,
        sessionId: ctx.sessionId,
        turnId: ctx.attemptAuthority.turnId,
        attemptId: ctx.attemptAuthority.attemptId,
        executionGeneration: ctx.attemptAuthority.executionGeneration,
        enrollmentId: sandbox.enrollmentId,
        requireActiveSandbox: false,
      });
      if (!authorized) {
        return {
          target,
          targetName: sandbox.name,
          kind: op.kind,
          ok: false,
          reason: "personal Connected Machine authority was not admitted for this attempt",
        };
      }
    } catch {
      return {
        target,
        targetName: sandbox.name,
        kind: op.kind,
        ok: false,
        reason: "personal Connected Machine authority is not live for this attempt",
      };
    }
  }
  const enrollment = await getLiveEnrollmentConnection(
    services.db,
    ctx.subjectId
      ? {
          accountId: ctx.accountId,
          workspaceId: ctx.workspaceId,
          subjectId: ctx.subjectId,
        }
      : sandbox.workspaceId,
    sandbox.enrollmentId,
  );
  if (!enrollment || enrollment.status !== "active" || !enrollment.connectionInstanceId) {
    return {
      target,
      targetName: sandbox.name,
      kind: op.kind,
      ok: false,
      reason: `sandbox ${target} is not enrolled/active`,
    };
  }
  const resolveOperationAdmission = async (): Promise<SelfhostedOperationAdmission | null> => {
    try {
      const current =
        sandbox.scope === "user" && ctx.subjectId && ctx.attemptAuthority
          ? await resolvePersonalMachineConnectionForAttempt(services.db, {
              accountId: ctx.accountId,
              workspaceId: ctx.workspaceId,
              subjectId: ctx.subjectId,
              sessionId: ctx.sessionId,
              turnId: ctx.attemptAuthority.turnId,
              attemptId: ctx.attemptAuthority.attemptId,
              executionGeneration: ctx.attemptAuthority.executionGeneration,
              enrollmentId: sandbox.enrollmentId!,
              requireActiveSandbox: false,
            })
          : await getLiveEnrollmentConnection(
              services.db,
              ctx.subjectId
                ? {
                    accountId: ctx.accountId,
                    workspaceId: ctx.workspaceId,
                    subjectId: ctx.subjectId,
                  }
                : sandbox.workspaceId,
              sandbox.enrollmentId!,
            );
      return runOnOperationAdmission(services, current);
    } catch {
      return null;
    }
  };

  const result = await executeRunOnSelfhostedMachine(
    {
      workspaceId: sandbox.workspaceId,
      agentId: sandbox.enrollmentId,
      connectionInstanceId: enrollment.connectionInstanceId,
      controlRpc: controlRpc(services.bus),
      relay: relayConfigFromSettings(services.settings),
      controlTimeoutMs: services.settings.sandboxSelfhostedControlTimeoutMs,
      execTimeoutMs: services.settings.sandboxSelfhostedExecTimeoutMs,
      operationResourcePolicy: enrollment.operationPolicy,
      operationResourcePolicySupported:
        enrollment.agentCapabilities.operationResourcePolicy === true,
      operationCpuQuotaSupported: enrollment.agentCapabilities.operationCpuQuota === true,
      resolveOperationAdmission,
      ...(options.transientExecEnvironment !== undefined
        ? { transientExecEnvironment: options.transientExecEnvironment }
        : {}),
      ...(services.settings.agentOpStreamEnabled === true &&
      enrollment.opStream === true &&
      services.bus?.getOpStreamConnection
        ? {
            opStream: {
              transport: new NatsOpStreamTransport(
                async () => services.bus?.getOpStreamConnection?.() ?? null,
              ),
            },
          }
        : {}),
    },
    target,
    op,
  );
  return { ...result, targetName: sandbox.name };
}

export type ProvisionResult =
  | {
      kind: "selfhosted";
      instructions: string;
      installCommandUnix: string;
      installCommandWindows: string;
      verificationUri: string;
      note: string;
    }
  | { kind: "modal"; sandbox: SandboxRecord; note: string };

/**
 * Provision a new fleet member.
 *   - selfhosted → return the device-flow enrollment instructions (the agent
 *     surfaces them to a HUMAN, who installs the agent + enrolls — the agent
 *     cannot click the loud whole-machine consent itself).
 *   - modal → create a first-class named modal `sandboxes` record (a swap target).
 *     NOTE: the Modal BOX is materialized lazily when first swapped-to (Modal
 * lifecycle is owned by the lease — unchanged per).
 */
export async function provisionSandbox(
  services: FleetServices,
  ctx: FleetContext,
  input: { kind: "selfhosted" | "modal"; name?: string },
): Promise<ProvisionResult> {
  if (input.kind === "selfhosted") {
    const base = (services.settings.publicBaseUrl ?? "https://app.opengeni.ai").replace(/\/+$/, "");
    const unixEnvironment = `OPENGENI_API_URL=${base} OPENGENI_WORKSPACE_ID=${ctx.workspaceId}`;
    const windowsEnvironment = `$env:OPENGENI_API_URL='${base}'; $env:OPENGENI_WORKSPACE_ID='${ctx.workspaceId}';`;
    return {
      kind: "selfhosted",
      instructions:
        "Share one of these deployment-specific commands with a human operator. It installs the OpenGeni agent and starts `opengeni-agent connect` for this exact deployment and workspace; do not run a second bare `connect`. Complete the device-flow at the verification URL (the loud whole-machine + screen-control consent), and the machine then appears here as an attachable selfhosted sandbox. Existing connections to other OpenGeni workspaces or deployments are preserved.",
      // Install from THIS control plane's origin (not a hardcoded public CDN): the
      // served install script is rewritten to pull the per-SHA agent baked into
      // this exact deployment (see apps/api/src/routes/install.ts), so a deployed
      // env is self-contained and a private/air-gapped one works with no public DNS.
      installCommandUnix: `curl -fsSL ${base}/install.sh | ${unixEnvironment} sh`,
      installCommandWindows: `${windowsEnvironment} irm ${base}/install.ps1 | iex`,
      verificationUri: `${base}/device`,
      note: "Whole-machine access requires explicit human consent in the device-flow web page; the agent cannot self-consent.",
    };
  }
  // modal: create a first-class named modal sandbox record. NOTE: a session cannot
  // yet be swapped onto a second Modal box — cross-group Modal routing is not built,
  // so `sandbox_swap` to this id is rejected (unsupported_backend_context). The
  // response says so plainly rather than implying an attach that does not work.
  const { createSandbox } = await import("@opengeni/db");
  const sandbox = await createSandbox(services.db, {
    accountId: ctx.accountId,
    workspaceId: ctx.workspaceId,
    kind: "modal",
    name: input.name?.trim() || "modal-box",
  });
  return {
    kind: "modal",
    sandbox,
    note: "A named Modal sandbox record was created, but it is NOT yet attachable as a swap target: routing a session onto a second Modal box is not supported yet, so a sandbox_swap to this id is rejected. Use the session's own box (the default) or attach a Connected Machine instead.",
  };
}
