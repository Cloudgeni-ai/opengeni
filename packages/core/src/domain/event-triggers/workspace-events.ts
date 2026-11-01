import {
  WORKSPACE_WEBHOOK_EVENT_TYPES,
  type EventTypeDescriptor,
  type RecordingEventType,
} from "@opengeni/contracts";
import { oneLine, type NormalizedEventInput } from "./normalize";

/**
 * Things that happen in Opengeni itself as automation events, for the
 * "This workspace" source: the types workspace webhooks send, by the same
 * names, apart from the few listed in NOT_OFFERED.
 *
 * Meeting recording facts carry what a webhook receives (ids, states and
 * counts, never transcript text) plus the recording's title, which the
 * reading person may see, and whether that person recorded it. A browser
 * recording is one an agent made, and notes an agent saved name its chat, so
 * those events count as Opengeni's own.
 *
 * Chat and usage facts come from workspace_activity_events (migration 1105):
 * a chat finished, failed, was stopped, waits for an approval, asked a
 * question or sent a notification, and usage thresholds. A chat event counts
 * as Opengeni's own when an automation run caused it, and carries that run's
 * chain depth.
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

type WorkspaceEventType = (typeof WORKSPACE_WEBHOOK_EVENT_TYPES)[number];

/**
 * Webhook types a trigger can't listen for, and why. Every webhook type is a
 * recording type, an activity type or listed here, so a new one is a
 * conscious decision.
 */
const NOT_OFFERED = {
  "session.status.changed": "Too frequent; the turn types cover what it means",
  "session.notification.withdrawn": "Only bookkeeping",
  "session.agentCall.ringing": "A call is for the phone it rings, not for automations",
  "session.agentCall.settled": "Its outcome goes back to the chat that called",
  "turn.superseded": "The new message's turn carries on the chat's work",
} as const satisfies Partial<Record<WorkspaceEventType, string>>;

type ActivityEventType = Exclude<WorkspaceEventType, RecordingEventType | keyof typeof NOT_OFFERED>;

type Field = [string, string];

const CHAT_FIELDS: Field[] = [
  ["data.sessionId", "The chat, for the chat tools"],
  ["data.turnId", "The turn in that chat"],
  ["data.chatTitle", "The chat's title"],
  [
    "data.startedByYou",
    "true when it ran for you: your own message, your agent or your own automation",
  ],
  ["data.automationId", "The automation whose run caused it; absent when a person's work did"],
  ["data.automationRunId", "That automation's run"],
];

const USAGE_FIELDS: Field[] = [
  ["data.scope", "workspace for the workspace's limit, member for one member's"],
  ["data.forYou", "true when it is about your own limit"],
  ["data.usedCredits", "Credits used in this period"],
  ["data.limitCredits", "The limit, in credits"],
  ["data.period", "The usage period"],
  ["data.periodEnd", "When the usage period ends"],
];

const THRESHOLD_FIELD: Field = [
  "data.threshold",
  "The share of the limit reached, such as 0.8; 1 is the whole limit",
];

