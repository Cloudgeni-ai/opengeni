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
   * The turn's prepared request prefix. When present the checkpoint request
   * reuses its tools, system, model settings (thinking, effort, tool choice)
   * and cache key, so it differs from the warm turn prefix only by the
   * appended checkpoint instruction and reads the prompt cache.
   */
  preparedRequest?: Omit<ModelRequest, "input">;
};

/** Appended to the checkpoint instruction when tools stay visible for caching. */
export const ANTHROPIC_CACHE_REUSE_COMPACTION_NOTE =
  "Do not call any tools. Reply with the handoff summary text only.";

/** One request constructor for both fitting and the actual checkpoint call. */
export function anthropicCompactionRequest(
  input: CompactionItem[],
  options: AnthropicCompactionOptions,
): ModelRequest {
  if (options.preparedRequest)
    return anthropicCacheReuseCompactionRequest(input, options, options.preparedRequest);
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

function anthropicCacheReuseCompactionRequest(
  input: CompactionItem[],
  options: AnthropicCompactionOptions,
  preparedRequest: Omit<ModelRequest, "input">,
): ModelRequest {
  const {
    signal: _priorSignal,
    previousResponseId: _previousResponseId,
    conversationId: _conversationId,
    ...prefix
  } = preparedRequest;
  const providerData = { ...prefix.modelSettings.providerData };
  if (options.promptCacheKey && typeof providerData.prompt_cache_key !== "string")
    providerData.prompt_cache_key = options.promptCacheKey;
  // Tool choice, thinking and effort stay exactly as on the turn: changing any
  // of them invalidates the cached message history. Only max_tokens changes.
  return {
    ...prefix,
    input: withCacheReuseNote(input) as ModelRequest["input"],
    modelSettings: {
      ...prefix.modelSettings,
      maxTokens: options.maxOutputTokens,
      providerData,
    },
    outputType: "text",
    tracing: false,
    ...(options.signal ? { signal: options.signal } : {}),
  };
}

function withCacheReuseNote(input: CompactionItem[]): CompactionItem[] {
  const last = input.at(-1);
  if (!last || last.role !== "user" || typeof last.content !== "string") return input;
  return [
    ...input.slice(0, -1),
    { ...last, content: `${last.content}\n\n${ANTHROPIC_CACHE_REUSE_COMPACTION_NOTE}` },
  ];
}

/**
 * A reused-prefix checkpoint keeps the turn's tools visible. A response that
 * calls a tool or returns no text is not a summary; the caller retries once
 * with the standalone tool-less request.
 */
export function anthropicCacheReuseSummaryUsable(response: unknown): boolean {
  const value = response as {
    output?: Array<{ type?: string; content?: Array<{ type?: string; text?: unknown }> }>;
    providerData?: { anthropic?: { stopReason?: unknown } };
  };
  if (value?.providerData?.anthropic?.stopReason === "tool_use") return false;
  const output = Array.isArray(value?.output) ? value.output : [];
  if (output.some((item) => item?.type !== "message" && item?.type !== "reasoning")) return false;
  return output.some(
    (item) =>
      item?.type === "message" &&
      (item.content ?? []).some(
        (part) => part?.type === "output_text" && typeof part.text === "string" && part.text.trim(),
      ),
  );
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
