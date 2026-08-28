import { describe, expect, test } from "bun:test";
import {
  observeSessionEventAppendPhase,
  sessionEventAppendClass,
  type SessionEventAppendPhaseObservation,
} from "../src/index";

describe("session event append phase observer", () => {
  test("classifies raw, semantic, and mixed batches without using event types as labels", () => {
    expect(sessionEventAppendClass([{ type: "agent.message.delta" }])).toBe("raw");
    expect(sessionEventAppendClass([{ type: "agent.message.completed" }])).toBe("semantic");
    expect(
      sessionEventAppendClass([
        { type: "agent.message.delta" },
        { type: "agent.message.completed" },
      ]),
    ).toBe("mixed");
  });

  test("delivers bounded observations and isolates a failing telemetry sink", () => {
    const observations: SessionEventAppendPhaseObservation[] = [];
    const observation: SessionEventAppendPhaseObservation = {
      phase: "event_insert",
      eventClass: "raw",
      eventCount: 50,
      outcome: "ok",
      durationSeconds: 0.01,
    };

    observeSessionEventAppendPhase({ onPhase: (value) => observations.push(value) }, observation);
    expect(observations).toEqual([observation]);
    expect(() =>
      observeSessionEventAppendPhase(
        {
          onPhase: () => {
            throw new Error("metrics registry unavailable");
          },
        },
        observation,
      ),
    ).not.toThrow();
  });
});
