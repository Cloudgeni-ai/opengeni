import { z } from "zod";
import { defineSchema } from "./define-schema";
import {
  EVENT_TRIGGER_CONDITIONS_MAX,
  EVENT_TRIGGER_TYPES_MAX,
  EVENT_TRIGGERS_PER_AUTOMATION_MAX,
  EventCondition,
  EventSourceKind,
  EventTypeName,
  MAX_EVENT_RUNS_PER_HOUR,
  WebhookEventAdapter,
} from "./event-triggers";

/**
 * Automation templates: where a new automation starts. A template holds what
 * an automation does and when, but never where its runs go, who owns it or
 * which accounts it uses: those come from wherever it is used. Its schedule
 * has no time zone (the person's own applies) and its triggers name a kind
 * of source rather than a source, since sources differ per person.
 *
 * Built-in and host templates live in the client. A workspace keeps the
 * templates its people save from their automations.
 *
 * This module must not import `./index`.
 */

export const AUTOMATION_TEMPLATE_NAME_MAX_LENGTH = 120;
export const AUTOMATION_TEMPLATE_DESCRIPTION_MAX_LENGTH = 500;
export const AUTOMATION_TEMPLATE_INSTRUCTIONS_MAX_LENGTH = 20_000;
/** Saved templates a workspace keeps; saving another past this is refused. */
export const AUTOMATION_TEMPLATES_PER_WORKSPACE_MAX = 200;

const Uuid = /* @__PURE__ */ defineSchema(() => z.string().uuid());

/** When it runs, read in the time zone of whoever uses the template. */
export const AutomationTemplateSchedule = /* @__PURE__ */ defineSchema(() =>
  z.discriminatedUnion("type", [
    z
      .object({
        type: z.literal("calendar"),
        hour: z.number().int().min(0).max(23),
        minute: z.number().int().min(0).max(59),
        /** Omitted: every day. */
        daysOfWeek: z
          .array(
            z.enum(["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"]),
          )
          .min(1)
          .max(7)
          .optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("interval"),
        everySeconds: z
          .number()
          .int()
          .min(60)
          .max(366 * 86_400),
      })
      .strict(),
  ]),
);
export type AutomationTemplateSchedule = z.infer<typeof AutomationTemplateSchedule>;

/**
 * The kind of source a template trigger listens on: GitHub, a Linear webhook,
 * one MCP server, this workspace. `sourceId` names a source shared with the
 * workspace, used when the person can use it; otherwise their own source of
 * this kind is.
 */
export const AutomationTemplateEventSource = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      kind: EventSourceKind,
      /** For a webhook: how it verifies and reads deliveries. */
      adapter: WebhookEventAdapter.optional(),
      /** For an MCP source: the server, as configured for the workspace. */
      mcpServerId: z.string().min(1).max(256).optional(),
      sourceId: Uuid.optional(),
    })
    .strict()
    .superRefine((source, context) => {
      if ((source.kind === "webhook") !== (source.adapter !== undefined)) {
        context.addIssue({
          code: "custom",
          path: ["adapter"],
          message: "A webhook source names its adapter, and only a webhook source does",
        });
      }
      if ((source.kind === "mcp") !== (source.mcpServerId !== undefined)) {
        context.addIssue({
          code: "custom",
          path: ["mcpServerId"],
          message: "An MCP source names its server, and only an MCP source does",
        });
      }
    }),
);
export type AutomationTemplateEventSource = z.infer<typeof AutomationTemplateEventSource>;

export const AutomationTemplateTrigger = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      source: AutomationTemplateEventSource,
      eventTypes: z.array(EventTypeName).min(1).max(EVENT_TRIGGER_TYPES_MAX),
      conditions: z.array(EventCondition).max(EVENT_TRIGGER_CONDITIONS_MAX).default([]),
      /** Also fire on events made by Opengeni's own bots. */
      includeOwnEvents: z.boolean().default(false),
      /** MCP subscription arguments. */
      arguments: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
);
export type AutomationTemplateTrigger = z.input<typeof AutomationTemplateTrigger>;

const TemplateName = /* @__PURE__ */ defineSchema(() =>
  z.string().trim().min(1).max(AUTOMATION_TEMPLATE_NAME_MAX_LENGTH),
);
const TemplateDescription = /* @__PURE__ */ defineSchema(() =>
  z.string().trim().max(AUTOMATION_TEMPLATE_DESCRIPTION_MAX_LENGTH),
);
/** What the agent does on each run. */
const TemplateInstructions = /* @__PURE__ */ defineSchema(() =>
  z.string().trim().min(1).max(AUTOMATION_TEMPLATE_INSTRUCTIONS_MAX_LENGTH),
);
const TemplateTriggers = /* @__PURE__ */ defineSchema(() =>
  z.array(AutomationTemplateTrigger).max(EVENT_TRIGGERS_PER_AUTOMATION_MAX),
);
/** The storm guard for event runs; null takes the default. */
const TemplateMaxRunsPerHour = /* @__PURE__ */ defineSchema(() =>
  z.number().int().min(1).max(MAX_EVENT_RUNS_PER_HOUR).nullable(),
);

/** A template saved in a workspace. */
export const WorkspaceAutomationTemplate = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: Uuid,
    workspaceId: Uuid,
    name: z.string(),
    description: z.string(),
    instructions: z.string(),
    /** Null: it runs only on its events or with Run now. */
    schedule: AutomationTemplateSchedule.nullable(),
    triggers: TemplateTriggers,
    maxRunsPerHour: TemplateMaxRunsPerHour,
    /** Who saved it; null when a workspace-level caller did. */
    createdBySubjectId: z.string().nullable(),
    /** `manage`: the reader may rename, change or delete it. */
    viewerAccess: z.enum(["manage", "use"]),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);
export type WorkspaceAutomationTemplate = z.output<typeof WorkspaceAutomationTemplate>;

export const CreateAutomationTemplateRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      name: TemplateName,
      description: TemplateDescription.default(""),
      instructions: TemplateInstructions,
      schedule: AutomationTemplateSchedule.nullable().default(null),
      triggers: TemplateTriggers.default([]),
      maxRunsPerHour: TemplateMaxRunsPerHour.default(null),
    })
    .strict(),
);
export type CreateAutomationTemplateRequest = z.input<typeof CreateAutomationTemplateRequest>;
export type ParsedCreateAutomationTemplateRequest = z.output<
  typeof CreateAutomationTemplateRequest
>;

/** Changes only what it names. */
export const UpdateAutomationTemplateRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      name: TemplateName.optional(),
      description: TemplateDescription.optional(),
      instructions: TemplateInstructions.optional(),
      schedule: AutomationTemplateSchedule.nullable().optional(),
      triggers: TemplateTriggers.optional(),
      maxRunsPerHour: TemplateMaxRunsPerHour.optional(),
    })
    .strict(),
);
export type UpdateAutomationTemplateRequest = z.input<typeof UpdateAutomationTemplateRequest>;
export type ParsedUpdateAutomationTemplateRequest = z.output<
  typeof UpdateAutomationTemplateRequest
>;

export const ListAutomationTemplatesResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ templates: z.array(WorkspaceAutomationTemplate) }),
);
export type ListAutomationTemplatesResponse = z.output<typeof ListAutomationTemplatesResponse>;

export const AutomationTemplateResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ template: WorkspaceAutomationTemplate }),
);
export type AutomationTemplateResponse = z.output<typeof AutomationTemplateResponse>;
