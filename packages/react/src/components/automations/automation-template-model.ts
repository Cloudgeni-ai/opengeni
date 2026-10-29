/**
 * Automation templates: where a new automation starts. Using one fills the
 * ordinary form; nothing is created until the person saves. A template holds
 * what an automation does and when, never where its runs go, who owns it or
 * which accounts it uses. Its schedule has no time zone (the person's own
 * applies) and its triggers name a kind of source, resolved to the person's
 * own source when the form opens. Pure; text comes from the host's catalog.
 */
import { AUTOMATION_TEMPLATE_NAME_MAX_LENGTH } from "@opengeni/contracts/automation-templates";
import { webhookPresetOf } from "@opengeni/contracts/event-triggers";
import type {
  AutomationTemplateEventSource,
  AutomationTemplateSchedule,
  AutomationTemplateTrigger,
  CreateAutomationTemplateRequest,
  EventSource,
  ScheduledTask,
  WorkspaceAutomationTemplate,
} from "@opengeni/sdk";

import type { OpenGeniText } from "../../messages/runtime";
import {
  cadenceFromScheduleSpec,
  describeCadence,
  toScheduleSpec,
  type CadenceValue,
} from "../../ui/cadence-picker";
import {
  AUTOMATION_NAME_MAX_LENGTH,
  automationCadence,
  automationName,
  viewerTimeZone,
  type AutomationDraft,
} from "./automation-model";
import {
  eventSourceChoiceName,
  eventSourceChoiceOf,
  type EventSourceChoice,
} from "./event-source-model";
import {
  DEFAULT_EVENT_RUNS_PER_HOUR,
  emptyEventTriggersDraft,
  eventTriggerDraftFrom,
  eventTypesLabel,
  type EventTriggerDraft,
  type EventTriggersDraft,
} from "./event-trigger-model";

/** A template a person can start an automation from: built in, the host's own, or saved in the workspace. */
export interface AutomationTemplate {
  /** Unique among the templates offered together. */
  id: string;
  name: string;
  /** One sentence: what it does. */
  description: string;
  /** What the agent does on each run. */
  instructions: string;
  /** Null: it runs only on its events or with Run now. */
  schedule: AutomationTemplateSchedule | null;
  triggers: readonly AutomationTemplateTrigger[];
  /** The storm guard for event runs; omitted or null takes the default. */
  maxRunsPerHour?: number | null | undefined;
  /** When it runs, for its card: "When a pull request opens". Default: said from its schedule and triggers. */
  when?: string | undefined;
}

/* ----------------------------------------------------------------------------
   Built-in templates.
   -------------------------------------------------------------------------- */

const WEEKDAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"] as const;

/**
 * The templates that ship with Opengeni, in the host's language. Event
 * templates listen on GitHub, Linear and this workspace's meetings; offer
 * them where those sources can be added.
 */
export function builtinAutomationTemplates(t: OpenGeniText): AutomationTemplate[] {
  return [
    {
      id: "meeting-notes",
      name: t("automations.template.meetingNotes.name"),
      description: t("automations.template.meetingNotes.description"),
      instructions: t("automations.template.meetingNotes.instructions"),
      when: t("automations.template.meetingNotes.when"),
      schedule: null,
      triggers: [
        {
          source: { kind: "workspace" },
          eventTypes: ["recording.transcript.ready"],
          conditions: [
            { field: "data.purpose", op: "equals", value: "meeting" },
            // The person's own meetings: everyone who uses the template writes their own.
            { field: "data.recordedByYou", op: "equals", value: true },
          ],
        },
      ],
    },
    {
      id: "pr-review",
      name: t("automations.template.prReview.name"),
      description: t("automations.template.prReview.description"),
      instructions: t("automations.template.prReview.instructions"),
      when: t("automations.template.prReview.when"),
      schedule: null,
      triggers: [
        {
          source: { kind: "github" },
          eventTypes: ["pull_request.opened", "pull_request.ready_for_review"],
          // A draft is reviewed once it is marked ready for review.
          conditions: [{ field: "data.pull_request.draft", op: "equals", value: false }],
        },
      ],
    },
    {
      id: "issue-triage",
      name: t("automations.template.issueTriage.name"),
      description: t("automations.template.issueTriage.description"),
      instructions: t("automations.template.issueTriage.instructions"),
      when: t("automations.template.issueTriage.when"),
      schedule: null,
      triggers: [
        {
          source: { kind: "webhook", adapter: "custom", preset: "linear" },
          eventTypes: ["Issue.create"],
        },
      ],
    },
    {
      id: "morning-brief",
      name: t("automations.template.morningBrief.name"),
      description: t("automations.template.morningBrief.description"),
      instructions: t("automations.template.morningBrief.instructions"),
      schedule: { type: "calendar", hour: 8, minute: 0, daysOfWeek: [...WEEKDAYS] },
      triggers: [],
    },
    {
      id: "dependency-pr",
      name: t("automations.template.dependencyPr.name"),
      description: t("automations.template.dependencyPr.description"),
      instructions: t("automations.template.dependencyPr.instructions"),
      schedule: { type: "calendar", hour: 9, minute: 30, daysOfWeek: ["MONDAY"] },
      triggers: [],
    },
    {
      id: "cost-check",
      name: t("automations.template.costCheck.name"),
      description: t("automations.template.costCheck.description"),
      instructions: t("automations.template.costCheck.instructions"),
      schedule: { type: "calendar", hour: 8, minute: 0, daysOfWeek: [...WEEKDAYS] },
      triggers: [],
    },
  ];
}

