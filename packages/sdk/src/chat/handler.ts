import { parseSseStream } from "../sse";
import type { HumanInputAnswer } from "../types";
import {
  chatErrorSummary,
  errorResponse,
  openResolvedChat,
  readJsonObject,
  resolveChatRequest,
  sseByteStream,
  sseHeaders,
  sseLine,
  type ChatResolve,
} from "./http";
import { handleChatCompletionsRequest, handleResponsesRequest } from "./openai";
import type { OpenGeni } from "./opengeni";
import { OpenGeniChatError, type ChatChunk, type ChatRespondInput } from "./types";
import { handleVercelChatRequest } from "./vercel";

export type { ChatResolution, ChatResolve } from "./http";

export type ChatHandlerFormat = "native" | "vercel" | "openai-chat" | "openai-responses";

export type ChatHandlerOptions = {
  /** Mandatory host auth hook; see {@link ChatResolve}. */
  resolve: ChatResolve;
  /** Default wire format; a request may override it with the format header. */
  format?: ChatHandlerFormat | undefined;
};

/** Per-request wire-format override header. */
export const CHAT_FORMAT_HEADER = "x-opengeni-chat-format";
/** Header the stock React component uses to tell the host which conversation it is on. */
export const CHAT_CONVERSATION_HEADER = "x-opengeni-conversation";

const CHAT_FORMATS: ReadonlySet<string> = new Set([
  "native",
  "vercel",
  "openai-chat",
  "openai-responses",
]);

/**
 * One request handler for a product's chat endpoint. `POST` with `{ message }`
 * streams the reply in the selected format; `POST .../respond` answers a
 * pending approval or human-input request and streams the continuation.
 * Every other method is a 405.
 */
export function createChatHandler(
  og: OpenGeni,
  options: ChatHandlerOptions,
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== "POST") {
      return new Response(
        JSON.stringify({ error: { message: "Use POST.", code: "method_not_allowed" } }),
        {
          status: 405,
          headers: { Allow: "POST", "Content-Type": "application/json; charset=utf-8" },
        },
      );
    }
    const headerFormat = request.headers.get(CHAT_FORMAT_HEADER);
    if (headerFormat !== null && !CHAT_FORMATS.has(headerFormat)) {
      return errorResponse(400, `Unknown chat format: ${headerFormat}`, "unknown_format");
    }
    const format = (headerFormat as ChatHandlerFormat | null) ?? options.format ?? "native";
    if (new URL(request.url).pathname.replace(/\/+$/, "").endsWith("/respond")) {
      return await handleNativeRespondRequest(og, request, options.resolve);
    }
    switch (format) {
      case "vercel":
        return await handleVercelChatRequest(og, request, options.resolve);
      case "openai-chat":
        return await handleChatCompletionsRequest(og, request, options.resolve);
      case "openai-responses":
        return await handleResponsesRequest(og, request, options.resolve);
      default:
        return await handleNativeChatRequest(og, request, options.resolve);
    }
  };
}

/** `POST { message }` -> native SSE of {@link ChatChunk} (`event: chunk`). */
export async function handleNativeChatRequest(
  og: OpenGeni,
  request: Request,
  resolve: ChatResolve,
): Promise<Response> {
  const body = await readJsonObject(request);
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (!message) {
    return errorResponse(400, "Body must carry a non-empty message.", "message_required");
  }
  const resolved = await resolveChatRequest(request, resolve);
  if (resolved.response) return resolved.response;
  const opened = await openResolvedChat(og, resolved.resolution, undefined);
  if (opened.response) return opened.response;
  return chatChunksToSseResponse(opened.chat.stream(message, { signal: request.signal }));
}

/** `POST .../respond { requestId, decision | answers | skip }` -> native SSE of the continuation. */
export async function handleNativeRespondRequest(
  og: OpenGeni,
  request: Request,
  resolve: ChatResolve,
): Promise<Response> {
  const body = await readJsonObject(request);
  const input = respondInputFromBody(body);
  if (!input) {
    return errorResponse(
      400,
      "Body must carry requestId plus decision, answers, or skip.",
      "respond_input_invalid",
    );
  }
  const resolved = await resolveChatRequest(request, resolve);
  if (resolved.response) return resolved.response;
  const opened = await openResolvedChat(og, resolved.resolution, undefined);
  if (opened.response) return opened.response;
  return chatChunksToSseResponse(opened.chat.respondStream(input, { signal: request.signal }));
}

export function respondInputFromBody(
  body: Record<string, unknown> | null,
): ChatRespondInput | null {
  const requestId = typeof body?.requestId === "string" ? body.requestId : "";
  if (!body || !requestId) return null;
  if (body.decision === "approve" || body.decision === "reject") {
    return {
      requestId,
      decision: body.decision,
      ...(typeof body.message === "string" ? { message: body.message } : {}),
    };
  }
  if (Array.isArray(body.answers)) {
    const answers = body.answers.filter(
      (answer): answer is HumanInputAnswer =>
        !!answer &&
        typeof answer === "object" &&
        typeof (answer as HumanInputAnswer).questionId === "string" &&
        Array.isArray((answer as HumanInputAnswer).values),
    );
    return { requestId, answers };
  }
  if (body.skip === true) return { requestId, skip: true };
  return null;
}

/** Native wire format: `event: chunk` per {@link ChatChunk}, `event: error` on failure. */
export async function* chatChunksToSseBlocks(
  chunks: AsyncIterable<ChatChunk>,
): AsyncGenerator<string, void, void> {
  try {
    for await (const chunk of chunks) {
      yield sseLine(JSON.stringify(chunk), "chunk");
    }
  } catch (error) {
    const summary = chatErrorSummary(error);
    yield sseLine(JSON.stringify({ code: summary.code, message: summary.message }), "error");
  }
}

export function chatChunksToSseStream(
  chunks: AsyncIterable<ChatChunk>,
  onCancel?: () => void,
): ReadableStream<Uint8Array> {
  return sseByteStream(chatChunksToSseBlocks(chunks), onCancel);
}

export function chatChunksToSseResponse(chunks: AsyncIterable<ChatChunk>): Response {
  return new Response(chatChunksToSseStream(chunks), {
    headers: sseHeaders({ [CHAT_FORMAT_HEADER]: "native" }),
  });
}

/** Browser-side reader for the native wire format. Throws {@link OpenGeniChatError} on `event: error`. */
export async function* parseChatChunkStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<ChatChunk, void, void> {
  for await (const message of parseSseStream(stream)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.data);
    } catch {
      continue;
    }
    if (message.event === "error") {
      const record = (parsed ?? {}) as { code?: unknown; message?: unknown };
      throw new OpenGeniChatError(
        typeof record.code === "string" ? record.code : "chat_error",
        typeof record.message === "string" ? record.message : "Chat request failed.",
      );
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { type?: unknown }).type === "string"
    ) {
      yield parsed as ChatChunk;
    }
  }
}
