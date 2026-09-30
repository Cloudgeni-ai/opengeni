import type { ConfiguredModel, ResolvedModelProvider, Settings } from "@opengeni/config";
import { configuredProviders, resolveModelProvider } from "@opengeni/config";
import {
  OpenAIChatCompletionsModel,
  type Model,
  type ModelResponse,
  type ModelProvider,
  type ModelRequest,
  type ResponseStreamEvent,
} from "@openai/agents";
import OpenAI, { APIError } from "openai";
import { AnthropicMessagesModel } from "./anthropic-messages";
import { instrumentedModelFetch } from "./model-provider-client";
import { CODEX_MODEL_ID_PREFIX } from "@opengeni/codex";
import { XAI_SUBSCRIPTION_MODEL_ID_PREFIX } from "@opengeni/xai-subscription";

import { AppendOnlyOpenAIResponsesModel } from "./append-only-responses-model";
import { recordModelPreparationMeasurement } from "./model-preparation-diagnostics";
import {
  ResponsesStreamingTerminalError,
  responsesStreamingTerminalError,
} from "./responses-terminal-error";
import { buildProviderClient } from "./model-provider-client";
import {
  CodexSubscriptionUnavailableError,
  UnknownModelFinishReasonError,
  XaiSubscriptionUnavailableError,
} from "./model-provider-errors";

function isUnknownFinishReason(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "unknown";
}

function chatCompletionFinishReason(value: unknown): unknown {
  if (!value || typeof value !== "object") return undefined;
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return undefined;
  const primary = choices.find(
    (choice) => choice && typeof choice === "object" && (choice as { index?: unknown }).index === 0,
  );
  return primary && typeof primary === "object"
    ? (primary as { finish_reason?: unknown }).finish_reason
    : undefined;
}

/**
 * Chat-compatible providers can report `finish_reason: "unknown"` after an
 * interrupted generation. The upstream SDK otherwise converts that terminal
 * into an ordinary `response_done`, which can commit a truncated answer. Fail
 * before that boundary so the worker's fenced same-turn recovery owns the
 * continuation and no OpenGeni tool call from the ambiguous response executes.
 */
export class OpenGeniChatCompletionsModel extends OpenAIChatCompletionsModel {
  override async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const response = await super.getResponse(request);
    if (isUnknownFinishReason(chatCompletionFinishReason(response.providerData))) {
      throw new UnknownModelFinishReasonError();
    }
    return response;
  }

  override async *getStreamedResponse(request: ModelRequest): AsyncIterable<ResponseStreamEvent> {
    let finishReason: unknown;
    for await (const event of super.getStreamedResponse(request)) {
      if (event.type === "model") {
        const observed = chatCompletionFinishReason(event.event);
        if (observed !== undefined && observed !== null) {
          finishReason = observed;
        }
      }
      if (event.type === "response_done" && isUnknownFinishReason(finishReason)) {
        throw new UnknownModelFinishReasonError();
      }
      yield event;
    }
  }
}

export class OpenGeniResponsesModel extends AppendOnlyOpenAIResponsesModel {
  constructor(
    client: OpenAI,
    model: string,
    protected readonly provider: ResolvedModelProvider,
  ) {
    super(client, model);
  }

  protected override _fetchResponse(
    request: ModelRequest,
    stream: false,
  ): Promise<OpenAI.Responses.Response>;
  protected _fetchResponse(
    request: ModelRequest,
    stream: true,
  ): Promise<AsyncIterable<OpenAI.Responses.ResponseStreamEvent>>;
  protected async _fetchResponse(
    request: ModelRequest,
    stream: boolean,
  ): Promise<OpenAI.Responses.Response | AsyncIterable<OpenAI.Responses.ResponseStreamEvent>> {
    if (!stream || !this.ownsResponsesTerminalClassification()) {
      // Subscription transports retain the SDK's request-id and error handling.
      return await super._fetchResponse(request, stream as false);
    }
    // Reuse the SDK's full request conversion, but retain its HTTP receipt
    // before the SDK's stream wrapper discards the response headers.
    const built = this._buildResponsesCreateRequest(request, true);
    const internal = (request as ModelRequest & { _internal?: { runnerManagedRetry?: boolean } })
      ._internal;
    const pending = this._client.responses.create(
      built.requestData as OpenAI.Responses.ResponseCreateParamsStreaming,
      {
        headers: built.sdkRequestHeaders,
        signal: built.signal,
        ...(built.transportExtraQuery ? { query: built.transportExtraQuery } : {}),
        ...(internal?.runnerManagedRetry === true ? { maxRetries: 0 } : {}),
      },
    );
    if (typeof pending.withResponse !== "function") {
      // The SDK also permits custom clients returning only the stream promise.
      // Such clients cannot supply HTTP evidence, but must remain usable.
      return this.classifiedResponseStream(await pending, new Headers(), null);
    }
    const receipt = await pending.withResponse();
    return this.classifiedResponseStream(
      receipt.data,
      receipt.response.headers,
      receipt.request_id,
    );
  }

