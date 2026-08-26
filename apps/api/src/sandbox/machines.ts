// apps/api/src/sandbox/machines.ts — the M10 Machines-DASHBOARD service (design
// §10.7). Builds the `MachinesResponse` the dashboard renders: the workspace's
// enrolled selfhosted machines, each enriched with
//   * STATE — heartbeat + goodbye liveness (online/offline) overlaid with the
//     enrollment-derived display reason (display_unavailable). This list does
//     not ControlRpc-ping; attach, capability negotiation, and fleet tools
//     still probe when they need a live responder.
//   * METRICS — the latest machine_metrics_latest row (or null before a first
//     heartbeat), projected to the contract's MetricSample;
//   * sharedSessionCount — the lease refcount (how many sessions share this one
//     whole machine, the maxSandboxes:1 disclosure).
// PLUS, when a session context is supplied, the session's synthetic Modal group
// box (isSessionGroup:true) + the active-sandbox pointer (activeSandboxId/Epoch).
//
// This is workspace-scoped (perm enrollments:read) and flag-gated upstream
// (sandboxSelfhostedEnabled). It deliberately does NOT depend on a FleetContext
// (which is session-coupled): the pure workspace dashboard works without a
// session; an in-session view passes the optional session to add the group box +
// active pointer.

import type { Settings } from "@opengeni/config";
import {
  getSession,
  getLiveEnrollmentConnection,
  listEnrollments,
  listSandboxes,
  readActiveSandbox,
  readLease,
  readMachineMetricsLatestForWorkspace,
  type Database,
  type EnrollmentRecord,
  type MachineMetricsRow,
} from "@opengeni/db";
import { MachineView, MetricSample, type MachinesResponse } from "@opengeni/contracts";
import { selfhostedHeartbeatLiveness } from "@opengeni/runtime/sandbox";

export type MachinesServices = {
  db: Database;
  settings: Settings;
};

const ACTIVE_UPDATE_STATUSES = new Set([
  "requested",
  "accepted",
  "waiting_for_idle",
  "downloading",
  "verifying",
  "applying",
  "restarting",
]);

function compareAgentVersions(left: string, right: string): number | null {
  const parse = (value: string): { core: number[]; prerelease: string | null } | null => {
    const match = /^(?:v)?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value.trim());
    if (!match) return null;
    return {
      core: [Number(match[1]), Number(match[2]), Number(match[3])],
      prerelease: match[4] ?? null,
    };
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    const delta = a.core[index]! - b.core[index]!;
    if (delta !== 0) return Math.sign(delta);
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return a.prerelease.localeCompare(b.prerelease);
}

function runtimeFor(settings: Settings, enrollment: EnrollmentRecord): MachineView["runtime"] {
  const desiredVersion =
    enrollment.agentUpdateChannel === "beta"
      ? (settings.agentBetaVersion ?? settings.agentStableVersion)
      : settings.agentStableVersion;
  const update = enrollment.agentUpdate;
  const activeUpdate = update ? ACTIVE_UPDATE_STATUSES.has(update.status) : false;
  const order =
    enrollment.agentVersion && desiredVersion
      ? compareAgentVersions(enrollment.agentVersion, desiredVersion)
      : null;
  const versionState = activeUpdate
    ? "updating"
    : update?.status === "failed"
      ? "update_failed"
      : order === null
        ? "unknown"
        : order === 0
          ? "current"
          : order < 0
            ? "outdated"
            : "ahead";
  const capability = (name: string): boolean => enrollment.agentCapabilities[name] === true;
  return {
    installedVersion: enrollment.agentVersion,
    binarySha256: enrollment.agentBinarySha256,
    updateChannel: enrollment.agentUpdateChannel,
    desiredVersion,
    versionState,
    capabilities: {
      exec: capability("exec"),
      filesystem: capability("filesystem"),
      git: capability("git"),
      pty: capability("pty"),
      desktop: capability("desktop"),
      opStream: capability("opStream"),
      browserBridge: capability("browserBridge"),
      operationResourcePolicy: capability("operationResourcePolicy"),
      operationCpuQuota: capability("operationCpuQuota"),
    },
    update,
  };
}

function connectionAuthorityFor(
  enrollment: EnrollmentRecord | null,
  liveConnection: EnrollmentRecord | null,
): MachineView["connectionAuthority"] {
  if (!enrollment) {
    return {
      state: "not_applicable",
      generation: 0,
      supersededCount: 0,
      leaseExpiresAt: null,
      duplicateRunnerDeniedCount: 0,
      duplicateRunnerDeniedAt: null,
    };
  }
  return {
    state: liveConnection
      ? "active"
      : enrollment.connectionInstanceId && enrollment.connectionLeaseExpiresAt
        ? "expired"
        : "unclaimed",
    generation: enrollment.connectionGeneration,
    supersededCount: Math.max(0, enrollment.connectionGeneration - 1),
    leaseExpiresAt: enrollment.connectionLeaseExpiresAt,
    duplicateRunnerDeniedCount: enrollment.connectionDuplicateDeniedCount,
    duplicateRunnerDeniedAt: enrollment.connectionDuplicateDeniedAt,
  };
}

