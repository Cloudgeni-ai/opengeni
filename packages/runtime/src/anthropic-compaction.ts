import type { ModelRequest } from "@openai/agents";
import type { ResolvedModelProvider } from "@opengeni/config";
import { AnthropicMessagesModel } from "./anthropic-messages";
import { TOOL_CALL_RESULT_TYPE_BY_CALL_TYPE } from "./history-sanitizer";
import { toolCallIdFromSdkItem } from "./tool-call-identity";
import type { CompactionItem } from "./context-compaction";

export type AnthropicCompactionOptions = {
  maxOutputTokens: number;
  systemInstructions?: string;
  promptCacheKey?: string;
  signal?: AbortSignal;
  /**
   * The ordinary request this agent prepared for its next model call (tools,
   * instructions and settings, without history). Claude caches the prefix in
   * the order tools → system → messages, and the thinking mode, effort and
   * tool choice are part of the cache key, so the checkpoint request reuses
   * all of them unchanged and only appends the checkpoint instruction.
   */
  preparedRequest?: Omit<ModelRequest, "input">;
  /**
   * Retry after the model called a tool instead of writing the summary. This
   * changes `tool_choice`, which costs the cached history (tools and
   * instructions stay cached), so it is never the first attempt.
   */
  forbidToolCalls?: boolean;
};

/**
 * Appended after the checkpoint prompt when the request keeps the agent's
 * tools for cache reuse. A separate trailing user message merges into the same
 * Claude user turn, so the shared Codex checkpoint prompt stays verbatim.
 */
export const ANTHROPIC_COMPACTION_TEXT_ONLY_INSTRUCTION =
  "Respond with the summary as plain text only. Do not call any tools.";

/**
 * Thinking shares `max_tokens` with the summary. The checkpoint keeps the
 * agent's effort because it is part of the cache key, so it gets room to reason
 * beyond the summary budget. `max_tokens` itself is not part of the cache key.
 */
export const ANTHROPIC_COMPACTION_THINKING_HEADROOM_TOKENS = 32_000;

/** One request constructor for both fitting and the actual checkpoint call. */
export function anthropicCompactionRequest(
  input: CompactionItem[],
  options: AnthropicCompactionOptions,
): ModelRequest {
  const prepared = options.preparedRequest;
  if (prepared) {
    const { signal: _preparedSignal, ...prefix } = prepared;
    const keepsTools = prefix.tools.length > 0 || prefix.handoffs.length > 0;
    const forbid = options.forbidToolCalls === true && keepsTools;
    const effort = prefix.modelSettings.reasoning?.effort;
    const thinks = Boolean(effort) && effort !== "none";
    // `disable_parallel_tool_use` is not valid with `tool_choice: none`.
    const { parallelToolCalls: _parallel, ...unforcedSettings } = prefix.modelSettings;
    return {
      ...prefix,
      input: (keepsTools
        ? [
            ...input,
            {
              type: "message",
              role: "user",
              content: ANTHROPIC_COMPACTION_TEXT_ONLY_INSTRUCTION,
            },
          ]
        : input) as ModelRequest["input"],
      modelSettings: {
        ...(forbid ? unforcedSettings : prefix.modelSettings),
        maxTokens:
          options.maxOutputTokens + (thinks ? ANTHROPIC_COMPACTION_THINKING_HEADROOM_TOKENS : 0),
        ...(forbid ? { toolChoice: "none" as const } : {}),
        providerData: {
          ...prefix.modelSettings.providerData,
          opengeni_compaction_prefix: "prepared",
        },
      },
      outputType: "text",
      tracing: false,
      ...(options.signal ? { signal: options.signal } : {}),
    };
  }
  return {
    input: input as ModelRequest["input"],
    systemInstructions: options.systemInstructions ?? "",
    modelSettings: {
      maxTokens: options.maxOutputTokens,
      providerData: {
        opengeni_portable_compaction: true,
        ...(options.promptCacheKey ? { prompt_cache_key: options.promptCacheKey } : {}),
      },
    },
    tools: [],
    toolsExplicitlyProvided: true,
    handoffs: [],
    outputType: "text",
    tracing: false,
    ...(options.signal ? { signal: options.signal } : {}),
  };
}

export function createAnthropicCompactionSizer(provider: ResolvedModelProvider, model: string) {
  const transport = new AnthropicMessagesModel(provider, model, (async () => {
    throw new Error("A compaction size check must never dispatch inference");
  }) as unknown as typeof fetch);
  return async (input: CompactionItem[], options: AnthropicCompactionOptions) =>
    (await transport.measureRequest(anthropicCompactionRequest(input, options))).requestBytes;
}

/** Cut only between whole assistant/tool batches; never split signed thinking
 * from its assistant turn or leave a tool receipt without its completed call. */
export function compactionPrefixCuts(items: readonly CompactionItem[]): number[] {
  const resultTypes = new Set(Object.values(TOOL_CALL_RESULT_TYPE_BY_CALL_TYPE));
  const calls = new Set<string>();
  const cuts: number[] = [];
  let previousPhase = "";
  let unidentifiedCall = false;
  for (let index = 0; index < items.length; index++) {
    const item = items[index]!;
    const type = String(item.type ?? "message");
    const isMessage = type === "message";
    const realInput = isMessage && ["user", "system", "developer"].includes(String(item.role));
    const phase = realInput || resultTypes.has(type) ? "user" : "assistant";
    if (index > 0 && calls.size === 0 && !unidentifiedCall && phase !== previousPhase)
      cuts.push(index);
    const id = toolCallIdFromSdkItem(item);
    if (Object.hasOwn(TOOL_CALL_RESULT_TYPE_BY_CALL_TYPE, type)) {
      if (id) calls.add(id);
      else unidentifiedCall = true;
    }
    if (resultTypes.has(type) && typeof id === "string") calls.delete(id);
    previousPhase = phase;
  }
  return cuts;
}

/** Find a fitting earlier prefix; the caller retains the entire suffix. No
 * history trimming, synthesized summary, or provider call occurs here. */
export async function fitCompactionPrefix(
  items: readonly CompactionItem[],
  fits: (prefix: CompactionItem[]) => Promise<boolean>,
  preserveLatest: boolean,
): Promise<number | null> {
  if (!preserveLatest && (await fits([...items]))) return items.length;
  const cuts = compactionPrefixCuts(items);
  let low = 0;
  let high = cuts.length - 1;
  let fitted: number | null = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const cut = cuts[middle]!;
    if (await fits(items.slice(0, cut))) {
      fitted = cut;
      low = middle + 1;
    } else high = middle - 1;
  }
  return fitted;
}
