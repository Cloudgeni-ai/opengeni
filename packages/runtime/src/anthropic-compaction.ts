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
};

/** One request constructor for both fitting and the actual checkpoint call. */
export function anthropicCompactionRequest(
  input: CompactionItem[],
  options: AnthropicCompactionOptions,
): ModelRequest {
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
