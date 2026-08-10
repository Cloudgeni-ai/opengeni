import {
  PublishEditableArtifactReceiptSchema,
  type PublishEditableArtifactReceipt,
} from "@opengeni/contracts/editable-artifact-publication-receipt";

import type { SessionEvent } from "./types";

export type { PublishEditableArtifactReceipt };

export type EditableArtifactPublication = Readonly<{
  receipt: PublishEditableArtifactReceipt;
  eventId: string;
  sequence: number;
  occurredAt: string;
}>;

/** Parse the closed durable receipt emitted by `publish_editable_artifact`. */
export function parseEditableArtifactPublicationReceipt(
  value: unknown,
): PublishEditableArtifactReceipt | null {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  const parsed = PublishEditableArtifactReceiptSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * Project the durable editable artifacts published in a session event window.
 *
 * The receipt is a closed, self-identifying contract, so its output can be
 * projected without retaining the corresponding tool-call input. Duplicate or
 * replayed outputs collapse by artifact id while the newest sequence wins.
 */
export function projectEditableArtifactPublications(
  events: readonly SessionEvent[],
  workspaceId?: string,
  sessionId?: string,
): EditableArtifactPublication[] {
  const publications = new Map<string, EditableArtifactPublication>();
  for (const event of events) {
    if (event.type !== "agent.toolCall.output") continue;
    if (workspaceId !== undefined && event.workspaceId !== workspaceId) continue;
    if (sessionId !== undefined && event.sessionId !== sessionId) continue;

    const payload = record(event.payload);
    if (!payload || payload.error === true || payload.isError === true) continue;
    const receipt =
      parseEditableArtifactPublicationReceipt(payload.output) ??
      parseEditableArtifactPublicationReceipt(payload.preview);
    if (!receipt) continue;

    const expectedEditorPath = `/workspaces/${event.workspaceId}/artifacts/editable/${receipt.artifact.id}`;
    if (receipt.editorPath !== expectedEditorPath) continue;

    const current = publications.get(receipt.artifact.id);
    if (current && current.sequence > event.sequence) continue;
    publications.set(
      receipt.artifact.id,
      Object.freeze({
        receipt,
        eventId: event.id,
        sequence: event.sequence,
        occurredAt: event.occurredAt,
      }),
    );
  }
  return [...publications.values()].sort((left, right) => left.sequence - right.sequence);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
