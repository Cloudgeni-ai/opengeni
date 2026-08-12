import {
  XAI_SUBSCRIPTION_AUTO_COMPACTION_PERCENT,
  XAI_SUBSCRIPTION_EFFECTIVE_CONTEXT_PERCENT,
} from "./constants";
import type { XaiFetchLike } from "./fetch";
import { fetchXaiProxyJson, type XaiProxyAuthContext } from "./proxy";

export type XaiSubscriptionModelMetadata = {
  slug: string;
  name: string;
  contextWindowTokens: number;
  effectiveContextWindowTokens: number;
  autoCompactTokenLimit: number;
  maxCompletionTokens: number | null;
  apiBackend: "responses" | "chat_completions" | "messages";
};

export async function fetchXaiSubscriptionModels(input: {
  context: XaiProxyAuthContext;
  fetch?: XaiFetchLike;
  timeoutMs?: number;
  baseUrl?: string;
}): Promise<XaiSubscriptionModelMetadata[]> {
  const body = await fetchXaiProxyJson<unknown>({
    path: "models-v2",
    context: input.context,
    ...(input.fetch ? { fetch: input.fetch } : {}),
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    maxBytes: 4 * 1024 * 1024,
    label: "model metadata request",
  });
  const values = Array.isArray(body)
    ? body
    : body && typeof body === "object" && Array.isArray((body as Record<string, unknown>).data)
      ? ((body as Record<string, unknown>).data as unknown[])
      : [];
  return values.flatMap((value) => {
    const parsed = parseXaiSubscriptionModelMetadata(value);
    return parsed ? [parsed] : [];
  });
}

export function parseXaiSubscriptionModelMetadata(
  value: unknown,
): XaiSubscriptionModelMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  const meta =
    object._meta && typeof object._meta === "object" && !Array.isArray(object._meta)
      ? (object._meta as Record<string, unknown>)
      : {};
  const slug = firstString(object.model, object.modelId, object.id, meta.model, meta.modelId);
  const contextWindowTokens = firstPositiveInteger(
    object.contextWindow,
    object.context_window,
    meta.contextWindow,
    meta.totalContextTokens,
  );
  if (!slug || contextWindowTokens === null) return null;
  const effectivePercent = firstPositiveInteger(
    object.effectiveContextWindowPercent,
    object.effective_context_window_percent,
  ) ?? XAI_SUBSCRIPTION_EFFECTIVE_CONTEXT_PERCENT;
  const autoCompactPercent = firstPositiveInteger(
    object.autoCompactThresholdPercent,
    object.auto_compact_threshold_percent,
  ) ?? XAI_SUBSCRIPTION_AUTO_COMPACTION_PERCENT;
  const backend = firstString(object.apiBackend, object.api_backend);
  return {
    slug,
    name: firstString(object.name) ?? slug,
    contextWindowTokens,
    effectiveContextWindowTokens: Math.floor((contextWindowTokens * effectivePercent) / 100),
    autoCompactTokenLimit: Math.floor((contextWindowTokens * autoCompactPercent) / 100),
    maxCompletionTokens: firstPositiveInteger(
      object.maxCompletionTokens,
      object.max_completion_tokens,
    ),
    apiBackend:
      backend === "chat_completions" || backend === "messages" ? backend : "responses",
  };
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function firstPositiveInteger(...values: unknown[]): number | null {
  for (const value of values) {
    const number = Number(value);
    if (Number.isSafeInteger(number) && number > 0) return number;
  }
  return null;
}