const ACTIVITY_TYPES: Record<ActivityEventType, CatalogEntry & { fields: Field[] }> = {
  "turn.completed": {
    description: "A chat finished its work",
    summary: "Chat finished",
    fields: [
      ...CHAT_FIELDS,
      ["data.answerExcerpt", "The first 1,000 characters of the final answer"],
    ],
  },
  "turn.failed": {
    description: "A chat stopped with an error",
    summary: "Chat failed",
    fields: [
      ...CHAT_FIELDS,
      ["data.error.code", "The error's code, if it has one"],
      ["data.error.message", "A short description of the error"],
    ],
  },
  "turn.cancelled": {
    description: "Someone stopped a chat",
    summary: "Chat stopped",
    fields: [...CHAT_FIELDS, ["data.reason", "Why it was stopped, if known"]],
  },
  "session.requiresAction": {
    description: "A chat is waiting for a tool approval",
    summary: "Waiting for approval",
    fields: [...CHAT_FIELDS, ["data.tools", "The tools waiting for approval, at most 10"]],
  },
  "session.humanInput.requested": {
    description: "A chat asked a person a question",
    summary: "Asked a question",
    fields: [...CHAT_FIELDS, ["data.questions", "The questions asked, at most 5"]],
  },
  "session.notification.posted": {
    description: "An agent sent someone a notification",
    summary: "Notification sent",
    fields: [
      ...CHAT_FIELDS,
      ["data.title", "The notification's title"],
      ["data.bodyExcerpt", "The start of its text"],
      ["data.forYou", "true when it was sent to you"],
    ],
  },
  "usage.threshold_reached": {
    description: "Usage passed a configured share of a usage limit",
    summary: "Usage threshold reached",
    fields: [...USAGE_FIELDS, THRESHOLD_FIELD],
  },
  "usage.exhausted": {
    description: "A usage limit was used up",
    summary: "Usage limit used up",
    fields: [...USAGE_FIELDS, THRESHOLD_FIELD],
  },
  "usage.period_reset": {
    description: "A new usage period started",
    summary: "New usage period",
    fields: USAGE_FIELDS,
  },
};

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

function activityEntry(type: string): (CatalogEntry & { fields: Field[] }) | undefined {
  return Object.hasOwn(ACTIVITY_TYPES, type)
    ? ACTIVITY_TYPES[type as ActivityEventType]
    : undefined;
}

function offeredFields(type: WorkspaceEventType): { description: string; fields: Field[] } | null {
  const activity = activityEntry(type);
  if (activity) return { description: activity.description, fields: activity.fields };
  const recording = recordingEntry(type);
  if (!recording) return null;
  return {
    description: recording.description,
    fields: [...RECORDING_FIELDS, ...(TYPE_FIELDS[type as RecordingEventType] ?? [])],
  };
}

/** The webhook types a "This workspace" trigger can't listen for. */
export function workspaceEventTypesNotOffered(): readonly string[] {
  return Object.keys(NOT_OFFERED);
}

