import type { ConfiguredModel, ResolvedModelProvider } from "@opengeni/config";
import { OPENGENI_GATEWAY_MODELS, gatewayRequestPolicyForUpstreamModel } from "@opengeni/config";
import {
  CODEX_REQUEST_BODY_NORMALIZED_HEADER,
  CODEX_REQUEST_CALLER_STREAM_HEADER,
  CODEX_REQUEST_ID_HEADER,
  CODEX_REQUEST_MODEL_HEADER,
  codexRequestStorage,
  normalizedCodexRequestBody,
  opaqueProviderArtifactFingerprints,
} from "@opengeni/codex";
import {
  XAI_SUBSCRIPTION_REQUEST_BODY_NORMALIZED_HEADER,
  XAI_SUBSCRIPTION_REQUEST_ID_HEADER,
  XAI_SUBSCRIPTION_REQUEST_MODEL_HEADER,
  normalizeXaiSubscriptionRequestBody,
  xaiSubscriptionRequestStorage,
} from "@opengeni/xai-subscription";
import { randomUUID } from "node:crypto";

import {
  rewriteComputerCallsToActionsOnly,
  rewriteEmptyComputerCallOutputImageUrls,
} from "./history-sanitizer";
import {
  CodexSubscriptionUnavailableError,
  XaiSubscriptionUnavailableError,
} from "./model-provider-errors";
import type { ModelJsonRequestPolicy } from "./replayable-json-body";
import { geminiFunctionResponseRefPolicy } from "./gemini-function-response";
import {
  chatReasoning,
  chatReasoningDetails,
  joinChatReasoningMessages,
  projectUnsignedClaudeChatReasoning,
} from "./chat-reasoning";

/**
 * Gateway's Kimi Responses adapter rejects the standard grouped parallel-tool
 * continuation (`call A, call B, result A, result B`) even though it accepts
 * the exact same complete items when each result follows its call. Pair only
 * complete contiguous batches by `call_id`; preserve every item and field,
 * parallel execution, model, and provider route. Partial or ambiguous batches
 * stay untouched and fail closed upstream.
 */
export const GATEWAY_REQUEST_BODY_NORMALIZED_HEADER = "x-opengeni-gateway-request-body-normalized";

export type GatewayRequestPolicyLookup = ReadonlyMap<string, ConfiguredModel["requestPolicy"]>;

function pairKimiParallelFunctionCallResults(body: Record<string, unknown>): void {
  const input = body.input;
  if (!Array.isArray(input)) return;
  let index = 0;
  while (index < input.length) {
    const item = input[index];
    if (
      !item ||
      typeof item !== "object" ||
      (item as Record<string, unknown>).type !== "function_call"
    ) {
      index += 1;
      continue;
    }
    let callEnd = index;
    while (
      callEnd < input.length &&
      input[callEnd] &&
      typeof input[callEnd] === "object" &&
      (input[callEnd] as Record<string, unknown>).type === "function_call"
    ) {
      callEnd += 1;
    }
    const calls = input.slice(index, callEnd) as Array<Record<string, unknown>>;
    if (calls.length < 2) {
      index = callEnd;
      continue;
    }
    let resultEnd = callEnd;
    while (
      resultEnd < input.length &&
      input[resultEnd] &&
      typeof input[resultEnd] === "object" &&
      (input[resultEnd] as Record<string, unknown>).type === "function_call_output"
    ) {
      resultEnd += 1;
    }
    const results = input.slice(callEnd, resultEnd) as Array<Record<string, unknown>>;
    if (results.length !== calls.length) {
      index = resultEnd;
      continue;
    }
    const resultsByCallId = new Map<string, Record<string, unknown>>();
    for (const result of results) {
      const callId = result.call_id;
      if (typeof callId !== "string" || resultsByCallId.has(callId)) {
        resultsByCallId.clear();
        break;
      }
      resultsByCallId.set(callId, result);
    }
    const paired: Array<Record<string, unknown>> = [];
    for (const call of calls) {
      const callId = call.call_id;
      const result = typeof callId === "string" ? resultsByCallId.get(callId) : undefined;
      if (!result) {
        paired.length = 0;
        break;
      }
      paired.push(call, result);
    }
    if (paired.length === calls.length * 2) {
      input.splice(index, paired.length, ...paired);
      index += paired.length;
    } else {
      index = resultEnd;
    }
  }
}

