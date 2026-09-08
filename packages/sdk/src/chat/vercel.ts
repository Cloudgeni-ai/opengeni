import { asRecord } from "./fold";
import {
  chatErrorSummary,
  errorResponse,
  lastUserMessageText,
  openResolvedChat,
  readJsonObject,
  resolveChatRequest,
  sseByteStream,
  sseHeaders,
  sseLine,
  type ChatResolve,
} from "./http";
import type { OpenGeni } from "./opengeni";
import type { ChatChunk, ChatPending } from "./types";

/**
 * Vercel AI SDK UI message stream (protocol v1, as consumed by `useChat` with
 * the default transport). Parts are `data: <json>` SSE lines terminated by
 * `data: [DONE]`, under the `x-vercel-ai-ui-message-stream: v1` header.
 */

export const UI_MESSAGE_STREAM_HEADER = "x-vercel-ai-ui-message-stream";
export const UI_MESSAGE_STREAM_VERSION = "v1";

export type UIMessageStreamOptions = {
  /** Assistant message id announced in the `start` part. Defaults to a random UUID. */
  messageId?: string | undefined;
};

/** Protocol parts for one reply, in order. */
export async function* uiMessageStreamParts(
  chunks: AsyncIterable<ChatChunk>,
  options: UIMessageStreamOptions = {},
): AsyncGenerator<Record<string, unknown>, void, void> {
  const messageId = options.messageId ?? crypto.randomUUID();
  const textId = `text_${messageId}`;
  let textOpen = false;
  const closeText = (): Record<string, unknown>[] => {
    if (!textOpen) return [];
    textOpen = false;
    return [{ type: "text-end", id: textId }];
  };
  yield { type: "start", messageId };
  yield { type: "start-step" };
  try {
    for await (const chunk of chunks) {
      switch (chunk.type) {
        case "text":
          if (!textOpen) {
            textOpen = true;
            yield { type: "text-start", id: textId };
          }
          yield { type: "text-delta", id: textId, delta: chunk.text };
          break;
        case "tool": {
          yield* closeText();
          const toolCallId = chunk.callId ?? `call_${crypto.randomUUID()}`;
          if (chunk.status === "started") {
            yield { type: "tool-input-start", toolCallId, toolName: chunk.name };
            yield {
              type: "tool-input-available",
              toolCallId,
              toolName: chunk.name,
              input: chunk.input ?? {},
            };
          } else {
            yield { type: "tool-output-available", toolCallId, output: { status: chunk.status } };
          }
          break;
        }
        case "pending":
          yield* closeText();
          yield* pendingParts(chunk.pending);
          break;
        case "done":
          yield* closeText();
          break;
      }
    }
    yield* closeText();
    yield { type: "finish-step" };
    yield { type: "finish" };
  } catch (error) {
    yield* closeText();
    yield { type: "error", errorText: chatErrorSummary(error).message };
  }
}

function* pendingParts(pending: ChatPending): Generator<Record<string, unknown>> {
  if (pending.kind === "approval") {
    const raw = asRecord(pending.payload);
    const rawItem = asRecord(raw.rawItem);
    yield {
      type: "tool-input-available",
      toolCallId: pending.requestId,
      toolName: pending.name ?? "tool",
      input: raw.arguments ?? rawItem.arguments ?? {},
    };
    yield {
      type: "tool-approval-request",
      toolCallId: pending.requestId,
      approvalId: pending.requestId,
    };
    return;
  }
  yield { type: "data-opengeni-pending", data: pending };
}

export async function* uiMessageStreamBlocks(
  chunks: AsyncIterable<ChatChunk>,
  options: UIMessageStreamOptions = {},
): AsyncGenerator<string, void, void> {
  for await (const part of uiMessageStreamParts(chunks, options)) {
    yield sseLine(JSON.stringify(part));
  }
  yield sseLine("[DONE]");
}

export function chatChunksToUIMessageStream(
  chunks: AsyncIterable<ChatChunk>,
  options: UIMessageStreamOptions & { onCancel?: (() => void) | undefined } = {},
): ReadableStream<Uint8Array> {
  return sseByteStream(uiMessageStreamBlocks(chunks, options), options.onCancel);
}

export function uiMessageStreamResponse(
  chunks: AsyncIterable<ChatChunk>,
  options: UIMessageStreamOptions = {},
): Response {
  return new Response(chatChunksToUIMessageStream(chunks, options), {
    headers: sseHeaders({ [UI_MESSAGE_STREAM_HEADER]: UI_MESSAGE_STREAM_VERSION }),
  });
}

/** Text of the last user `UIMessage` (`parts` of type `text`, joined). */
export function lastUIMessageText(messages: unknown): string | null {
  return lastUserMessageText(messages, ["text"], "parts");
}

/**
 * `useChat` request handler: body `{ id, messages, trigger, messageId }`.
 * The chat id is the conversation unless the host's `resolve` overrides it;
 * `regenerate-message` steers instead of queueing.
 */
export async function handleVercelChatRequest(
  og: OpenGeni,
  request: Request,
  resolve: ChatResolve,
): Promise<Response> {
  const body = await readJsonObject(request);
  const prompt = lastUIMessageText(body?.messages)?.trim() ?? "";
  if (!prompt) {
    return errorResponse(400, "The last user message has no text.", "message_required");
  }
  const resolved = await resolveChatRequest(request, resolve);
  if (resolved.response) return resolved.response;
  const opened = await openResolvedChat(
    og,
    resolved.resolution,
    typeof body?.id === "string" && body.id ? body.id : undefined,
  );
  if (opened.response) return opened.response;
  const steer = body?.trigger === "regenerate-message";
  return uiMessageStreamResponse(opened.chat.stream(prompt, { signal: request.signal, steer }));
}
