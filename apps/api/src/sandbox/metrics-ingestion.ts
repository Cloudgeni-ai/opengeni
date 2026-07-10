// apps/api/src/sandbox/metrics-ingestion.ts — the M10 metrics INGESTION consumer
// (dossier §10.7 + §10.6) + the connect-Hello DISPLAY-REFRESH consumer. The
// enrolled agent piggybacks a `MetricsSample` on its ~5s heartbeat (an
// `AgentEvent` published one-way on `agent.<ws>.<id>.events`) and publishes a
// `Hello` (its live self-description) on `agent.<ws>.<id>.hello` on every connect
// /reconnect. This module owns the two agent→control-plane inbound consumers:
//
//   `agent.*.*.events` (heartbeat) →
//     1. touchEnrollmentLastSeen  — the liveness cursor (online/reconnecting/offline
//        derivation + the M3 probe disambiguation).
//     2. ingestMachineMetricsSample — UPSERT machine_metrics_latest (the "now" row)
//        + APPEND a machine_metrics_series row downsampled to ~1/min.
//     A GOING-OFFLINE event is not a metrics point — liveness flips via the lease/
//     probe path; we skip it here (no-op).
//
//   `agent.*.*.hello` (connect) →
//     refreshEnrollmentDisplay — reconcile `enrollments.has_display` to the LIVE
//     capability the Hello reports. `has_display` was previously FROZEN at the
//     enroll-time offer snapshot; a machine that GAINS a display later (a Mac that
//     grants Screen Recording, a box whose Xvfb starts) or LOSES one never
//     re-surfaced. Consuming the Hello's `capabilities.desktop` / `display` makes
//     `has_display` track reality (both directions), which the desktop-capability
//     gate (packages/runtime capabilities.ts) keys off.
//
// Both consumers are BEST-EFFORT and fail-soft: a decode/DB error for one message
// is logged + swallowed (the bus subscription already swallows handler throws) so
// a metrics blip / a display-refresh write failure never tears down the consumer,
// back-pressures the agent, or breaks its connect.

import {
  clearEnrollmentWentOffline,
  getEnrollment,
  ingestMachineMetricsSample,
  sessionsWithActiveOpOnEnrollment,
  setEnrollmentDisplayState,
  setEnrollmentWentOffline,
  touchEnrollmentLastSeen,
  type AppendEventInput,
  type Database,
  type MachineMetricsSample,
} from "@opengeni/db";
import { appendAndPublishEvents, type EventBus } from "@opengeni/events";
import type { Observability } from "@opengeni/observability";
import {
  AgentEvent,
  GoingOfflineReason,
  Hello,
  goingOfflineReasonToJSON,
  type MetricsSample,
} from "@opengeni/agent-proto";

/** The wildcard subject the agent event plane publishes heartbeats on. */
export const AGENT_EVENTS_SUBJECT = "agent.*.*.events";

/** The wildcard subject the agent publishes its connect Hello on. */
export const AGENT_HELLO_SUBJECT = "agent.*.*.hello";

/**
 * Parse `agent.<ws>.<id>.<tail>` → `{ workspaceId, agentId }`, requiring the
 * expected tail token. Returns null for a subject that does not match the shape
 * (defensive — the subscription pattern already constrains it).
 */
function parseAgentSubject(
  subject: string,
  tail: "events" | "hello",
): { workspaceId: string; agentId: string } | null {
  const parts = subject.split(".");
  if (parts.length !== 4 || parts[0] !== "agent" || parts[3] !== tail) {
    return null;
  }
  return { workspaceId: parts[1]!, agentId: parts[2]! };
}

/** Parse `agent.<ws>.<id>.events` → `{ workspaceId, agentId }` (heartbeat plane). */
export function parseAgentEventSubject(
  subject: string,
): { workspaceId: string; agentId: string } | null {
  return parseAgentSubject(subject, "events");
}

