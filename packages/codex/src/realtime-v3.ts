/**
 * Codex GPT-Live Frameless Bidi (V3) wire adapter.
 *
 * These shapes are pinned to openai/codex@fa1d4c40. V3 delegates work with
 * `delegation.created`; it does not expose the ordinary Realtime V2
 * `function_call` protocol.
 */

export const CODEX_REALTIME_INITIAL_ITEMS_MAX_COUNT = 128;
export const CODEX_REALTIME_INITIAL_ITEMS_MAX_TOKENS = 8_192;
export const CODEX_REALTIME_CONTEXT_APPEND_MAX_BYTES = 500;

export type CodexRealtimeInitialItem = {
  role: "user" | "developer" | "assistant";
  text: string;
};

type ProviderEventIdentity = {
  providerEventId: string | null;
};

export type CodexRealtimeV3Event =
  | (ProviderEventIdentity & {
      type: "session.started" | "session.updated";
      sessionId: string;
      instructions: string | null;
    })
  | (ProviderEventIdentity & {
      type: "input_transcript.added" | "output_transcript.added";
      itemId: string | null;
      text: string;
    })
  | (ProviderEventIdentity & {
      type: "output_audio.delta";
      audio: string;
      startMs: number | null;
      endMs: number | null;
    })
  | (ProviderEventIdentity & {
      type: "turn.done";
      turnId: string;
      role: "user" | "assistant";
      transcript: string;
    })
  | (ProviderEventIdentity & {
      type: "delegation.created";
      delegationItemId: string;
      inputTranscript: string;
      offsetMs: number | null;
    })
  | (ProviderEventIdentity & {
      type: "error";
      message: string;
    });

export type CodexRealtimeV3ParseFailure = {
  ok: false;
  reason: "invalid_json" | "missing_type" | "unsupported_type" | "invalid_shape";
  eventType: string | null;
};

export type CodexRealtimeV3ParseResult =
  | { ok: true; event: CodexRealtimeV3Event }
  | CodexRealtimeV3ParseFailure;

export type CodexRealtimeV3ContextAppendChannel = "speakable" | "commentary";

export type CodexRealtimeV3DelegationContextAppend = {
  type: "delegation.context.append";
  delegation_item_id: string;
  channel?: CodexRealtimeV3ContextAppendChannel | undefined;
  content: Array<{ type: "input_text"; text: string }>;
};

export type CodexRealtimeV3SessionContextAppend = {
  type: "session.context.append";
  channel?: CodexRealtimeV3ContextAppendChannel | undefined;
  content: Array<{ type: "input_text"; text: string }>;
};

export function parseCodexRealtimeV3Event(payload: string): CodexRealtimeV3ParseResult {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return failure("invalid_json", null);
  }
  const event = record(value);
  const type = stringField(event, "type");
  if (!type) return failure("missing_type", null);
  const providerEventId = stringField(event, "event_id") ?? stringField(event, "id") ?? null;

  if (type === "session.started" || type === "session.updated") {
    const session = record(event.session);
    const sessionId = stringField(session, "id");
    if (!sessionId) return failure("invalid_shape", type);
    return {
      ok: true,
      event: {
        type,
        providerEventId,
        sessionId,
        instructions: stringField(session, "instructions") ?? null,
      },
    };
  }

  if (type === "input_transcript.added" || type === "output_transcript.added") {
    const item = record(event.item);
    const text = stringField(item, "text");
    if (text === undefined) return failure("invalid_shape", type);
    return {
      ok: true,
      event: {
        type,
        providerEventId,
        itemId: stringField(item, "id") ?? null,
        text,
      },
    };
  }

  if (type === "output_audio.delta") {
    const audio = stringField(event, "audio");
    if (audio === undefined) return failure("invalid_shape", type);
    return {
      ok: true,
      event: {
        type,
        providerEventId,
        audio,
        startMs: finiteNumberField(event, "start_ms"),
        endMs: finiteNumberField(event, "end_ms"),
      },
    };
  }

  if (type === "turn.done") {
    const turn = record(event.turn);
    const turnId = stringField(turn, "id");
    const role = stringField(turn, "role");
    const transcript = stringField(turn, "transcript");
    if (!turnId || (role !== "user" && role !== "assistant") || transcript === undefined) {
      return failure("invalid_shape", type);
    }
    return {
      ok: true,
      event: { type, providerEventId, turnId, role, transcript },
    };
  }

  if (type === "delegation.created") {
    const item = record(event.item);
    const delegationItemId = stringField(item, "id");
    if (
      !delegationItemId ||
      stringField(item, "type") !== "delegation" ||
      stringField(item, "target") !== "client" ||
      !Array.isArray(item.content)
    ) {
      return failure("invalid_shape", type);
    }
    const inputTranscript = item.content
      .map(record)
      .filter((content) => stringField(content, "type") === "input_text")
      .map((content) => stringField(content, "text") ?? "")
      .join("");
    return {
      ok: true,
      event: {
        type,
        providerEventId,
        delegationItemId,
        inputTranscript,
        offsetMs: finiteNumberField(event, "offset_ms"),
      },
    };
  }

  if (type === "error") {
    const nested = record(event.error);
    const message =
      stringField(event, "message") ??
      stringField(nested, "message") ??
      (event.error === undefined ? undefined : JSON.stringify(event.error));
    if (message === undefined) return failure("invalid_shape", type);
    return { ok: true, event: { type, providerEventId, message } };
  }

  return failure("unsupported_type", type);
}

export function encodeCodexRealtimeV3DelegationContextAppend(input: {
  delegationItemId: string;
  text: string;
  channel?: CodexRealtimeV3ContextAppendChannel | undefined;
}): CodexRealtimeV3DelegationContextAppend[] {
  return contextAppendChunks(input.text).map((text) => ({
    type: "delegation.context.append",
    delegation_item_id: input.delegationItemId,
    ...(input.channel ? { channel: input.channel } : {}),
    content: [{ type: "input_text", text }],
  }));
}

export function encodeCodexRealtimeV3SessionContextAppend(input: {
  text: string;
  channel?: CodexRealtimeV3ContextAppendChannel | undefined;
}): CodexRealtimeV3SessionContextAppend[] {
  return contextAppendChunks(input.text).map((text) => ({
    type: "session.context.append",
    ...(input.channel ? { channel: input.channel } : {}),
    content: [{ type: "input_text", text }],
  }));
}

export function contextAppendChunks(text: string): string[] {
  if (utf8ByteLength(text) <= CODEX_REALTIME_CONTEXT_APPEND_MAX_BYTES) return [text];
  const chunks: string[] = [];
  let chunk = "";
  let bytes = 0;
  for (const character of text) {
    const characterBytes = utf8ByteLength(character);
    if (bytes + characterBytes > CODEX_REALTIME_CONTEXT_APPEND_MAX_BYTES && chunk) {
      chunks.push(chunk);
      chunk = "";
      bytes = 0;
    }
    chunk += character;
    bytes += characterBytes;
  }
  if (chunk || text.length === 0) chunks.push(chunk);
  return chunks;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function failure(
  reason: CodexRealtimeV3ParseFailure["reason"],
  eventType: string | null,
): CodexRealtimeV3ParseFailure {
  return { ok: false, reason, eventType };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}

function finiteNumberField(value: Record<string, unknown>, key: string): number | null {
  const candidate = value[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
}