/** Apply the complete configured Gateway request policy to an SDK-owned object. */
export function normalizeVercelGatewayRequestBody(
  body: Record<string, unknown>,
  configuredPolicies?: GatewayRequestPolicyLookup,
): void {
  const model = typeof body.model === "string" ? body.model : "";
  const configured = configuredPolicies?.has(model) ?? false;
  const policy = configuredPolicies
    ? configuredPolicies.get(model)
    : gatewayRequestPolicyForUpstreamModel(model);
  if (!policy && !configured) {
    throw new Error("Model request is not in the approved catalogue");
  }
  const providerOptions =
    body.providerOptions &&
    typeof body.providerOptions === "object" &&
    !Array.isArray(body.providerOptions)
      ? { ...(body.providerOptions as Record<string, unknown>) }
      : {};
  if (!policy) {
    // A stored workspace custom model deliberately uses Gateway's own default
    // routing. Strip any caller-supplied pin or fallback list so "unpinned"
    // cannot become an alternate, user-controlled routing policy.
    delete providerOptions.gateway;
    if (Object.keys(providerOptions).length > 0) {
      body.providerOptions = providerOptions;
    } else {
      delete body.providerOptions;
    }
    return;
  }
  providerOptions.gateway = {
    only: [...policy.gateway.only],
    order: [...policy.gateway.only],
    ...(policy.gateway.caching === "auto" ? { caching: "auto" } : {}),
  };
  body.providerOptions = providerOptions;
  if (model === OPENGENI_GATEWAY_MODELS.kimi.upstreamModelId) {
    pairKimiParallelFunctionCallResults(body);
  }
}

export function azureModelRequestPolicy({
  body,
}: {
  body: Readonly<Record<string, unknown>>;
}): ReturnType<ModelJsonRequestPolicy> {
  // Azure documents sources for web search and result snippets for reasoning
  // models. Request only when the native tool is actually attached; this is not
  // capability discovery or a second search. Effort presence is a conservative
  // predicate: no/disabled reasoning still receives URL-only sources.
  const hostedSearch =
    body.input !== undefined &&
    Array.isArray(body.tools) &&
    body.tools.some((tool) => tool?.type === "web_search" || tool?.type === "web_search_preview");
  let projectedBody: Record<string, unknown> = body;
  if (hostedSearch && (body.include === undefined || Array.isArray(body.include))) {
    const reasoning = body.reasoning as { effort?: unknown } | undefined;
    const includes = [
      ...(Array.isArray(body.include) ? body.include : []),
      "web_search_call.action.sources",
      ...(typeof reasoning?.effort === "string" &&
      reasoning.effort.trim() &&
      reasoning.effort !== "none"
        ? ["web_search_call.results"]
        : []),
    ];
    const include = [...new Set(includes)];
    if (
      !Array.isArray(body.include) ||
      include.length !== body.include.length ||
      include.some((value, index) => value !== (body.include as unknown[])[index])
    ) {
      projectedBody = { ...body, include };
    }
  }
  const input = body.input;
  if (!Array.isArray(input)) return projectedBody === body ? undefined : { body: projectedBody };
  const containsComputerProtocol = input.some(
    (item) =>
      item &&
      typeof item === "object" &&
      ((item as Record<string, unknown>).type === "computer_call" ||
        (item as Record<string, unknown>).type === "computer_call_output"),
  );
  if (!containsComputerProtocol)
    return projectedBody === body ? undefined : { body: projectedBody };
  const projectedInput = input.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    if (record.type === "computer_call") return { ...record };
    if (
      record.type === "computer_call_output" &&
      record.output &&
      typeof record.output === "object" &&
      !Array.isArray(record.output)
    ) {
      return { ...record, output: { ...(record.output as Record<string, unknown>) } };
    }
    return item;
  });
  const computerBody = { ...projectedBody, input: projectedInput };
  const changedComputerCalls = rewriteComputerCallsToActionsOnly(computerBody);
  const changedScreenshots = rewriteEmptyComputerCallOutputImageUrls(computerBody);
  return changedComputerCalls || changedScreenshots
    ? { body: computerBody }
    : projectedBody === body
      ? undefined
      : { body: projectedBody };
}

/**
 * Opper ids name Claude as a pool (`claude-sonnet-4-6`), a pinned route
 * (`aws/claude-sonnet-4-6-eu`, `anthropic/claude-…`, `vertexai/claude-…`) or a
 * provider-native alias (`eu.anthropic.claude-…`). Match the model family, not
 * one route prefix.
 */
