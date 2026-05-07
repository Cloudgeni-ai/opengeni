import { describe, expect, test } from "bun:test";
import { formatSse } from "../src/index";

describe("SSE formatting", () => {
  test("formats session events as named SSE messages", () => {
    const text = formatSse({
      id: "00000000-0000-4000-8000-000000000001",
      sessionId: "00000000-0000-4000-8000-000000000002",
      sequence: 7,
      type: "agent.message.delta",
      payload: { text: "hello" },
      occurredAt: "2026-05-06T00:00:00.000Z",
      clientEventId: null,
      turnId: null,
    });

    expect(text).toContain("id: 7\n");
    expect(text).toContain("event: agent.message.delta\n");
    expect(text).toContain('"text":"hello"');
    expect(text.endsWith("\n\n")).toBe(true);
  });
});
