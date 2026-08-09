import { isOpenAIResponsesRawModelStreamEvent, type RunStreamEvent } from "@openai/agents";
import {
  approvalIdentifier,
  RequestHumanInputToolInput,
  sessionEventMediaPreview,
  sessionEventMediaPreviewFromDataUrl,
  type SessionEventMediaPreview,
  type SessionEventType,
} from "@opengeni/contracts";

import { normalizeProtocolJsonValue } from "./protocol-json";

export type NormalizedRuntimeEvent = {
  type: SessionEventType;
  payload: unknown;
  retainedOutputEvidence?: unknown;
};

export type NormalizeSdkEventOptions = {
  /** Trusted worker replacement for one tool output (for example an artifact receipt). */
  toolOutputOverride?: unknown;
  /** Separately trusted receipt for the event truncation boundary. */
  retainedOutputEvidence?: unknown;
};

export type ModelResponseUsage = {
  responseId?: string;
  serviceTier?: string;
  gatewayBilling?: {
    finalProvider: string;
    inferenceCostUsd: string;
  };
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    inputTokensDetails?: Record<string, number> | Array<Record<string, number>>;
    outputTokensDetails?: Record<string, number> | Array<Record<string, number>>;
    requestUsageEntries?: Array<{
      inputTokens?: number;
      input_tokens?: number;
      outputTokens?: number;
      output_tokens?: number;
      totalTokens?: number;
      total_tokens?: number;
      inputTokensDetails?: Record<string, number>;
      input_tokens_details?: Record<string, number>;
      outputTokensDetails?: Record<string, number>;
      output_tokens_details?: Record<string, number>;
    }>;
  };
};

export type ModelTerminalResponse = {
  responseId?: string;
  usage: ModelResponseUsage | null;
};

export const HUMAN_INPUT_TOOL_NAME = "request_human_input";

export type SerializedHumanInputInterruption = {
  toolCallId: string;
  input: ReturnType<typeof RequestHumanInputToolInput.parse>;
};

function base64DecodedByteLength(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((value.length * 3) / 4) - padding);
}

/** Determine image byte length without allocating another binary/base64 copy. */
function imageDataByteLength(data: unknown): number | null {
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (Array.isArray(data)) {
    return data.every((value) => typeof value === "number") ? data.length : null;
  }
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (record.type === "Buffer" && Array.isArray(record.data)) {
    return record.data.every((value) => typeof value === "number") ? record.data.length : null;
  }
  const keys = Object.keys(record);
  return keys.length > 0 &&
    keys.every((key) => /^\d+$/.test(key) && typeof record[key] === "number")
    ? keys.length
    : null;
}

/**
 * Convert one image-shaped tool result into a content-free audit fact. This is
 * intentionally different from model history: the model keeps its structured
 * image item, while `session_events` never becomes an implicit image blob store.
 */
function toolOutputMediaPreview(value: unknown): SessionEventMediaPreview | null {
  if (typeof value === "string") {
    return sessionEventMediaPreviewFromDataUrl(value);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.type === "input_image") {
    const source = record.image ?? record.image_url ?? record.imageUrl;
    const url =
      typeof source === "string"
        ? source
        : source && typeof source === "object"
          ? (source as Record<string, unknown>).url
          : null;
    if (typeof url !== "string" || url.length === 0) return null;
    return sessionEventMediaPreviewFromDataUrl(url) ?? sessionEventMediaPreview("image/*", null);
  }
  if (record.type !== "image" || !record.image || typeof record.image !== "object") return null;
  const image = record.image as Record<string, unknown>;
  const mediaType =
    typeof image.mediaType === "string" && image.mediaType.length > 0
      ? image.mediaType
      : "image/png";
  if (typeof image.url === "string" && image.url.length > 0) {
    return (
      sessionEventMediaPreviewFromDataUrl(image.url) ?? sessionEventMediaPreview(mediaType, null)
    );
  }
  if (typeof image.data === "string") {
    return (
      sessionEventMediaPreviewFromDataUrl(image.data) ??
      sessionEventMediaPreview(mediaType, base64DecodedByteLength(image.data))
    );
  }
  const byteLength = imageDataByteLength(image.data);
  return byteLength === null ? null : sessionEventMediaPreview(mediaType, byteLength);
}

