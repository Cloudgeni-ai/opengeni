import {
  SCHEDULED_OCCURRENCE_EVENT_DATA_MAX_BYTES,
  SCHEDULED_OCCURRENCE_EVENTS_MAX_BYTES,
  type InboundEvent,
  type InboundEventSummary,
  type ScheduledOccurrenceEvent,
  type ScheduledOccurrenceEvents,
} from "@opengeni/contracts";
import { boundEventData, jsonUtf8Bytes } from "./normalize";

/**
 * The events an event run carries into its chat. Each event keeps its summary
 * and a bounded excerpt of its data; events are added oldest first while they
 * fit in `budgetBytes`. An event whose stored copy already expired is carried
 * as its summary only.
 */
export function scheduledOccurrenceEvents(input: {
  occurrenceId: string;
  eventCount: number;
  gapBefore: boolean;
  summaries: readonly InboundEventSummary[];
  events: readonly InboundEvent[];
  /** Bytes left in the chat update; capped at the events budget. */
  budgetBytes: number;
}): ScheduledOccurrenceEvents {
  const budget = Math.min(SCHEDULED_OCCURRENCE_EVENTS_MAX_BYTES, Math.max(0, input.budgetBytes));
  const full = new Map(input.events.map((event) => [event.id, event]));
  const result: ScheduledOccurrenceEvents = {
    occurrenceId: input.occurrenceId,
    eventCount: input.eventCount,
    events: [],
    gapBefore: input.gapBefore,
  };
  for (const summary of input.summaries) {
    const stored = full.get(summary.id);
    const bounded = stored
      ? boundEventData(stored.data, SCHEDULED_OCCURRENCE_EVENT_DATA_MAX_BYTES)
      : { data: {}, truncated: true };
    const event: ScheduledOccurrenceEvent = {
      ...summary,
      data: bounded.data,
      dataTruncated: bounded.truncated || (stored?.dataTruncated ?? true),
    };
    const next = { ...result, events: [...result.events, event] };
    if (jsonUtf8Bytes(next) > budget) break;
    result.events.push(event);
  }
  return result;
}
