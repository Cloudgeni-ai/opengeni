import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/contracts";
import { coalesceSessionEventDeltas } from "../src/index";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const TURN_A = "33333333-3333-4333-8333-333333333333";
const TURN_B = "44444444-4444-4444-8444-444444444444";

function event(
  sequence: number,
  type: SessionEvent["type"] = "agent.message.delta",
  payload: unknown = { text: String(sequence) },
  turnId: string | null = TURN_A,
): SessionEvent {
  return {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    sequence,
    type,
    payload,
    occurredAt: new Date(1_770_000_000_000 + sequence).toISOString(),
    clientEventId: null,
    turnId,
  };
}

describe("coalesceSessionEventDeltas", () => {
  test("leaves empty and no-delta inputs untouched", () => {
    expect(coalesceSessionEventDeltas([])).toEqual([]);
    const events = [
      event(1, "session.created", {}, null),
      event(2, "user.message", { text: "hello" }, null),
    ];
    expect(coalesceSessionEventDeltas(events)).toEqual(events);
  });

  test("coalesces a single message delta run onto the first event cursor", () => {
    const result = coalesceSessionEventDeltas([
      event(1, "agent.message.delta", { text: "hel" }),
      event(2, "agent.message.delta", { text: "lo" }),
      event(3, "agent.message.delta", { text: "!" }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "00000000-0000-4000-8000-000000000001",
      sequence: 1,
      occurredAt: new Date(1_770_000_000_001).toISOString(),
      payload: { text: "hello!", coalescedUntil: 3 },
    });
  });

  test("starts a new run when a non-delta event is interleaved", () => {
    const result = coalesceSessionEventDeltas([
      event(1, "agent.message.delta", { text: "a" }),
      event(2, "turn.updated", {}),
      event(3, "agent.message.delta", { text: "b" }),
    ]);

    expect(result.map((item) => item.sequence)).toEqual([1, 2, 3]);
    expect(result.map((item) => item.payload)).toEqual([
      { text: "a", coalescedUntil: 1 },
      {},
      { text: "b", coalescedUntil: 3 },
    ]);
  });

  test("starts a new run when type or turn changes", () => {
    const result = coalesceSessionEventDeltas([
      event(1, "agent.message.delta", { text: "a" }, TURN_A),
      event(2, "agent.reasoning.delta", { text: "think" }, TURN_A),
      event(3, "agent.message.delta", { text: "b" }, TURN_A),
      event(4, "agent.message.delta", { text: "c" }, TURN_B),
    ]);

    expect(result.map((item) => [item.type, item.turnId, item.payload])).toEqual([
      ["agent.message.delta", TURN_A, { text: "a", coalescedUntil: 1 }],
      ["agent.reasoning.delta", TURN_A, { text: "think", coalescedUntil: 2 }],
      ["agent.message.delta", TURN_A, { text: "b", coalescedUntil: 3 }],
      ["agent.message.delta", TURN_B, { text: "c", coalescedUntil: 4 }],
    ]);
  });

  test("starts a new sandbox output run when the command name changes", () => {
    const result = coalesceSessionEventDeltas([
      event(1, "sandbox.command.output.delta", { name: "build", text: "one\n" }),
      event(2, "sandbox.command.output.delta", { name: "build", output: "two\n" }),
      event(3, "sandbox.command.output.delta", { name: "test", text: "ok\n" }),
      event(4, "sandbox.command.output.delta", { text: "unnamed\n" }),
    ]);

    expect(result.map((item) => item.payload)).toEqual([
      { text: "one\ntwo\n", coalescedUntil: 2, name: "build" },
      { text: "ok\n", coalescedUntil: 3, name: "test" },
      { text: "unnamed\n", coalescedUntil: 4 },
    ]);
  });

  test("extracts reasoning text from raw item content parts", () => {
    const result = coalesceSessionEventDeltas([
      event(1, "agent.reasoning.delta", { item: { rawItem: { content: [{ text: "look " }, { text: "here" }, { other: true }] } } }),
      event(2, "agent.reasoning.delta", { text: " now" }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.payload).toEqual({ text: "look here now", coalescedUntil: 2 });
  });
});
