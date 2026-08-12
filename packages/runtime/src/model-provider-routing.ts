import type { ConfiguredModel, ResolvedModelProvider, Settings } from "@opengeni/config";
import { configuredProviders, resolveModelProvider } from "@opengeni/config";
import { OpenAIChatCompletionsModel, type Model, type ModelProvider } from "@openai/agents";
import OpenAI from "openai";
import { CODEX_MODEL_ID_PREFIX } from "@opengeni/codex";
import { XAI_SUBSCRIPTION_MODEL_ID_PREFIX } from "@opengeni/xai-subscription";

import { AppendOnlyOpenAIResponsesModel } from "./append-only-responses-model";
import { buildProviderClient } from "./model-provider-client";
import {
  CodexSubscriptionUnavailableError,
  XaiSubscriptionUnavailableError,
} from "./model-provider-errors";

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
        if (
          modelName.startsWith(XAI_SUBSCRIPTION_MODEL_ID_PREFIX) &&
          resolved.provider.kind !== "xai-subscription"
        ) {
          throw new XaiSubscriptionUnavailableError(modelName);
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
