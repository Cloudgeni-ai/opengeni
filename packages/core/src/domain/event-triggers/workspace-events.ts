import type { EventTypeDescriptor, RecordingEventType } from "@opengeni/contracts";
import { oneLine, type NormalizedEventInput } from "./normalize";

/**
 * Things that happen in Opengeni itself as automation events, for the
 * "This workspace" source. Today these are the meeting recording facts that
 * workspace webhooks also send. The event's data is what a webhook receives
 * (ids, states and counts, never transcript text) plus the recording's
 * title, which the reading person may see, and whether that person recorded
 * it. A browser recording is one an agent made, and notes an agent saved name
 * its chat, so those events count as Opengeni's own.
 */

/** One recording fact as the feed keeps it in a delivery body. */
export type WorkspaceRecordingFact = {
  id: string;
  recordingId: string;
  type: string;
  data: Record<string, unknown>;
  occurredAt: string;
  title: string | null;
  purpose: string | null;
};

type CatalogEntry = { description: string; summary: string };

/** Every recording event type, so a new one can't be left out of the source. */
const RECORDING_TYPES: Record<RecordingEventType, CatalogEntry> = {
  "recording.started": { description: "A recording started", summary: "Recording started" },
  "recording.finished": {
    description: "A recording finished",
    summary: "Recording finished",
  },
  "recording.transcript.ready": {
    description: "A recording's transcript is ready to read",
    summary: "Transcript ready",
  },
  "recording.transcript.failed": {
    description: "A recording's transcript could not be made",
    summary: "Transcript failed",
  },
  "recording.transcript.current_changed": {
    description: "A recording's current transcript was replaced",
    summary: "Transcript replaced",
  },
  "recording.speakers.updated": {
    description: "Who spoke in a recording was changed",
    summary: "Speakers updated",
  },
  "recording.notes.updated": {
    description: "A meeting's notes were saved, by a person or an agent",
    summary: "Notes saved",
  },
  "recording.deleted": {
    description: "A recording was deleted",
    summary: "Recording deleted",
  },
};

const RECORDING_FIELDS: Array<[string, string]> = [
  ["data.title", "The recording's title"],
  ["data.purpose", "meeting, or browser for a browser tab an agent recorded"],
  ["data.recordingId", "The recording, for the meeting tools"],
  ["data.visibility", "private, or workspace when it is shared with the workspace"],
  ["data.ownerSubjectId", "Who recorded it"],
  ["data.recordedByYou", "true when you recorded it, false when someone shared it with you"],
  ["data.externalRef", "The id the recording app gave it, if any"],
];

/** Fields only some types carry. */
const TYPE_FIELDS: Partial<Record<RecordingEventType, Array<[string, string]>>> = {
  "recording.notes.updated": [
    ["data.noteRevision", "The notes' revision; each save adds one"],
    ["data.sessionId", "The chat whose agent saved them; null when a person did"],
  ],
};

function recordingEntry(type: string): CatalogEntry | undefined {
  return Object.hasOwn(RECORDING_TYPES, type)
    ? RECORDING_TYPES[type as RecordingEventType]
    : undefined;
}

/** The event types a "This workspace" source offers. */
export function workspaceEventTypeCatalog(): EventTypeDescriptor[] {
  return (Object.keys(RECORDING_TYPES) as RecordingEventType[]).map((type) => ({
    type,
    description: RECORDING_TYPES[type].description,
    fields: [...RECORDING_FIELDS, ...(TYPE_FIELDS[type] ?? [])].map(([field, description]) => ({
      field,
      description,
    })),
    argumentsSchema: null,
    available: true,
    unavailableReason: null,
  }));
}

/** Opengeni made it: an agent's browser recording, or notes an agent saved. */
function madeByOpengeni(fact: WorkspaceRecordingFact): boolean {
  if (fact.purpose === "browser") return true;
  return fact.type === "recording.notes.updated" && typeof fact.data.sessionId === "string";
}

/**
 * One recording fact as a normalized event for the person whose source read
 * it: `viewerSubjectId` is that source's owner.
 */
export function workspaceRecordingEvent(
  fact: WorkspaceRecordingFact,
  viewerSubjectId: string | null,
): NormalizedEventInput {
  const what = recordingEntry(fact.type)?.summary ?? fact.type;
  const title = fact.title ? oneLine(fact.title, 300) : null;
  return {
    externalId: fact.id,
    type: fact.type,
    occurredAt: new Date(fact.occurredAt),
    subject: title,
    summary: title ? `${what}: ${title}` : what,
    url: null,
    actor: { kind: madeByOpengeni(fact) ? "opengeni" : "unknown", name: null },
    data: {
      ...fact.data,
      recordingId: fact.recordingId,
      ...(title ? { title } : {}),
      ...(fact.purpose ? { purpose: fact.purpose } : {}),
      recordedByYou: viewerSubjectId !== null && fact.data.ownerSubjectId === viewerSubjectId,
    },
  };
}

export function workspaceDeliveryBody(facts: readonly WorkspaceRecordingFact[]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ recordingEvents: facts }));
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The events a stored "This workspace" delivery carries, to replay it for its source's owner. */
export function workspaceDeliveryEvents(
  body: Uint8Array,
  viewerSubjectId: string | null,
): NormalizedEventInput[] {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return [];
  }
  const facts =
    value &&
    typeof value === "object" &&
    Array.isArray((value as { recordingEvents?: unknown }).recordingEvents)
      ? ((value as { recordingEvents: unknown[] }).recordingEvents ?? [])
      : [];
  return facts.flatMap((entry) => {
    const fact = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null;
    const id = text(fact?.id);
    const recordingId = text(fact?.recordingId);
    const type = text(fact?.type);
    const occurredAt = text(fact?.occurredAt);
    if (
      !fact ||
      !id ||
      !recordingId ||
      !type ||
      !occurredAt ||
      Number.isNaN(Date.parse(occurredAt))
    ) {
      return [];
    }
    const data =
      fact.data && typeof fact.data === "object" && !Array.isArray(fact.data)
        ? (fact.data as Record<string, unknown>)
        : {};
    return [
      workspaceRecordingEvent(
        {
          id,
          recordingId,
          type,
          data,
          occurredAt,
          title: text(fact.title),
          purpose: text(fact.purpose),
        },
        viewerSubjectId,
      ),
    ];
  });
}