  private async *classifiedResponseStream(
    stream: AsyncIterable<OpenAI.Responses.ResponseStreamEvent>,
    headers: Headers,
    requestId: string | null,
  ): AsyncIterable<OpenAI.Responses.ResponseStreamEvent> {
    try {
      for await (const event of stream) {
        const failure = responsesStreamingTerminalError(event, headers);
        if (failure) throw failure;
        // response.done is supported by the pinned terminal reducer but absent
        // from the OpenAI wire declaration.
        const eventType: string = event.type;
        if (
          requestId &&
          (eventType === "response.completed" || eventType === "response.done") &&
          "response" in event &&
          event.response &&
          !("_request_id" in event.response)
        ) {
          // Match the SDK's successful-terminal request-id attachment without
          // making transport metadata enumerable in provider/model data.
          try {
            Object.defineProperty(event.response, "_request_id", {
              value: requestId,
              enumerable: false,
            });
          } catch {
            // Frozen custom response objects remain usable, as in the SDK.
          }
        }
        yield event;
      }
    } catch (error) {
      // The OpenAI parser can throw a top-level `error` before yielding it.
      // Convert inside the stream, before the Agents SDK's span error handler,
      // so even enabled model tracing receives only the structural message.
      if (error instanceof APIError && error.status === undefined && error.error) {
        throw new ResponsesStreamingTerminalError("response.error", error.error, headers);
      }
      throw error;
    }
  }

  private ownsResponsesTerminalClassification(): boolean {
    return this.provider.kind !== "codex-subscription" && this.provider.kind !== "xai-subscription";
  }

  protected override _buildResponsesCreateRequest(request: ModelRequest, stream: boolean) {
    const startedAt = performance.now();
    let outcome: "completed" | "failed" = "completed";
    try {
      return super._buildResponsesCreateRequest(request, stream);
    } catch (error) {
      outcome = "failed";
      throw error;
    } finally {
      recordModelPreparationMeasurement({
        phase: "responses_request_build",
        outcome,
        durationSeconds: (performance.now() - startedAt) / 1_000,
        count: typeof request.input === "string" ? 1 : request.input.length,
      });
    }
  }
}

/** Bind a model id to the provider's declared wire API and owned client. */
export function buildModelInstance(
  provider: ResolvedModelProvider,
  client: OpenAI,
  modelId: string,
): Model {
  if (provider.api === "anthropic-messages")
    return new AnthropicMessagesModel(
      provider,
      modelId,
      instrumentedModelFetch(provider.id, globalThis.fetch),
    );
  return provider.api === "chat"
    ? new OpenGeniChatCompletionsModel(client, modelId)
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
  // Per-run only: preserve Claude prompt/request lineage across tool iterations.
  private readonly anthropicModels = new Map<string, Model>();
  constructor(private readonly settings: Settings) {}

  async getModel(modelName?: string): Promise<Model> {
    const binding = this.resolveBinding(modelName);
    if (binding.provider.api !== "anthropic-messages") return binding.model;
    const key = `${binding.provider.id}/${binding.modelId}`;
    const cached = this.anthropicModels.get(key);
    if (cached) return cached;
    this.anthropicModels.set(key, binding.model);
    return binding.model;
  }

  /**
   * The provider, owned client, and upstream model id that `getModel` binds.
   * Standalone requests outside an agent run (the session-title sidecar) use
   * this to call the provider directly instead of the runner-facing
   * `Model.getResponse()`, which requires an active trace.
   */
  resolveBinding(modelName?: string): ModelProviderBinding {
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
        if (
          modelName.startsWith(XAI_SUBSCRIPTION_MODEL_ID_PREFIX) &&
          resolved.provider.kind !== "xai-subscription"
        ) {
          throw new XaiSubscriptionUnavailableError(modelName);
        }
        return {
          provider: resolved.provider,
          client: resolved.client,
          model: resolved.model,
          modelId: resolved.configured.upstreamModelId,
        };
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
      if (modelName.startsWith(XAI_SUBSCRIPTION_MODEL_ID_PREFIX)) {
        throw new XaiSubscriptionUnavailableError(modelName);
      }
    }
    // Preserve the legacy unlisted-model fallback, but bind it through the same
    // typed request-policy model as every configured Responses call. This keeps
    // Azure wire normalization at the object stage instead of reintroducing a
    // JSON parse/stringify transport wrapper on the fallback path.
    const builtin = configuredProviders(this.settings)[0];
    if (!builtin) throw new Error("Built-in model provider is unavailable");
    const client = buildProviderClient(builtin, this.settings);
    const modelId = modelName ?? this.settings.openaiModel;
    return {
      provider: builtin,
      client,
      model: new OpenGeniResponsesModel(client, modelId, builtin),
      modelId,
    };
  }
}

export type ModelProviderBinding = {
  provider: ResolvedModelProvider;
  client: OpenAI;
  model: Model;
  /** The id sent on the provider wire (the upstream id for a registry model). */
  modelId: string;
};

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