/**
 * Normalize a tool-call output for the lossy `agent.toolCall.output` audit event.
 * Inline image bytes/data URLs become a compact `media_preview` with exact byte
 * length where knowable and `fullOutputAvailable:false`. The model-facing output
 * is not changed here, and mixed arrays retain their non-image text/error facts.
 */
export function normalizeToolOutputForEvent(output: unknown): unknown {
  const single = toolOutputMediaPreview(output);
  if (single !== null) {
    return single;
  }
  if (Array.isArray(output)) {
    const normalized = output.map((el) => toolOutputMediaPreview(el) ?? el);
    if (normalized.length === 1 && normalized[0]?.type === "media_preview") {
      return normalized[0];
    }
    return normalized;
  }
  return output;
}

/**
 * Hosted web_search progresses on the raw Responses stream
 * (`response.output_item.added/done` with `web_search_call`) long before the SDK
 * materializes a `RunToolCallItem` at `response_done`. Without this mapping the
 * timeline only sees search cards after the whole model round finishes — or
 * never mid-turn — while assistant prose ("Search 1/5") streams live.
 */
function hostedWebSearchToolCallFromResponsesEvent(raw: unknown): NormalizedRuntimeEvent | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const event = raw as {
    type?: unknown;
    item?: {
      id?: unknown;
      type?: unknown;
      status?: unknown;
      action?: unknown;
      [key: string]: unknown;
    };
  };
  const eventType = typeof event.type === "string" ? event.type : "";
  if (
    !(
      (eventType === "response.output_item.added" || eventType === "response.output_item.done") &&
      event.item?.type === "web_search_call"
    )
  ) {
    // Progress-only `response.web_search_call.*` events lack the action
    // payload; added/done are enough for a live, query-bearing card.
    return null;
  }
  const item = event.item;
  const itemId = typeof item.id === "string" ? item.id : null;
  if (!itemId) {
    return null;
  }
  const status =
    typeof item.status === "string"
      ? item.status
      : eventType === "response.output_item.done"
        ? "completed"
        : "in_progress";
  const action = item.action ?? null;
  // Codex frequently emits `output_item.added` for web_search_call before the
  // action payload exists. Persist that so the timeline can show "Searching…",
  // then the matching `done` (same id) fills in query/queries via merge.
  const { status: _status, ...providerData } = item;

  return {
    type: "agent.toolCall.created",
    payload: {
      id: itemId,
      name: "web_search_call",
      arguments: action,
      raw: {
        type: "hosted_tool_call",
        id: itemId,
        name: "web_search_call",
        status,
        providerData,
      },
    },
  };
}

