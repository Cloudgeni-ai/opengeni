import { expect } from "bun:test";
import {
  turnUsageFromPayload,
  type SessionEvent,
  type SessionEventType,
} from "@opengeni/contracts";

const TERMINAL_TURN_EVENT_TYPES = new Set([
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "turn.superseded",
]);

/**
 * The events with the `usage` a terminal turn event carries checked for shape
 * and removed, so assertions about a turn's content stay exact. Tests about
 * what a turn cost read `usage` from the raw events instead.
 */
export function turnContentEvents<T extends { type: string; payload: unknown }>(events: T[]): T[] {
  return events.map((event) => {
    const payload = event.payload;
    if (
      !TERMINAL_TURN_EVENT_TYPES.has(event.type) ||
      payload === null ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      !Object.hasOwn(payload, "usage")
    ) {
      return event;
    }
    expect(turnUsageFromPayload(payload)).not.toBeNull();
    const { usage: _usage, ...content } = payload as Record<string, unknown>;
    return { ...event, payload: content };
  });
}

export function expectContiguousSequences(events: SessionEvent[], start = 1): void {
  for (let index = 0; index < events.length; index += 1) {
    expect(events[index]!.sequence).toBe(start + index);
  }
}

export function expectEventTypes(events: SessionEvent[], types: SessionEventType[]): void {
  expect(events.map((event) => event.type)).toEqual(types);
}

export function latestStatus(events: SessionEvent[]): string | null {
  for (const event of [...events].reverse()) {
    if (event.type === "session.status.changed") {
      const payload = event.payload as { status?: unknown };
      return typeof payload.status === "string" ? payload.status : null;
    }
  }
  return null;
}
