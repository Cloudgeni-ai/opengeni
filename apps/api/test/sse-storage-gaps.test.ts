import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/contracts";
import { coalesceSessionEventDeltasWithCoverage } from "@opengeni/events";

import { coverStorageGaps } from "../src/http/sse";

function event(sequence: number, type: string, payload: Record<string, unknown> = {}) {
  return {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    workspaceId: "w",
    sessionId: "s",
    sequence,
    type,
    payload,
    occurredAt: "2026-01-01T00:00:00.000Z",
  } as unknown as SessionEvent;
}

describe("SSE coverage across intentional storage gaps", () => {
  test("each frame covers through the next stored row, and the last asks storage", async () => {
    // An archived session keeps 1, 2, 27 and 28; 3..26 were purged telemetry.
    const projection = coalesceSessionEventDeltasWithCoverage([
      event(1, "user.message"),
      event(2, "turn.queued"),
      event(27, "agent.message.completed"),
      event(28, "turn.completed"),
    ]);
    const asked: number[] = [];
    const coverage = await coverStorageGaps(projection, async (through) => {
      asked.push(through);
      return 31;
    });
    expect([...coverage.entries()]).toEqual([
      [1, 1],
      [2, 26],
      [27, 27],
      [28, 31],
    ]);
    expect(asked).toEqual([28]);
  });

  test("coalesced delta runs keep their own coverage and live delivery skips the lookup", async () => {
    const projection = coalesceSessionEventDeltasWithCoverage([
      event(3, "agent.message.delta", { delta: "Hel" }),
      event(4, "agent.message.delta", { delta: "lo" }),
      event(9, "agent.message.completed", { text: "Hello" }),
    ]);
    const coverage = await coverStorageGaps(projection, null);
    expect([...coverage.entries()]).toEqual([
      [3, 8],
      [9, 9],
    ]);
  });
});
