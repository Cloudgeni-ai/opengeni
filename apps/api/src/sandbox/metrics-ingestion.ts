// apps/api/src/sandbox/metrics-ingestion.ts — the M10 metrics INGESTION consumer
// (dossier §10.7 + §10.6). The enrolled agent piggybacks a `MetricsSample` on its
// ~5s heartbeat (an `AgentEvent` published one-way on `agent.<ws>.<id>.events`).
// This consumer subscribes the wildcard `agent.*.*.events`, decodes the
// AgentEvent, and on each HEARTBEAT:
//   1. touchEnrollmentLastSeen  — the liveness cursor (online/reconnecting/offline
//      derivation + the M3 probe disambiguation).
//   2. ingestMachineMetricsSample — UPSERT machine_metrics_latest (the "now" row)
//      + APPEND a machine_metrics_series row downsampled to ~1/min.
// A GOING-OFFLINE event is not a metrics point — liveness flips via the lease/
// probe path; we simply skip it here (no-op).
//
// Ingestion is BEST-EFFORT and fail-soft: a decode/DB error for one event is
// logged + swallowed (the bus subscription already swallows handler throws) so a
// metrics blip never tears down the consumer or back-pressures the agent.

import {
  getEnrollment,
  ingestMachineMetricsSample,
  touchEnrollmentLastSeen,
  type Database,
  type MachineMetricsSample,
} from "@opengeni/db";
import type { EventBus } from "@opengeni/events";
import type { Observability } from "@opengeni/observability";
import { AgentEvent, type MetricsSample } from "@opengeni/agent-proto";

/** The wildcard subject the agent event plane publishes heartbeats on. */
export const AGENT_EVENTS_SUBJECT = "agent.*.*.events";

/**
 * Parse `agent.<ws>.<id>.events` → `{ workspaceId, agentId }`. Returns null for a
 * subject that does not match the shape (defensive — the subscription pattern
 * already constrains it).
 */
export function parseAgentEventSubject(subject: string): { workspaceId: string; agentId: string } | null {
  const parts = subject.split(".");
  if (parts.length !== 4 || parts[0] !== "agent" || parts[3] !== "events") {
    return null;
  }
  return { workspaceId: parts[1]!, agentId: parts[2]! };
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
    sampledAt: wire.sampledAtMs && Number(wire.sampledAtMs) > 0 ? new Date(Number(wire.sampledAtMs)) : new Date(),
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
 * Decode a raw `AgentEvent` payload + ingest it (the per-message handler). A
 * heartbeat carrying a metrics sample is ingested; a going-offline (or a
 * heartbeat without metrics) is a no-op. Decode failures are reported + swallowed.
 */
export async function handleAgentEventPayload(
  db: Database,
  observability: Observability | undefined,
  payload: Uint8Array,
  subject: string,
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
  if (event.event?.$case !== "heartbeat") {
    return; // going-offline / unknown → not a metrics point.
  }
  const metrics = event.event.heartbeat.metrics;
  if (!metrics) {
    return; // a heartbeat without a sample → liveness already touched elsewhere.
  }
  try {
    await ingestHeartbeat(db, { workspaceId: ids.workspaceId, agentId: ids.agentId, sample: metrics });
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
    handleAgentEventPayload(deps.db, deps.observability, payload, subject),
  );
}