export function isOpperClaudeUpstreamModel(model: unknown): boolean {
  return typeof model === "string" && /(?:^|[/.])claude-/iu.test(model);
}

/**
 * One object-stage request policy for both Responses and Chat Completions.
 * Transport wrappers only authenticate, route, observe, and translate errors;
 * they never need to parse and re-stringify an owned model request.
 */
export function modelRequestPolicyForProvider(
  provider: ResolvedModelProvider,
  gatewayPolicies?: GatewayRequestPolicyLookup,
  /** Opper upstream id -> `max_tokens` sent when a request sets no output cap. */
  opperOutputLimits?: ReadonlyMap<string, number>,
): ModelJsonRequestPolicy {
  const providerPolicy: ModelJsonRequestPolicy = ({ path, body }) => {
    if (
      (provider.kind === "openrouter-managed" ||
        provider.kind === "openrouter-workspace" ||
        provider.kind === "openrouter-organization") &&
      (path.split("?", 1)[0] ?? path).endsWith("/chat/completions") &&
      typeof body.model === "string" &&
      body.model.startsWith("anthropic/") &&
      Array.isArray(body.messages)
    ) {
      const messages = projectUnsignedClaudeChatReasoning(body.messages);
      return messages === body.messages ? undefined : { body: { ...body, messages } };
    }
    if (
      (provider.kind === "opper-managed" ||
        provider.kind === "opper-workspace" ||
        provider.kind === "opper-organization") &&
      gatewayPolicies &&
      !gatewayPolicies.has(typeof body.model === "string" ? body.model : "")
    ) {
      throw new Error(`Opper model ${String(body.model)} is not in the reviewed catalog`);
    }
    if (
      (provider.kind === "opper-managed" ||
        provider.kind === "opper-workspace" ||
        provider.kind === "opper-organization") &&
      (path.split("?", 1)[0] ?? path).endsWith("/chat/completions")
    ) {
      let projected = body;
      if (isOpperClaudeUpstreamModel(body.model) && Array.isArray(body.messages)) {
        // Opper routes Claude through Anthropic, Bedrock, Vertex and Azure; all
        // reject unsigned plaintext thinking exactly like OpenRouter `anthropic/…`.
        const messages = projectUnsignedClaudeChatReasoning(body.messages);
        if (messages !== body.messages) projected = { ...projected, messages };
      }
      // Opper caps output at 4,096 tokens when a request names no limit, which
      // hidden reasoning can consume entirely (finish `length`, empty answer).
      const outputLimit =
        typeof body.model === "string" ? opperOutputLimits?.get(body.model) : undefined;
      if (
        outputLimit !== undefined &&
        body.max_tokens === undefined &&
        body.max_completion_tokens === undefined
      ) {
        projected = { ...projected, max_tokens: outputLimit };
      }
      return projected === body ? undefined : { body: projected };
    }
    if (provider.wireProfile === "azure-openai") {
      return azureModelRequestPolicy({ body });
    }
    if (provider.kind === "codex-subscription") {
      if (!(path.split("?", 1)[0] ?? path).endsWith("/responses")) {
        throw new Error("Subscription models require the Responses API");
      }
      const fallbackModel = typeof body.model === "string" ? body.model : provider.id;
      const callerWantsStream = body.stream === true;
      const context = codexRequestStorage.getStore();
      if (!context) throw new CodexSubscriptionUnavailableError(fallbackModel);

      const normalizedBody = normalizedCodexRequestBody(body, context.resolveModel);
      const requestId = context.nextRequestId?.() ?? randomUUID();
      context.onRequestOpaqueArtifacts?.({
        requestId,
        fingerprints: opaqueProviderArtifactFingerprints(normalizedBody.input),
      });
      return {
        body: normalizedBody,
        headers: {
          [CODEX_REQUEST_BODY_NORMALIZED_HEADER]: "1",
          [CODEX_REQUEST_CALLER_STREAM_HEADER]: callerWantsStream ? "1" : "0",
          [CODEX_REQUEST_MODEL_HEADER]:
            typeof normalizedBody.model === "string" ? normalizedBody.model : fallbackModel,
          [CODEX_REQUEST_ID_HEADER]: requestId,
        },
      };
    }
    if (provider.kind === "xai-subscription") {
      if (!(path.split("?", 1)[0] ?? path).endsWith("/responses")) {
        throw new Error("SuperGrok subscription models require the Responses API");
      }
      const fallbackModel = typeof body.model === "string" ? body.model : provider.id;
      const context = xaiSubscriptionRequestStorage.getStore();
      if (!context) throw new XaiSubscriptionUnavailableError(fallbackModel);

      const normalizedBody = normalizeXaiSubscriptionRequestBody(
        body,
        context.resolveModel,
        context.hostedSearch,
      );
      return {
        body: normalizedBody,
        headers: {
          [XAI_SUBSCRIPTION_REQUEST_BODY_NORMALIZED_HEADER]: "1",
          [XAI_SUBSCRIPTION_REQUEST_MODEL_HEADER]:
            typeof normalizedBody.model === "string" ? normalizedBody.model : fallbackModel,
          [XAI_SUBSCRIPTION_REQUEST_ID_HEADER]: context.nextRequestId?.() ?? randomUUID(),
        },
      };
    }
    if (
      provider.kind === "vercel-gateway-managed" ||
      provider.kind === "vercel-gateway-workspace" ||
      provider.kind === "vercel-gateway-organization"
    ) {
      const projectedBody: Record<string, unknown> = {
        ...body,
        ...(body.model === OPENGENI_GATEWAY_MODELS.kimi.upstreamModelId && Array.isArray(body.input)
          ? { input: [...body.input] }
          : {}),
      };
      normalizeVercelGatewayRequestBody(projectedBody, gatewayPolicies);
      return {
        body: projectedBody,
        headers: { [GATEWAY_REQUEST_BODY_NORMALIZED_HEADER]: "1" },
      };
    }
    return undefined;
  };
  return (request) => {
    const projected = chatModelRequestPolicy(request);
    const result =
      providerPolicy({ ...request, body: projected?.body ?? request.body }) ?? projected;
    // Upstream-model wire quirk, independent of route: Gemini reserves `$ref`
    // keys inside a parsed function response. Request-local copy only.
    const gemini = geminiFunctionResponseRefPolicy({
      path: request.path,
      body: result?.body ?? request.body,
    });
    return gemini?.body ? { ...result, body: gemini.body } : result;
  };
}

