/**
 * Event triggers as people edit and read them: the editable draft, the
 * request it becomes, validation in the product's words, and short summaries
 * for rows and pages. Pure; every automation surface shares it. Words come
 * from the host's message catalog, so each function that returns text takes
 * the `t` of `useOpenGeniText()` first.
 */
import {
  DEFAULT_EVENT_RUNS_PER_HOUR,
  EVENT_CONDITION_FIELD_PATTERN,
  EVENT_TRIGGER_CONDITIONS_MAX,
  EVENT_TRIGGER_TYPES_MAX,
  EVENT_TRIGGERS_PER_AUTOMATION_MAX,
  EVENT_TYPE_MAX_LENGTH,
  MAX_EVENT_RUNS_PER_HOUR,
} from "@opengeni/contracts/event-triggers";
import type {
  EventCondition,
  EventConditionOperator,
  EventSource,
  EventTrigger,
  EventTypeDescriptor,
  ScheduledTaskEvents,
  ScheduledTaskEventsInput,
} from "@opengeni/sdk";

import type { OpenGeniText } from "../../messages/runtime";

export {
  DEFAULT_EVENT_RUNS_PER_HOUR,
  EVENT_TRIGGER_CONDITIONS_MAX,
  EVENT_TRIGGER_TYPES_MAX,
  EVENT_TRIGGERS_PER_AUTOMATION_MAX,
  MAX_EVENT_RUNS_PER_HOUR,
};

/* ----------------------------------------------------------------------------
   Drafts.
   -------------------------------------------------------------------------- */

/** One condition while it is edited; `value` stays the text a person typed. */
export interface EventConditionDraft {
  key: string;
  field: string;
  op: EventConditionOperator;
  value: string;
}

/** One event trigger while it is edited. */
export interface EventTriggerDraft {
  /** Stable across edits, for list keys and error lookup. */
  key: string;
  sourceId: string;
  eventTypes: string[];
  conditions: EventConditionDraft[];
  includeOwnEvents: boolean;
  /** MCP subscription arguments as JSON text; empty for none. */
  argumentsText: string;
}

/** An automation's event triggers and their run policy while they are edited. */
export interface EventTriggersDraft {
  triggers: EventTriggerDraft[];
  /** Finish after the first run, whichever trigger fires first. */
  once: boolean;
  /** The storm guard: at most this many event runs in a rolling hour. */
  maxRunsPerHour: number;
}

let draftKeySequence = 0;
function draftKey(prefix: string): string {
  draftKeySequence += 1;
  return `${prefix}-${draftKeySequence}`;
}

export function emptyEventTriggersDraft(): EventTriggersDraft {
  return { triggers: [], once: false, maxRunsPerHour: DEFAULT_EVENT_RUNS_PER_HOUR };
}

/** A new trigger on `sourceId`, with no event types picked yet. */
export function newEventTriggerDraft(sourceId = ""): EventTriggerDraft {
  return {
    key: draftKey("trigger"),
    sourceId,
    eventTypes: [],
    conditions: [],
    includeOwnEvents: false,
    argumentsText: "",
  };
}

export function newEventConditionDraft(field = ""): EventConditionDraft {
  return { key: draftKey("condition"), field, op: "equals", value: "" };
}

/** The text a stored condition value is edited as. */
function conditionValueText(value: EventCondition["value"]): string {
  if (value === undefined) return "";
  if (Array.isArray(value)) return value.map((entry) => scalarText(entry)).join(", ");
  return scalarText(value);
}

function scalarText(value: string | number | boolean | null): string {
  return value === null ? "null" : String(value);
}

export function eventConditionDraftFrom(condition: EventCondition): EventConditionDraft {
  return {
    key: draftKey("condition"),
    field: condition.field,
    op: condition.op,
    value: conditionValueText(condition.value),
  };
}

export function eventTriggerDraftFrom(
  trigger: Pick<
    EventTrigger,
    "sourceId" | "eventTypes" | "conditions" | "includeOwnEvents" | "arguments"
  >,
): EventTriggerDraft {
  return {
    key: draftKey("trigger"),
    sourceId: trigger.sourceId,
    eventTypes: [...trigger.eventTypes],
    conditions: trigger.conditions.map(eventConditionDraftFrom),
    includeOwnEvents: trigger.includeOwnEvents,
    argumentsText:
      trigger.arguments && Object.keys(trigger.arguments).length > 0
        ? JSON.stringify(trigger.arguments, null, 2)
        : "",
  };
}

