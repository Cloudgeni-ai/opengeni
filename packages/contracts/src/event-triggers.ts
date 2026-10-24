import { z } from "zod";
import { defineSchema } from "./define-schema";

/**
 * Event sources, normalized events and event triggers.
 *
 * An event source delivers events into a workspace: a webhook endpoint a person
 * pastes into another app, an app Opengeni receives events from directly, or an
 * MCP connection whose server offers the MCP Events extension. Every source
 * produces the same normalized event. An automation (a scheduled task) runs
 * when one of its event triggers matches an event.
 *
 * This module must not import `./index`: the scheduled-task schemas there
 * embed these schemas.
 */

export const EVENT_SOURCE_KINDS = ["webhook", "github", "slack", "gmail", "mcp"] as const;
export const EventSourceKind = /* @__PURE__ */ defineSchema(() => z.enum(EVENT_SOURCE_KINDS));
export type EventSourceKind = z.infer<typeof EventSourceKind>;

/** How a webhook endpoint verifies and reads deliveries. */
export const WEBHOOK_EVENT_ADAPTERS = ["standard", "linear", "sentry"] as const;
export const WebhookEventAdapter = /* @__PURE__ */ defineSchema(() =>
  z.enum(WEBHOOK_EVENT_ADAPTERS),
);
export type WebhookEventAdapter = z.infer<typeof WebhookEventAdapter>;

export const EventSourceStatus = /* @__PURE__ */ defineSchema(() =>
  z.enum(["active", "disabled", "blocked"]),
);
export type EventSourceStatus = z.infer<typeof EventSourceStatus>;

/** Who can use a source and see its events: only its owner, or the workspace. */
export const EventSourceVisibility = /* @__PURE__ */ defineSchema(() =>
  z.enum(["private", "workspace"]),
);
export type EventSourceVisibility = z.infer<typeof EventSourceVisibility>;

export const EVENT_SOURCE_NAME_MAX_LENGTH = 120;
export const EVENT_TYPE_MAX_LENGTH = 200;
export const EVENT_SUMMARY_MAX_LENGTH = 500;
export const EVENT_SUBJECT_MAX_LENGTH = 300;
/** Serialized UTF-8 bytes of an event's stored `data`; larger data is cut. */
export const EVENT_DATA_MAX_BYTES = 64 * 1024;
/** Raw request bodies above this size are refused before verification. */
export const EVENT_DELIVERY_BODY_MAX_BYTES = 1024 * 1024;
export const EVENT_TRIGGERS_PER_AUTOMATION_MAX = 16;
export const EVENT_TRIGGER_TYPES_MAX = 32;
export const EVENT_TRIGGER_CONDITIONS_MAX = 16;
export const DEFAULT_EVENT_RUNS_PER_HOUR = 30;
export const MAX_EVENT_RUNS_PER_HOUR = 1000;
/** Raw delivery bodies are deleted after this many days; delivery rows stay. */
export const EVENT_DELIVERY_BODY_RETENTION_DAYS = 7;
/** Normalized events and delivery rows are deleted after this many days. */
export const EVENT_RETENTION_DAYS = 30;

const Uuid = /* @__PURE__ */ defineSchema(() => z.string().uuid());
const Timestamp = /* @__PURE__ */ defineSchema(() => z.string());

export const EventSourceName = /* @__PURE__ */ defineSchema(() =>
  z.string().trim().min(1).max(EVENT_SOURCE_NAME_MAX_LENGTH),
);

export const EventTypeName = /* @__PURE__ */ defineSchema(() =>
  z
    .string()
    .min(1)
    .max(EVENT_TYPE_MAX_LENGTH)
    .regex(/^[\x21-\x7e]+$/u, "Event types are printable ASCII without spaces"),
);