/** Output-only metadata can survive the SDK's conversion of retained replies.
 * Project it off the Chat request without changing the retained history or
 * provider extensions such as cache_control. Responses keeps its own schema.
 */
export const chatModelRequestPolicy: ModelJsonRequestPolicy = ({ path, body }) => {
  if (!(path.split("?", 1)[0] ?? path).endsWith("/chat/completions")) return undefined;
  if (!Array.isArray(body.messages)) return undefined;
  let changed = false;
  const messages = body.messages.map((message) => {
    if (!message || typeof message !== "object" || message.role !== "assistant") return message;
    if (!Array.isArray(message.content)) return message;
    let contentChanged = false;
    // Older non-streamed SDK replies retained message fields inside text parts.
    // Recover their reasoning at message scope before removing invalid nesting.
    let retainedReasoning = chatReasoning(message);
    let retainedDetails = chatReasoningDetails(message);
    const content = message.content.map((part: unknown) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return part;
      const record = part as Record<string, unknown>;
      if (record.type !== "text" && record.type !== "refusal") return part;
      retainedReasoning ??= chatReasoning(record);
      retainedDetails ??= chatReasoningDetails(record);
      const outputOnlyKeys = [
        "annotations",
        "logprobs",
        "role",
        "tool_calls",
        "function_call",
        "audio",
        "reasoning",
        "reasoning_content",
        "reasoning_details",
        "tools",
        ...(record.type === "text" ? ["refusal"] : ["content"]),
      ];
      if (!outputOnlyKeys.some((key) => Object.hasOwn(record, key))) return part;
      const projected = { ...record };
      for (const key of outputOnlyKeys) delete projected[key];
      contentChanged = true;
      return projected;
    });
    if (!contentChanged) return message;
    changed = true;
    return {
      ...message,
      content,
      ...(retainedReasoning ? { [retainedReasoning.field]: retainedReasoning.text } : {}),
      ...(retainedDetails ? { reasoning_details: retainedDetails } : {}),
    };
  });
  const joined = joinChatReasoningMessages(messages);
  return changed || joined !== messages ? { body: { ...body, messages: joined } } : undefined;
};
