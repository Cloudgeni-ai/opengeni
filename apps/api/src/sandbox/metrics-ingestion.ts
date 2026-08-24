// apps/api/src/sandbox/metrics-ingestion.ts — the M10 metrics INGESTION consumer
// + the connect-Hello DISPLAY-REFRESH consumer. The
// enrolled agent piggybacks a `MetricsSample` on its ~5s heartbeat (an
// `AgentEvent` published one-way on the exact process events subject) and publishes a
// `Hello` (its live self-description) on the exact process hello subject on every connect
// /reconnect. This module owns the two agent→control-plane inbound consumers:
//
//   `agent.*.*.connection.*.events` (heartbeat) →
//     1. touchEnrollmentLastSeen  — the liveness cursor (online/reconnecting/offline
//        derivation + the M3 probe disambiguation).
//     2. ingestMachineMetricsSample — UPSERT machine_metrics_latest (the "now" row)
//        + APPEND a machine_metrics_series row downsampled to ~1/min.
//     A GOING-OFFLINE event is not a metrics point — liveness flips via the lease/
//     probe path; we skip it here (no-op).
//
//   `agent.*.*.connection.*.hello` (connect) →
//     refreshEnrollmentDisplay — reconcile `enrollments.has_display` to the LIVE
//     capability the Hello reports. `has_display` was previously FROZEN at the
//     enroll-time offer snapshot; a machine that GAINS a display later (a Mac that
//     grants Screen Recording, a box whose Xvfb starts) or LOSES one never
//     re-surfaced. Consuming the Hello's `capabilities.desktop` / `display` makes
//     `has_display` track reality (both directions), which the desktop-capability
//     gate (packages/runtime capabilities.ts) keys off.
//     refreshEnrollmentOpStream — reconcile `enrollments.op_stream` to the LIVE
//     runner capability the Hello reports. Exec is unavailable unless the runner
//     advertises the streaming engine.
//
// Both consumers are BEST-EFFORT and fail-soft: a decode/DB error for one message
// is logged + swallowed (the bus subscription already swallows handler throws) so
// a metrics blip / a display-refresh write failure never tears down the consumer,
// back-pressures the agent, or breaks its connect.

import {
  clearEnrollmentWentOffline,
  disconnectAttachedBrowserDevices,
  advanceEnrollmentAgentUpdate,
  getEnrollment,
  getLiveEnrollmentConnection,
  ingestMachineMetricsSample,
  reconcileAttachedBrowserInventory,
  releaseEnrollmentConnection,
  renewEnrollmentConnection,
  sessionsWithActiveOpOnEnrollment,
  setEnrollmentDisplayState,
  setEnrollmentAgentRuntime,
  setEnrollmentOpStreamState,
  type AppendEventInput,
  type Database,
  type MachineMetricsSample,
} from "@opengeni/db";
import {
  AttachedBrowserInventorySnapshot as AttachedBrowserInventoryContract,
  type AttachedBrowserInventorySnapshot as AttachedBrowserInventoryContractValue,
} from "@opengeni/contracts";
import { appendAndPublishEvents, type EventBus } from "@opengeni/events";
import type { Observability } from "@opengeni/observability";
import { normalizeConnectedMachineWorkspaceRoot } from "@opengeni/runtime/sandbox";
import {
  AgentEvent,
  AgentUpdateStage,
  Arch,
  GoingOfflineReason,
  Hello,
  Os,
  goingOfflineReasonToJSON,
  type AttachedBrowserInventorySnapshot as WireAttachedBrowserInventorySnapshot,
  type MetricsSample,
} from "@opengeni/agent-proto";
import { AGENT_CONNECTION_LEASE_MS } from "./connection-authority";

/** The wildcard subject the agent event plane publishes heartbeats on. */
export const AGENT_EVENTS_SUBJECT = "agent.*.*.connection.*.events";

