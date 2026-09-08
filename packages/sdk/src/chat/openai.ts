import {
  chatErrorSummary,
  errorResponse,
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
import type { ChatChunk, ChatReply } from "./types";

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

export const CHAT_CONVERSATION_HEADER = "x-opengeni-conversation";

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
 * else `metadata.conversation_id`; 400 when none.
 */
export async function handleChatCompletionsRequest(
  og: OpenGeni,
  request: Request,
  resolve: ChatResolve,
): Promise<Response> {
  const body = await readJsonObject(request);
  const prompt =
    lastUserMessageText(body?.messages, ["text", "input_text"], "content")?.trim() ?? "";
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
  const conversation =
    request.headers.get(CHAT_CONVERSATION_HEADER) ??
    (typeof metadataConversation === "string" && metadataConversation
      ? metadataConversation
      : undefined);
  const opened = await openResolvedChat(og, resolved.resolution, conversation);
  if (opened.response) return opened.response;
  const model = modelLabel(body);
  if (wantsStream(body)) {
    const chunks = opened.chat.stream(prompt, { signal: request.signal });
    return new Response(sseByteStream(chatCompletionBlocks(opened.chat, chunks, model)), {
      headers: sseHeaders(),
    });
  }
  try {
    const reply = await opened.chat.send(prompt, { signal: request.signal });
    return jsonResponse(chatCompletionObject(reply, model));
  } catch (error) {
    const summary = chatErrorSummary(error);
    return errorResponse(summary.status, summary.message, summary.code);
  }
}

// --- Responses ----------------------------------------------------------------

/** `resp_<sessionId>_<sequence>`; the session id alone addresses the conversation. */
export function encodeResponseId(sessionId: string, sequence: number): string {
  return `resp_${sessionId}_${sequence}`;
}

export function decodeResponseId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^resp_([0-9a-f-]{36})(?:_\d+)?$/i.exec(value);
  const sessionId = match?.[1];
  return sessionId && isUuid(sessionId) ? sessionId : null;
}

function responseObject(
  reply: ChatReply | null,
  chat: Chat,
  model: string,
  status: "in_progress" | "completed" | "incomplete",
  previousResponseId: string | null,
  text: string,
): Record<string, unknown> {
  const sequence = reply?.events.at(-1)?.sequence ?? 0;
  return {
    id: encodeResponseId(chat.sessionId, sequence),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    previous_response_id: previousResponseId,
    output:
      status === "in_progress"
        ? []
        : [
            {
              type: "message",
              id: `msg_${chat.sessionId}_${sequence}`,
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text, annotations: [] }],
            },
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
  const itemId = `msg_${chat.sessionId}`;
  const event = (type: string, data: Record<string, unknown>): string =>
    sseLine(JSON.stringify({ type, sequence_number: sequenceNumber++, ...data }), type);
  let text = "";
  yield event("response.created", {
    response: responseObject(null, chat, model, "in_progress", previousResponseId, ""),
  });
  try {
    for await (const chunk of chunks) {
      if (chunk.type === "text") {
        text += chunk.text;
        yield event("response.output_text.delta", {
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          delta: chunk.text,
        });
      } else if (chunk.type === "done") {
        yield event("response.output_text.done", {
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          text: chunk.reply.text,
        });
        yield event("response.completed", {
          response: responseObject(
            chunk.reply,
            chat,
            model,
            chunk.reply.status === "completed" ? "completed" : "incomplete",
            previousResponseId,
            chunk.reply.text,
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
 * Conversation: the host's `resolve`, else `conversation` / `conversation.id`,
 * else the session encoded in `previous_response_id`; 400 when none.
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
  const conversation = conversationFromBody(body);
  let chat: Chat;
  const previousSessionId = decodeResponseId(previousResponseId);
  if (!resolved.resolution.conversation && !conversation && previousSessionId) {
    try {
      const workspaceId = await og.workspaceId(resolved.resolution);
      chat = await og.chatBySessionId({ workspaceId, sessionId: previousSessionId });
    } catch (error) {
      const summary = chatErrorSummary(error);
      return errorResponse(summary.status, summary.message, summary.code);
    }
  } else {
    const opened = await openResolvedChat(og, resolved.resolution, conversation);
    if (opened.response) return opened.response;
    chat = opened.chat;
  }
  const model = modelLabel(body);
  if (wantsStream(body)) {
    const chunks = chat.stream(prompt, { signal: request.signal });
    return new Response(sseByteStream(responsesBlocks(chat, chunks, model, previousResponseId)), {
      headers: sseHeaders(),
    });
  }
  try {
    const reply = await chat.send(prompt, { signal: request.signal });
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
