import type { EventActor, EventCondition } from "@opengeni/contracts";
import { readPath } from "./normalize";

/** The fields of a stored event that triggers can match on. */
export type MatchableEvent = {
  type: string;
  subject: string | null;
  summary: string;
  url: string | null;
  actor: EventActor;
  data: Record<string, unknown>;
};

/** The parts of a trigger that decide whether an event fires it. */
export type MatchableTrigger = {
  eventTypes: readonly string[];
  conditions: readonly EventCondition[];
  includeOwnEvents: boolean;
};

/**
 * Event type patterns: an exact type, `*` for every type, or a prefix ending
 * in `.*` (`pull_request.*` matches `pull_request.opened`).
 */
export function eventTypeMatches(pattern: string, type: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) return type.startsWith(pattern.slice(0, -1));
  return pattern === type;
}

export function eventConditionField(event: MatchableEvent, field: string): unknown {
  switch (field) {
    case "type":
      return event.type;
    case "subject":
      return event.subject;
    case "summary":
      return event.summary;
    case "url":
      return event.url;
    case "actor.kind":
      return event.actor.kind;
    case "actor.name":
      return event.actor.name;
    default:
      return field.startsWith("data.") ? readPath(event.data, field.slice(5)) : undefined;
  }
}

function same(left: unknown, right: unknown): boolean {
  if (typeof left === "number" && typeof right === "string") return String(left) === right;
  if (typeof left === "string" && typeof right === "number") return left === String(right);
  return left === right;
}

function contains(container: unknown, value: unknown): boolean {
  if (typeof container === "string" && typeof value === "string") {
    return container.toLowerCase().includes(value.toLowerCase());
  }
  if (Array.isArray(container)) {
    return container.some(
      (entry) =>
        same(entry, value) ||
        (entry !== null &&
          typeof entry === "object" &&
          Object.values(entry as Record<string, unknown>).some((inner) => same(inner, value))),
    );
  }
  return false;
}

export function eventConditionHolds(event: MatchableEvent, condition: EventCondition): boolean {
  const actual = eventConditionField(event, condition.field);
  const values = Array.isArray(condition.value) ? condition.value : [condition.value];
  switch (condition.op) {
    case "exists":
      return actual !== undefined && actual !== null;
    case "not_exists":
      return actual === undefined || actual === null;
    case "equals":
      return same(actual, condition.value);
    case "not_equals":
      return !same(actual, condition.value);
    case "in":
      return values.some((value) => same(actual, value));
    case "not_in":
      return !values.some((value) => same(actual, value));
    case "contains":
      return contains(actual, condition.value);
  }
}

/** Whether an event fires a trigger: its type matches, every condition holds, and it is not one of Opengeni's own events unless the trigger opts in. */
export function eventMatchesTrigger(event: MatchableEvent, trigger: MatchableTrigger): boolean {
  if (event.actor.kind === "opengeni" && !trigger.includeOwnEvents) return false;
  if (!trigger.eventTypes.some((pattern) => eventTypeMatches(pattern, event.type))) return false;
  return trigger.conditions.every((condition) => eventConditionHolds(event, condition));
}