/**
 * Project a stored `machine_metrics_latest` row to the contract `MetricSample`.
 * The DB carries `gpuUtilPercent` + `gpuMemUsedBytes`/`gpuMemTotalBytes`; the wire
 * `MetricSample` exposes the single `gpuUtilPct` + `gpuMemBytes` (USED bytes — the
 * "how much VRAM is in use" the dashboard reads). A null any-numeric stays null
 * (the not-reported contract); the byte/load fields default to 0 when a sample
 * carried no value (the agent reports 0 == not-reported for those).
 */
export function metricRowToSample(row: MachineMetricsRow): MetricSample {
  return MetricSample.parse({
    cpuPct: row.cpuPercent ?? 0,
    load1: row.load1 ?? 0,
    load5: row.load5 ?? 0,
    load15: row.load15 ?? 0,
    memUsedBytes: row.memUsedBytes ?? 0,
    memTotalBytes: row.memTotalBytes ?? 0,
    diskUsedBytes: row.diskUsedBytes ?? 0,
    diskTotalBytes: row.diskTotalBytes ?? 0,
    gpuUtilPct: row.gpuUtilPercent,
    gpuMemBytes: row.gpuMemUsedBytes,
    runQueue: row.contention ?? 0,
    sampledAt: row.sampledAt,
  });
}

function enrollmentLiveness(enrollment: EnrollmentRecord) {
  return selfhostedHeartbeatLiveness({
    enrollment: {
      status: enrollment.status,
      exposure: enrollment.exposure,
      allowScreenControl: enrollment.allowScreenControl,
      hasDisplay: enrollment.hasDisplay,
      lastSeenAt: enrollment.lastSeenAt,
      wentOfflineAt: enrollment.wentOfflineAt,
      wentOfflineReason: enrollment.wentOfflineReason,
    },
  });
}

/**
 * Resolve the dashboard STATE of a machine. State reflects REACHABILITY + the
 * VIEW plane only: an online machine with no display → `display_unavailable` (no
 * desktop stream, but compute — exec/fs/git/terminal — still works); otherwise
 * the liveness state (online/offline; list heartbeat never yields reconnecting).
 * It deliberately does NOT fold
 * in screen-control consent: a displayed machine can be VIEWED (read-only) and
 * used for compute regardless of `allowScreenControl` — only INPUT (ComputerUse /
 * an interactive stream) needs that consent, which is a per-capability concern
 * carried by the separate `allowScreenControl` field (surfaced in the viewer's
 * Take-control affordance), NOT a blocking machine state. This mirrors the
 * view/control split in the selfhosted capability negotiation so the dashboard
 * pill, the dock, and the "Run on" picker agree (a machine is never wrongly
 * un-selectable just because its input isn't consented).
 */
function machineStateFor(
  liveness: "online" | "reconnecting" | "offline",
  hasDisplay: boolean,
): MachinesResponse["machines"][number]["state"] {
  if (liveness !== "online") {
    return liveness;
  }
  if (!hasDisplay) {
    return "display_unavailable";
  }
  return "online";
}

/**
 * Build the Machines dashboard response for a workspace. When `sessionId` is
 * supplied (an in-session view) the session's synthetic home group box is
 * prepended when one exists (`isSessionGroup:true`) and the active-sandbox pointer is echoed;
 * without it (the pure workspace dashboard) `activeSandboxId` is null and only
 * the enrolled machines are listed.
 */