export const EventSourceMcpBinding = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      /** The MCP server id as configured for the workspace. */
      serverId: z.string().min(1).max(256),
      /** The owner's connection used for every events/* request. */
      connectionId: Uuid.nullable(),
    })
    .strict(),
);
export type EventSourceMcpBinding = z.infer<typeof EventSourceMcpBinding>;

export const EventSource = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: Uuid,
    workspaceId: Uuid,
    kind: EventSourceKind,
    /** Webhook sources only. */
    adapter: WebhookEventAdapter.nullable(),
    name: z.string(),
    /** The person the source belongs to; null for workspace app sources. */
    ownerSubjectId: z.string().nullable(),
    visibility: EventSourceVisibility,
    status: EventSourceStatus,
    /** Why the source is blocked or disabled, in plain language. */
    statusReason: z.string().nullable(),
    /** The URL to paste into the sending app. Webhook sources only. */
    webhookUrl: z.string().nullable(),
    /**
     * A Linear or Sentry webhook whose secret is not pasted yet: it refuses
     * deliveries until the secret is set with an update.
     */
    awaitingSigningSecret: z.boolean().default(false),
    /** MCP sources only. */
    mcp: EventSourceMcpBinding.nullable(),
    lastDeliveryAt: Timestamp.nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
    /**
     * What the reading person can do with the source: `manage` (its owner or
     * a workspace admin: edit, rotate, test, replay, delete) or `use` (point
     * triggers at it and read its log). Set on REST reads.
     */
    viewerAccess: z.enum(["manage", "use"]).optional(),
  }),
);
export type EventSource = z.infer<typeof EventSource>;

/**
 * Linear and Sentry generate the secret once they have the webhook URL, so it
 * is pasted on create or afterwards. Standard sources get one from Opengeni.
 */
export const EventSourceSigningSecretInput = /* @__PURE__ */ defineSchema(() =>
  z.string().min(8).max(512),
);

export const CreateEventSourceRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("webhook"),
          adapter: WebhookEventAdapter,
          name: EventSourceName,
          visibility: EventSourceVisibility.default("private"),
          signingSecret: EventSourceSigningSecretInput.optional(),
        })
        .strict(),
      z
        .object({
          kind: z.enum(["github", "slack"]),
          name: EventSourceName.optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal("gmail"),
          /** The mailbox connection; defaults to the caller's only Gmail connection. */
          connectionId: Uuid.optional(),
          name: EventSourceName.optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal("mcp"),
          serverId: z.string().min(1).max(256),
          connectionId: Uuid.optional(),
          name: EventSourceName.optional(),
        })
        .strict(),
    ])
    .superRefine((value, context) => {
      if (
        value.kind === "webhook" &&
        value.adapter === "standard" &&
        value.signingSecret !== undefined
      ) {
        context.addIssue({
          code: "custom",
          path: ["signingSecret"],
          message: "Opengeni generates the signing secret for standard webhooks",
        });
      }
    }),
);
/** What a caller sends; a webhook source's `visibility` defaults to `private`. */
export type CreateEventSourceRequest = z.input<typeof CreateEventSourceRequest>;
export type ParsedCreateEventSourceRequest = z.output<typeof CreateEventSourceRequest>;

export const CreateEventSourceResponse = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      source: EventSource,
      /** Standard webhook sources only; shown once. */
      signingSecret: z.string().optional(),
    })
    .strict(),
);
export type CreateEventSourceResponse = z.infer<typeof CreateEventSourceResponse>;

export const UpdateEventSourceRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      name: EventSourceName.optional(),
      visibility: EventSourceVisibility.optional(),
      status: z.enum(["active", "disabled"]).optional(),
      /** Replace a pasted Linear or Sentry secret. */
      signingSecret: EventSourceSigningSecretInput.optional(),
    })
    .strict()
    .refine((value) => Object.keys(value).length > 0, "Supply at least one field"),
);
export type UpdateEventSourceRequest = z.infer<typeof UpdateEventSourceRequest>;