export function normalizeSdkEvent(
  event: RunStreamEvent,
  options: NormalizeSdkEventOptions = {},
): NormalizedRuntimeEvent[] {
  const out: NormalizedRuntimeEvent[] = [];
  const pushProtocolEvent = (normalized: NormalizedRuntimeEvent): void => {
    out.push(normalizeProtocolJsonValue(normalized, '$["event"]'));
  };
  if (event.type === "raw_model_stream_event") {
    const data = (event as any).data;
    if (data?.type === "output_text_delta" && typeof data.delta === "string") {
      out.push({ type: "agent.message.delta", payload: { text: data.delta } });
      return out;
    }
    if (data?.type === "response_done") {
      return out;
    }
  }
  if (isOpenAIResponsesRawModelStreamEvent(event)) {
    const raw = (event as any).data?.event;
    if (raw?.type === "response.reasoning_summary_text.delta" && typeof raw.delta === "string") {
      out.push({ type: "agent.reasoning.delta", payload: { text: raw.delta } });
    }
    const webSearch = hostedWebSearchToolCallFromResponsesEvent(raw);
    if (webSearch) {
      pushProtocolEvent(webSearch);
    }
    return out;
  }
  if (event.type === "agent_updated_stream_event") {
    out.push({
      type: "agent.updated",
      payload: { agent: (event as any).agent?.name ?? null },
    });
    return out;
  }
  if (event.type !== "run_item_stream_event") {
    return out;
  }
  const item = (event as any).item;
  if (!item) {
    return out;
  }
  if (item.type === "tool_call_item") {
    const raw = item.rawItem ?? {};
    pushProtocolEvent({
      type: "agent.toolCall.created",
      payload: {
        id: raw.callId ?? raw.id ?? item.id ?? null,
        name: raw.name ?? raw.type ?? "tool",
        arguments: raw.arguments ?? raw.input ?? null,
        raw,
      },
    });
  } else if (item.type === "tool_call_output_item") {
    pushProtocolEvent({
      type: "agent.toolCall.output",
      payload: {
        id: item.rawItem?.callId ?? item.id ?? null,
        // Inline media becomes a content-free audit fact. Model history keeps
        // the provider's real structured image output on its separate path.
        output:
          "toolOutputOverride" in options
            ? options.toolOutputOverride
            : normalizeToolOutputForEvent(item.output),
      },
      ...(options.retainedOutputEvidence !== undefined
        ? { retainedOutputEvidence: options.retainedOutputEvidence }
        : {}),
    });
  } else if (item.type === "tool_search_call_item") {
    // Progressive connector disclosure: surface the model's tool search as a
    // regular tool-call event so the session stream shows the step (parity with
    // the Codex CLI, which renders its searches). Arguments may be an object
    // (the live wire shape) or a string.
    const raw = item.rawItem ?? {};
    pushProtocolEvent({
      type: "agent.toolCall.created",
      payload: {
        id: raw.call_id ?? raw.callId ?? raw.id ?? item.id ?? null,
        name: "tool_search",
        arguments: raw.arguments ?? null,
        raw,
      },
    });
  } else if (item.type === "tool_search_output_item") {
    const raw = item.rawItem ?? {};
    const disclosed = Array.isArray(raw.tools)
      ? raw.tools
          .map((tool: { name?: unknown }) => (typeof tool?.name === "string" ? tool.name : ""))
          .filter(Boolean)
      : [];
    pushProtocolEvent({
      type: "agent.toolCall.output",
      payload: {
        id: raw.call_id ?? raw.callId ?? item.id ?? null,
        output: {
          type: "text",
          text:
            disclosed.length > 0
              ? `Disclosed tools: ${disclosed.join(", ")}`
              : "No matching tools found.",
        },
      },
    });
  } else if (item.type === "message_output_item") {
    const text = typeof item.text === "string" ? item.text : undefined;
    if (text) {
      out.push({ type: "agent.message.completed", payload: { text } });
    }
  }
  return out;
}

export function modelResponseUsageFromSdkEvent(event: RunStreamEvent): ModelResponseUsage | null {
  return modelTerminalResponseFromSdkEvent(event)?.usage ?? null;
}

/** Recognize a terminal response even when the provider omitted usage. */
export function modelTerminalResponseFromSdkEvent(
  event: RunStreamEvent,
): ModelTerminalResponse | null {
  const response = modelResponseFromSdkEvent(event);
  if (!response) {
    return null;
  }
  const responseId = modelResponseIdFromResponse(response);
  return {
    ...(responseId ? { responseId } : {}),
    usage: modelResponseUsageFromResponse(response),
  };
}

/** Normalize usage from either a Responses or Chat Completions result. */
export function modelResponseUsageFromResponse(response: unknown): ModelResponseUsage | null {
  const usage = usageFromResponse(response);
  if (!usage) {
    return null;
  }
  const responseId = modelResponseIdFromResponse(response);
  const serviceTier = modelResponseServiceTierFromResponse(response);
  const gatewayBilling = gatewayBillingFromResponse(response);
  return {
    ...(responseId ? { responseId } : {}),
    ...(serviceTier ? { serviceTier } : {}),
    ...(gatewayBilling ? { gatewayBilling } : {}),
    usage,
  };
}

function modelResponseIdFromResponse(response: unknown): string | undefined {
  return typeof (response as { id?: unknown } | null)?.id === "string"
    ? (response as { id: string }).id
    : typeof (response as { responseId?: unknown } | null)?.responseId === "string"
      ? (response as { responseId: string }).responseId
      : undefined;
}

