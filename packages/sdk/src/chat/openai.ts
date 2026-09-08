import {
  chatErrorSummary,
  clientConversation,
  errorResponse,
  importedHistoryBefore,
  jsonResponse,
  lastUserMessageText,
  messageContentText,
  openResolvedChat,
  readJsonObject,
  resolveChatRequest,
  sseByteStream,
  sseHeaders,
  sseLine,
  type ChatResolve,
} from "./http";
import { isUuid } from "./ids";
import type { Chat, OpenGeni } from "./opengeni";
import { OpenGeniChatError, type ChatChunk, type ChatReply } from "./types";

/**
 * OpenAI-compatible adapters over the stable subset of the Chat Completions
 * and Responses wire formats. `model` and `user` in the body are echoed, never
 * trusted: identity comes from the host's `resolve` hook.
 */

const DEFAULT_MODEL_LABEL = "opengeni";

type ReplyExtension = {
  sessionId: string;
  workspaceId: string;
  turnId: string | null;
  status: ChatReply["status"];
  pending: ChatReply["pending"];
};

function replyExtension(reply: ChatReply): ReplyExtension {
  return {
    sessionId: reply.sessionId,
    workspaceId: reply.workspaceId,
    turnId: reply.turnId,
    status: reply.status,
    pending: reply.pending,
  };
}

function conversationFromBody(body: Record<string, unknown> | null): string | undefined {
  const conversation = body?.conversation;
  if (typeof conversation === "string" && conversation) return conversation;
  if (conversation && typeof conversation === "object") {
    const id = (conversation as { id?: unknown }).id;
    if (typeof id === "string" && id) return id;
  }
  return undefined;
}

function modelLabel(body: Record<string, unknown> | null): string {
  return typeof body?.model === "string" && body.model ? body.model : DEFAULT_MODEL_LABEL;
}

function wantsStream(body: Record<string, unknown> | null): boolean {
  return body?.stream === true;
}

// --- Chat Completions ---------------------------------------------------------

const CHAT_COMPLETION_PART_TYPES = ["text", "input_text"];

function chatCompletionChunk(
  sessionId: string,
  model: string,
  created: number,
  delta: Record<string, unknown>,
  finishReason: "stop" | null,
  extension?: ReplyExtension,
): string {
  return sseLine(
    JSON.stringify({
      id: `chatcmpl-${sessionId}`,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...(extension ? { opengeni: extension } : {}),
    }),
  );
}

export async function* chatCompletionBlocks(
  chat: Chat,
  chunks: AsyncIterable<ChatChunk>,
  model: string,
): AsyncGenerator<string, void, void> {
  const created = Math.floor(Date.now() / 1000);
  yield chatCompletionChunk(
    chat.sessionId,
    model,
    created,
    { role: "assistant", content: "" },
    null,
  );
  try {
    for await (const chunk of chunks) {
      if (chunk.type === "text") {
        yield chatCompletionChunk(chat.sessionId, model, created, { content: chunk.text }, null);
      } else if (chunk.type === "done") {
        yield chatCompletionChunk(
          chat.sessionId,
          model,
          created,
          {},
          "stop",
          replyExtension(chunk.reply),
        );
      }
    }
  } catch (error) {
    const summary = chatErrorSummary(error);
    yield sseLine(
      JSON.stringify({
        error: { message: summary.message, code: summary.code, type: "server_error" },
      }),
    );
  }
  yield sseLine("[DONE]");
}

