import type { WorkspaceControlEvent, WorkspaceControlEventTruncation } from "./index";
import { sessionEventJsonBytes } from "./event-preview";
export const WORKSPACE_CONTROL_REASON_MAX_BYTES = 8 * 1024;

export const WORKSPACE_CONTROL_ACTOR_MAX_BYTES = 1024;

export const WORKSPACE_CONTROL_EVENT_MAX_BYTES = 16 * 1024;

export type WorkspaceControlBoundarySurface = WorkspaceControlEventTruncation["surface"];

export type BoundWorkspaceControlEventOptions = {
  surface?: WorkspaceControlBoundarySurface;
  reasonOriginalBytes?: number | null;
  actorOriginalBytes?: number | null;
};

/** UTF-8 byte count used by workspace-control storage and transport guards. */
export function workspaceControlUtf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * Canonical bounded invalidation event. The event is not a full evidence store:
 * when a producer or legacy row exceeds a field cap, the retained head carries
 * a visible marker and structured exact byte-loss facts.
 */
export function boundWorkspaceControlEvent(
  event: WorkspaceControlEvent,
  options: BoundWorkspaceControlEventOptions = {},
): WorkspaceControlEvent {
  const existingFields = new Map(
    (event.truncation?.fields ?? []).map((field) => [field.field, field] as const),
  );
  const reason =
    event.reason === null
      ? null
      : boundWorkspaceControlText(event.reason, WORKSPACE_CONTROL_REASON_MAX_BYTES);
  const actor = boundWorkspaceControlText(event.actor, WORKSPACE_CONTROL_ACTOR_MAX_BYTES);
  const reasonBytes = reason === null ? 0 : workspaceControlUtf8Bytes(reason);
  const actorBytes = workspaceControlUtf8Bytes(actor);
  const reasonOriginalBytes =
    event.reason === null
      ? null
      : Math.max(
          workspaceControlUtf8Bytes(event.reason),
          normalizedWorkspaceControlOriginalBytes(options.reasonOriginalBytes),
          existingFields.get("reason")?.originalBytes ?? 0,
        );
  const actorOriginalBytes = Math.max(
    workspaceControlUtf8Bytes(event.actor),
    normalizedWorkspaceControlOriginalBytes(options.actorOriginalBytes),
    existingFields.get("actor")?.originalBytes ?? 0,
  );
  const fields: WorkspaceControlEventTruncation["fields"] = [];
  if (reasonOriginalBytes !== null && reasonOriginalBytes > reasonBytes) {
    fields.push({
      field: "reason",
      originalBytes: reasonOriginalBytes,
      deliveredBytes: reasonBytes,
      omittedBytes: reasonOriginalBytes - reasonBytes,
    });
  }
  if (actorOriginalBytes > actorBytes) {
    fields.push({
      field: "actor",
      originalBytes: actorOriginalBytes,
      deliveredBytes: actorBytes,
      omittedBytes: actorOriginalBytes - actorBytes,
    });
  }
  if (fields.length === 0 && event.truncation == null) {
    if (sessionEventJsonBytes(event) > WORKSPACE_CONTROL_EVENT_MAX_BYTES) {
      throw new RangeError("Workspace control event exceeds its bounded envelope");
    }
    return event;
  }

  const truncation: WorkspaceControlEventTruncation = {
    truncated: true,
    surface: event.truncation?.surface ?? options.surface ?? "durable_control",
    deliveredBytes: 0,
    fields,
    fullEvidence: { available: false, reason: "not_retained" },
  };
  const bounded: WorkspaceControlEvent = {
    ...event,
    reason,
    actor,
    truncation,
  };
  settleWorkspaceControlDeliveredBytes(bounded, truncation);
  const deliveredBytes = sessionEventJsonBytes(bounded);
  if (deliveredBytes > WORKSPACE_CONTROL_EVENT_MAX_BYTES) {
    throw new RangeError(
      `Bounded workspace control event exceeds its final envelope (${deliveredBytes} > ${WORKSPACE_CONTROL_EVENT_MAX_BYTES} bytes)`,
    );
  }
  return bounded;
}

function boundWorkspaceControlText(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  const marker = "…[truncated]";
  const prefixBudget = Math.max(0, maxBytes - encoder.encode(marker).byteLength);
  let prefixEnd = Math.min(prefixBudget, bytes.byteLength);
  while (prefixEnd > 0 && prefixEnd < bytes.byteLength && (bytes[prefixEnd]! & 0xc0) === 0x80) {
    prefixEnd -= 1;
  }
  return `${decoder.decode(bytes.subarray(0, prefixEnd))}${marker}`;
}

function normalizedWorkspaceControlOriginalBytes(value: number | null | undefined): number {
  return value === null || value === undefined || !Number.isFinite(value)
    ? 0
    : Math.max(0, Math.floor(value));
}

function settleWorkspaceControlDeliveredBytes(
  event: WorkspaceControlEvent,
  truncation: WorkspaceControlEventTruncation,
): void {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const deliveredBytes = sessionEventJsonBytes(event);
    if (truncation.deliveredBytes === deliveredBytes) return;
    truncation.deliveredBytes = deliveredBytes;
  }
  const deliveredBytes = sessionEventJsonBytes(event);
  if (truncation.deliveredBytes !== deliveredBytes) {
    throw new RangeError("Workspace control event byte accounting did not converge");
  }
}
