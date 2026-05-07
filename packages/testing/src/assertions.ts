import { expect } from "bun:test";
import type { SessionEvent, SessionEventType } from "@infra-agents/contracts";

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
