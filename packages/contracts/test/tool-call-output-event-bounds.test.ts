import { describe, expect, test } from "bun:test";
import {
  TOOL_CALL_OUTPUT_EVENT_MAX_BYTES,
  boundSessionEventPayloadForWrite,
  sessionEventJsonBytes,
  sessionEventPayloadTruncation,
} from "../src";

function noisyText(bytes: number): string {
  let text = "";
  let index = 0;
  while (text.length < bytes) text += `line ${index++} ${"abcdefghij".repeat(7)}; `;
  return text.slice(0, bytes);
}

describe("boundSessionEventPayloadForWrite", () => {
  test("keeps ordinary tool output and every other event type exactly", () => {
    const small = { id: "call-1", output: { content: [{ type: "text", text: "ok" }] } };
    expect(boundSessionEventPayloadForWrite("agent.toolCall.output", small)).toBe(small);
    const atLimit = { id: "call-2", output: noisyText(TOOL_CALL_OUTPUT_EVENT_MAX_BYTES - 64) };
    expect(boundSessionEventPayloadForWrite("agent.toolCall.output", atLimit)).toBe(atLimit);
    const bigMessage = { text: noisyText(2 * TOOL_CALL_OUTPUT_EVENT_MAX_BYTES) };
    expect(boundSessionEventPayloadForWrite("user.message", bigMessage)).toBe(bigMessage);
  });

  test("stores an oversized string output as an explicit head and tail preview", () => {
    const text = `HEAD-MARKER\n${noisyText(8 * 1024 * 1024)}\nTAIL-MARKER`;
    const payload = { id: "call-big", output: text };
    const bounded = boundSessionEventPayloadForWrite("agent.toolCall.output", payload) as {
      id: string;
      output: string;
    };
    expect(sessionEventJsonBytes(bounded)).toBeLessThanOrEqual(TOOL_CALL_OUTPUT_EVENT_MAX_BYTES);
    expect(bounded.id).toBe("call-big");
    expect(bounded.output.startsWith("HEAD-MARKER")).toBe(true);
    expect(bounded.output.endsWith("TAIL-MARKER")).toBe(true);
    // More than the model-facing truncation keeps (about 48 KB of text).
    expect(bounded.output.length).toBeGreaterThan(48 * 1024);
    const truncation = sessionEventPayloadTruncation(bounded);
    expect(truncation).toMatchObject({
      truncated: true,
      surface: "durable_audit",
      reason: "payload_bytes_exceeded",
      originalBytes: sessionEventJsonBytes(payload),
      fullEvidence: { available: false, reason: "not_retained" },
    });
  });

  test("bounds structured MCP results and keeps their identity and error flag", () => {
    const payload = {
      id: "call-mcp",
      error: true,
      output: {
        isError: true,
        content: [
          { type: "text", text: noisyText(3 * 1024 * 1024) },
          { type: "text", text: noisyText(3 * 1024 * 1024) },
        ],
        structuredContent: { rows: Array.from({ length: 5_000 }, (_, row) => ({ row })) },
      },
    };
    const bounded = boundSessionEventPayloadForWrite("agent.toolCall.output", payload) as {
      id: string;
      error: boolean;
      output: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(sessionEventJsonBytes(bounded)).toBeLessThanOrEqual(TOOL_CALL_OUTPUT_EVENT_MAX_BYTES);
    expect(bounded.id).toBe("call-mcp");
    expect(bounded.error).toBe(true);
    expect(bounded.output.isError).toBe(true);
    expect(bounded.output.content).toHaveLength(2);
    expect(sessionEventPayloadTruncation(bounded)?.truncated).toBe(true);
  });
});
