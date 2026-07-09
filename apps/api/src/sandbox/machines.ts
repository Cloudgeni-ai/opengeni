// apps/api/src/sandbox/machines.ts — the M10 Machines-DASHBOARD service (dossier
// §10.7). Builds the `MachinesResponse` the dashboard renders: the workspace's
// enrolled selfhosted machines, each enriched with
//   * STATE — the M3 liveness (online/reconnecting/offline) overlaid with the
//     enrollment-derived consent/display reasons (consent_required /
//     display_unavailable) — a real ControlRpc ping (the subject IS the registry),
//     reusing the M7 fleet probe;
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
  listEnrollments,
  listSandboxes,
  readActiveSandbox,
  readLease,
  readMachineMetricsLatestForWorkspace,
  type Database,
  type EnrollmentRecord,
  type MachineMetricsRow,
} from "@opengeni/db";
import type { EventBus } from "@opengeni/events";
import { MachineView, MetricSample, type MachinesResponse } from "@opengeni/contracts";
import {
  NatsControlRpc,
  selfhostedLiveness,
  SelfhostedSession,
  type ControlRpc,
  type NatsRequestConnection,
} from "@opengeni/runtime/sandbox";
import { relayConfigFromSettings } from "@opengeni/core";

export type MachinesServices = {
  db: Database;
  settings: Settings;
  bus?: EventBus;
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

/** Probe an enrolled machine's liveness — a real ControlRpc ping mapped through
 *  `selfhostedLiveness` (the enrollment status/consent/display + lastSeenAt
 *  disambiguate a probe-miss into reconnecting vs offline). Mirrors the M7 fleet
 *  probe. A non-active enrollment is offline without a probe. */
async function probeEnrollment(
  services: MachinesServices,
  workspaceId: string,
  enrollment: EnrollmentRecord,
): Promise<{
  state: "online" | "reconnecting" | "offline";
  consented: boolean;
  hasDisplay: boolean;
}> {
  const { settings, bus } = services;
  let probeResponded = false;
  if (enrollment.status === "active") {
    const session = new SelfhostedSession({
      workspaceId,
      agentId: enrollment.id,
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
  const derived = selfhostedLiveness({
    enrollment: {
      status: enrollment.status,
      exposure: enrollment.exposure,
      allowScreenControl: enrollment.allowScreenControl,
      hasDisplay: enrollment.hasDisplay,
      lastSeenAt: enrollment.lastSeenAt,
    },
    probeResponded,
  });
  return { state: derived.state, consented: derived.consented, hasDisplay: derived.hasDisplay };
}

/**
 * Resolve the dashboard STATE of a machine. State reflects REACHABILITY + the
 * VIEW plane only: an online machine with no display → `display_unavailable` (no
 * desktop stream, but compute — exec/fs/git/terminal — still works); otherwise
 * the liveness state (online/reconnecting/offline). It deliberately does NOT fold
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
 * supplied (an in-session view) the session's synthetic Modal group box is
 * prepended (`isSessionGroup:true`) and the active-sandbox pointer is echoed;
 * without it (the pure workspace dashboard) `activeSandboxId` is null and only
 * the enrolled machines are listed.
 */
export async function listMachines(
  services: MachinesServices,
  input: { workspaceId: string; sessionId?: string | null },
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

  // The session's own Modal group box (synthetic): the default/home sandbox a
  // null active pointer routes to. Only present in an in-session view.
  if (session) {
    const groupActive = activeSandboxId === null;
    machines.push(
      MachineView.parse({
        sandboxId: session.sandboxGroupId,
        enrollmentId: null,
        name: "session sandbox",
        kind: session.sandboxBackend === "selfhosted" ? "selfhosted" : "modal",
        state: "online",
        active: groupActive,
        isSessionGroup: true,
        // The Modal group box is a cloud Linux box; its precise OS/arch is not
        // surfaced as a metric, so the dashboard shows the canonical linux/x86_64.
        os: "linux",
        arch: "x86_64",
        hasDisplay: false,
        desktopUnavailableReason: null,
        allowScreenControl: false,
        sharedSessionCount: 1,
        lastSeenAt: null,
        metrics: null,
      }),
    );
  }

  // The workspace's enrolled selfhosted machines. One bulk metrics read joined
  // onto the machines (no N+1). Each machine is probed for liveness.
  const [sandboxes, enrollments, metricsByEnrollment] = await Promise.all([
    listSandboxes(db, workspaceId),
    listEnrollments(db, workspaceId),
    readMachineMetricsLatestForWorkspace(db, workspaceId),
  ]);
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
      const [probe, lease] = await Promise.all([
        probeEnrollment(services, workspaceId, enrollment),
        readLease(db, workspaceId, sandbox.id),
      ]);
      const state = machineStateFor(probe.state, probe.hasDisplay);

      // sharedSessionCount = the lease refcount for this machine's group. The
      // selfhosted sandbox id IS the lease group key (maxSandboxes:1, N sessions
      // share via refcount). No lease yet → 0 sessions sharing.
      const sharedSessionCount = lease?.refcount ?? 0;

      const metricsRow = metricsByEnrollment.get(enrollment.id) ?? null;
      return MachineView.parse({
        sandboxId: sandbox.id,
        enrollmentId: enrollment.id,
        name: sandbox.name,
        kind: "selfhosted",
        state,
        active: activeSandboxId === sandbox.id,
        isSessionGroup: false,
        os: enrollment.os,
        arch: enrollment.arch,
        hasDisplay: enrollment.hasDisplay,
        desktopUnavailableReason: enrollment.desktopUnavailableReason,
        allowScreenControl: enrollment.allowScreenControl,
        sharedSessionCount,
        lastSeenAt: enrollment.lastSeenAt,
        metrics: metricsRow ? metricRowToSample(metricsRow) : null,
      });
    }),
  );
  machines.push(...machineViews.filter((machine): machine is MachineView => machine !== null));

  return { activeSandboxId, activeEpoch, machines };
}