/**
 * The templates a place can offer: one with event triggers only where events
 * run, and one on this workspace's own events only where those are offered.
 */
export function automationTemplatesFor(
  templates: readonly AutomationTemplate[],
  options: { eventTriggers: boolean; workspaceEvents?: boolean | undefined },
): AutomationTemplate[] {
  return templates.filter(
    (template) =>
      (options.eventTriggers || template.triggers.length === 0) &&
      (options.workspaceEvents === true ||
        !template.triggers.some((trigger) => trigger.source.kind === "workspace")),
  );
}

/** A template saved in the workspace, as the list and the form use it. */
export function automationTemplateOfSaved(saved: WorkspaceAutomationTemplate): AutomationTemplate {
  return {
    id: saved.id,
    name: saved.name,
    description: saved.description,
    instructions: saved.instructions,
    schedule: saved.schedule,
    triggers: saved.triggers,
    maxRunsPerHour: saved.maxRunsPerHour,
  };
}

/* ----------------------------------------------------------------------------
   Words.
   -------------------------------------------------------------------------- */

/** The kind of source a template trigger asks for, as "Add a source" offers it. */
export function automationTemplateSourceChoice(
  source: AutomationTemplateEventSource,
): EventSourceChoice {
  return eventSourceChoiceOf({
    kind: source.kind,
    adapter: source.adapter ?? null,
    format: source.preset ? { preset: source.preset } : null,
  });
}

/** When a template runs, for its card: its own words, else its schedule or first trigger. */
export function automationTemplateWhenWords(
  t: OpenGeniText,
  template: AutomationTemplate,
  now: Date,
): string {
  if (template.when) return template.when;
  const cadence = template.schedule
    ? automationTemplateCadence(template.schedule, viewerTimeZone())
    : null;
  if (cadence) {
    return describeCadence(cadence.rule, {
      timeZone: cadence.timeZone,
      now,
      text: t,
    }).short.replace(/ · .*$/u, "");
  }
  const [first] = template.triggers;
  if (!first) return t("automations.when.manual");
  const words = t("automations.trigger.short", {
    events: eventTypesLabel(t, first.eventTypes),
    source: eventSourceChoiceName(t, automationTemplateSourceChoice(first.source)),
  });
  return template.triggers.length === 1
    ? words
    : t("automations.triggers.shortAndMore", { words, count: template.triggers.length - 1 });
}

/* ----------------------------------------------------------------------------
   Schedules.
   -------------------------------------------------------------------------- */

/** A template's schedule in the person's time zone, as the form edits it. */
export function automationTemplateCadence(
  schedule: AutomationTemplateSchedule,
  timeZone: string,
): CadenceValue {
  return schedule.type === "calendar"
    ? cadenceFromScheduleSpec({ ...schedule, timeZone }, timeZone)
    : cadenceFromScheduleSpec({ type: "interval", everySeconds: schedule.everySeconds }, timeZone);
}

/**
 * The schedule a template keeps: the time of day and days without the time
 * zone, or the interval without its start. A one-time run has none.
 */
export function automationTemplateSchedule(
  cadence: CadenceValue | null,
  now: Date,
): AutomationTemplateSchedule | null {
  if (!cadence) return null;
  const spec = toScheduleSpec(cadence.rule, { timeZone: cadence.timeZone, now });
  if (spec.type === "calendar") {
    if (spec.daysOfMonth?.length) return null;
    return {
      type: "calendar",
      hour: spec.hour,
      minute: spec.minute,
      ...(spec.daysOfWeek?.length ? { daysOfWeek: [...spec.daysOfWeek] } : {}),
    };
  }
  if (spec.type === "interval") return { type: "interval", everySeconds: spec.everySeconds };
  return null;
}

/* ----------------------------------------------------------------------------
   Sources.
   -------------------------------------------------------------------------- */

/** Whether `source` is of the kind a template trigger asks for. */
export function eventSourceFitsTemplate(
  wanted: AutomationTemplateEventSource,
  source: Pick<EventSource, "kind" | "adapter" | "mcp"> & Partial<Pick<EventSource, "format">>,
): boolean {
  if (source.kind !== wanted.kind) return false;
  if (wanted.kind === "webhook") {
    const have = webhookPresetOf({ adapter: source.adapter, preset: source.format?.preset });
    const want = webhookPresetOf(wanted);
    return have.adapter === want.adapter && have.preset === want.preset;
  }
  if (wanted.kind === "mcp") return source.mcp?.serverId === wanted.mcpServerId;
  return true;
}

/**
 * The source a template trigger listens on for this person: the source the
 * template names when they can use it, else their first active source of its
 * kind; empty when they have none yet.
 */
