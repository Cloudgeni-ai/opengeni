import { OpenGeniApiError } from "../errors";
import type { OpenGeni } from "./opengeni";
import { OpenGeniChatError, type ChatOptions } from "./types";

/** Internal HTTP plumbing shared by the native handler and the protocol adapters. */

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

/** Open a chat from a resolution plus the conversation the protocol supplied. */
export async function openResolvedChat(
  og: OpenGeni,
  resolution: ChatResolution,
  conversation: string | undefined,
): Promise<
  { chat: Awaited<ReturnType<OpenGeni["chat"]>>; response?: undefined } | { response: Response }
> {
  const conversationId = resolution.conversation ?? conversation;
  if (!conversationId) {
    return {
      response: errorResponse(400, "A conversation id is required.", "conversation_required"),
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
    const status = error.code === "memory_scope_requires_user" ? 400 : 502;
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

/** The last user-role message's text from an OpenAI/Vercel-style `messages` array. */
export function lastUserMessageText(
  messages: unknown,
  partTypes: string[],
  partsField: "parts" | "content",
): string | null {
  if (!Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") continue;
    const record = message as Record<string, unknown>;
    if (record.role !== "user") continue;
    return (
      messageContentText(record[partsField], partTypes) ??
      messageContentText(record.content, partTypes)
    );
  }
  return null;
}

export function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
