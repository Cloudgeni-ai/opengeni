import { OpenGeniApiError } from "../errors";
import type { OpenGeni } from "./opengeni";
import { OpenGeniChatError, type ChatImportedMessage, type ChatOptions } from "./types";

/** Internal HTTP plumbing shared by the native handler and the protocol adapters. */

/**
 * Header a client uses to name the conversation it is on. Every handler reads
 * the client conversation as: the host's resolution, else this header, else
 * the protocol's own field.
 */
export const CHAT_CONVERSATION_HEADER = "x-opengeni-conversation";

const CHAT_ERROR_STATUS: Readonly<Record<string, number>> = {
  memory_scope_requires_user: 400,
  conversation_not_authorized: 403,
  conversation_mismatch: 409,
};

/** What the host's auth hook returns: identity from the host, conversation optional per protocol. */
export type ChatResolution = Omit<ChatOptions, "conversation"> & {
  conversation?: string | undefined;
};

/**
 * The host's authentication hook. It receives the raw request and returns the
 * tenant/user/conversation the caller is allowed to use, or a `Response` to
 * reject the request. Never derive tenant or user from the request body.
 */
export type ChatResolve = (
  request: Request,
) => Promise<ChatResolution | Response> | ChatResolution | Response;

export type ChatErrorSummary = { status: number; code: string; message: string };

export function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

export function errorResponse(status: number, message: string, code: string): Response {
  return jsonResponse(
    { error: { message, code, type: status >= 500 ? "server_error" : "invalid_request_error" } },
    status,
  );
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await request.json();
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export async function resolveChatRequest(
  request: Request,
  resolve: ChatResolve,
): Promise<{ resolution: ChatResolution; response?: undefined } | { response: Response }> {
  const resolved = await resolve(request);
  if (resolved instanceof Response) return { response: resolved };
  return { resolution: resolved };
}

/** The client-supplied conversation: the header, else the protocol's own field. */
export function clientConversation(request: Request, protocolField: unknown): string | undefined {
  const header = request.headers.get(CHAT_CONVERSATION_HEADER);
  if (header) return header;
  return typeof protocolField === "string" && protocolField ? protocolField : undefined;
}

/**
 * Open a chat from a resolution plus the conversation the client supplied.
 * The host names the conversation, or the host names the user and the client
 * conversation id is namespaced to that user; anything else is a 400, because
 * an unscoped client id could address any conversation in the workspace.
 */
export async function openResolvedChat(
  og: OpenGeni,
  resolution: ChatResolution,
  clientConversationId: string | undefined,
): Promise<
  { chat: Awaited<ReturnType<OpenGeni["chat"]>>; response?: undefined } | { response: Response }
> {
  if (!resolution.conversation && !resolution.user) {
    return {
      response: errorResponse(
        400,
        "Return a conversation from resolve, or a user so client conversation ids are scoped to that user.",
        "conversation_required",
      ),
    };
  }
  const conversationId = resolution.conversation ?? clientConversationId;
  if (!conversationId) {
    return {
      response: errorResponse(
        400,
        `A conversation id is required: send the ${CHAT_CONVERSATION_HEADER} header or the protocol's conversation field.`,
        "conversation_required",
      ),
    };
  }
  try {
    const chat = await og.chat({ ...resolution, conversation: conversationId } as ChatOptions);
    return { chat };
  } catch (error) {
    const summary = chatErrorSummary(error);
    return { response: errorResponse(summary.status, summary.message, summary.code) };
  }
}

export function chatErrorSummary(error: unknown): ChatErrorSummary {
  if (error instanceof OpenGeniChatError) {
    const status = CHAT_ERROR_STATUS[error.code] ?? 502;
    return { status, code: error.code, message: error.message };
  }
  if (error instanceof OpenGeniApiError) {
    return {
      status: error.status >= 500 ? 502 : error.status,
      code: error.code ?? "opengeni_api_error",
      message: error.message,
    };
  }
  if (error instanceof Error && error.name === "AbortError") {
    return { status: 499, code: "aborted", message: "The chat request was aborted." };
  }
  return { status: 500, code: "internal_error", message: "Chat request failed." };
}

export function sseHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    ...extra,
  };
}

export function sseLine(data: string, event?: string): string {
  return `${event ? `event: ${event}\n` : ""}data: ${data}\n\n`;
}

/**
 * Pull-based text-to-bytes stream over already-formatted SSE blocks. Upstream
 * consumption follows downstream demand; cancelling fires `onCancel` so the
 * producer can abort its OpenGeni stream.
 */
export function sseByteStream(
  blocks: AsyncIterable<string>,
  onCancel?: () => void,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = blocks[Symbol.asyncIterator]();
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      const result = await iterator.next();
      if (cancelled) return;
      if (result.done) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(result.value));
    },
    cancel: () => {
      cancelled = true;
      onCancel?.();
      void Promise.resolve(iterator.return?.(undefined)).then(
        () => undefined,
        () => undefined,
      );
    },
  });
}

/** Text from an OpenAI-style message content: a string or `[{ type, text }]` parts. */
export function messageContentText(content: unknown, partTypes: string[]): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const texts = content
    .map((part) => {
      if (!part || typeof part !== "object") return null;
      const record = part as Record<string, unknown>;
      return partTypes.includes(String(record.type)) && typeof record.text === "string"
        ? record.text
        : null;
    })
    .filter((text): text is string => text !== null);
  return texts.length > 0 ? texts.join("\n") : null;
}

function lastUserMessageIndex(messages: unknown[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && typeof message === "object" && (message as { role?: unknown }).role === "user") {
      return index;
    }
  }
  return -1;
}

function messageText(
  message: unknown,
  partTypes: string[],
  partsField: "parts" | "content",
): string | null {
  if (!message || typeof message !== "object") return null;
  const record = message as Record<string, unknown>;
  return (
    messageContentText(record[partsField], partTypes) ??
    messageContentText(record.content, partTypes)
  );
}

/** The last user-role message's text from an OpenAI/Vercel-style `messages` array. */
export function lastUserMessageText(
  messages: unknown,
  partTypes: string[],
  partsField: "parts" | "content",
): string | null {
  if (!Array.isArray(messages)) return null;
  const index = lastUserMessageIndex(messages);
  return index < 0 ? null : messageText(messages[index], partTypes, partsField);
}

/**
 * Every user/assistant/system message before the last user message, as
 * imported history for the first create. Items without a role or text
 * (tool calls, files) are skipped.
 */
export function importedHistoryBefore(
  messages: unknown,
  partTypes: string[],
  partsField: "parts" | "content",
): ChatImportedMessage[] {
  if (!Array.isArray(messages)) return [];
  const lastUser = lastUserMessageIndex(messages);
  if (lastUser < 0) return [];
  const imported: ChatImportedMessage[] = [];
  for (const message of messages.slice(0, lastUser)) {
    const role = (message as { role?: unknown } | null)?.role;
    if (role !== "user" && role !== "assistant" && role !== "system") continue;
    const text = messageText(message, partTypes, partsField);
    if (text) imported.push({ role, text });
  }
  return imported;
}

export function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
