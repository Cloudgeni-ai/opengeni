import { describe, expect, test } from "bun:test";
import {
  CODEX_REALTIME_CONTEXT_APPEND_MAX_BYTES,
  CODEX_REALTIME_V3_MAX_EVENT_BYTES,
  CODEX_REALTIME_V3_MAX_IDENTIFIER_BYTES,
  CODEX_REALTIME_V3_MAX_TEXT_BYTES,
  contextAppendChunks,
  encodeCodexRealtimeV3DelegationContextAppend,
  encodeCodexRealtimeV3SessionContextAppend,
  parseCodexRealtimeV3Event,
} from "../src";

describe("Codex Frameless Bidi V3 protocol", () => {
  test("parses the proven V3 transcript, turn, audio, and session shapes", () => {
    expect(
      parseCodexRealtimeV3Event(
        JSON.stringify({
          type: "session.started",
          event_id: "event-1",
          session: { id: "rtc-1", instructions: "backend prompt" },
        }),
      ),
    ).toEqual({
      ok: true,
      event: {
        type: "session.started",
        providerEventId: "event-1",
        sessionId: "rtc-1",
        instructions: "backend prompt",
      },
    });
    expect(
      parseCodexRealtimeV3Event(
        JSON.stringify({
          type: "input_transcript.added",
          item: { id: "input-1", type: "input_transcript", text: "hello" },
        }),
      ),
    ).toMatchObject({
      ok: true,
      event: { type: "input_transcript.added", text: "hello" },
    });
    expect(
      parseCodexRealtimeV3Event(
        JSON.stringify({
          type: "turn.done",
          turn: { id: "turn-1", role: "assistant", transcript: "done" },
        }),
      ),
    ).toMatchObject({
      ok: true,
      event: {
        type: "turn.done",
        turnId: "turn-1",
        role: "assistant",
        transcript: "done",
      },
    });
    expect(
      parseCodexRealtimeV3Event(
        JSON.stringify({
          type: "output_audio.delta",
          audio: "AAE=",
          start_ms: 0,
          end_ms: 100,
        }),
      ),
    ).toMatchObject({
      ok: true,
      event: {
        type: "output_audio.delta",
        audio: "AAE=",
        startMs: 0,
        endMs: 100,
      },
    });
  });

  test("parses only client-targeted V3 delegations and never V2 function calls", () => {
    expect(
      parseCodexRealtimeV3Event(
        JSON.stringify({
          type: "delegation.created",
          offset_ms: 1_000,
          item: {
            id: "delegation-1",
            type: "delegation",
            target: "client",
            content: [
              { type: "input_text", text: "check " },
              { type: "input_text", text: "the workspace" },
            ],
          },
        }),
      ),
    ).toEqual({
      ok: true,
      event: {
        type: "delegation.created",
        providerEventId: null,
        delegationItemId: "delegation-1",
        inputTranscript: "check the workspace",
        offsetMs: 1_000,
      },
    });
    expect(
      parseCodexRealtimeV3Event(
        JSON.stringify({
          type: "response.function_call_arguments.done",
          call_id: "call-1",
        }),
      ),
    ).toEqual({
      ok: false,
      reason: "unsupported_type",
      eventType: "response.function_call_arguments.done",
    });
    expect(
      parseCodexRealtimeV3Event(
        JSON.stringify({
          type: "delegation.created",
          item: {
            id: "delegation-1",
            type: "delegation",
            target: "server",
            content: [],
          },
        }),
      ),
    ).toMatchObject({ ok: false, reason: "invalid_shape" });
  });

  test("reports malformed and provider error events without throwing", () => {
    expect(parseCodexRealtimeV3Event("{")).toEqual({
      ok: false,
      reason: "invalid_json",
      eventType: null,
    });
    expect(parseCodexRealtimeV3Event("{}")).toEqual({
      ok: false,
      reason: "missing_type",
      eventType: null,
    });
    expect(
      parseCodexRealtimeV3Event(
        JSON.stringify({
          type: "error",
          error: { message: "provider rejected append" },
        }),
      ),
    ).toEqual({
      ok: true,
      event: {
        type: "error",
        providerEventId: null,
        message: "provider rejected append",
      },
    });
  });

  test("bounds raw events, identifiers, and text by exact UTF-8 bytes", () => {
    expect(parseCodexRealtimeV3Event("x".repeat(CODEX_REALTIME_V3_MAX_EVENT_BYTES + 1))).toEqual({
      ok: false,
      reason: "oversized_event",
      eventType: null,
    });
    expect(
      parseCodexRealtimeV3Event(
        JSON.stringify({
          type: "input_transcript.added",
          event_id: "🙂".repeat(Math.floor(CODEX_REALTIME_V3_MAX_IDENTIFIER_BYTES / 4) + 1),
          item: { text: "valid" },
        }),
      ),
    ).toEqual({
      ok: false,
      reason: "oversized_field",
      eventType: "input_transcript.added",
    });
    expect(
      parseCodexRealtimeV3Event(
        JSON.stringify({
          type: "turn.done",
          turn: {
            id: "turn-1",
            role: "assistant",
            transcript: "🙂".repeat(Math.floor(CODEX_REALTIME_V3_MAX_TEXT_BYTES / 4) + 1),
          },
        }),
      ),
    ).toMatchObject({ ok: false, reason: "oversized_field", eventType: "turn.done" });
    expect(
      parseCodexRealtimeV3Event(
        JSON.stringify({
          type: "delegation.created",
          item: {
            id: "delegation-1",
            type: "delegation",
            target: "client",
            content: [
              { type: "input_text", text: "a".repeat(70_000) },
              { type: "input_text", text: "b".repeat(70_000) },
            ],
          },
        }),
      ),
    ).toMatchObject({
      ok: false,
      reason: "oversized_field",
      eventType: "delegation.created",
    });
    expect(
      parseCodexRealtimeV3Event(
        JSON.stringify({
          type: "input_transcript.added",
          event_id: "e".repeat(CODEX_REALTIME_V3_MAX_IDENTIFIER_BYTES),
          item: { text: "t".repeat(CODEX_REALTIME_V3_MAX_TEXT_BYTES) },
        }),
      ),
    ).toMatchObject({ ok: true });
  });

  test("encodes exact V3 context appends in UTF-8-safe 500-byte chunks", () => {
    const text = `${"a".repeat(501)}${"🙂".repeat(200)}`;
    const chunks = contextAppendChunks(text);
    expect(chunks.join("")).toBe(text);
    expect(
      chunks.every(
        (chunk) =>
          new TextEncoder().encode(chunk).byteLength <= CODEX_REALTIME_CONTEXT_APPEND_MAX_BYTES,
      ),
    ).toBe(true);
    expect(
      encodeCodexRealtimeV3DelegationContextAppend({
        delegationItemId: "delegation-1",
        text: "result",
        channel: "speakable",
      }),
    ).toEqual([
      {
        type: "delegation.context.append",
        delegation_item_id: "delegation-1",
        channel: "speakable",
        content: [{ type: "input_text", text: "result" }],
      },
    ]);
    expect(encodeCodexRealtimeV3SessionContextAppend({ text: "update" })).toEqual([
      {
        type: "session.context.append",
        content: [{ type: "input_text", text: "update" }],
      },
    ]);
  });
});
