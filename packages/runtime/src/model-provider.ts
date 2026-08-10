import type { ConfiguredModel, ResolvedModelProvider, Settings } from "@opengeni/config";
import {
  OPENGENI_GATEWAY_MODELS,
  configuredProviders,
  gatewayRequestPolicyForUpstreamModel,
  resolveModelProvider,
} from "@opengeni/config";
import {
  OpenAIChatCompletionsModel,
  setDefaultModelProvider,
  setDefaultOpenAIClient,
  setDefaultOpenAIKey,
  setOpenAIResponsesTransport,
  setTracingDisabled,
  type Model,
  type ModelProvider,
} from "@openai/agents";
import OpenAI from "openai";
import {
  CODEX_MODEL_ID_PREFIX,
  CODEX_REQUEST_BODY_NORMALIZED_HEADER,
  CODEX_REQUEST_CALLER_STREAM_HEADER,
  CODEX_REQUEST_ID_HEADER,
  CODEX_REQUEST_MODEL_HEADER,
  CODEX_RESPONSE_SDK_OUTER_TIMEOUT_MS,
  codexRequestStorage,
  codexSubscriptionFetch,
  normalizedCodexRequestBody,
  opaqueProviderArtifactFingerprints,
} from "@opengeni/codex";
import { randomUUID } from "node:crypto";

import { AppendOnlyOpenAIResponsesModel } from "./append-only-responses-model";
import {
  rewriteComputerCallsToActionsOnly,
  rewriteEmptyComputerCallOutputImageUrls,
} from "./history-sanitizer";
import type { RuntimeMetricsHooks } from "./metrics";
import { ReplayableJsonOpenAI, type ModelJsonRequestPolicy } from "./replayable-json-body";

let runtimeMetricsHooks: RuntimeMetricsHooks | null = null;

export function configureRuntimeMetricsHooks(hooks: RuntimeMetricsHooks | null | undefined): void {
  runtimeMetricsHooks = hooks ?? null;
}

/**
 * Build an OpenAI client from settings for the configured provider. Mirrors the
 * client construction in configureOpenAI so a direct API call (the compaction
 * summarizer) uses the same Azure/OpenAI auth and base URL. Returns null when
 * the OpenAI-platform path has only a key (the SDK default client is used via
 * setDefaultOpenAIKey there); the caller then constructs a key-only client.
 */
export function buildOpenAIClientFromSettings(
  settings: Settings,
  providerId: string = settings.openaiProvider,
): OpenAI {
  if (settings.openaiProvider === "azure") {
    const baseURL = settings.azureOpenaiBaseUrl ?? azureDeploymentBaseUrl(settings);
    const apiKey = settings.azureOpenaiApiKey ?? settings.azureOpenaiAdToken ?? "azure-ad-token";
    return new ReplayableJsonOpenAI(
      {
        apiKey,
        baseURL,
        maxRetries: settings.openaiMaxRetries,
        defaultQuery: azureOpenAIDefaultQuery(settings, baseURL),
        defaultHeaders:
          settings.azureOpenaiAdToken && !settings.azureOpenaiApiKey
            ? { Authorization: `Bearer ${settings.azureOpenaiAdToken}` }
            : undefined,
        fetch: instrumentedModelFetch(providerId, globalThis.fetch),
      },
      { modelRequestPolicy: azureModelRequestPolicy },
    );
  }
  return new ReplayableJsonOpenAI({
    apiKey: settings.openaiApiKey ?? process.env.OPENAI_API_KEY,
    ...(settings.openaiBaseUrl ? { baseURL: settings.openaiBaseUrl } : {}),
    maxRetries: settings.openaiMaxRetries,
    fetch: instrumentedModelFetch(providerId, globalThis.fetch),
  });
}

/**
 * One OpenAI client per resolved provider id, built lazily and cached for the
 * process. The built-in openai/azure provider reuses
 * buildOpenAIClientFromSettings verbatim (so its Azure AD/api-version/base-URL
 * construction stays byte-for-byte identical to configureOpenAI); a registry
 * provider gets a plain client pointed at its base URL with its resolved key,
 * the shared maxRetries budget, and its declared defaultQuery/defaultHeaders.
 * Caching by provider.id keeps concurrent multi-provider turns sharing one
 * connection pool per provider rather than reconstructing a client per turn.
 */
const providerClientCache = new Map<string, OpenAI>();