export const RotateEventSourceSecretResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ signingSecret: z.string() }).strict(),
);
export type RotateEventSourceSecretResponse = z.infer<typeof RotateEventSourceSecretResponse>;

export const ListEventSourcesResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ sources: z.array(EventSource) }).strict(),
);
export type ListEventSourcesResponse = z.infer<typeof ListEventSourcesResponse>;

/**
 * Who caused an event. `opengeni` marks Opengeni's own identities (its GitHub
 * App bot, its Slack bot); triggers ignore those events unless they opt in.
 */
export const EventActorKind = /* @__PURE__ */ defineSchema(() =>
  z.enum(["person", "bot", "opengeni", "unknown"]),
);
export type EventActorKind = z.infer<typeof EventActorKind>;

export const EventActor = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      kind: EventActorKind,
      name: z.string().max(200).nullable(),
    })
    .strict(),
);
export type EventActor = z.infer<typeof EventActor>;

export const InboundEvent = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: Uuid,
    sourceId: Uuid,
    sourceKind: EventSourceKind,
    type: z.string(),
    occurredAt: Timestamp,
    receivedAt: Timestamp,
    /** What the event is about, such as `acme/api#42`. */
    subject: z.string().nullable(),
    /** One line a person or agent can read. */
    summary: z.string(),
    /** A link to the thing in its app, when known. */
    url: z.string().nullable(),
    actor: EventActor,
    data: z.record(z.string(), z.unknown()),
    /** The source's data was larger than the stored budget and was cut. */
    dataTruncated: z.boolean(),
    /** Events from this source may have been missed just before this one. */
    gapBefore: z.boolean(),
  }),
);
export type InboundEvent = z.infer<typeof InboundEvent>;

export const InboundEventSummary = /* @__PURE__ */ defineSchema(() =>
  InboundEvent.pick({
    id: true,
    sourceId: true,
    sourceKind: true,
    type: true,
    occurredAt: true,
    subject: true,
    summary: true,
    url: true,
    actor: true,
  }),
);
export type InboundEventSummary = z.infer<typeof InboundEventSummary>;

export const ListInboundEventsResponse = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      events: z.array(InboundEvent),
      nextCursor: z.string().nullable(),
    })
    .strict(),
);
export type ListInboundEventsResponse = z.infer<typeof ListInboundEventsResponse>;

export const EventDeliveryStatus = /* @__PURE__ */ defineSchema(() =>
  z.enum(["accepted", "ignored", "rejected", "failed"]),
);
export type EventDeliveryStatus = z.infer<typeof EventDeliveryStatus>;

export const EventDelivery = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: Uuid,
    sourceId: Uuid,
    receivedAt: Timestamp,
    status: EventDeliveryStatus,
    /** Why a delivery was ignored, rejected or failed, in plain language. */
    reason: z.string().nullable(),
    eventIds: z.array(Uuid),
    /** The types of the events it became, each once, in order. */
    eventTypes: z.array(z.string()),
    bodyBytes: z.number().int().nonnegative(),
    /** The raw body is kept for a few days so a delivery can be replayed. */
    bodyRetained: z.boolean(),
    /** How many times the sender delivered this same delivery again. */
    duplicateCount: z.number().int().nonnegative(),
    replayOfDeliveryId: Uuid.nullable(),
  }),
);
export type EventDelivery = z.infer<typeof EventDelivery>;

export const ListEventDeliveriesResponse = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      deliveries: z.array(EventDelivery),
      nextCursor: z.string().nullable(),
    })
    .strict(),
);
export type ListEventDeliveriesResponse = z.infer<typeof ListEventDeliveriesResponse>;

export const ReplayEventDeliveryResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ delivery: EventDelivery }).strict(),
);
export type ReplayEventDeliveryResponse = z.infer<typeof ReplayEventDeliveryResponse>;