/** The draft of a saved automation's events, or an empty draft when it has none. */
export function eventTriggersDraftFrom(
  events: ScheduledTaskEvents | null | undefined,
): EventTriggersDraft {
  if (!events) return emptyEventTriggersDraft();
  return {
    triggers: events.triggers.map(eventTriggerDraftFrom),
    once: events.once,
    maxRunsPerHour: events.maxRunsPerHour,
  };
}

/* ----------------------------------------------------------------------------
   Conditions.
   -------------------------------------------------------------------------- */

export interface EventConditionOperatorOption {
  value: EventConditionOperator;
  /** What the value box holds; null when the operator takes no value. */
  takes: "one" | "list" | null;
}

export const EVENT_CONDITION_OPERATORS: readonly EventConditionOperatorOption[] = [
  { value: "equals", takes: "one" },
  { value: "not_equals", takes: "one" },
  { value: "in", takes: "list" },
  { value: "not_in", takes: "list" },
  { value: "contains", takes: "one" },
  { value: "exists", takes: null },
  { value: "not_exists", takes: null },
];

export function eventConditionOperator(op: EventConditionOperator): EventConditionOperatorOption {
  return EVENT_CONDITION_OPERATORS.find((option) => option.value === op)!;
}

/** How an operator reads after the field: "data.action is opened". */
export function eventConditionOperatorLabel(t: OpenGeniText, op: EventConditionOperator): string {
  switch (op) {
    case "equals":
      return t("automations.condition.op.equals");
    case "not_equals":
      return t("automations.condition.op.notEquals");
    case "in":
      return t("automations.condition.op.in");
    case "not_in":
      return t("automations.condition.op.notIn");
    case "contains":
      return t("automations.condition.op.contains");
    case "exists":
      return t("automations.condition.op.exists");
    case "not_exists":
      return t("automations.condition.op.notExists");
  }
}

/** The fields every event has, besides its app's own `data.*` fields. */
export function eventCommonFields(t: OpenGeniText): Array<{ field: string; description: string }> {
  return [
    { field: "subject", description: t("automations.field.subject") },
    { field: "summary", description: t("automations.field.summary") },
    { field: "actor.name", description: t("automations.field.actorName") },
    { field: "actor.kind", description: t("automations.field.actorKind") },
    { field: "url", description: t("automations.field.url") },
  ];
}

/** "true" and "false" are booleans; numbers match their text either way. */
function parseScalar(text: string): string | boolean {
  if (text === "true") return true;
  if (text === "false") return false;
  return text;
}

export function eventConditionFromDraft(draft: EventConditionDraft): EventCondition {
  const takes = eventConditionOperator(draft.op).takes;
  const field = draft.field.trim();
  if (takes === null) return { field, op: draft.op };
  if (takes === "list") {
    return {
      field,
      op: draft.op,
      value: draft.value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map(parseScalar),
    };
  }
  return { field, op: draft.op, value: parseScalar(draft.value.trim()) };
}

/* ----------------------------------------------------------------------------
   Requests.
   -------------------------------------------------------------------------- */

/** The `events` field of a create or update request. */
export function eventTriggersInputFrom(draft: EventTriggersDraft): ScheduledTaskEventsInput {
  return {
    triggers: draft.triggers.map((trigger) => {
      const args = parseArguments(trigger.argumentsText);
      return {
        sourceId: trigger.sourceId,
        eventTypes: trigger.eventTypes,
        conditions: trigger.conditions.map(eventConditionFromDraft),
        includeOwnEvents: trigger.includeOwnEvents,
        ...(args.ok && args.value ? { arguments: args.value } : {}),
      };
    }),
    maxRunsPerHour: draft.maxRunsPerHour,
    once: draft.once,
  };
}

