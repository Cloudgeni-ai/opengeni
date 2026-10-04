import type { ModelRequest, ModelResponse } from "@openai/agents";

type JsonObject = Record<string, unknown>;
type ReasoningField = "reasoning" | "reasoning_content";
export type ChatReasoning = { field: ReasoningField; text: string };

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

/** Match the SDK's single supported streaming choice; never show another choice. */
export function primaryChatChoice(value: unknown): JsonObject | undefined {
  const choices = object(value)?.choices;
  return Array.isArray(choices)
    ? choices.map(object).find((choice) => choice?.index === 0)
    : undefined;
}

/** Some compatible endpoints supply both aliases. Consume their text only once. */
export function chatReasoning(value: unknown): ChatReasoning | undefined {
  const record = object(value);
  for (const field of ["reasoning_content", "reasoning"] as const) {
    const text = record?.[field];
    if (typeof text === "string" && text.length > 0) return { field, text };
  }
  return undefined;
}

/** Retain reasoning independently of answer text, with its native replay field. */
export function withChatReasoning<T extends ModelResponse["output"][number]>(
  output: T[],
  reasoning: ChatReasoning | undefined,
) {
  if (!reasoning) return output;
  return [
    {
      type: "reasoning" as const,
      content: [],
      rawContent: [
        {
          type: "reasoning_text" as const,
          text: reasoning.text,
          // Raw-content provenance is not serialized as a foreign wire field
          // when this history is later projected to the Responses API.
          providerData: { chatCompletions: { reasoningField: reasoning.field } },
        },
      ],
    },
    ...output.filter((item) => item.type !== "reasoning"),
  ];
}

/** The SDK only replays `reasoning`. Supply a message-level carrier for either
 * native field; the Chat wire policy joins it to its answer/tool-call message.
 * This is an attempt-local projection: durable reasoning stays a reasoning item.
 */
export function projectChatReasoning(request: ModelRequest): ModelRequest {
  if (typeof request.input === "string") return request;
  let changed = false;
  const input = request.input.map((item) => {
    if (item.type !== "reasoning") return item;
    const field = object(
      object(item.rawContent?.[0]?.providerData)?.chatCompletions,
    )?.reasoningField;
    if (field !== "reasoning" && field !== "reasoning_content") return item;
    const text = item.rawContent?.map((part) => part.text).join("");
    if (!text) return item;
    changed = true;
    return {
      type: "message" as const,
      role: "assistant" as const,
      content: [],
      status: "completed" as const,
      providerData: { [field]: text },
    };
  });
  return changed ? { ...request, input } : request;
}

function emptyContent(content: unknown): boolean {
  return content == null || content === "" || (Array.isArray(content) && content.length === 0);
}

/** The SDK splits reasoning, answer text and tool calls into adjacent assistant
 * messages. Reasoning belongs on the same message as the calls it produced.
 * Join only a reasoning-led group, never across a user/tool message or another
 * distinct reasoning item. Identical nested legacy metadata is deduplicated;
 * conflicting extensions/audio remain separate and untouched.
 */
export function joinChatReasoningMessages(messages: JsonObject[]): JsonObject[] {
  const result: JsonObject[] = [];
  let carrier: JsonObject | undefined;
  for (const message of messages) {
    const reasoning = chatReasoning(message);
    const previousReasoning = chatReasoning(carrier);
    if (
      carrier &&
      message?.role === "assistant" &&
      (!reasoning ||
        (!emptyContent(message.content) &&
          reasoning.field === previousReasoning?.field &&
          reasoning.text === previousReasoning.text)) &&
      !carrier.audio &&
      !message.audio &&
      Object.keys(message).every(
        (key) =>
          ["role", "content", "tool_calls"].includes(key) ||
          !Object.hasOwn(carrier!, key) ||
          carrier![key] === message[key],
      )
    ) {
      const parts = (content: unknown): unknown[] =>
        emptyContent(content)
          ? []
          : typeof content === "string"
            ? [{ type: "text", text: content }]
            : Array.isArray(content)
              ? content
              : [content];
      const content = emptyContent(carrier.content)
        ? message.content
        : emptyContent(message.content)
          ? carrier.content
          : [...parts(carrier.content), ...parts(message.content)];
      carrier = {
        ...carrier,
        ...message,
        content,
        ...(Array.isArray(carrier.tool_calls) || Array.isArray(message.tool_calls)
          ? {
              tool_calls: [
                ...(Array.isArray(carrier.tool_calls) ? carrier.tool_calls : []),
                ...(Array.isArray(message.tool_calls) ? message.tool_calls : []),
              ],
            }
          : {}),
      };
      result[result.length - 1] = carrier;
      continue;
    }
    result.push(message);
    carrier = message?.role === "assistant" && reasoning ? message : undefined;
  }
  return result.length === messages.length ? messages : result;
}
