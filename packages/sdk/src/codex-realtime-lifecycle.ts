import type { SessionEvent } from "./types";

export type SessionRealtimeLifecycleProjection =
  | {
      state: "active";
      realtimeId: string;
      operationId: string;
      version: number;
      connectionEpoch: number;
      leaseExpiresAt: string;
    }
  | {
      state: "ended";
      realtimeId: string;
      operationId: string;
      version: number;
      connectionEpoch: number;
      reason: "user_stop" | "browser_unload" | "lease_expired";
    };

export function projectSessionRealtimeLifecycle(
  events: ReadonlyArray<Pick<SessionEvent, "sequence" | "type" | "payload">>,
): SessionRealtimeLifecycleProjection | null {
  let projected: SessionRealtimeLifecycleProjection | null = null;
  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    const payload = recordValue(event.payload);
    if (event.type === "session.realtime.started") {
      const realtimeId = stringValue(payload?.realtimeId);
      const operationId = stringValue(payload?.operationId);
      const version = positiveInteger(payload?.version);
      const connectionEpoch = positiveInteger(payload?.connectionEpoch);
      const leaseExpiresAt = stringValue(payload?.leaseExpiresAt);
      if (realtimeId && operationId && version && connectionEpoch && leaseExpiresAt) {
        projected = {
          state: "active",
          realtimeId,
          operationId,
          version,
          connectionEpoch,
          leaseExpiresAt,
        };
      }
    } else if (event.type === "session.realtime.ended") {
      const realtimeId = stringValue(payload?.realtimeId);
      const operationId = stringValue(payload?.operationId);
      const version = positiveInteger(payload?.version);
      const connectionEpoch = positiveInteger(payload?.connectionEpoch);
      const reason = endReason(payload?.reason);
      if (realtimeId && operationId && version && connectionEpoch && reason) {
        projected = {
          state: "ended",
          realtimeId,
          operationId,
          version,
          connectionEpoch,
          reason,
        };
      }
    }
  }
  return projected;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function endReason(value: unknown): "user_stop" | "browser_unload" | "lease_expired" | null {
  return value === "user_stop" || value === "browser_unload" || value === "lease_expired"
    ? value
    : null;
}
