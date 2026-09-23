import { describe, expect, test } from "bun:test";
import {
  SESSION_EVENT_PAYLOAD_MAX_BYTES,
  sessionEventJsonBytes,
  type SessionEvent,
} from "@opengeni/contracts";
import {
  SESSION_EVENT_COALESCED_TEXT_TARGET_BYTES,
  boundSessionEventHttpPage,
  coalesceSessionEventDeltas,
  coalesceSessionEventDeltasWithCoverage,
  formatSessionEventSse,
} from "../src/index";

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
  test("preserves message identities and never coalesces across their boundary", () => {
    const result = coalesceSessionEventDeltas([
      event(1, "agent.message.delta", { text: "calc", messageId: "message-a" }),
      event(2, "agent.message.delta", { text: "ulation", messageId: "message-a" }),
      event(3, "agent.message.delta", { text: "next", messageId: "message-b" }),
    ]);
    expect(result.map((item) => item.payload)).toEqual([
      { text: "calculation", messageId: "message-a", coalescedUntil: 2 },
      { text: "next", messageId: "message-b", coalescedUntil: 3 },
    ]);
  });
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

  test("coalesces sandbox chunk runs and breaks on name, stream, and commandId", () => {
    // The CANONICAL wire shape (contracts SandboxCommandOutputDeltaPayload):
    // { stream, chunk, commandId?, seq? }. text/output are legacy-tolerated.
    const result = coalesceSessionEventDeltas([
      event(1, "sandbox.command.output.delta", {
        stream: "stdout",
        chunk: "one\n",
        commandId: "cmd-1",
      }),
      event(2, "sandbox.command.output.delta", {
        stream: "stdout",
        chunk: "two\n",
        commandId: "cmd-1",
      }),
      // stderr of the SAME command must not merge into the stdout run.
      event(3, "sandbox.command.output.delta", {
        stream: "stderr",
        chunk: "warn\n",
        commandId: "cmd-1",
      }),
      // A new command starts a new run even on the same stream.
      event(4, "sandbox.command.output.delta", {
        stream: "stdout",
        chunk: "next\n",
        commandId: "cmd-2",
      }),
      // Legacy shapes still coalesce (text/output fallbacks).
      event(5, "sandbox.command.output.delta", {
        name: "build",
        text: "legacy\n",
      }),
      event(6, "sandbox.command.output.delta", {
        name: "build",
        output: "older\n",
      }),
    ]);

    expect(result.map((item) => item.payload)).toEqual([
      {
        chunk: "one\ntwo\n",
        coalescedUntil: 2,
        stream: "stdout",
        commandId: "cmd-1",
      },
      {
        chunk: "warn\n",
        coalescedUntil: 3,
        stream: "stderr",
        commandId: "cmd-1",
      },
      {
        chunk: "next\n",
        coalescedUntil: 4,
        stream: "stdout",
        commandId: "cmd-2",
      },
      { chunk: "legacy\nolder\n", coalescedUntil: 6, name: "build" },
    ]);
  });

  test("extracts reasoning text from raw item content parts", () => {
    const result = coalesceSessionEventDeltas([
      event(1, "agent.reasoning.delta", {
        item: {
          rawItem: {
            content: [{ text: "look " }, { text: "here" }, { other: true }],
          },
        },
      }),
      event(2, "agent.reasoning.delta", { text: " now" }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.payload).toEqual({
      text: "look here now",
      coalescedUntil: 2,
    });
  });

  test("does not recreate an oversized payload when a long delta run is coalesced", () => {
    const events = Array.from({ length: 2_000 }, (_, index) =>
      event(index + 1, "agent.message.delta", {
        text: `${index === 0 ? "HEAD-" : ""}${"x".repeat(2_000)}${index === 1_999 ? "-TAIL" : ""}`,
      }),
    );

    const result = coalesceSessionEventDeltas(events);

    expect(result.length).toBeGreaterThan(1);
    for (const projected of result) {
      expect(sessionEventJsonBytes(projected.payload)).toBeLessThanOrEqual(
        SESSION_EVENT_PAYLOAD_MAX_BYTES,
      );
    }
    expect(result.at(-1)?.payload).toMatchObject({ coalescedUntil: 2_000 });
    expect(JSON.stringify(result[0]?.payload)).toContain("HEAD-");
    expect(JSON.stringify(result.at(-1)?.payload)).toContain("-TAIL");
    expect(result.map((item) => (item.payload as { text: string }).text).join("")).toBe(
      events.map((item) => (item.payload as { text: string }).text).join(""),
    );
    expect(result.map((projected) => Number((projected.payload as any).coalescedUntil))).toEqual(
      [...result]
        .map((projected) => Number((projected.payload as any).coalescedUntil))
        .sort((left, right) => left - right),
    );
  });

  test("does not absorb an oversized delta into an empty prefix run", () => {
    const result = coalesceSessionEventDeltas([
      event(1, "agent.message.delta", { text: "" }),
      event(2, "agent.message.delta", {
        text: "x".repeat(SESSION_EVENT_COALESCED_TEXT_TARGET_BYTES * 4),
      }),
      event(3, "agent.message.delta", { text: "tail" }),
    ]);

    expect(result).toHaveLength(3);
    expect(result.map((projected) => (projected.payload as any).coalescedUntil)).toEqual([1, 2, 3]);
    expect(result.map((projected) => (projected.payload as { text: string }).text)).toEqual([
      "",
      "x".repeat(SESSION_EVENT_COALESCED_TEXT_TARGET_BYTES * 4),
      "tail",
    ]);
  });

  for (const type of [
    "agent.message.delta",
    "agent.reasoning.delta",
    "sandbox.command.output.delta",
  ] as const) {
    test(`preserves long UTF-8 ${type} text across coalescing, SSE, and default HTTP`, () => {
      const key = type === "sandbox.command.output.delta" ? "chunk" : "text";
      const parts = [
        "",
        '界🙂e\u0301"\\\n'.repeat(150_000),
        ...Array.from({ length: 40 }, (_, index) => `${index}:${"🙂界".repeat(2_000)}\n`),
        "end",
      ];
      const events = parts.map((text, index) => event(index + 1, type, { [key]: text }));
      const compact = coalesceSessionEventDeltasWithCoverage(events);
      const textOf = (items: SessionEvent[]) =>
        items.map((item) => (item.payload as Record<string, string>)[key]).join("");
      expect(textOf(compact.events)).toBe(parts.join(""));
      expect(compact.events.length).toBeLessThan(events.length);

      const replayed: SessionEvent[] = [];
      let cursor = 0;
      while (replayed.length < compact.events.length) {
        const page = boundSessionEventHttpPage(
          compact.events.filter((item) => item.sequence > cursor),
          { direction: "after", coveredThroughBySequence: compact.coveredThroughBySequence },
        );
        expect(page.events.length).toBeGreaterThan(0);
        expect(page.nextSequence!).toBeGreaterThan(cursor);
        expect(page.bytes).toBe(sessionEventJsonBytes(page.events));
        for (const item of page.events) {
          const coverage = compact.coveredThroughBySequence.get(item.sequence)!;
          const frame = formatSessionEventSse(item, coverage);
          expect(frame).toStartWith(`id: ${coverage}\n`);
          const data = frame
            .split("\n")
            .find((line) => line.startsWith("data: "))!
            .slice(6);
          expect(JSON.parse(data)).toEqual(item);
          replayed.push(JSON.parse(data));
        }
        cursor = page.nextSequence!;
      }
      expect(replayed).toEqual(compact.events);
      expect(textOf(replayed)).toBe(parts.join(""));
      expect(cursor).toBe(events.at(-1)!.sequence);
    });
  }
});