/** Whether two drafts would save the same triggers and policy. */
export function sameEventTriggers(left: EventTriggersDraft, right: EventTriggersDraft): boolean {
  const normalized = (draft: EventTriggersDraft) =>
    draft.triggers.length === 0
      ? { triggers: [] }
      : (eventTriggersInputFrom(draft) as Record<string, unknown>);
  return JSON.stringify(normalized(left)) === JSON.stringify(normalized(right));
}

function parseArguments(
  text: string,
): { ok: true; value: Record<string, unknown> | null } | { ok: false } {
  if (!text.trim()) return { ok: true, value: null };
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return { ok: true, value: value as Record<string, unknown> };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

/* ----------------------------------------------------------------------------
   Validation.
   -------------------------------------------------------------------------- */

export interface EventTriggerIssues {
  source?: string;
  eventTypes?: string;
  arguments?: string;
  /** By condition key. */
  conditions?: Record<string, string>;
}

export interface EventTriggersIssues {
  /** By trigger key. */
  triggers: Record<string, EventTriggerIssues>;
  maxRunsPerHour?: string;
}

const EVENT_TYPE_PATTERN = /^[\x21-\x7e]+$/u;

/** Why an event type can't be saved, or null when it can. */
export function eventTypeIssue(t: OpenGeniText, type: string): string | null {
  if (!type) return t("automations.issue.eventTypeEmpty");
  if (type.length > EVENT_TYPE_MAX_LENGTH) return t("automations.issue.eventTypeTooLong");
  if (!EVENT_TYPE_PATTERN.test(type)) return t("automations.issue.eventTypeSpaces");
  return null;
}

export function validateEventTriggers(
  t: OpenGeniText,
  draft: EventTriggersDraft,
  sources: readonly Pick<EventSource, "id" | "kind">[],
): EventTriggersIssues {
  const issues: EventTriggersIssues = { triggers: {} };
  for (const trigger of draft.triggers) {
    const found: EventTriggerIssues = {};
    const source = sources.find((candidate) => candidate.id === trigger.sourceId);
    if (!trigger.sourceId) found.source = t("automations.issue.source");
    else if (!source) found.source = t("automations.issue.sourceGone");
    if (trigger.eventTypes.length === 0) found.eventTypes = t("automations.issue.eventTypesEmpty");
    else if (source?.kind === "mcp" && trigger.eventTypes.length > 1)
      found.eventTypes = t("automations.issue.mcpOneEvent");
    else if (trigger.eventTypes.length > EVENT_TRIGGER_TYPES_MAX)
      found.eventTypes = t("automations.issue.eventTypesTooMany", { max: EVENT_TRIGGER_TYPES_MAX });
    if (!parseArguments(trigger.argumentsText).ok)
      found.arguments = t("automations.issue.arguments");
    const conditionIssues: Record<string, string> = {};
    for (const condition of trigger.conditions) {
      const field = condition.field.trim();
      const takes = eventConditionOperator(condition.op).takes;
      if (!field) conditionIssues[condition.key] = t("automations.issue.conditionField");
      else if (!EVENT_CONDITION_FIELD_PATTERN.test(field))
        conditionIssues[condition.key] = t("automations.issue.conditionFieldPattern");
      else if (takes !== null && !condition.value.trim())
        conditionIssues[condition.key] =
          takes === "list"
            ? t("automations.issue.conditionValues")
            : t("automations.issue.conditionValue");
    }
    if (Object.keys(conditionIssues).length > 0) found.conditions = conditionIssues;
    if (Object.keys(found).length > 0) issues.triggers[trigger.key] = found;
  }
  if (
    !Number.isInteger(draft.maxRunsPerHour) ||
    draft.maxRunsPerHour < 1 ||
    draft.maxRunsPerHour > MAX_EVENT_RUNS_PER_HOUR
  ) {
    issues.maxRunsPerHour = t("automations.issue.maxRunsPerHour", {
      max: MAX_EVENT_RUNS_PER_HOUR,
    });
  }
  return issues;
}

export function hasEventTriggerIssues(issues: EventTriggersIssues): boolean {
  return Object.keys(issues.triggers).length > 0 || issues.maxRunsPerHour !== undefined;
}

/* ----------------------------------------------------------------------------
   Words.
   -------------------------------------------------------------------------- */

/** "Every event", "Every pull_request event" or the type itself. */
export function eventTypeLabel(t: OpenGeniText, type: string): string {
  if (type === "*") return t("automations.eventType.every");
  if (type.endsWith(".*"))
    return t("automations.eventType.everyPrefix", { prefix: type.slice(0, -2) });
  return type;
}

/** "pull_request.opened", "pull_request.opened or issues.opened", "pull_request.opened and 2 more". */
export function eventTypesLabel(t: OpenGeniText, types: readonly string[]): string {
  if (types.length === 0) return t("automations.eventTypes.none");
  const first = eventTypeLabel(t, types[0]!);
  if (types.length === 1) return first;
  if (types.length === 2)
    return t("automations.eventTypes.either", { first, second: eventTypeLabel(t, types[1]!) });
  return t("automations.eventTypes.firstAndMore", { first, count: types.length - 1 });
}

/** "only when data.action is opened", or "only when 3 conditions hold". */
export function eventConditionsLabel(
  t: OpenGeniText,
  conditions: readonly EventCondition[],
): string | null {
  if (conditions.length === 0) return null;
  if (conditions.length > 1)
    return t("automations.conditions.onlyWhenCount", { count: conditions.length });
  const [condition] = conditions as [EventCondition];
  const operator = eventConditionOperatorLabel(t, condition.op);
  if (eventConditionOperator(condition.op).takes === null)
    return t("automations.conditions.onlyWhenSet", { field: condition.field, operator });
  return t("automations.conditions.onlyWhen", {
    field: condition.field,
    operator,
    value: conditionValueText(condition.value),
  });
}

export interface EventTriggerWords {
  /** The source's name, or "A source you can't see" when it is gone or hidden. */
  source: string;
  /** The event types in words. */
  events: string;
  /** The conditions in words, or null without any. */
  conditions: string | null;
  /** "deploy.finished from Deploys", for rows. */
  short: string;
}

export function eventTriggerWords(
  t: OpenGeniText,
  trigger: Pick<EventTrigger, "sourceId" | "eventTypes" | "conditions">,
  sources: readonly Pick<EventSource, "id" | "name">[],
): EventTriggerWords {
  const source = sources.find((candidate) => candidate.id === trigger.sourceId)?.name;
  const events = eventTypesLabel(t, trigger.eventTypes);
  return {
    source: source ?? t("automations.trigger.hiddenSource"),
    events,
    conditions: eventConditionsLabel(t, trigger.conditions),
    short: t("automations.trigger.short", {
      events,
      source: source ?? t("automations.trigger.hiddenSourceInline"),
    }),
  };
}

/** One line for a list row: the first trigger, and how many more there are. */
export function eventTriggersShortLabel(
  t: OpenGeniText,
  triggers: readonly Pick<EventTrigger, "sourceId" | "eventTypes" | "conditions">[],
  sources: readonly Pick<EventSource, "id" | "name">[],
): string | null {
  const [first] = triggers;
  if (!first) return null;
  const words = eventTriggerWords(t, first, sources).short;
  return triggers.length === 1
    ? words
    : t("automations.triggers.shortAndMore", { words, count: triggers.length - 1 });
}

/** The descriptor a source lists for exactly this type. */
export function eventTypeDescriptor(
  type: string,
  descriptors: readonly EventTypeDescriptor[],
): EventTypeDescriptor | undefined {
  return descriptors.find((descriptor) => descriptor.type === type);
}

/**
 * Fields worth matching for the picked types: their app's own fields first,
 * then the fields every event has. Each field once.
 */
export function eventConditionFieldSuggestions(
  t: OpenGeniText,
  eventTypes: readonly string[],
  descriptors: readonly EventTypeDescriptor[],
): Array<{ field: string; description: string }> {
  const picked = descriptors.filter((descriptor) => eventTypes.includes(descriptor.type));
  const seen = new Set<string>();
  const fields: Array<{ field: string; description: string }> = [];
  for (const entry of [
    ...picked.flatMap((descriptor) => descriptor.fields),
    ...eventCommonFields(t),
  ]) {
    if (seen.has(entry.field)) continue;
    seen.add(entry.field);
    fields.push(entry);
  }
  return fields;
}
