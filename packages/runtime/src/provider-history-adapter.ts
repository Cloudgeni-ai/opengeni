import { chatReasoning, chatReasoningDetails, chatReasoningDetailsText } from "./chat-reasoning";
import { projectHostedSearchEvidence } from "./hosted-search-evidence";

export type HistoryProviderApi = "responses" | "chat" | "anthropic-messages";

const CHAT_FUNCTION_NAME = /^[a-zA-Z0-9_-]+$/;
const HISTORICAL_FACT_MAX_CHARS = 32_000;

export class ProviderHistoryIncompatibleError extends Error {
  readonly name = "ProviderHistoryIncompatibleError";

  constructor(
    readonly providerApi: HistoryProviderApi,
    readonly itemType: string,
  ) {
    super(
      itemType === "compaction"
        ? "This session uses Codex remote compaction and can only continue on a Codex Responses model. Choose a compatible model or start a new session."
        : `Stored ${itemType} history cannot be represented by the ${providerApi} provider API.`,
    );
  }
}

function callId(item: Record<string, unknown>): string | null {
  const providerData =
    item.providerData && typeof item.providerData === "object"
      ? (item.providerData as Record<string, unknown>)
      : null;
  const value = item.callId ?? item.call_id ?? providerData?.callId ?? providerData?.call_id;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function boundedJson(value: unknown): string {
  let rendered: string;
  try {
    rendered = JSON.stringify(value) ?? String(value);
  } catch {
    rendered = String(value);
  }
  if (rendered.length <= HISTORICAL_FACT_MAX_CHARS) return rendered;
  return `${rendered.slice(0, HISTORICAL_FACT_MAX_CHARS)}…`;
}

function historicalFact(item: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "message",
    // This is transcript evidence, never a privileged instruction. Keeping it
    // in the assistant role avoids elevating arbitrary historical tool output.
    role: "assistant",
    content: `[Opengeni historical ${String(item.type ?? "provider item")} fact]\n${boundedJson(item)}`,
  };
}

/** Chat reasoning has plaintext rawContent, not a portable Responses reasoning
 * artifact. Keep it as historical evidence when switching wire protocols.
 * Native Responses/Claude reasoning continues through its existing path.
 */
function isChatReasoning(item: Record<string, unknown>): boolean {
  const metadata =
    item.providerData && typeof item.providerData === "object"
      ? (item.providerData as Record<string, unknown>)
      : undefined;
  return (
    item.type === "reasoning" &&
    Array.isArray(item.rawContent) &&
    item.rawContent.some(
      (part) => part?.type === "reasoning_text" && typeof part.text === "string",
    ) &&
    (!Array.isArray(item.content) || item.content.length === 0) &&
    !item.encrypted_content &&
    !item.encryptedContent &&
    !metadata?.encrypted_content &&
    !metadata?.encryptedContent &&
    !metadata?.anthropic
  );
}

