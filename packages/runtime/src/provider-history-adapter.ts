export type HistoryProviderApi = "responses" | "chat";

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
    content: `[OpenGeni historical ${String(item.type ?? "provider item")} fact]\n${boundedJson(item)}`,
  };
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

/**
 * Build the one attempt-local history view required by the target wire API.
 * Canonical history remains untouched. Responses history is returned by
 * reference. Chat-compatible history is also returned by reference when every
 * item is already representable by the SDK's Chat Completions converter.
 */
export function projectHistoryForProvider(
  items: Array<Record<string, unknown>>,
  providerApi: HistoryProviderApi,
): Array<Record<string, unknown>> {
  if (providerApi === "responses") return items;

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
    if (item.type === "message" && item.role === "developer") {
      changed = true;
      return { ...item, role: "system" };
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
