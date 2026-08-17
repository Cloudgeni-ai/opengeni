import { performance } from "node:perf_hooks";
import type { SessionEvent } from "@opengeni/sdk";
import { boundBrowserSessionEventWindow } from "../packages/react/src/hooks/use-session-events";
import { buildTimeline, groupTimeline } from "../packages/react/src/timeline";

function integerArgument(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  const parsed = Number.parseInt(index < 0 ? "" : (process.argv[index + 1] ?? ""), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const eventCount = integerArgument("--events", 10_000);
const payloadBytes = integerArgument("--payload-bytes", 128);
const samples = integerArgument("--samples", 7);
const appendCount = integerArgument("--append-events", 256);
const maxWindowBytes = integerArgument("--max-window-bytes", 64 * 1024 * 1024);

function event(sequence: number, type: string, payload: unknown, turnId: string): SessionEvent {
  return {
    id: `evt-${sequence}`,
    workspaceId: "11111111-1111-4111-8111-111111111111",
    sessionId: "22222222-2222-4222-8222-222222222222",
    sequence,
    type,
    payload,
    occurredAt: new Date(1_750_000_000_000 + sequence).toISOString(),
    clientEventId: null,
    turnId,
  };
}

function events(count: number, startSequence = 1): SessionEvent[] {
  const text = "x".repeat(payloadBytes);
  return Array.from({ length: count }, (_, offset) => {
    const sequence = startSequence + offset;
    const turnNumber = Math.floor((sequence - 1) / 4);
    const turnId = `turn-${turnNumber}`;
    switch ((sequence - 1) % 4) {
      case 0:
        return event(sequence, "user.message", { text }, turnId);
      case 1:
        return event(sequence, "agent.message.delta", { text }, turnId);
      case 2:
        return event(sequence, "agent.message.completed", { text }, turnId);
      default:
        return event(sequence, "turn.completed", {}, turnId);
    }
  });
}

type Measurement = {
  boundMs: number;
  projectionMs: number;
  groupingMs: number;
  appendBoundMs: number;
  appendProjectionMs: number;
  retainedEvents: number;
  timelineItems: number;
  timelineGroups: number;
  windowBytes: number;
};

function measure(input: SessionEvent[], appended: SessionEvent[]): Measurement {
  const boundStarted = performance.now();
  const window = boundBrowserSessionEventWindow(input, {
    maxBytes: maxWindowBytes,
    maxCount: input.length + appended.length,
  });
  const boundMs = performance.now() - boundStarted;
  if (window.events.length !== input.length || window.truncated) {
    throw new Error(`lossless window retained ${window.events.length}/${input.length} events`);
  }

  const projectionStarted = performance.now();
  const timeline = buildTimeline(window.events);
  const projectionMs = performance.now() - projectionStarted;
  const groupingStarted = performance.now();
  const groups = groupTimeline(timeline);
  const groupingMs = performance.now() - groupingStarted;

  const appendBoundStarted = performance.now();
  const appendedWindow = boundBrowserSessionEventWindow([...window.events, ...appended], {
    maxBytes: maxWindowBytes,
    maxCount: input.length + appended.length,
  });
  const appendBoundMs = performance.now() - appendBoundStarted;
  if (appendedWindow.events.length !== input.length + appended.length || appendedWindow.truncated) {
    throw new Error(
      `lossless append retained ${appendedWindow.events.length}/${input.length + appended.length} events`,
    );
  }
  const appendProjectionStarted = performance.now();
  buildTimeline(appendedWindow.events);
  const appendProjectionMs = performance.now() - appendProjectionStarted;

  return {
    boundMs,
    projectionMs,
    groupingMs,
    appendBoundMs,
    appendProjectionMs,
    retainedEvents: window.events.length,
    timelineItems: timeline.length,
    timelineGroups: groups.length,
    windowBytes: window.bytes,
  };
}

function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * quantile) - 1]!;
}

const input = events(eventCount);
const appended = events(appendCount, eventCount + 1);
const collected: Measurement[] = [];
for (let sample = 0; sample < samples; sample += 1) {
  Bun.gc(true);
  collected.push(measure(input, appended));
}

const timingFields = [
  "boundMs",
  "projectionMs",
  "groupingMs",
  "appendBoundMs",
  "appendProjectionMs",
] as const;
console.log(
  JSON.stringify({
    eventCount,
    payloadBytes,
    appendCount,
    maxWindowBytes,
    samples,
    retainedEvents: collected[0]!.retainedEvents,
    timelineItems: collected[0]!.timelineItems,
    timelineGroups: collected[0]!.timelineGroups,
    windowBytes: collected[0]!.windowBytes,
    timingsMs: Object.fromEntries(
      timingFields.map((field) => {
        const values = collected.map((measurement) => measurement[field]);
        return [field, { p50: percentile(values, 0.5), p95: percentile(values, 0.95) }];
      }),
    ),
    contentParity: "pass",
  }),
);