/** The wildcard subject the agent publishes its connect Hello on. */
export const AGENT_HELLO_SUBJECT = "agent.*.*.connection.*.hello";

/**
 * Parse `agent.<ws>.<id>.connection.<instance>.<tail>` into its exact authority,
 * expected tail token. Returns null for a subject that does not match the shape
 * (defensive — the subscription pattern already constrains it).
 */
function parseAgentSubject(
  subject: string,
  tail: "events" | "hello",
): { workspaceId: string; agentId: string; connectionInstanceId: string } | null {
  const parts = subject.split(".");
  if (
    parts.length !== 6 ||
    parts[0] !== "agent" ||
    parts[3] !== "connection" ||
    !parts[4] ||
    parts[5] !== tail
  ) {
    return null;
  }
  return {
    workspaceId: parts[1]!,
    agentId: parts[2]!,
    connectionInstanceId: parts[4]!,
  };
}

/** Parse the exact process events subject (heartbeat plane). */
export function parseAgentEventSubject(
  subject: string,
): { workspaceId: string; agentId: string; connectionInstanceId: string } | null {
  return parseAgentSubject(subject, "events");
}

/** Parse the exact process hello subject (connect plane). */
export function parseAgentHelloSubject(
  subject: string,
): { workspaceId: string; agentId: string; connectionInstanceId: string } | null {
  return parseAgentSubject(subject, "hello");
}

/**
 * Project a wire `MetricsSample` (proto, ms-stamped, GPU as a repeated list) to
 * the DB `MachineMetricsSample`. The proto byte/count fields are protobuf-encoded
 * as decimal strings (uint64) on the TS side (ts-proto `string`); coerce to
 * numbers. The DB carries a single `gpuUtilPercent` + `gpuMemUsedBytes`/Total —
 * we take the FIRST GPU (the dashboard surfaces the primary accelerator); absent
 * GPUs stay null (the not-reported contract). A zero on a non-GPU field is the
 * agent's "not reported" (we keep it null-friendly via `nullIfZero` only for the
 * GPU plane; cpu/mem/disk 0 is a legitimate reading the dashboard shows as 0).
 */
export function wireSampleToDbSample(wire: MetricsSample): MachineMetricsSample {
  const num = (v: string | number): number => (typeof v === "number" ? v : Number(v));
  const firstGpu = wire.gpus[0];
  return {
    cpuPercent: wire.cpuPercent,
    load1: wire.load1,
    load5: wire.load5,
    load15: wire.load15,
    memUsedBytes: num(wire.memUsedBytes),
    memTotalBytes: num(wire.memTotalBytes),
    diskUsedBytes: num(wire.diskUsedBytes),
    diskTotalBytes: num(wire.diskTotalBytes),
    gpuUtilPercent: firstGpu ? firstGpu.utilPercent : null,
    gpuMemUsedBytes: firstGpu ? num(firstGpu.memUsedBytes) : null,
    gpuMemTotalBytes: firstGpu ? num(firstGpu.memTotalBytes) : null,
    contention: wire.runQueue,
    // The sample carries its own wall-clock stamp (epoch ms); fall back to now on
    // a missing/zero stamp so a series row is never NULL-dated.
    sampledAt:
      wire.sampledAtMs && Number(wire.sampledAtMs) > 0
        ? new Date(Number(wire.sampledAtMs))
        : new Date(),
  };
}

/** Validate and project one wire inventory before it reaches durable browser
 *  discovery. Unknown enum values and unsafe uint64 counters reject the whole
 *  authoritative snapshot instead of partially disconnecting good endpoints. */