export function buildProviderClient(provider: ResolvedModelProvider, settings: Settings): OpenAI {
  const workspaceGateway = provider.kind === "vercel-gateway-workspace";
  const gatewayProvider = workspaceGateway || provider.kind === "vercel-gateway-managed";
  const cached = workspaceGateway ? undefined : providerClientCache.get(provider.id);
  if (cached) {
    return cached;
  }
  if (workspaceGateway && !provider.apiKey) {
    throw new WorkspaceGatewayUnavailableError();
  }
  const client = provider.builtin
    ? buildOpenAIClientFromSettings(settings, provider.id)
    : provider.kind === "codex-subscription"
      ? // Codex subscription: the static apiKey is a placeholder — the real per-request
        // bearer + ChatGPT-Account-ID, the /responses->/codex/responses rewrite, and the
        // body normalization are all injected by codexSubscriptionFetch, which reads the
        // per-workspace token from the Codex request context at call time.
        // The provider id is constant ("codex-subscription"), so one cached client serves
        // every workspace without baking a token into it.
        new ReplayableJsonOpenAI(
          {
            apiKey: provider.apiKey ?? "codex-subscription",
            ...(provider.baseUrl ? { baseURL: provider.baseUrl } : {}),
            // Codex transport owns exactly one explicit 401 refresh/retry. Blind
            // SDK retries on network/5xx/partial streams can replay provider work
            // or external tool side effects without a durable checkpoint.
            maxRetries: 0,
            // Codex transport owns finer headers/idle/whole deadlines and emits
            // typed durable evidence. Keep the SDK envelope beyond that budget.
            timeout: CODEX_RESPONSE_SDK_OUTER_TIMEOUT_MS,
            fetch: codexSubscriptionFetch(instrumentedModelFetch(provider.id, globalThis.fetch)),
          },
          { modelRequestPolicy: modelRequestPolicyForProvider(provider) },
        )
      : // ResolvedModelProvider.apiKey is already the resolved key (configuredProviders
        // ran resolveProviderApiKey at config time, collapsing apiKey/apiKeyEnv), so it
        // is passed straight through here rather than re-resolved.
        new ReplayableJsonOpenAI(
          {
            ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
            ...(provider.baseUrl ? { baseURL: provider.baseUrl } : {}),
            // Gateway routing is deliberately fail-closed. Avoid SDK replay after
            // a request may have reached the one pinned endpoint.
            maxRetries: gatewayProvider ? 0 : settings.openaiMaxRetries,
            ...(provider.defaultQuery ? { defaultQuery: provider.defaultQuery } : {}),
            ...(provider.defaultHeaders ? { defaultHeaders: provider.defaultHeaders } : {}),
            fetch: gatewayProvider
              ? vercelGatewayRoutingFetch(
                  provider.kind as "vercel-gateway-managed" | "vercel-gateway-workspace",
                  instrumentedModelFetch(provider.id, globalThis.fetch),
                )
              : instrumentedModelFetch(provider.id, globalThis.fetch),
          },
          { modelRequestPolicy: modelRequestPolicyForProvider(provider) },
        );
  if (!workspaceGateway) {
    providerClientCache.set(provider.id, client);
  }
  return client;
}

export class WorkspaceGatewayUnavailableError extends Error {
  constructor() {
    super(
      "Your Gateway model is unavailable: connect or reconnect the workspace AI Gateway key in Settings, then retry.",
    );
    this.name = "WorkspaceGatewayUnavailableError";
  }
}

/**
 * Gateway's Kimi Responses adapter rejects the standard grouped parallel-tool
 * continuation (`call A, call B, result A, result B`) even though it accepts
 * the exact same complete items when each result follows its call. Pair only
 * complete contiguous batches by `call_id`; preserve every item and field,
 * parallel execution, model, and provider route. Partial or ambiguous batches
 * stay untouched and fail closed upstream.
 */
const GATEWAY_REQUEST_BODY_NORMALIZED_HEADER = "x-opengeni-gateway-request-body-normalized";

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

/**
 * Compatibility fallback for callers that did not apply the object-stage
 * request policy. Inject the reviewed route from the serialized body and
 * replace any caller gateway options. Only the ordered, reviewed endpoint
 * providers are allowed; no model fallback list is sent. Unknown models/body
 * shapes fail before I/O.
 */
