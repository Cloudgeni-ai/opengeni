import type { ResolvedModelProvider } from "@opengeni/config";
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

/**
 * Gateway's Kimi Responses adapter rejects the standard grouped parallel-tool
 * continuation (`call A, call B, result A, result B`) even though it accepts
 * the exact same complete items when each result follows its call. Pair only
 * complete contiguous batches by `call_id`; preserve every item and field,
 * parallel execution, model, and provider route. Partial or ambiguous batches
 * stay untouched and fail closed upstream.
 */
export const GATEWAY_REQUEST_BODY_NORMALIZED_HEADER = "x-opengeni-gateway-request-body-normalized";

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

/** Apply the complete reviewed Gateway request policy to an SDK-owned object. */
export function normalizeVercelGatewayRequestBody(body: Record<string, unknown>): void {
  const model = typeof body.model === "string" ? body.model : "";
  const policy = gatewayRequestPolicyForUpstreamModel(model);
  if (!policy) {
    throw new Error("Model request is not in the approved catalogue");
  }
  const providerOptions =
    body.providerOptions &&
    typeof body.providerOptions === "object" &&
    !Array.isArray(body.providerOptions)
      ? { ...(body.providerOptions as Record<string, unknown>) }
      : {};
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
  const input = body.input;
  if (!Array.isArray(input)) return undefined;
  const containsComputerProtocol = input.some(
    (item) =>
      item &&
      typeof item === "object" &&
      ((item as Record<string, unknown>).type === "computer_call" ||
        (item as Record<string, unknown>).type === "computer_call_output"),
  );
  if (!containsComputerProtocol) return undefined;
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
  const projectedBody: Record<string, unknown> = { ...body, input: projectedInput };
  const changedComputerCalls = rewriteComputerCallsToActionsOnly(projectedBody);
  const changedScreenshots = rewriteEmptyComputerCallOutputImageUrls(projectedBody);
  return changedComputerCalls || changedScreenshots ? { body: projectedBody } : undefined;
}

/**
 * One object-stage request policy for both Responses and Chat Completions.
 * Transport wrappers only authenticate, route, observe, and translate errors;
 * they never need to parse and re-stringify an owned model request.
 */
export function modelRequestPolicyForProvider(
  provider: ResolvedModelProvider,
): ModelJsonRequestPolicy {
  return ({ path, body }) => {
    if (provider.id === "azure") {
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
      provider.kind === "vercel-gateway-workspace"
    ) {
      const projectedBody: Record<string, unknown> = {
        ...body,
        ...(body.model === OPENGENI_GATEWAY_MODELS.kimi.upstreamModelId && Array.isArray(body.input)
          ? { input: [...body.input] }
          : {}),
      };
      normalizeVercelGatewayRequestBody(projectedBody);
      return {
        body: projectedBody,
        headers: { [GATEWAY_REQUEST_BODY_NORMALIZED_HEADER]: "1" },
      };
    }
    return undefined;
  };
}
