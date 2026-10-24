/**
 * Event triggers as people edit and read them: the editable draft, the
 * request it becomes, validation in the product's words, and short summaries
 * for rows and pages. Pure; every automation surface shares it.
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
  /** Reads after the field: "data.action is opened". */
  label: string;
  /** What the value box holds; null when the operator takes no value. */
  takes: "one" | "list" | null;
}

export const EVENT_CONDITION_OPERATORS: readonly EventConditionOperatorOption[] = [
  { value: "equals", label: "is", takes: "one" },
  { value: "not_equals", label: "is not", takes: "one" },
  { value: "in", label: "is one of", takes: "list" },
  { value: "not_in", label: "is none of", takes: "list" },
  { value: "contains", label: "contains", takes: "one" },
  { value: "exists", label: "is set", takes: null },
  { value: "not_exists", label: "is not set", takes: null },
];

export function eventConditionOperator(op: EventConditionOperator): EventConditionOperatorOption {
  return EVENT_CONDITION_OPERATORS.find((option) => option.value === op)!;
}

/** The fields every event has, besides its app's own `data.*` fields. */
export const EVENT_COMMON_FIELDS: ReadonlyArray<{ field: string; description: string }> = [
  { field: "subject", description: "What the event is about, such as acme/api#42" },
  { field: "summary", description: "The event's one-line summary" },
  { field: "actor.name", description: "Who caused it" },
  { field: "actor.kind", description: "person, bot or unknown" },
  { field: "url", description: "The link to the thing in its app" },
];

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
export function eventTypeIssue(type: string): string | null {
  if (!type) return "Enter an event type.";
  if (type.length > EVENT_TYPE_MAX_LENGTH) return "That event type is too long.";
  if (!EVENT_TYPE_PATTERN.test(type)) return "Event types have no spaces.";
  return null;
}

export function validateEventTriggers(
  draft: EventTriggersDraft,
  sources: readonly Pick<EventSource, "id" | "kind">[],
): EventTriggersIssues {
  const issues: EventTriggersIssues = { triggers: {} };
  for (const trigger of draft.triggers) {
    const found: EventTriggerIssues = {};
    const source = sources.find((candidate) => candidate.id === trigger.sourceId);
    if (!trigger.sourceId) found.source = "Choose where the events come from.";
    else if (!source) found.source = "This source is gone or you can no longer use it.";
    if (trigger.eventTypes.length === 0) found.eventTypes = "Pick at least one event.";
    else if (source?.kind === "mcp" && trigger.eventTypes.length > 1)
      found.eventTypes =
        "An MCP server trigger listens to one event. Add another trigger for more.";
    else if (trigger.eventTypes.length > EVENT_TRIGGER_TYPES_MAX)
      found.eventTypes = `Pick at most ${EVENT_TRIGGER_TYPES_MAX} events.`;
    if (!parseArguments(trigger.argumentsText).ok)
      found.arguments = "Write the settings as a JSON object, like {} or a filled-in example.";
    const conditionIssues: Record<string, string> = {};
    for (const condition of trigger.conditions) {
      const field = condition.field.trim();
      const takes = eventConditionOperator(condition.op).takes;
      if (!field) conditionIssues[condition.key] = "Name the field to check.";
      else if (!EVENT_CONDITION_FIELD_PATTERN.test(field))
        conditionIssues[condition.key] =
          "Check type, subject, summary, url, actor.kind, actor.name or a data. field.";
      else if (takes !== null && !condition.value.trim())
        conditionIssues[condition.key] =
          takes === "list" ? "Enter values separated by commas." : "Enter a value.";
    }
    if (Object.keys(conditionIssues).length > 0) found.conditions = conditionIssues;
    if (Object.keys(found).length > 0) issues.triggers[trigger.key] = found;
  }
  if (
    !Number.isInteger(draft.maxRunsPerHour) ||
    draft.maxRunsPerHour < 1 ||
    draft.maxRunsPerHour > MAX_EVENT_RUNS_PER_HOUR
  ) {
    issues.maxRunsPerHour = `Enter a whole number from 1 to ${MAX_EVENT_RUNS_PER_HOUR}.`;
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
export function eventTypeLabel(type: string): string {
  if (type === "*") return "Every event";
  if (type.endsWith(".*")) return `Every ${type.slice(0, -2)} event`;
  return type;
}

/** "pull_request.opened", "pull_request.opened or issues.opened", "pull_request.opened and 2 more". */
export function eventTypesLabel(types: readonly string[]): string {
  if (types.length === 0) return "No events picked";
  if (types.length === 1) return eventTypeLabel(types[0]!);
  if (types.length === 2) return `${eventTypeLabel(types[0]!)} or ${eventTypeLabel(types[1]!)}`;
  return `${eventTypeLabel(types[0]!)} and ${types.length - 1} more`;
}

/** "only when data.action is opened", or "only when 3 conditions hold". */
export function eventConditionsLabel(conditions: readonly EventCondition[]): string | null {
  if (conditions.length === 0) return null;
  if (conditions.length > 1) return `only when ${conditions.length} conditions hold`;
  const [condition] = conditions as [EventCondition];
  const operator = eventConditionOperator(condition.op);
  if (operator.takes === null) return `only when ${condition.field} ${operator.label}`;
  return `only when ${condition.field} ${operator.label} ${conditionValueText(condition.value)}`;
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
  trigger: Pick<EventTrigger, "sourceId" | "eventTypes" | "conditions">,
  sources: readonly Pick<EventSource, "id" | "name">[],
): EventTriggerWords {
  const source = sources.find((candidate) => candidate.id === trigger.sourceId)?.name;
  const name = source ?? "A source you can't see";
  const events = eventTypesLabel(trigger.eventTypes);
  return {
    source: name,
    events,
    conditions: eventConditionsLabel(trigger.conditions),
    short: `${events} from ${source ?? "a source you can't see"}`,
  };
}

/** One line for a list row: the first trigger, and how many more there are. */
export function eventTriggersShortLabel(
  triggers: readonly Pick<EventTrigger, "sourceId" | "eventTypes" | "conditions">[],
  sources: readonly Pick<EventSource, "id" | "name">[],
): string | null {
  const [first] = triggers;
  if (!first) return null;
  const words = eventTriggerWords(first, sources).short;
  return triggers.length === 1 ? words : `${words} · ${triggers.length - 1} more`;
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
  eventTypes: readonly string[],
  descriptors: readonly EventTypeDescriptor[],
): Array<{ field: string; description: string }> {
  const picked = descriptors.filter((descriptor) => eventTypes.includes(descriptor.type));
  const seen = new Set<string>();
  const fields: Array<{ field: string; description: string }> = [];
  for (const entry of [
    ...picked.flatMap((descriptor) => descriptor.fields),
    ...EVENT_COMMON_FIELDS,
  ]) {
    if (seen.has(entry.field)) continue;
    seen.add(entry.field);
    fields.push(entry);
  }
  return fields;
}