export function vercelGatewayRoutingFetch(
  kind: Extract<
    ResolvedModelProvider["kind"],
    "vercel-gateway-managed" | "vercel-gateway-workspace"
  >,
  inner: typeof fetch,
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (!isModelCallFetch(input)) {
      return await inner(input, init);
    }
    const headers = new Headers(init?.headers);
    const bodyAlreadyNormalized = headers.get(GATEWAY_REQUEST_BODY_NORMALIZED_HEADER) === "1";
    headers.delete(GATEWAY_REQUEST_BODY_NORMALIZED_HEADER);
    let nextInit: RequestInit = { ...init, headers };
    if (!bodyAlreadyNormalized) {
      if (typeof init?.body !== "string") {
        throw new Error("Model request could not be prepared");
      }
      try {
        const parsed = JSON.parse(init.body) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("invalid body");
        }
        const body = parsed as Record<string, unknown>;
        normalizeVercelGatewayRequestBody(body);
        nextInit = { ...nextInit, body: JSON.stringify(body) };
      } catch (error) {
        if (error instanceof Error && error.message.includes("approved catalogue")) throw error;
        throw new Error("Model request could not be prepared", { cause: error });
      }
    }
    const response = await inner(input, nextInit);
    if (response.ok) {
      return response;
    }
    // The public error below replaces the upstream response. Cancel its unread
    // body now so buffered bytes and the connection are not retained until GC.
    await response.body?.cancel().catch(() => undefined);
    const message =
      kind === "vercel-gateway-workspace" && (response.status === 401 || response.status === 403)
        ? "Your Gateway connection needs attention. Reconnect it in workspace Settings."
        : "The selected model is temporarily unavailable.";
    return new Response(JSON.stringify({ error: { type: "model_unavailable", message } }), {
      status: response.status,
      statusText: response.statusText,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function azureModelRequestPolicy({
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

export class OpenGeniResponsesModel extends AppendOnlyOpenAIResponsesModel {
  constructor(
    client: OpenAI,
    model: string,
    protected readonly provider: ResolvedModelProvider,
  ) {
    super(client, model);
  }
}

/** Bind a model id to the provider's declared wire API and owned client. */
export function buildModelInstance(
  provider: ResolvedModelProvider,
  client: OpenAI,
  modelId: string,
): Model {
  return provider.api === "chat"
    ? new OpenAIChatCompletionsModel(client, modelId)
    : new OpenGeniResponsesModel(client, modelId, provider);
}

/**
 * Resolved per-turn model routing: the provider that serves `modelId`, its
 * (cached) OpenAI client, the provider-bound `Model` instance, and the
 * configured-model shape (label/api/contextWindow/reasoningEffort/hostedWebSearch).
 * Returns null when the model is not in the registry — the caller then falls
 * back to the legacy global-client path (settings.openaiModel + the default
 * client configured by configureOpenAI), preserved byte-for-byte.
 */
export function resolveTurnModel(
  settings: Settings,
  modelId: string,
): {
  provider: ResolvedModelProvider;
  client: OpenAI;
  model: Model;
  configured: ConfiguredModel;
} | null {
  const resolved = resolveModelProvider(settings, modelId);
  if (!resolved) {
    return null;
  }
  const client = buildProviderClient(resolved.provider, settings);
  return {
    provider: resolved.provider,
    client,
    model: buildModelInstance(resolved.provider, client, resolved.model.upstreamModelId),
    configured: resolved.model,
  };
}

/**
 * Routes a model *name* to its provider-bound Model (Fireworks chat model for a
 * registry model id, the built-in OpenAI/Azure responses model otherwise) via
 * `resolveTurnModel`. This is the load-bearing piece for the sandbox path:
 * passing a Model *instance* as `agent.model` only survives the in-process
 * (`sandboxBackend: "none"`) run — on the SandboxAgent/Modal path the instance
 * is dropped and the model *name* is re-resolved through the run's
 * `modelProvider` (or the global default). Without this router that re-resolution
 * hits the default client (e.g. Azure) and a registry model 404s
 * ("deployment does not exist"); with it the name resolves back to the right
 * provider. Installed both as the run-scoped `Runner.config.modelProvider` (every
 * run in runAgentStream goes through `runScopedRunner(settings, agent)`, built from the
 * per-turn settings) and as the process default (see configureOpenAI). The
 * run-scoped instance is the load-bearing one: a `Runner` resolves string model
 * names against ITS OWN modelProvider, not the lazy global default, so each
 * concurrent turn routes codex/registry names against its own settings and a
 * foreign turn's setDefaultModelProvider can never clobber this turn's routing.
 * The process default remains only as a boot-time fallback. Falls back to the
 * SDK default provider for a model that is in no provider's allow-list.
 */
export class MultiProviderModelProvider implements ModelProvider {
  constructor(private readonly settings: Settings) {}

  async getModel(modelName?: string): Promise<Model> {
    if (modelName) {
      const resolved = resolveTurnModel(
        settingsForRunScopedModelResolution(this.settings, modelName),
        modelName,
      );
      if (resolved) {
        // Fail-loud floor (defense in depth): a `codex/<slug>` id must only ever
        // resolve through the synthetic codex-subscription provider (which installs
        // fetch: codexSubscriptionFetch + the per-workspace bearer). If a future
        // settings path re-introduces a built-in/registry shadow that binds a
        // `codex/` id to any other provider kind, that would silently ship the id
        // to Azure/OpenAI as a deployment name (DeploymentNotFound 404). Refuse it
        // here so codex can never reach a non-codex client on ANY backend; the
        // primary fix (config configuredModels) keeps this a no-op in practice.
        if (
          modelName.startsWith(CODEX_MODEL_ID_PREFIX) &&
          resolved.provider.kind !== "codex-subscription"
        ) {
          throw new CodexSubscriptionUnavailableError(modelName);
        }
        return resolved.model;
      }
      // A `codex/<slug>` id only resolves when the per-workspace worker overlay
      // (settingsWithCodexCredential) has injected the synthetic codex-subscription
      // provider — which it does ONLY for a workspace with an *active* connected
      // Codex subscription. If it did not resolve, the subscription is not
      // connected for this workspace, so the codex provider is absent. Falling
      // through to the built-in Responses fallback below would ship `codex/<slug>` to
      // the global default (Azure) client as a deployment name and surface a
      // misleading "DeploymentNotFound" 404. Throw a clear, user-actionable error
      // instead; it propagates through the worker's agentRunFailurePayload as the
      // turn.failed message the session UI shows. Mirrors the codex-prefix
      // awareness of assertConfiguredModel at apps/api/src/domain/sessions.ts.
      if (modelName.startsWith(CODEX_MODEL_ID_PREFIX)) {
        throw new CodexSubscriptionUnavailableError(modelName);
      }
    }
    // Preserve the legacy unlisted-model fallback, but bind it through the same
    // typed request-policy model as every configured Responses call. This keeps
    // Azure wire normalization at the object stage instead of reintroducing a
    // JSON parse/stringify transport wrapper on the fallback path.
    const builtin = configuredProviders(this.settings)[0];
    if (!builtin) throw new Error("Built-in model provider is unavailable");
    return new OpenGeniResponsesModel(
      buildProviderClient(builtin, this.settings),
      modelName ?? this.settings.openaiModel,
      builtin,
    );
  }
}

function settingsForRunScopedModelResolution(settings: Settings, modelName: string): Settings {
  if (modelName !== settings.openaiModel) {
    return settings;
  }
  const builtinAllowed = splitOpenaiAllowedModels(settings.openaiAllowedModels);
  const fallbackBuiltin = builtinAllowed.find((id) => id !== modelName);
  if (!fallbackBuiltin) {
    return settings;
  }
  // The worker sets runSettings.openaiModel to the turn's model. For namespaced
  // registry ids configuredModels filters the built-in entry out, but a unique
  // bare registry id would otherwise be claimed by the built-in only because of
  // that per-turn override. Resolve the run-scoped router against the deployment
  // allow-list head instead; real built-in models stay in the allow-list.
  return builtinAllowed.includes(modelName)
    ? settings
    : { ...settings, openaiModel: fallbackBuiltin };
}

function splitOpenaiAllowedModels(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * A `codex/<slug>` turn reached the model router but the workspace has no active
 * Codex subscription connected (the worker overlay never injected the synthetic
 * provider, so resolveTurnModel returned nothing). Thrown instead of silently
 * routing the id to the built-in Azure/OpenAI client — that produced an opaque
 * "DeploymentNotFound" 404. The message is user-actionable (connect/reconnect)
 * and carries no status/code, so agentRunFailurePayload surfaces it verbatim as
 * a non-retryable turn.failed the session UI shows.
 */
export class CodexSubscriptionUnavailableError extends Error {
  constructor(modelName: string) {
    super(
      `Codex subscription model "${modelName}" is unavailable: no active Codex subscription is connected for this workspace. ` +
        `Connect (or reconnect) your ChatGPT/Codex subscription in Settings, then retry.`,
    );
    this.name = "CodexSubscriptionUnavailableError";
  }
}

/**
 * The workspace's model policy blocks the provider/model this turn resolved
 * to. Thrown at the worker's post-resolution gate INSTEAD of running the turn
 * on the blocked provider — a policy-restricted workspace (e.g. fail-closed to
 * the Codex subscription) must never silently remap to, or fall through to,
 * the paid built-in client. Like CodexSubscriptionUnavailableError the message
 * is user-actionable and surfaces verbatim as a non-retryable turn.failed.
 */
export class WorkspaceModelPolicyBlockedError extends Error {
  constructor(modelName: string, providerId: string, reason: "provider" | "model") {
    super(
      reason === "provider"
        ? `Model "${modelName}" is not available in this workspace: its provider ("${providerId}") is not in the workspace's allowed providers. ` +
            `Pick an allowed model, or ask a workspace admin to change the workspace model policy.`
        : `Model "${modelName}" is not in this workspace's allowed models. ` +
            `Pick an allowed model, or ask a workspace admin to change the workspace model policy.`,
    );
    this.name = "WorkspaceModelPolicyBlockedError";
  }
}

export function configureOpenAI(settings: Settings): void {
  setOpenAIResponsesTransport(settings.openaiResponsesTransport);
  setTracingDisabled(settings.disableOpenaiTracing || !settings.observabilityOtlpEndpoint);
  // Install the registry-aware router as the process default model provider so a
  // model name re-resolved on the SandboxAgent/Modal path (where a Model instance
  // does not survive) routes to its provider instead of the built-in client.
  // Built before the default-client calls below so it captures the same settings.
  const router = new MultiProviderModelProvider(settings);
  if (settings.openaiProvider === "azure") {
    setDefaultOpenAIClient(buildOpenAIClientFromSettings(settings));
    setDefaultModelProvider(router);
    return;
  }
  if (settings.openaiApiKey) {
    setDefaultOpenAIKey(settings.openaiApiKey);
  }
  if (settings.openaiBaseUrl) {
    setDefaultOpenAIClient(buildOpenAIClientFromSettings(settings));
  }
  setDefaultModelProvider(router);
}

function instrumentedModelFetch(provider: string, inner: typeof fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (!isModelCallFetch(input)) {
      return await inner(input, init);
    }
    const started = performance.now();
    try {
      const response = await inner(input, init);
      recordModelCallMetric(provider, response.ok ? "completed" : "failed", started);
      return response;
    } catch (error) {
      recordModelCallMetric(provider, "failed", started);
      throw error;
    }
  }) as typeof fetch;
}

function isModelCallFetch(input: Parameters<typeof fetch>[0]): boolean {
  const rawUrl =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : (input as { url?: unknown }).url;
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    return false;
  }
  try {
    const pathname = new URL(rawUrl, "http://opengeni.local").pathname;
    return (
      pathname.endsWith("/responses") ||
      pathname.endsWith("/chat/completions") ||
      pathname.endsWith("/codex/responses")
    );
  } catch {
    return /\/(?:codex\/)?responses(?:\?|$)|\/chat\/completions(?:\?|$)/.test(rawUrl);
  }
}

function recordModelCallMetric(
  provider: string,
  outcome: "completed" | "failed",
  started: number,
): void {
  const durationSeconds = Math.max(0, (performance.now() - started) / 1000);
  try {
    runtimeMetricsHooks?.onModelCall?.({ provider, outcome, durationSeconds });
  } catch {
    // Metrics emission must never affect a model call.
  }
}

function azureDeploymentBaseUrl(settings: Settings): string {
  const endpoint = settings.azureOpenaiEndpoint?.replace(/\/+$/, "");
  if (!endpoint || !settings.azureOpenaiDeployment) {
    throw new Error("Azure OpenAI endpoint/deployment settings are incomplete");
  }
  return `${endpoint}/openai/deployments/${settings.azureOpenaiDeployment}`;
}

export function azureOpenAIDefaultQuery(
  settings: Pick<Settings, "azureOpenaiApiVersion">,
  baseURL: string,
): Record<string, string> | undefined {
  if (!settings.azureOpenaiApiVersion) return undefined;
  const normalized = baseURL.replace(/\/+$/, "").toLowerCase();
  if (normalized.endsWith("/openai/v1")) {
    return undefined;
  }
  return { "api-version": settings.azureOpenaiApiVersion };
}