/** Parse `agent.<ws>.<id>.hello` → `{ workspaceId, agentId }` (connect plane). */
export function parseAgentHelloSubject(
  subject: string,
): { workspaceId: string; agentId: string } | null {
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

/**
 * Ingest ONE decoded heartbeat for an enrolled machine. Resolves the enrollment's
 * accountId (needed for the RLS-scoped writes) from the enrollment row; an
 * unknown/cross-workspace agentId is ignored (no row → no write). Touches
 * last-seen + upserts latest + downsamples the series.
 */
export async function ingestHeartbeat(
  db: Database,
  input: { workspaceId: string; agentId: string; sample: MetricsSample },
): Promise<{ ingested: boolean; seriesAppended: boolean }> {
  // The enrollment row is the source of the accountId (the RLS principal) and the
  // existence check. A revoked machine still reports its accountId, so we ingest
  // (the dashboard shows its last sample); a truly unknown id is a no-op.
  const enrollment = await getEnrollment(db, input.workspaceId, input.agentId);
  if (!enrollment) {
    return { ingested: false, seriesAppended: false };
  }
  const sample = wireSampleToDbSample(input.sample);
  await touchEnrollmentLastSeen(db, {
    accountId: enrollment.accountId,
    workspaceId: input.workspaceId,
    enrollmentId: input.agentId,
  });
  const result = await ingestMachineMetricsSample(db, {
    accountId: enrollment.accountId,
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
 */
async function fanOutMachineLinkEvents(
  db: Database,
  bus: EventBus,
  workspaceId: string,
  enrollmentId: string,
  build: (activeTurnId: string) => AppendEventInput[],
): Promise<void> {
  const sessions = await sessionsWithActiveOpOnEnrollment(db, { workspaceId, enrollmentId });
  for (const session of sessions) {
    await appendAndPublishEvents(
      db,
      bus,
      workspaceId,
      session.sessionId,
      build(session.activeTurnId),
    );
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
        await setEnrollmentWentOffline(db, {
          accountId: enrollment.accountId,
          workspaceId: ids.workspaceId,
          enrollmentId: ids.agentId,
          reason,
        });
        // Fan out the link-plane events to the sessions with an active op on this
        // machine: machine.link.lost (its control link is going away) for every
        // clean going-offline, PLUS machine.runner.restarted when the reason is a
        // self-update restart specifically (link.lost fires for it too; this
        // distinguishes a restart from a plain stop / host shutdown).
        if (bus) {
          const isSelfUpdate =
            event.event.goingOffline.reason === GoingOfflineReason.GOING_OFFLINE_REASON_UPDATE;
          await fanOutMachineLinkEvents(db, bus, ids.workspaceId, ids.agentId, (activeTurnId) => {
            const events: AppendEventInput[] = [
              { type: "machine.link.lost", turnId: activeTurnId, payload: { reason } },
            ];
            if (isSelfUpdate) {
              events.push({ type: "machine.runner.restarted", turnId: activeTurnId, payload: {} });
            }
            return events;
          });
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
  if (event.event?.$case !== "heartbeat") {
    return; // an unknown event kind → not a metrics point.
  }
  const metrics = event.event.heartbeat.metrics;
  if (!metrics) {
    return; // a heartbeat without a sample → liveness already touched elsewhere.
  }
  try {
    await ingestHeartbeat(db, {
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
 * Start the metrics-ingestion consumer: subscribe `agent.*.*.events` and ingest
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
  try {
    await refreshEnrollmentDisplay(db, {
      workspaceId: ids.workspaceId,
      agentId: ids.agentId,
      hasDisplay: helloReportsDisplay(hello),
      desktopUnavailableReason: helloDesktopUnavailableReason(hello),
    });
  } catch (error) {
    observability?.warn?.("Failed to refresh an enrollment's display from a Hello", {
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
    const enrollment = await getEnrollment(db, ids.workspaceId, ids.agentId);
    if (enrollment) {
      const { cleared } = await clearEnrollmentWentOffline(db, {
        accountId: enrollment.accountId,
        workspaceId: ids.workspaceId,
        enrollmentId: ids.agentId,
      });
      if (cleared && bus) {
        await fanOutMachineLinkEvents(db, bus, ids.workspaceId, ids.agentId, (activeTurnId) => [
          { type: "machine.link.restored", turnId: activeTurnId, payload: {} },
        ]);
      }
    }
  } catch (error) {
    observability?.warn?.("Failed to clear a machine going-offline marker on a Hello", {
      subject,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Start the Hello display-refresh consumer: subscribe `agent.*.*.hello` and
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