export function automationTemplateSourceId(
  wanted: AutomationTemplateEventSource,
  sources: readonly EventSource[],
): string {
  const usable = sources.filter(
    (source) => source.status === "active" && eventSourceFitsTemplate(wanted, source),
  );
  return usable.find((source) => source.id === wanted.sourceId)?.id ?? usable[0]?.id ?? "";
}

/**
 * Triggers still waiting for a source get one once sources load. Returns the
 * same draft when nothing changed, so it is safe to run on every load.
 */
export function withTemplateSources(
  events: EventTriggersDraft,
  sources: readonly EventSource[] | undefined,
): EventTriggersDraft {
  if (!sources) return events;
  let changed = false;
  const triggers = events.triggers.map((trigger) => {
    if (trigger.sourceId || !trigger.templateSource) return trigger;
    const sourceId = automationTemplateSourceId(trigger.templateSource, sources);
    if (!sourceId) return trigger;
    changed = true;
    return { ...trigger, sourceId };
  });
  return changed ? { ...events, triggers } : events;
}

/* ----------------------------------------------------------------------------
   Drafts.
   -------------------------------------------------------------------------- */

/**
 * The draft a template starts: its name, message, schedule in the person's
 * time zone, and triggers on their own sources. A trigger whose source isn't
 * there yet remembers what it asks for, so `withTemplateSources` can fill it
 * when sources load and the editor can offer to add one.
 */
export function automationDraftFromTemplate(
  template: AutomationTemplate,
  options: { sources?: readonly EventSource[] | undefined; timeZone?: string | undefined } = {},
): AutomationDraft {
  const timeZone = options.timeZone ?? viewerTimeZone();
  const events: EventTriggersDraft = {
    ...emptyEventTriggersDraft(),
    maxRunsPerHour: template.maxRunsPerHour ?? DEFAULT_EVENT_RUNS_PER_HOUR,
    triggers: template.triggers.map(
      (trigger): EventTriggerDraft => ({
        ...eventTriggerDraftFrom({
          sourceId: "",
          eventTypes: trigger.eventTypes,
          conditions: trigger.conditions ?? [],
          includeOwnEvents: trigger.includeOwnEvents ?? false,
          arguments: trigger.arguments ?? null,
        }),
        templateSource: trigger.source,
      }),
    ),
  };
  return {
    instructions: template.instructions,
    name: template.name.slice(0, AUTOMATION_NAME_MAX_LENGTH),
    cadence: template.schedule ? automationTemplateCadence(template.schedule, timeZone) : null,
    events: withTemplateSources(events, options.sources),
  };
}

/**
 * The template an automation saves as: its message, schedule and triggers.
 * A trigger keeps the kind of its source, and names the source only when it
 * is shared with the workspace; a trigger on a source the saver can't see is
 * left out, since its kind can't be told.
 */
export function automationTemplateFromTask(
  t: OpenGeniText,
  task: Pick<ScheduledTask, "name" | "schedule" | "events" | "agentConfig">,
  sources: readonly EventSource[],
  input: { name?: string | undefined; description?: string | undefined; now: Date },
): CreateAutomationTemplateRequest {
  const cadence = automationCadence(task.schedule);
  const triggers = (task.events?.triggers ?? []).flatMap((trigger) => {
    const source = sources.find((candidate) => candidate.id === trigger.sourceId);
    const wanted = templateSourceOf(trigger.sourceKind, source);
    if (!wanted) return [];
    return [
      {
        source: wanted,
        eventTypes: [...trigger.eventTypes],
        conditions: trigger.conditions.map((condition) => ({ ...condition })),
        includeOwnEvents: trigger.includeOwnEvents,
        ...(trigger.arguments && Object.keys(trigger.arguments).length > 0
          ? { arguments: { ...trigger.arguments } }
          : {}),
      },
    ];
  });
  const name = (input.name ?? "").trim() || task.name;
  return {
    name: automationName(t, { name, instructions: task.agentConfig.prompt }).slice(
      0,
      AUTOMATION_TEMPLATE_NAME_MAX_LENGTH,
    ),
    description: (input.description ?? "").trim(),
    instructions: task.agentConfig.prompt,
    schedule: automationTemplateSchedule(cadence, input.now),
    triggers,
    maxRunsPerHour:
      triggers.length > 0 &&
      task.events &&
      task.events.maxRunsPerHour !== DEFAULT_EVENT_RUNS_PER_HOUR
        ? task.events.maxRunsPerHour
        : null,
  };
}

function templateSourceOf(
  kind: EventSource["kind"],
  source: EventSource | undefined,
): AutomationTemplateEventSource | null {
  const shared = source?.visibility === "workspace" ? { sourceId: source.id } : {};
  if (kind === "webhook") {
    if (!source?.adapter) return null;
    const { adapter, preset } = webhookPresetOf({
      adapter: source.adapter,
      preset: source.format?.preset,
    });
    return { kind, adapter, ...(preset ? { preset } : {}), ...shared };
  }
  if (kind === "mcp") {
    return source?.mcp ? { kind, mcpServerId: source.mcp.serverId, ...shared } : null;
  }
  return { kind, ...shared };
}