export const SendTestEventRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      type: EventTypeName.default("opengeni.test"),
      data: z.record(z.string(), z.unknown()).default({}),
    })
    .strict(),
);
/** What a caller sends; `type` defaults to `opengeni.test` and `data` to `{}`. */
export type SendTestEventRequest = z.input<typeof SendTestEventRequest>;
export type ParsedSendTestEventRequest = z.output<typeof SendTestEventRequest>;

export const SendTestEventResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ event: InboundEvent, matchedAutomationIds: z.array(Uuid) }).strict(),
);
export type SendTestEventResponse = z.infer<typeof SendTestEventResponse>;

/** A field an event condition can read. */
export const EVENT_CONDITION_FIELD_PATTERN =
  /^(?:type|subject|summary|url|actor\.kind|actor\.name|data(?:\.[A-Za-z0-9_@$-]{1,64}){1,8})$/u;

export const EventConditionOperator = /* @__PURE__ */ defineSchema(() =>
  z.enum(["equals", "not_equals", "in", "not_in", "contains", "exists", "not_exists"]),
);
export type EventConditionOperator = z.infer<typeof EventConditionOperator>;

const EventConditionScalar = /* @__PURE__ */ defineSchema(() =>
  z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()]),
);

export const EventCondition = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      /** `type`, `subject`, `summary`, `url`, `actor.kind`, `actor.name`, or `data.<path>`. */
      field: z.string().regex(EVENT_CONDITION_FIELD_PATTERN, "Unsupported event field"),
      op: EventConditionOperator,
      value: z.union([EventConditionScalar, z.array(EventConditionScalar).max(50)]).optional(),
    })
    .strict()
    .superRefine((condition, context) => {
      const presence = condition.op === "exists" || condition.op === "not_exists";
      const list = condition.op === "in" || condition.op === "not_in";
      if (presence && condition.value !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["value"],
          message: `${condition.op} takes no value`,
        });
      }
      if (!presence && condition.value === undefined) {
        context.addIssue({
          code: "custom",
          path: ["value"],
          message: `${condition.op} needs a value`,
        });
      }
      if (list && !Array.isArray(condition.value)) {
        context.addIssue({
          code: "custom",
          path: ["value"],
          message: `${condition.op} needs a list`,
        });
      }
      if (!list && Array.isArray(condition.value)) {
        context.addIssue({
          code: "custom",
          path: ["value"],
          message: `${condition.op} needs one value`,
        });
      }
    }),
);
export type EventCondition = z.infer<typeof EventCondition>;

export const EventTriggerInput = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      sourceId: Uuid,
      /** Event types that fire the trigger. An MCP trigger names exactly one. */
      eventTypes: z.array(EventTypeName).min(1).max(EVENT_TRIGGER_TYPES_MAX),
      /** All conditions must hold. */
      conditions: z.array(EventCondition).max(EVENT_TRIGGER_CONDITIONS_MAX).default([]),
      /** Also fire on events made by Opengeni's own bots. */
      includeOwnEvents: z.boolean().default(false),
      /** MCP subscription arguments, validated against the event type's inputSchema. */
      arguments: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
);
export type EventTriggerInput = z.input<typeof EventTriggerInput>;
export type ParsedEventTriggerInput = z.output<typeof EventTriggerInput>;

export const EventTriggerStatus = /* @__PURE__ */ defineSchema(() =>
  z.enum(["active", "blocked", "disabled"]),
);
export type EventTriggerStatus = z.infer<typeof EventTriggerStatus>;

export const EventTrigger = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: Uuid,
    sourceId: Uuid,
    sourceKind: EventSourceKind,
    eventTypes: z.array(z.string()),
    conditions: z.array(EventCondition),
    includeOwnEvents: z.boolean(),
    arguments: z.record(z.string(), z.unknown()).nullable(),
    status: EventTriggerStatus,
    statusReason: z.string().nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  }),
);
export type EventTrigger = z.infer<typeof EventTrigger>;