function chatReasoningText(item: Record<string, unknown>): string {
  const parts = item.rawContent as Array<{ type?: string; text?: string }>;
  return parts
    .filter((part) => part?.type === "reasoning_text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function historicalReasoningContent(text: string) {
  return { type: "output_text", text: `[Historical reasoning from another model]\n${text}` };
}

/** Opaque reasoning belongs to its native API. Foreign APIs receive only its
 * readable text (or an explicit unavailable marker), never signatures/ciphertext.
 * The canonical artifact stays intact for a later switch back to its native API.
 */
function foreignReasoningFact(
  item: Record<string, unknown>,
  providerApi: HistoryProviderApi,
): Record<string, unknown> | undefined {
  if (item.type !== "reasoning") return undefined;
  const metadata = item.providerData as Record<string, any> | undefined;
  const nativeApi: HistoryProviderApi = metadata?.anthropic?.block
    ? "anthropic-messages"
    : isChatReasoning(item)
      ? "chat"
      : "responses";
  if (nativeApi === providerApi) return undefined;
  const content =
    nativeApi === "chat"
      ? chatReasoningText(item)
      : Array.isArray(item.content)
        ? item.content
            .filter((part) => typeof part?.text === "string")
            .map((part) => part.text)
            .join("")
        : "";
  return {
    type: "message",
    role: "assistant",
    status: "completed",
    content: [
      content
        ? historicalReasoningContent(content)
        : {
            type: "output_text",
            text: "[Historical reasoning from another model is unavailable.]",
          },
    ],
  };
}

/** The Chat SDK stores a complete reply message (including its role) in an
 * output text/refusal part's metadata. That is not Responses content metadata:
 * projecting it verbatim sends fields like role/tools/reasoning_content in an
 * output_text block. Only this identifiable Chat shape is removed; canonical
 * history and native Responses annotations/provider extensions remain intact.
 */
function portableChatMetadata(
  item: Record<string, unknown>,
  previous: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const metadata = item.providerData as Record<string, unknown> | undefined;
  if (item.type === "function_call" && metadata?.type === "function" && metadata.function) {
    // Non-streamed Chat calls also retain their nested wire function envelope.
    // The canonical call already owns name/arguments/callId; Responses has no
    // nested `function` field. Preserve unrelated provider extensions.
    const { type: _type, function: _function, ...providerData } = metadata;
    const { providerData: _metadata, ...projected } = item;
    return Object.keys(providerData).length ? { ...projected, providerData } : projected;
  }
  if (item.role !== "assistant" || !Array.isArray(item.content)) return item;
  let changed = false;
  const precedingReason =
    previous && isChatReasoning(previous) ? chatReasoningText(previous) : undefined;
  const legacyReasons = new Set<string>();
  const content = item.content.map((part) => {
    if (
      (part?.type !== "output_text" && part?.type !== "refusal") ||
      part.providerData?.role !== "assistant"
    )
      return part;
    // Before the shared Chat adapter, reasoning_content survived only inside
    // reply metadata. Retain it before removing that foreign envelope. Newer
    // histories already have the same text in their preceding reasoning item.
    const reason =
      chatReasoning(part.providerData)?.text ??
      chatReasoningDetailsText(chatReasoningDetails(part.providerData));
    if (reason && reason !== precedingReason) legacyReasons.add(reason);
    const { providerData: _replyMetadata, ...projected } = part;
    changed = true;
    return projected;
  });
  return changed
    ? {
        ...item,
        content: [...Array.from(legacyReasons, historicalReasoningContent), ...content],
      }
    : item;
}

function isChatIncompatibleCall(item: Record<string, unknown>): boolean {
  if (item.type !== "function_call") return false;
  return (
    (typeof item.namespace === "string" && item.namespace.trim().length > 0) ||
    (typeof item.name === "string" && !CHAT_FUNCTION_NAME.test(item.name))
  );
}

const CHAT_INCOMPATIBLE_ITEM_TYPES = new Set([
  "tool_search_call",
  "tool_search_output",
  "computer_call",
  "computer_call_result",
  "shell_call",
  "shell_call_output",
  "apply_patch_call",
  "apply_patch_call_output",
]);

function isChatIncompatibleHostedToolCall(item: Record<string, unknown>): boolean {
  return item.type === "hosted_tool_call" && item.name !== "file_search_call";
}

/** The Chat SDK passes system content through instead of converting Responses
 * text parts. Normalize only text-only content; preserve canonical input.
 */
function chatSystemContent(content: unknown): unknown {
  if (
    !Array.isArray(content) ||
    !content.every(
      (part) =>
        part !== null &&
        typeof part === "object" &&
        (part.type === "input_text" || part.type === "output_text" || part.type === "text") &&
        typeof part.text === "string",
    )
  )
    return content;
  return content.map((part) => part.text).join("\n");
}

/**
 * Build the one attempt-local history view required by the target wire API.
 * Canonical history remains untouched. SDK-unsupported developer messages use
 * the Responses pass-through item. Other history is returned by reference when every
 * item is already representable by the SDK's Chat Completions converter.
 */
export function projectHistoryForProvider(
  items: Array<Record<string, unknown>>,
  providerApi: HistoryProviderApi,
): Array<Record<string, unknown>> {
  const nativeClaude = providerApi === "anthropic-messages";
  const projected = items.map((item) => {
    const evidence = projectHostedSearchEvidence(item, { preserveAnthropicNative: nativeClaude });
    return nativeClaude ? evidence : withoutClaudeCitationMetadata(evidence);
  });
  const input = projected.every((item, index) => item === items[index]) ? items : projected;
  return projectWireHistory(withWireValidFunctionCallArguments(input), providerApi);
}

/**
 * Claude citations ride on assistant text parts as `providerData.anthropic`.
 * The Responses and Chat converters would serialize that metadata onto the
 * wire, so other providers get the plain text. Canonical history keeps it for
 * a later switch back to Claude, which must replay it exactly.
 */
function withoutClaudeCitationMetadata(item: Record<string, unknown>): Record<string, unknown> {
  if (item.type !== "message" || item.role !== "assistant" || !Array.isArray(item.content))
    return item;
  let changed = false;
  const content = item.content.map((part) => {
    const metadata = part?.providerData;
    if (!metadata || typeof metadata !== "object" || !("anthropic" in metadata)) return part;
    changed = true;
    const { anthropic: _anthropic, ...rest } = metadata as Record<string, unknown>;
    const { providerData: _providerData, ...plain } = part;
    return Object.keys(rest).length ? { ...plain, providerData: rest } : plain;
  });
  return changed ? { ...item, content } : item;
}

/** Bound on the raw text carried by a request-local invalid-arguments wrapper. */
export const INVALID_FUNCTION_CALL_ARGUMENTS_MAX_CHARS = 4_000;

function isJsonObjectText(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

/**
 * A model can emit a function call whose `arguments` are not a JSON object
 * (truncated output, a leaked provider control token). The SDK answers that
 * call with a model-visible parse error, and canonical history keeps the exact
 * text. Replaying it verbatim makes Chat Completions providers reject the whole
 * request ("function.arguments must be valid JSON") and the Claude converter
 * throw, poisoning every later turn. Request-locally, wrap such text in a
 * deterministic JSON object so the transcript stays honest and prompt-cache
 * stable while canonical history is never rewritten.
 */
export function withWireValidFunctionCallArguments(
  items: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  let changed = false;
  const projected = items.map((item) => {
    if (item.type !== "function_call" || typeof item.arguments !== "string") return item;
    const raw = item.arguments;
    if (isJsonObjectText(raw)) return item;
    changed = true;
    if (raw.trim().length === 0) return { ...item, arguments: "{}" };
    const bounded =
      raw.length <= INVALID_FUNCTION_CALL_ARGUMENTS_MAX_CHARS
        ? raw
        : `${raw.slice(0, INVALID_FUNCTION_CALL_ARGUMENTS_MAX_CHARS)}…[truncated ${raw.length - INVALID_FUNCTION_CALL_ARGUMENTS_MAX_CHARS} chars]`;
    return { ...item, arguments: JSON.stringify({ _invalid_arguments: bounded }) };
  });
  return changed ? projected : items;
}

function projectWireHistory(
  items: Array<Record<string, unknown>>,
  providerApi: HistoryProviderApi,
): Array<Record<string, unknown>> {
  if (providerApi === "responses") {
    // agents-js 0.14's message converter supports system/user/assistant only.
    // The Responses API itself supports developer; use the SDK's raw-item adapter.
    let changed = false;
    const projected = items.map((item, index) => {
      const next =
        item.type === "message" && item.role === "developer"
          ? { type: "unknown", providerData: item }
          : (foreignReasoningFact(item, providerApi) ??
            portableChatMetadata(item, items[index - 1]));
      changed ||= next !== item;
      return next;
    });
    return changed ? projected : items;
  }

  if (providerApi === "anthropic-messages") {
    if (items.some((item) => item.type === "compaction"))
      throw new ProviderHistoryIncompatibleError(providerApi, "compaction");
    let changed = false;
    const projected = items.map((item, index) => {
      const next =
        item.type === "message" && item.role === "developer"
          ? { ...item, role: "system" }
          : (foreignReasoningFact(item, providerApi) ??
            portableChatMetadata(item, items[index - 1]));
      changed ||= next !== item;
      return next;
    });
    return changed ? projected : items;
  }
  const incompatibleCallIds = new Set<string>();
  for (const item of items) {
    if (item.type === "compaction") {
      throw new ProviderHistoryIncompatibleError(providerApi, "compaction");
    }
    if (isChatIncompatibleCall(item)) {
      const id = callId(item);
      if (id) incompatibleCallIds.add(id);
    }
  }

  let changed = false;
  const projected = items.map((item) => {
    const reasoning = foreignReasoningFact(item, providerApi);
    if (reasoning) {
      changed = true;
      return reasoning;
    }
    if (item.type === "message" && (item.role === "developer" || item.role === "system")) {
      const content = chatSystemContent(item.content);
      if (item.role === "developer" || content !== item.content) {
        changed = true;
        return { ...item, role: "system", content };
      }
    }
    const resultId = item.type === "function_call_result" ? callId(item) : null;
    if (
      CHAT_INCOMPATIBLE_ITEM_TYPES.has(String(item.type ?? "")) ||
      isChatIncompatibleHostedToolCall(item) ||
      isChatIncompatibleCall(item) ||
      (resultId !== null && incompatibleCallIds.has(resultId))
    ) {
      changed = true;
      return historicalFact(item);
    }
    return item;
  });
  return changed ? projected : items;
}