export async function listMachines(
  services: MachinesServices,
  input: {
    accountId?: string;
    workspaceId: string;
    subjectId?: string;
    sessionId?: string | null;
  },
): Promise<MachinesResponse> {
  const { db } = services;
  const { workspaceId } = input;

  // The session's active pointer (in-session view only). Absent session → the
  // default null pointer (the workspace dashboard has no "active" machine).
  let activeSandboxId: string | null = null;
  let activeEpoch = 0;
  let session: Awaited<ReturnType<typeof getSession>> | null = null;
  if (input.sessionId) {
    session = await getSession(db, workspaceId, input.sessionId);
    if (session) {
      const pointer = await readActiveSandbox(db, workspaceId, input.sessionId);
      activeSandboxId = pointer?.activeSandboxId ?? null;
      activeEpoch = pointer?.activeEpoch ?? 0;
    }
  }

  const machines: MachineView[] = [];

  // The session's own managed group box (synthetic): the default/home sandbox a
  // null active pointer routes to. A backend:none session has no home box, while
  // a selfhosted-home session is represented by its real enrolled machine row —
  // inventing a second enrollment-less "selfhosted" target cannot be established.
  if (session && session.sandboxBackend !== "none" && session.sandboxBackend !== "selfhosted") {
    const groupActive = activeSandboxId === null;
    const groupLease = await readLease(db, workspaceId, session.sandboxGroupId);
    machines.push(
      MachineView.parse({
        sandboxId: session.sandboxGroupId,
        enrollmentId: null,
        name: "session sandbox",
        kind: "modal",
        state: "online",
        active: groupActive,
        isSessionGroup: true,
        workspaceGeneration: groupLease?.workspaceGeneration ?? null,
        archiveGeneration: groupLease?.archiveGeneration ?? null,
        archiveComplete: groupLease?.archiveComplete ?? false,
        // The Modal group box is a cloud Linux box; its precise OS/arch is not
        // surfaced as a metric, so the dashboard shows the canonical linux/x86_64.
        os: "linux",
        arch: "x86_64",
        hasDisplay: false,
        desktopUnavailableReason: null,
        allowScreenControl: false,
        sharedSessionCount: 1,
        lastSeenAt: null,
        connectionAuthority: connectionAuthorityFor(null, null),
        runtime: null,
        operationPolicy: null,
        metrics: null,
      }),
    );
  }

  // The workspace's enrolled selfhosted machines. One bulk metrics read joined
  // onto the machines (no N+1). Liveness is the durable heartbeat cursor.
  const [legacySandboxes, enrollments] = await Promise.all([
    listSandboxes(db, workspaceId),
    listEnrollments(
      db,
      input.accountId && input.subjectId
        ? {
            accountId: input.accountId,
            workspaceId,
            subjectId: input.subjectId,
          }
        : workspaceId,
      { status: "active" },
    ),
  ]);
  const metricsByEnrollment = new Map<string, MachineMetricsRow>();
  for (const originWorkspaceId of new Set(enrollments.map((entry) => entry.workspaceId))) {
    const originMetrics = await readMachineMetricsLatestForWorkspace(db, originWorkspaceId);
    for (const [enrollmentId, metrics] of originMetrics) {
      metricsByEnrollment.set(enrollmentId, metrics);
    }
  }
  const scopedSandboxes = enrollments.flatMap((enrollment) =>
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
  const enrollmentById = new Map(enrollments.map((e) => [e.id, e]));

  const machineViews = await Promise.all(
    sandboxes.map(async (sandbox): Promise<MachineView | null> => {
      if (sandbox.kind !== "selfhosted" || !sandbox.enrollmentId) {
        return null;
      }
      const enrollment = enrollmentById.get(sandbox.enrollmentId) ?? null;
      if (!enrollment) {
        return null;
      }
      const [liveConnection, lease] = await Promise.all([
        enrollment.connectionInstanceId &&
        enrollment.connectionLeaseExpiresAt &&
        Date.parse(enrollment.connectionLeaseExpiresAt) > Date.now()
          ? Promise.resolve(enrollment)
          : getLiveEnrollmentConnection(
              db,
              input.accountId && input.subjectId
                ? {
                    accountId: input.accountId,
                    workspaceId,
                    subjectId: input.subjectId,
                  }
                : enrollment.workspaceId,
              enrollment.id,
            ),
        readLease(db, enrollment.workspaceId, sandbox.id),
      ]);
      const liveness = enrollmentLiveness(enrollment);
      const state = machineStateFor(liveness.state, liveness.hasDisplay);

      // sharedSessionCount = the lease refcount for this machine's group. The
      // selfhosted sandbox id IS the lease group key (maxSandboxes:1, N sessions
      // share via refcount). No lease yet → 0 sessions sharing.
      const sharedSessionCount = lease?.refcount ?? 0;

      const metricsRow = metricsByEnrollment.get(enrollment.id) ?? null;
      return MachineView.parse({
        sandboxId: sandbox.id,
        enrollmentId: enrollment.id,
        scope: enrollment.scope,
        generation: enrollment.generation,
        name: sandbox.name,
        kind: "selfhosted",
        state,
        active: activeSandboxId === sandbox.id,
        isSessionGroup: false,
        workspaceGeneration: null,
        archiveGeneration: null,
        archiveComplete: false,
        os: enrollment.os,
        arch: enrollment.arch,
        hasDisplay: enrollment.hasDisplay,
        desktopUnavailableReason: enrollment.desktopUnavailableReason,
        allowScreenControl: enrollment.allowScreenControl,
        sharedSessionCount,
        lastSeenAt: enrollment.lastSeenAt,
        connectionAuthority: connectionAuthorityFor(enrollment, liveConnection),
        runtime: runtimeFor(services.settings, enrollment),
        operationPolicy: enrollment.operationPolicy,
        metrics: metricsRow ? metricRowToSample(metricsRow) : null,
      });
    }),
  );
  machines.push(...machineViews.filter((machine): machine is MachineView => machine !== null));

  return { activeSandboxId, activeEpoch, machines };
}