export function wireAttachedBrowserInventoryToContract(
  wire: WireAttachedBrowserInventorySnapshot,
): AttachedBrowserInventoryContractValue {
  return AttachedBrowserInventoryContract.parse({
    bridgeGeneration: wire.bridgeGeneration,
    revision: safeWireInteger(wire.revision, "browser inventory revision"),
    devices: wire.devices.map((device) => ({
      id: device.id,
      name: device.name,
      profileLabel: device.profileLabel.trim() || null,
      browserName: device.browserName,
      browserVersion: device.browserVersion,
      extensionVersion: device.extensionVersion,
      platform: wireBrowserPlatform(device.platform),
      architecture: wireBrowserArchitecture(device.arch),
      connectionGeneration: device.connectionGeneration,
      inventoryRevision: safeWireInteger(
        device.inventoryRevision,
        "attached browser inventory revision",
      ),
      tabCount: safeWireInteger(device.tabCount, "attached browser tab count"),
      capabilities: device.capabilities,
    })),
  });
}

function safeWireInteger(value: string | number, label: string): number {
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new Error(`${label} is not an integer`);
  }
  if (parsed < 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} is outside the safe integer range`);
  }
  return Number(parsed);
}

function wireBrowserPlatform(platform: Os): "linux" | "macos" | "windows" {
  switch (platform) {
    case Os.OS_LINUX:
      return "linux";
    case Os.OS_MACOS:
      return "macos";
    case Os.OS_WINDOWS:
      return "windows";
    default:
      throw new Error("attached browser platform is unspecified or unsupported");
  }
}

function wireBrowserArchitecture(architecture: Arch): "x64" | "arm64" {
  switch (architecture) {
    case Arch.ARCH_X86_64:
      return "x64";
    case Arch.ARCH_AARCH64:
      return "arm64";
    default:
      throw new Error("attached browser architecture is unspecified or unsupported");
  }
}

async function ingestAttachedBrowserInventory(
  db: Database,
  input: {
    workspaceId: string;
    agentId: string;
    inventory: WireAttachedBrowserInventorySnapshot;
  },
): Promise<void> {
  const enrollment = await getEnrollment(db, input.workspaceId, input.agentId);
  if (!enrollment) return;
  await reconcileAttachedBrowserInventory(db, {
    accountId: enrollment.accountId,
    workspaceId: input.workspaceId,
    enrollmentId: input.agentId,
    snapshot: wireAttachedBrowserInventoryToContract(input.inventory),
  });
}

/**
 * Ingest the OPTIONAL metrics sample carried by an already-authorized heartbeat.
 * Connection renewal is deliberately owned by the outer event handler and runs
 * before optional telemetry/inventory work, so telemetry absence or failure can
 * never make a healthy runner lose authority.
 */
async function ingestHeartbeatMetrics(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    agentId: string;
    sample: MetricsSample;
  },
): Promise<{ ingested: boolean; seriesAppended: boolean }> {
  const sample = wireSampleToDbSample(input.sample);
  const result = await ingestMachineMetricsSample(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    enrollmentId: input.agentId,
    sample,
  });
  return { ingested: true, seriesAppended: result.seriesAppended };
}

/**
 * Fan out one or more machine-LINK session events to the sessions that had an
 * active op running on the machine when its control link changed (per
 * `sessionsWithActiveOpOnEnrollment`) — the announce-only failure-visibility
 * plane. Each session's events are stamped on its OWN active turn. No matching
 * session ⇒ nothing is emitted (an idle-machine blip must never spam idle /
 * historical sessions). Called best-effort inside the handlers' fail-soft blocks.
 *
 * Each session's emission is ISOLATED: one session's append failing (a
 * session-specific constraint like a sequence collision from a racing writer, a
 * transient write error) is logged with that sessionId and skipped, never
 * aborting the fan-out — one session's failure must never cost the OTHER matching
 * sessions their events. A partial fan-out stays visible per-session in the logs.
 */
async function fanOutMachineLinkEvents(
  db: Database,
  bus: EventBus,
  observability: Observability | undefined,
  workspaceId: string,
  enrollmentId: string,
  build: (activeTurnId: string) => AppendEventInput[],
): Promise<void> {
  const sessions = await sessionsWithActiveOpOnEnrollment(db, { workspaceId, enrollmentId });
  for (const session of sessions) {
    try {
      await appendAndPublishEvents(
        db,
        bus,
        workspaceId,
        session.sessionId,
        build(session.activeTurnId),
      );
    } catch (error) {
      observability?.warn?.("Failed to fan out a machine-link event to a session", {
        workspaceId,
        sessionId: session.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Decode a raw `AgentEvent` payload + ingest it (the per-message handler). A
 * heartbeat carrying a metrics sample is ingested; a going-offline records the
 * machine-plane marker + fans out the link-plane session events. Decode failures
 * are reported + swallowed. `bus` (when present) enables the session-event
 * fan-out; the live consumer always supplies it, pure unit tests may omit it.
 */
export async function handleAgentEventPayload(
  db: Database,
  observability: Observability | undefined,
  payload: Uint8Array,
  subject: string,
  bus?: EventBus,
): Promise<void> {
  const ids = parseAgentEventSubject(subject);
  if (!ids) {
    return;
  }
  let event: AgentEvent;
  try {
    event = AgentEvent.decode(payload);
  } catch (error) {
    observability?.warn?.("Failed to decode an agent event for metrics ingestion", {
      subject,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  // A clean GoingOffline is the machine-plane's typed shutdown signal. Two things
  // happen, in this order:
  //   1. Record it ALWAYS on the machine plane (a Prometheus counter keyed by the
  //      typed reason) so a fleet operator can see clean stops / self-updates /
  //      host shutdowns. This fires unconditionally, independent of the DB.
  //   2. Stamp the enrollment's clean going-offline marker so the liveness
  //      derivation reads the machine OFFLINE immediately instead of waiting out
  //      the last_seen dead-detect window. Best-effort + fail-soft (like the rest
  //      of this module): an unknown enrollment is a no-op and a DB error is
  //      swallowed so a bad write never tears down the consumer. Deliberately does
  //      NOT touch last-seen (a shutdown must not look "more recently alive").
  if (event.event?.$case === "goingOffline") {
    const reason = goingOfflineReasonToJSON(event.event.goingOffline.reason);
    observability?.incrementCounter({
      name: "opengeni_machine_going_offline_total",
      help: "Total Connected Machine clean GoingOffline signals by typed reason.",
      labels: { reason },
    });
    try {
      const enrollment = await getEnrollment(db, ids.workspaceId, ids.agentId);
      if (enrollment) {
        const released = await releaseEnrollmentConnection(db, {
          accountId: enrollment.accountId,
          workspaceId: ids.workspaceId,
          enrollmentId: ids.agentId,
          connectionInstanceId: ids.connectionInstanceId,
          reason,
        });
        // A late goodbye from a superseded process is not the current machine
        // going offline. It must not disconnect browsers or fan out link loss.
        if (!released.released) return;
        try {
          await disconnectAttachedBrowserDevices(db, {
            accountId: enrollment.accountId,
            workspaceId: ids.workspaceId,
            enrollmentId: ids.agentId,
          });
        } catch (error) {
          observability?.warn?.("Failed to disconnect attached browsers with their machine", {
            subject,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        // Fan out the link-plane events to the sessions with an active op on this
        // machine: machine.link.lost (its control link is going away) for every
        // clean going-offline, PLUS machine.runner.restarted when the reason is a
        // self-update restart specifically (link.lost fires for it too; this
        // distinguishes a restart from a plain stop / host shutdown).
        if (bus) {
          const isSelfUpdate =
            event.event.goingOffline.reason === GoingOfflineReason.GOING_OFFLINE_REASON_UPDATE;
          await fanOutMachineLinkEvents(
            db,
            bus,
            observability,
            ids.workspaceId,
            ids.agentId,
            (activeTurnId) => {
              const events: AppendEventInput[] = [
                { type: "machine.link.lost", turnId: activeTurnId, payload: { reason } },
              ];
              if (isSelfUpdate) {
                events.push({
                  type: "machine.runner.restarted",
                  turnId: activeTurnId,
                  payload: {},
                });
              }
              return events;
            },
          );
        }
      }
    } catch (error) {
      observability?.warn?.("Failed to record a machine clean going-offline", {
        subject,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }
  if (event.event?.$case === "agentUpdateProgress") {
    const enrollment = await getEnrollment(db, ids.workspaceId, ids.agentId).catch(() => null);
    if (!enrollment || enrollment.connectionInstanceId !== ids.connectionInstanceId) return;
    const progress = event.event.agentUpdateProgress;
    const status = (() => {
      switch (progress.stage) {
        case AgentUpdateStage.AGENT_UPDATE_STAGE_ACCEPTED:
          return "accepted" as const;
        case AgentUpdateStage.AGENT_UPDATE_STAGE_WAITING_FOR_IDLE:
          return "waiting_for_idle" as const;
        case AgentUpdateStage.AGENT_UPDATE_STAGE_DOWNLOADING:
          return "downloading" as const;
        case AgentUpdateStage.AGENT_UPDATE_STAGE_VERIFYING:
          return "verifying" as const;
        case AgentUpdateStage.AGENT_UPDATE_STAGE_APPLYING:
          return "applying" as const;
        case AgentUpdateStage.AGENT_UPDATE_STAGE_RESTARTING:
          return "restarting" as const;
        case AgentUpdateStage.AGENT_UPDATE_STAGE_FAILED:
          return "failed" as const;
        default:
          return null;
      }
    })();
    if (!status) return;
    try {
      await advanceEnrollmentAgentUpdate(db, {
        accountId: enrollment.accountId,
        workspaceId: ids.workspaceId,
        enrollmentId: ids.agentId,
        connectionInstanceId: ids.connectionInstanceId,
        connectionGeneration: enrollment.connectionGeneration,
        operationId: progress.operationId,
        status,
        expectedBinarySha256: /^[0-9a-f]{64}$/.test(progress.expectedBinarySha256)
          ? progress.expectedBinarySha256
          : null,
        errorCode: progress.errorCode || null,
        retryable: progress.retryable,
        rolledBack: progress.rolledBack,
      });
    } catch (error) {
      observability?.warn?.("Failed to ingest a machine self-update progress event", {
        subject,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }
  if (event.event?.$case !== "heartbeat") {
    return; // an unknown event kind → not a metrics point.
  }
  const heartbeat = event.event.heartbeat;
  const enrollment = await getEnrollment(db, ids.workspaceId, ids.agentId).catch(() => null);
  if (!enrollment || enrollment.connectionInstanceId !== ids.connectionInstanceId) return;
  try {
    const renewed = await renewEnrollmentConnection(db, {
      accountId: enrollment.accountId,
      workspaceId: ids.workspaceId,
      enrollmentId: ids.agentId,
      connectionInstanceId: ids.connectionInstanceId,
      leaseMs: AGENT_CONNECTION_LEASE_MS,
    });
    if (!renewed.renewed) return;
  } catch (error) {
    observability?.warn?.("Failed to renew a machine connection heartbeat", {
      subject,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  if (heartbeat.attachedBrowserInventory) {
    try {
      await ingestAttachedBrowserInventory(db, {
        workspaceId: ids.workspaceId,
        agentId: ids.agentId,
        inventory: heartbeat.attachedBrowserInventory,
      });
    } catch (error) {
      observability?.warn?.("Failed to ingest an attached-browser inventory", {
        subject,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const metrics = heartbeat.metrics;
  if (!metrics) return;
  try {
    await ingestHeartbeatMetrics(db, {
      accountId: enrollment.accountId,
      workspaceId: ids.workspaceId,
      agentId: ids.agentId,
      sample: metrics,
    });
  } catch (error) {
    observability?.warn?.("Failed to ingest a machine metrics heartbeat", {
      subject,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Start the metrics-ingestion consumer: subscribe exact process events and ingest
 * every heartbeat. Gated by sandboxSelfhostedEnabled (the caller checks the flag;
 * a disabled deployment never starts the consumer). Returns the unsubscribe fn.
 */
export function startMetricsIngestion(deps: {
  db: Database;
  bus: EventBus;
  observability?: Observability;
}): () => void {
  return deps.bus.subscribeAgentEvents(AGENT_EVENTS_SUBJECT, (payload, subject) =>
    handleAgentEventPayload(deps.db, deps.observability, payload, subject, deps.bus),
  );
}

// ── Connect-Hello display refresh ─────────────────────────────────────────────

/**
 * The LIVE display presence the agent's Hello reports: a desktop framebuffer is
 * available (`capabilities.desktop`, which the agent sets true only when a display
 * probes AND it can stream it) OR a `Display` detail is present. An unset
 * Capabilities (or a headless machine) → false. This is what `has_display` should
 * track, replacing the enroll-time snapshot.
 */
export function helloReportsDisplay(hello: Hello): boolean {
  const caps = hello.capabilities;
  if (!caps) {
    return false;
  }
  // A CAPTURE-BLOCKED display is NOT a usable display: a Mac reports a display but
  // withholds `desktop` and sets `desktopUnavailableReason` when Screen Recording
  // (TCC) is not granted. Treating it as "has display" is exactly how the 0.1.3
  // incident hid — the machine claimed a desktop it could not capture, so it was
  // offered for computer-use and the model saw a blank. Gate it out here (the single
  // source of truth for `has_display`, consumed by both the machine state and the
  // capability negotiation). The `display`-present fallback is preserved for every
  // other case (e.g. a relay-less agent that reports a display but not `desktop`).
  if (caps.desktopUnavailableReason) {
    return false;
  }
  return caps.desktop === true || caps.display != null;
}

/**
 * The human, actionable reason a display is present but UNUSABLE (macOS Screen
 * Recording / TCC not granted), or null when capture is permitted / the machine is
 * headless. Normalizes the proto's non-optional "" empty string to null so the DB
 * carries a clean tri-state (a real reason vs. no reason) — the Machines dashboard
 * shows "display: capture not granted" only when this is non-null.
 */
export function helloDesktopUnavailableReason(hello: Hello): string | null {
  const reason = hello.capabilities?.desktopUnavailableReason;
  return reason ? reason : null;
}

/** Whether the runner's current Hello advertises the op-stream engine. */
export function helloReportsOpStream(hello: Hello): boolean {
  return hello.capabilities?.opStream === true;
}

function helloRuntimeCapabilities(hello: Hello): Record<string, boolean> {
  const caps = hello.capabilities;
  // Absence is an older-agent/unknown signal, not a fabricated set of false claims.
  // Keep the durable cursor empty so reconnects from legacy agents remain a
  // no-op and future capability additions do not get silently fabricated.
  if (!caps) return {};
  return {
    exec: caps.exec === true,
    filesystem: caps.filesystem === true,
    git: caps.git === true,
    pty: caps.pty === true,
    desktop: caps.desktop === true,
    opStream: caps.opStream === true,
    browserBridge: caps.browserBridge === true,
    operationResourcePolicy: caps.operationResourcePolicy === true,
    operationCpuQuota: caps.operationCpuQuota === true,
  };
}

function helloCompletedUpdate(hello: Hello): {
  operationId: string;
  targetVersion: string;
  binarySha256: string;
} | null {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      hello.completedUpdateOperationId,
    ) ||
    !/^(?:v)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(hello.completedUpdateTargetVersion) ||
    !/^[0-9a-f]{64}$/.test(hello.completedUpdateBinarySha256)
  ) {
    return null;
  }
  return {
    operationId: hello.completedUpdateOperationId,
    targetVersion: hello.completedUpdateTargetVersion,
    binarySha256: hello.completedUpdateBinarySha256,
  };
}

/**
 * Reconcile `enrollments.has_display` (+ the capture-blocked reason) to what a Hello
 * reports. Resolves the enrollment (the accountId is the RLS principal + the
 * existence check + the current values). A no-change Hello short-circuits BEFORE
 * issuing any write (and the DB writer is itself change-guarded on BOTH fields as a
 * backstop), so a steady state never churns. An unknown/cross-workspace agentId is a
 * no-op.
 */
export async function refreshEnrollmentDisplay(
  db: Database,
  input: {
    workspaceId: string;
    agentId: string;
    hasDisplay: boolean;
    desktopUnavailableReason?: string | null;
    connectionInstanceId?: string;
  },
): Promise<{ updated: boolean }> {
  const desktopUnavailableReason = input.desktopUnavailableReason ?? null;
  const enrollment = await getEnrollment(db, input.workspaceId, input.agentId);
  if (!enrollment) {
    return { updated: false };
  }
  if (
    enrollment.hasDisplay === input.hasDisplay &&
    (enrollment.desktopUnavailableReason ?? null) === desktopUnavailableReason
  ) {
    // Both fields unchanged — do not even issue the UPDATE (no churn on a
    // steady-state Hello).
    return { updated: false };
  }
  return await setEnrollmentDisplayState(db, {
    accountId: enrollment.accountId,
    workspaceId: input.workspaceId,
    enrollmentId: input.agentId,
    hasDisplay: input.hasDisplay,
    desktopUnavailableReason,
    ...(input.connectionInstanceId ? { connectionInstanceId: input.connectionInstanceId } : {}),
  });
}

/**
 * Reconcile `enrollments.op_stream` to what a Hello reports. Resolves the
 * enrollment first so the accountId remains the RLS principal and so a no-change
 * Hello short-circuits BEFORE issuing any write (the DB writer is itself
 * change-guarded as a backstop). An unknown/cross-workspace agentId is a no-op.
 */
export async function refreshEnrollmentOpStream(
  db: Database,
  input: {
    workspaceId: string;
    agentId: string;
    opStream: boolean;
    connectionInstanceId?: string;
  },
): Promise<{ updated: boolean }> {
  const enrollment = await getEnrollment(db, input.workspaceId, input.agentId);
  if (!enrollment) {
    return { updated: false };
  }
  if (enrollment.opStream === input.opStream) {
    // The capability is unchanged — do not even issue the UPDATE (no churn on a
    // steady-state Hello).
    return { updated: false };
  }
  return await setEnrollmentOpStreamState(db, {
    accountId: enrollment.accountId,
    workspaceId: input.workspaceId,
    enrollmentId: input.agentId,
    opStream: input.opStream,
    ...(input.connectionInstanceId ? { connectionInstanceId: input.connectionInstanceId } : {}),
  });
}

/**
 * Decode a raw `Hello` payload + refresh the enrollment's display cursor + clear
 * any pending clean going-offline marker and, when the reconnect actually cleared
 * one, fan out machine.link.restored to the sessions with an active op on the
 * machine (the per-message handler for the hello plane). Decode failures + write
 * failures are reported + swallowed — a Hello must NEVER break the agent's connect.
 * `bus` (when present) enables the link.restored fan-out.
 */
export async function handleHelloPayload(
  db: Database,
  observability: Observability | undefined,
  payload: Uint8Array,
  subject: string,
  bus?: EventBus,
): Promise<void> {
  const ids = parseAgentHelloSubject(subject);
  if (!ids) {
    return;
  }
  let hello: Hello;
  try {
    hello = Hello.decode(payload);
  } catch (error) {
    observability?.warn?.("Failed to decode an agent Hello for display refresh", {
      subject,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  const authority = await getLiveEnrollmentConnection(db, ids.workspaceId, ids.agentId).catch(
    () => null,
  );
  if (!authority || authority.connectionInstanceId !== ids.connectionInstanceId) {
    observability?.warn?.("Ignored a Hello from a superseded runner instance", {
      workspaceId: ids.workspaceId,
      agentId: ids.agentId,
    });
    return;
  }
  let workspaceRoot: string | undefined;
  if (hello.workspaceRoot.length > 0) {
    try {
      workspaceRoot = normalizeConnectedMachineWorkspaceRoot(hello.workspaceRoot, authority.os);
    } catch (error) {
      observability?.warn?.("Ignored an invalid Connected Machine workspace root", {
        workspaceId: ids.workspaceId,
        agentId: ids.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  try {
    await refreshEnrollmentDisplay(db, {
      workspaceId: ids.workspaceId,
      agentId: ids.agentId,
      hasDisplay: helloReportsDisplay(hello),
      desktopUnavailableReason: helloDesktopUnavailableReason(hello),
      connectionInstanceId: ids.connectionInstanceId,
    });
    await refreshEnrollmentOpStream(db, {
      workspaceId: ids.workspaceId,
      agentId: ids.agentId,
      opStream: helloReportsOpStream(hello),
      connectionInstanceId: ids.connectionInstanceId,
    });
    await setEnrollmentAgentRuntime(db, {
      accountId: authority.accountId,
      workspaceId: ids.workspaceId,
      enrollmentId: ids.agentId,
      connectionInstanceId: ids.connectionInstanceId,
      agentVersion: hello.agentVersion.trim() || null,
      binarySha256: /^[0-9a-f]{64}$/.test(hello.binarySha256) ? hello.binarySha256 : null,
      updateChannel:
        hello.updateChannel === "stable" || hello.updateChannel === "beta"
          ? hello.updateChannel
          : null,
      capabilities: helloRuntimeCapabilities(hello),
      ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
      completedUpdate: helloCompletedUpdate(hello),
    });
  } catch (error) {
    observability?.warn?.("Failed to refresh an enrollment's capabilities from a Hello", {
      subject,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  // A reconnect Hello re-announces the machine, so any pending clean going-offline
  // marker no longer holds — clear it so the liveness derivation stops reading the
  // machine offline. Best-effort + fail-soft, and change-guarded in the DB (a
  // steady-state Hello with no marker writes nothing), so this never breaks the
  // agent's connect and never churns. When a marker was ACTUALLY cleared (the
  // machine had been reported link.lost), fan out machine.link.restored to the
  // sessions with an active op on it — a restored only ever pairs a prior lost, so
  // a routine connect Hello (no marker) emits nothing.
  try {
    const { cleared } = await clearEnrollmentWentOffline(db, {
      accountId: authority.accountId,
      workspaceId: ids.workspaceId,
      enrollmentId: ids.agentId,
      connectionInstanceId: ids.connectionInstanceId,
    });
    if (cleared && bus) {
      await fanOutMachineLinkEvents(
        db,
        bus,
        observability,
        ids.workspaceId,
        ids.agentId,
        (activeTurnId) => [{ type: "machine.link.restored", turnId: activeTurnId, payload: {} }],
      );
    }
  } catch (error) {
    observability?.warn?.("Failed to clear a machine going-offline marker on a Hello", {
      subject,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Start the Hello display-refresh consumer: subscribe exact process hellos and
 * reconcile `has_display` to the live capability the agent reports on every
 * connect. Gated by sandboxSelfhostedEnabled (the caller checks the flag). Returns
 * the unsubscribe fn.
 */
export function startHelloIngestion(deps: {
  db: Database;
  bus: EventBus;
  observability?: Observability;
}): () => void {
  return deps.bus.subscribeAgentEvents(AGENT_HELLO_SUBJECT, (payload, subject) =>
    handleHelloPayload(deps.db, deps.observability, payload, subject, deps.bus),
  );
}