export function chatCompletionObject(reply: ChatReply, model: string): Record<string, unknown> {
  return {
    id: `chatcmpl-${reply.sessionId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      { index: 0, message: { role: "assistant", content: reply.text }, finish_reason: "stop" },
    ],
    opengeni: replyExtension(reply),
  };
}

/**
 * `POST /v1/chat/completions` shape: `{ messages, stream?, model?, user?, metadata? }`.
 * Conversation: the host's `resolve`, else the `x-opengeni-conversation` header,
 * else `metadata.conversation_id`; 400 when none. Only the last user message
 * is sent; the messages before it are imported once as context when this
 * request creates the session.
 */
export async function handleChatCompletionsRequest(
  og: OpenGeni,
  request: Request,
  resolve: ChatResolve,
): Promise<Response> {
  const body = await readJsonObject(request);
  const prompt =
    lastUserMessageText(body?.messages, CHAT_COMPLETION_PART_TYPES, "content")?.trim() ?? "";
  if (!prompt) {
    return errorResponse(400, "The last user message has no text.", "message_required");
  }
  const resolved = await resolveChatRequest(request, resolve);
  if (resolved.response) return resolved.response;
  const metadata = body?.metadata;
  const metadataConversation =
    metadata && typeof metadata === "object"
      ? (metadata as { conversation_id?: unknown }).conversation_id
      : undefined;
  const opened = await openResolvedChat(
    og,
    resolved.resolution,
    clientConversation(request, metadataConversation),
  );
  if (opened.response) return opened.response;
  const model = modelLabel(body);
  const importedHistory = importedHistoryBefore(
    body?.messages,
    CHAT_COMPLETION_PART_TYPES,
    "content",
  );
  if (wantsStream(body)) {
    const chunks = opened.chat.stream(prompt, { signal: request.signal, importedHistory });
    return new Response(sseByteStream(chatCompletionBlocks(opened.chat, chunks, model)), {
      headers: sseHeaders(),
    });
  }
  try {
    const reply = await opened.chat.send(prompt, { signal: request.signal, importedHistory });
    return jsonResponse(chatCompletionObject(reply, model));
  } catch (error) {
    const summary = chatErrorSummary(error);
    return errorResponse(summary.status, summary.message, summary.code);
  }
}

// --- Responses ----------------------------------------------------------------

/** Non-streaming response id; the session id alone addresses the conversation. */
export function encodeResponseId(sessionId: string, sequence: number): string {
  return `resp_${sessionId}_${sequence}`;
}

export function decodeResponseId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Streams allocate a UUID before the final event sequence is known. Keep
  // accepting existing sequence-based response ids for conversation continuity.
  const match = /^resp_([0-9a-f-]{36})(?:_(\d+|[0-9a-f-]{36}))?$/i.exec(value);
  const sessionId = match?.[1];
  const suffix = match?.[2];
  if (suffix && !/^\d+$/.test(suffix) && !isUuid(suffix)) return null;
  return sessionId && isUuid(sessionId) ? sessionId : null;
}

type ResponseIdentity = { responseId: string; itemId: string; createdAt: number };
type ResponseStatus = "in_progress" | "completed" | "incomplete";

function responseOutputItem(itemId: string, status: ResponseStatus, text: string | null) {
  return {
    type: "message",
    id: itemId,
    status,
    role: "assistant",
    content: text === null ? [] : [{ type: "output_text", text, annotations: [] }],
  };
}

function responseObject(
  reply: ChatReply | null,
  chat: Chat,
  model: string,
  status: ResponseStatus,
  previousResponseId: string | null,
  text: string,
  identity?: ResponseIdentity,
): Record<string, unknown> {
  const sequence = reply?.events.at(-1)?.sequence ?? 0;
  return {
    id: identity?.responseId ?? encodeResponseId(chat.sessionId, sequence),
    object: "response",
    created_at: identity?.createdAt ?? Math.floor(Date.now() / 1000),
    status,
    model,
    previous_response_id: previousResponseId,
    output:
      status === "in_progress"
        ? []
        : [
            responseOutputItem(
              identity?.itemId ?? `msg_${chat.sessionId}_${sequence}`,
              status,
              text,
            ),
          ],
    output_text: text,
    ...(reply ? { opengeni: replyExtension(reply) } : {}),
  };
}

export async function* responsesBlocks(
  chat: Chat,
  chunks: AsyncIterable<ChatChunk>,
  model: string,
  previousResponseId: string | null,
): AsyncGenerator<string, void, void> {
  let sequenceNumber = 0;
  const requestId = crypto.randomUUID();
  const identity: ResponseIdentity = {
    responseId: `resp_${chat.sessionId}_${requestId}`,
    itemId: `msg_${chat.sessionId}_${requestId}`,
    createdAt: Math.floor(Date.now() / 1000),
  };
  const { itemId } = identity;
  const event = (type: string, data: Record<string, unknown>): string =>
    sseLine(JSON.stringify({ type, sequence_number: sequenceNumber++, ...data }), type);
  const initial = responseObject(
    null,
    chat,
    model,
    "in_progress",
    previousResponseId,
    "",
    identity,
  );
  yield event("response.created", { response: initial });
  yield event("response.in_progress", { response: initial });
  yield event("response.output_item.added", {
    output_index: 0,
    item: responseOutputItem(itemId, "in_progress", null),
  });
  yield event("response.content_part.added", {
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "", annotations: [] },
  });
  try {
    for await (const chunk of chunks) {
      if (chunk.type === "text") {
        yield event("response.output_text.delta", {
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          delta: chunk.text,
          logprobs: [],
        });
      } else if (chunk.type === "done") {
        const status = chunk.reply.status === "completed" ? "completed" : "incomplete";
        const item = responseOutputItem(itemId, status, chunk.reply.text);
        yield event("response.output_text.done", {
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          text: chunk.reply.text,
          logprobs: [],
        });
        yield event("response.content_part.done", {
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          part: item.content[0]!,
        });
        yield event("response.output_item.done", { output_index: 0, item });
        yield event(`response.${status}`, {
          response: responseObject(
            chunk.reply,
            chat,
            model,
            status,
            previousResponseId,
            chunk.reply.text,
            identity,
          ),
        });
      }
    }
  } catch (error) {
    const summary = chatErrorSummary(error);
    yield event("error", { code: summary.code, message: summary.message, param: null });
  }
}

/** Text of the Responses `input`: a string, or the last user item's `input_text` parts. */
export function responsesInputText(input: unknown): string | null {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return null;
  const fromRole = lastUserMessageText(input, ["input_text", "text"], "content");
  if (fromRole !== null) return fromRole;
  const last = input.at(-1);
  return last && typeof last === "object"
    ? messageContentText((last as { content?: unknown }).content, ["input_text", "text"])
    : null;
}

/**
 * `POST /v1/responses` shape: `{ input, previous_response_id?, conversation?, stream?, model?, user? }`.
 * Conversation: the host's `resolve`, else the `x-opengeni-conversation`
 * header, else `conversation` / `conversation.id`. A `previous_response_id`
 * may continue the session it encodes only when the host named the user that
 * session belongs to (403 otherwise); when a conversation is named as well,
 * the two must agree (409). 400 when nothing names a conversation. Only the
 * last user item is sent; earlier array items are imported once as context
 * when this request creates the session.
 */
export async function handleResponsesRequest(
  og: OpenGeni,
  request: Request,
  resolve: ChatResolve,
): Promise<Response> {
  const body = await readJsonObject(request);
  const prompt = responsesInputText(body?.input)?.trim() ?? "";
  if (!prompt) return errorResponse(400, "The input has no user text.", "message_required");
  const resolved = await resolveChatRequest(request, resolve);
  if (resolved.response) return resolved.response;
  const previousResponseId =
    typeof body?.previous_response_id === "string" ? body.previous_response_id : null;
  const conversation = clientConversation(request, conversationFromBody(body));
  const previousSessionId = decodeResponseId(previousResponseId);
  const namedConversation =
    resolved.resolution.conversation ?? (resolved.resolution.user ? conversation : undefined);
  let chat: Chat;
  if (previousSessionId && !namedConversation) {
    if (!resolved.resolution.user) {
      return errorResponse(
        400,
        "Return a conversation from resolve, or a user so client conversation ids are scoped to that user.",
        "conversation_required",
      );
    }
    try {
      const workspaceId = await og.workspaceId(resolved.resolution);
      chat = await og.chatBySessionId({
        workspaceId,
        sessionId: previousSessionId,
        user: resolved.resolution.user,
      });
    } catch (error) {
      const summary = chatErrorSummary(error);
      return errorResponse(summary.status, summary.message, summary.code);
    }
  } else {
    const opened = await openResolvedChat(og, resolved.resolution, conversation);
    if (opened.response) return opened.response;
    chat = opened.chat;
    if (previousSessionId && previousSessionId !== chat.sessionId) {
      const summary = chatErrorSummary(
        new OpenGeniChatError(
          "conversation_mismatch",
          "previous_response_id belongs to a different conversation than the one named for this request.",
        ),
      );
      return errorResponse(summary.status, summary.message, summary.code);
    }
  }
  const model = modelLabel(body);
  const importedHistory = importedHistoryBefore(
    body?.input,
    ["input_text", "text", "output_text"],
    "content",
  );
  if (wantsStream(body)) {
    const chunks = chat.stream(prompt, { signal: request.signal, importedHistory });
    return new Response(sseByteStream(responsesBlocks(chat, chunks, model, previousResponseId)), {
      headers: sseHeaders(),
    });
  }
  try {
    const reply = await chat.send(prompt, { signal: request.signal, importedHistory });
    return jsonResponse(
      responseObject(
        reply,
        chat,
        model,
        reply.status === "completed" ? "completed" : "incomplete",
        previousResponseId,
        reply.text,
      ),
    );
  } catch (error) {
    const summary = chatErrorSummary(error);
    return errorResponse(summary.status, summary.message, summary.code);
  }
}