/** Extract only the bounded, non-secret Gateway billing facts we consume. */
function gatewayBillingFromResponse(
  response: unknown,
): ModelResponseUsage["gatewayBilling"] | null {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    return null;
  }
  const record = response as Record<string, unknown>;
  const providerData =
    record.providerData &&
    typeof record.providerData === "object" &&
    !Array.isArray(record.providerData)
      ? (record.providerData as Record<string, unknown>)
      : null;
  const metadataCandidate =
    record.provider_metadata ??
    record.providerMetadata ??
    providerData?.provider_metadata ??
    providerData?.providerMetadata;
  if (
    !metadataCandidate ||
    typeof metadataCandidate !== "object" ||
    Array.isArray(metadataCandidate)
  ) {
    return null;
  }
  const gateway = (metadataCandidate as Record<string, unknown>).gateway;
  if (!gateway || typeof gateway !== "object" || Array.isArray(gateway)) {
    return null;
  }
  const gatewayRecord = gateway as Record<string, unknown>;
  const routing = gatewayRecord.routing;
  const routingRecord =
    routing && typeof routing === "object" && !Array.isArray(routing)
      ? (routing as Record<string, unknown>)
      : null;
  const finalProvider = routingRecord?.finalProvider ?? routingRecord?.final_provider;
  const inferenceCostUsd =
    gatewayRecord.inferenceCost ?? gatewayRecord.inference_cost ?? gatewayRecord.cost;
  if (
    typeof finalProvider !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(finalProvider) ||
    typeof inferenceCostUsd !== "string" ||
    !/^(0|[1-9]\d*)(?:\.\d{1,18})?$/.test(inferenceCostUsd)
  ) {
    return null;
  }
  return { finalProvider, inferenceCostUsd };
}

export type ModelResponseServiceTierEvent = {
  source: "normalized" | "provider";
  serviceTier: string | null;
};

/**
 * Read the provider's terminal service tier without depending on usage being
 * present. The normalized terminal can omit provider-only fields, so callers
 * should treat the raw provider response as the fail-closed authority.
 */
export function modelResponseServiceTierFromSdkEvent(
  event: RunStreamEvent,
): ModelResponseServiceTierEvent | null {
  if (event.type === "raw_model_stream_event") {
    const data = (event as any).data;
    if (data?.type === "response_done") {
      return {
        source: "normalized",
        serviceTier: modelResponseServiceTierFromResponse(data.response),
      };
    }
  }
  if (isOpenAIResponsesRawModelStreamEvent(event)) {
    const raw = (event as any).data?.event;
    if (raw?.type === "response.completed") {
      return {
        source: "provider",
        serviceTier: modelResponseServiceTierFromResponse(raw.response),
      };
    }
  }
  return null;
}

function modelResponseServiceTierFromResponse(response: unknown): string | null {
  if (!response || typeof response !== "object") {
    return null;
  }
  const record = response as Record<string, unknown>;
  const direct = record.service_tier ?? record.serviceTier;
  if (typeof direct === "string" && direct.length > 0) {
    return direct;
  }
  const providerData =
    record.providerData && typeof record.providerData === "object"
      ? (record.providerData as Record<string, unknown>)
      : null;
  const nested = providerData?.service_tier ?? providerData?.serviceTier;
  return typeof nested === "string" && nested.length > 0 ? nested : null;
}

function modelResponseFromSdkEvent(event: RunStreamEvent): any {
  if (event.type === "raw_model_stream_event") {
    const data = (event as any).data;
    if (data?.type === "response_done") {
      return data.response;
    }
  }
  if (isOpenAIResponsesRawModelStreamEvent(event)) {
    const raw = (event as any).data?.event;
    if (raw?.type === "response.completed") {
      return raw.response;
    }
  }
  return null;
}

function usageFromResponse(response: unknown): ModelResponseUsage["usage"] | null {
  const raw = (response as { usage?: unknown } | null)?.usage;
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const usage = {
    ...numberProp(
      record,
      "inputTokens",
      "inputTokens",
      "input_tokens",
      "promptTokens",
      "prompt_tokens",
    ),
    ...numberProp(
      record,
      "outputTokens",
      "outputTokens",
      "output_tokens",
      "completionTokens",
      "completion_tokens",
    ),
    ...numberProp(record, "totalTokens", "totalTokens", "total_tokens"),
    ...inputTokenDetailsProp(record),
    ...outputTokenDetailsProp(record),
    ...requestUsageEntriesProp(record),
  };
  return Object.keys(usage).length > 0 ? usage : null;
}