/** Event triggers and the event run policy of an automation. */
export const ScheduledTaskEventsInput = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      triggers: z.array(EventTriggerInput).max(EVENT_TRIGGERS_PER_AUTOMATION_MAX),
      /** Storm guard: at most this many event runs in a rolling hour. */
      maxRunsPerHour: z.number().int().min(1).max(MAX_EVENT_RUNS_PER_HOUR).optional(),
      /** Finish the automation after its first run, whichever trigger fires first. */
      once: z.boolean().optional(),
    })
    .strict(),
);
export type ScheduledTaskEventsInput = z.input<typeof ScheduledTaskEventsInput>;
export type ParsedScheduledTaskEventsInput = z.output<typeof ScheduledTaskEventsInput>;

export const ScheduledTaskEvents = /* @__PURE__ */ defineSchema(() =>
  z.object({
    triggers: z.array(EventTrigger),
    maxRunsPerHour: z.number().int(),
    once: z.boolean(),
    /** When a once-automation finished. */
    completedAt: Timestamp.nullable(),
    /** When the storm guard last held events back; null when it is not holding any. */
    throttledSince: Timestamp.nullable(),
  }),
);
export type ScheduledTaskEvents = z.infer<typeof ScheduledTaskEvents>;

/** The events an event run carried. */
export const ScheduledTaskRunEventOccurrence = /* @__PURE__ */ defineSchema(() =>
  z.object({
    triggerIds: z.array(Uuid),
    eventCount: z.number().int().nonnegative(),
    events: z.array(InboundEventSummary),
  }),
);
export type ScheduledTaskRunEventOccurrence = z.infer<typeof ScheduledTaskRunEventOccurrence>;

/** Bytes of a run's chat update spent on its events at most. */
export const SCHEDULED_OCCURRENCE_EVENTS_MAX_BYTES = 12 * 1024;
/** Bytes of one carried event's `data` at most; the full event stays fetchable by id. */
export const SCHEDULED_OCCURRENCE_EVENT_DATA_MAX_BYTES = 2 * 1024;

export const ScheduledOccurrenceEvent = /* @__PURE__ */ defineSchema(() =>
  InboundEventSummary.extend({
    data: z.record(z.string(), z.unknown()),
    /** The data was cut to fit; the stored event has more. */
    dataTruncated: z.boolean(),
  }),
);
export type ScheduledOccurrenceEvent = z.infer<typeof ScheduledOccurrenceEvent>;

/**
 * The events an event run delivers into its chat, bounded to fit the chat
 * update. `events` holds the oldest that fit; `eventCount` counts them all.
 */
export const ScheduledOccurrenceEvents = /* @__PURE__ */ defineSchema(() =>
  z.object({
    occurrenceId: Uuid,
    eventCount: z.number().int().nonnegative(),
    events: z.array(ScheduledOccurrenceEvent),
    /** The source may have missed events just before these. */
    gapBefore: z.boolean(),
  }),
);
export type ScheduledOccurrenceEvents = z.infer<typeof ScheduledOccurrenceEvents>;

/** An event type a source offers, for trigger pickers and agents. */
export const EventTypeDescriptor = /* @__PURE__ */ defineSchema(() =>
  z.object({
    type: z.string(),
    description: z.string(),
    /** Fields worth matching in conditions, such as `data.repository`. */
    fields: z.array(z.object({ field: z.string(), description: z.string() })),
    /** MCP sources: the subscription arguments the server accepts. */
    argumentsSchema: z.record(z.string(), z.unknown()).nullable(),
    /** False when Opengeni cannot receive this type from this source. */
    available: z.boolean(),
    unavailableReason: z.string().nullable(),
  }),
);
export type EventTypeDescriptor = z.infer<typeof EventTypeDescriptor>;

export const ListEventTypesResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ sourceId: Uuid, eventTypes: z.array(EventTypeDescriptor) }).strict(),
);
export type ListEventTypesResponse = z.infer<typeof ListEventTypesResponse>;