/** The event types a "This workspace" source offers, in the webhook list's order. */
export function workspaceEventTypeCatalog(): EventTypeDescriptor[] {
  return WORKSPACE_WEBHOOK_EVENT_TYPES.flatMap((type) => {
    const entry = offeredFields(type);
    if (!entry) return [];
    return [
      {
        type,
        description: entry.description,
        fields: entry.fields.map(([field, description]) => ({ field, description })),
        argumentsSchema: null,
        available: true,
        unavailableReason: null,
        unavailableReasonCode: null,
        unavailableReasonDetail: null,
      },
    ];
  });
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

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * One activity fact as the feed keeps it in a delivery body: the row plus
 * what the reading person saw of the chat, automation and member, and the
 * chat's address, so a replay produces the same event.
 */
export type WorkspaceActivityFact = {
  id: string;
  type: string;
  occurredAt: string;
  sessionId: string | null;
  turnId: string | null;
  subjectId: string | null;
  automationId: string | null;
  automationRunId: string | null;
  chainDepth: number;
  data: Record<string, unknown>;
  chatTitle: string | null;
  automationName: string | null;
  subjectLabel: string | null;
  url: string | null;
};

function percent(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1
    ? `${Math.round(value * 100)}%`
    : null;
}

function usageSummary(fact: WorkspaceActivityFact, mine: boolean): string {
  const whose = fact.data.scope === "workspace" ? "the workspace's" : mine ? "your" : "a member's";
  switch (fact.type) {
    case "usage.threshold_reached": {
      const share = percent(fact.data.threshold);
      return share ? `Usage reached ${share} of ${whose} limit` : `Usage reached ${whose} limit`;
    }
    case "usage.exhausted":
      return `Usage used up ${whose} limit`;
    default:
      return "A new usage period started";
  }
}

/**
 * One activity fact as a normalized event for the person whose source read
 * it: `viewerSubjectId` is that source's owner. A chat event is Opengeni's
 * own when an automation run caused it, or when Opengeni posted it outside
 * any turn (its own notices); otherwise it is the person's it ran for.
 */
export function workspaceActivityEvent(
  fact: WorkspaceActivityFact,
  viewerSubjectId: string | null,
): NormalizedEventInput {
  const mine = viewerSubjectId !== null && fact.subjectId === viewerSubjectId;
  const what = activityEntry(fact.type)?.summary ?? fact.type;
  const occurredAt = new Date(fact.occurredAt);
  if (fact.type.startsWith("usage.")) {
    return {
      externalId: fact.id,
      type: fact.type,
      occurredAt,
      subject: null,
      summary: usageSummary(fact, mine),
      url: null,
      actor: { kind: "unknown", name: null },
      data: { ...fact.data, forYou: mine },
      chainDepth: 0,
    };
  }
  const title = fact.chatTitle ? oneLine(fact.chatTitle, 300) : null;
  const byAutomation = fact.automationRunId !== null || fact.turnId === null;
  const forYou =
    fact.type === "session.notification.posted"
      ? { forYou: viewerSubjectId !== null && fact.data.recipientSubjectId === viewerSubjectId }
      : {};
  return {
    externalId: fact.id,
    type: fact.type,
    occurredAt,
    subject: title,
    summary: title ? `${what}: ${title}` : what,
    url: fact.url,
    actor: byAutomation
      ? { kind: "opengeni", name: fact.automationName }
      : { kind: "person", name: fact.subjectLabel },
    data: {
      ...fact.data,
      sessionId: fact.sessionId,
      turnId: fact.turnId,
      ...(title ? { chatTitle: title } : {}),
      startedByYou: mine,
      ...(fact.automationId ? { automationId: fact.automationId } : {}),
      ...(fact.automationRunId ? { automationRunId: fact.automationRunId } : {}),
      ...forYou,
    },
    chainDepth: fact.chainDepth,
  };
}

export function workspaceDeliveryBody(
  facts: readonly WorkspaceRecordingFact[],
  activity: readonly WorkspaceActivityFact[] = [],
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify(
      activity.length > 0
        ? { recordingEvents: facts, activityEvents: activity }
        : { recordingEvents: facts },
    ),
  );
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function activityFact(entry: unknown): WorkspaceActivityFact | null {
  const fact = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null;
  const id = text(fact?.id);
  const type = text(fact?.type);
  const occurredAt = text(fact?.occurredAt);
  if (!fact || !id || !type || !occurredAt || Number.isNaN(Date.parse(occurredAt))) return null;
  const data =
    fact.data && typeof fact.data === "object" && !Array.isArray(fact.data)
      ? (fact.data as Record<string, unknown>)
      : {};
  const depth = typeof fact.chainDepth === "number" ? fact.chainDepth : 0;
  return {
    id,
    type,
    occurredAt,
    sessionId: nullableText(fact.sessionId),
    turnId: nullableText(fact.turnId),
    subjectId: nullableText(fact.subjectId),
    automationId: nullableText(fact.automationId),
    automationRunId: nullableText(fact.automationRunId),
    chainDepth: depth,
    data,
    chatTitle: nullableText(fact.chatTitle),
    automationName: nullableText(fact.automationName),
    subjectLabel: nullableText(fact.subjectLabel),
    url: nullableText(fact.url),
  };
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
  const activity =
    value &&
    typeof value === "object" &&
    Array.isArray((value as { activityEvents?: unknown }).activityEvents)
      ? ((value as { activityEvents: unknown[] }).activityEvents ?? [])
      : [];
  const recordings = facts.flatMap((entry) => {
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
  const activityEvents = activity.flatMap((entry) => {
    const fact = activityFact(entry);
    return fact ? [workspaceActivityEvent(fact, viewerSubjectId)] : [];
  });
  return [...recordings, ...activityEvents];
}