function numberProp(
  raw: Record<string, unknown>,
  outputKey: "inputTokens" | "outputTokens" | "totalTokens",
  ...keys: string[]
): Partial<ModelResponseUsage["usage"]> {
  const value = keys.map((key) => raw[key]).find((candidate) => candidate !== undefined);
  // Preserve numeric provider values verbatim here, including malformed ones.
  // The shared usage normalizer is the single bounded validation boundary and
  // needs to see NaN/infinite/fractional/oversized values so it can emit safe
  // field-path diagnostics rather than silently erasing the evidence.
  return typeof value === "number" ? { [outputKey]: value } : {};
}

function inputTokenDetailsProp(raw: Record<string, unknown>): Partial<ModelResponseUsage["usage"]> {
  const details =
    raw.inputTokensDetails ??
    raw.input_tokens_details ??
    raw.promptTokensDetails ??
    raw.prompt_tokens_details;
  if (details === undefined || details === null) {
    return {};
  }
  return {
    inputTokensDetails: details as Record<string, number> | Array<Record<string, number>>,
  };
}

function outputTokenDetailsProp(
  raw: Record<string, unknown>,
): Partial<ModelResponseUsage["usage"]> {
  const details = raw.outputTokensDetails ?? raw.output_tokens_details;
  const normalized = details ?? raw.completionTokensDetails ?? raw.completion_tokens_details;
  if (normalized === undefined || normalized === null) {
    return {};
  }
  return {
    outputTokensDetails: normalized as Record<string, number> | Array<Record<string, number>>,
  };
}

function requestUsageEntriesProp(
  raw: Record<string, unknown>,
): Partial<ModelResponseUsage["usage"]> {
  const entries = raw.requestUsageEntries ?? raw.request_usage_entries;
  if (entries === undefined || entries === null) {
    return {};
  }
  return {
    // The normalizer validates every entry and all supported field aliases.
    // Preserve the SDK objects rather than rebuilding them and accidentally
    // dropping provider detail fields such as cache_write_tokens.
    requestUsageEntries: entries as NonNullable<ModelResponseUsage["usage"]["requestUsageEntries"]>,
  };
}

export function serializeApprovals(interruptions: unknown[]): unknown[] {
  const approvals = interruptions
    .filter((item) => interruptionToolName(item) !== HUMAN_INPUT_TOOL_NAME)
    .map((item: any) => {
      if (typeof item?.toJSON === "function") {
        return item.toJSON();
      }
      return {
        id: approvalIdentifier(item) ?? "approval",
        name: item?.name ?? item?.rawItem?.name ?? "tool",
        arguments: item?.arguments ?? item?.rawItem?.arguments ?? null,
        raw: item,
      };
    });
  return normalizeProtocolJsonValue(approvals, '$["approvals"]');
}

export function serializeHumanInputRequests(
  interruptions: unknown[],
): SerializedHumanInputInterruption[] {
  return interruptions
    .filter((item) => interruptionToolName(item) === HUMAN_INPUT_TOOL_NAME)
    .map((item: any) => {
      const rawArguments = item?.arguments ?? item?.rawItem?.arguments;
      let parsedArguments: unknown = rawArguments;
      if (typeof rawArguments === "string") {
        try {
          parsedArguments = JSON.parse(rawArguments);
        } catch {
          throw new Error("Human-input interruption contains invalid JSON arguments");
        }
      }
      const toolCallId = approvalIdentifier(item);
      if (!toolCallId) {
        throw new Error("Human-input interruption is missing a stable tool-call identity");
      }
      return {
        toolCallId,
        input: RequestHumanInputToolInput.parse(parsedArguments),
      };
    });
}

function interruptionToolName(item: unknown): string {
  const candidate = item as {
    toolName?: unknown;
    name?: unknown;
    rawItem?: { name?: unknown };
  };
  const name = candidate?.toolName ?? candidate?.name ?? candidate?.rawItem?.name;
  return typeof name === "string" ? name : "";
}
