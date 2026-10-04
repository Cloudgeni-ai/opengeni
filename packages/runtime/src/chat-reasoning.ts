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

/** Keep the complete ordered sequence, including signatures and unknown fields. */
export function chatReasoningDetails(value: unknown): JsonObject[] | undefined {
  const details = object(value)?.reasoning_details;
  return Array.isArray(details) && details.every((part) => object(part))
    ? (details as JsonObject[])
    : undefined;
}

/** Reassemble consecutive readable deltas like OpenRouter's native adapter.
 * Stream indexes may repeat across logical blocks. Opaque blocks stay discrete.
 * The accumulator belongs to one response; incoming provider objects are untouched.
 */
export function appendChatReasoningDetails(accumulated: JsonObject[], deltas: JsonObject[]): void {
  for (const delta of deltas) {
    const previous = accumulated.at(-1);
    const field =
      delta.type === "reasoning.text"
        ? "text"
        : delta.type === "reasoning.summary"
          ? "summary"
          : undefined;
    if (field && previous && previous.type === delta.type) {
      const text =
        (typeof previous[field] === "string" ? previous[field] : "") +
        (typeof delta[field] === "string" ? delta[field] : "");
      // Keep first-block identity and extensions, accepting late metadata such
      // as a signature-only delta after answer text has already started.
      const merged = { ...structuredClone(delta), ...previous, [field]: text };
      for (const key of ["signature", "format"]) {
        if (!previous[key] && delta[key] !== undefined) merged[key] = structuredClone(delta[key]);
      }
      accumulated[accumulated.length - 1] = merged;
    } else accumulated.push(structuredClone(delta));
  }
}

/** Only readable detail types may enter the thinking UI or foreign-model text. */
export function chatReasoningDetailsText(details: JsonObject[] | undefined): string {
  return (details ?? [])
    .map((part) => {
      const text =
        part.type === "reasoning.text"
          ? part.text
          : part.type === "reasoning.summary"
            ? part.summary
            : undefined;
      return typeof text === "string" ? text : "";
    })
    .join("");
}

/** Retain reasoning independently of answer text, with its native replay field. */
export function withChatReasoning<T extends ModelResponse["output"][number]>(
  output: T[],
  reasoning: ChatReasoning | undefined,
  details?: JsonObject[],
) {
  if (!reasoning && details === undefined) return output;
  return [
    {
      type: "reasoning" as const,
      content: [],
      rawContent: [
        {
          type: "reasoning_text" as const,
          text: reasoning?.text ?? chatReasoningDetailsText(details),
          // Raw-content provenance is not serialized as a foreign wire field
          // when this history is later projected to the Responses API.
          providerData: {
            chatCompletions: {
              ...(reasoning ? { reasoningField: reasoning.field } : {}),
              ...(details !== undefined ? { reasoningDetails: structuredClone(details) } : {}),
            },
          },
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
    const metadata = object(object(item.rawContent?.[0]?.providerData)?.chatCompletions);
    const field = metadata?.reasoningField;
    const details = chatReasoningDetails({ reasoning_details: metadata?.reasoningDetails });
    const hasField = field === "reasoning" || field === "reasoning_content";
    if (!hasField && !details) return item;
    const text = item.rawContent?.map((part) => part.text).join("");
    if (!text && !details) return item;
    changed = true;
    return {
      type: "message" as const,
      role: "assistant" as const,
      content: [],
      status: "completed" as const,
      providerData: {
        ...(hasField && text ? { [field]: text } : {}),
        ...(details ? { reasoning_details: details } : {}),
      },
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
    const details = chatReasoningDetails(message);
    const previousDetails = chatReasoningDetails(carrier);
    const sameDetails =
      details && previousDetails && JSON.stringify(details) === JSON.stringify(previousDetails);
    if (
      carrier &&
      message?.role === "assistant" &&
      (!reasoning ||
        (!emptyContent(message.content) &&
          reasoning.field === previousReasoning?.field &&
          reasoning.text === previousReasoning.text)) &&
      (!details || (!emptyContent(message.content) && sameDetails)) &&
      !carrier.audio &&
      !message.audio &&
      Object.keys(message).every(
        (key) =>
          ["role", "content", "tool_calls"].includes(key) ||
          (key === "reasoning_details" && sameDetails) ||
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
    carrier = message?.role === "assistant" && (reasoning || details) ? message : undefined;
  }
  return result.length === messages.length ? messages : result;
}
