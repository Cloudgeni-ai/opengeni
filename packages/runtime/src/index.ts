import type { ConfiguredModel, ContextCompactionMode, ModelProviderApi, ResolvedModelProvider, Settings } from "@opengeni/config";
import { AGENT_INSTRUCTIONS_CORE_PLACEHOLDER, collectSandboxEnvironment, contextInputBudgetTokens, contextServerCompactThreshold, firstPartyMcpBaseUrl, parseExposedPorts, resolveContextCompactionMode, resolveModelProvider, sandboxLifecycleHookIds } from "@opengeni/config";
import { CAPABILITY_DESCRIPTORS, isClearedRunStateBlob, prefixedMcpToolName as sharedPrefixedMcpToolName, signDelegatedAccessToken, type McpServerConnectionRef, type Permission, type ReasoningEffort, type ResourceRef, type SessionEventType, type ToolAuthNeededPayload, type ToolRef } from "@opengeni/contracts";
import {
  Agent,
  AgentsError,
  connectMcpServers,
  OpenAIProvider,
  setDefaultModelProvider,
  MaxTurnsExceededError,
  MCPServerStreamableHttp,
  // Provider-bound Model instances. Both are re-exported from
  // @openai/agents-openai via `export * from '@openai/agents-openai'` in
  // @openai/agents' index (0.11.6), so the multi-provider routing imports them
  // from the same entrypoint as the rest of the SDK rather than reaching into
  // the openai subpackage. OpenAIChatCompletionsModel speaks /v1/chat/completions
  // (the registry "chat" wire API, e.g. Fireworks); OpenAIResponsesModel speaks
  // /v1/responses (the built-in OpenAI/Azure "responses" wire API). Both bind a
  // model id to a specific OpenAI client, which is what routes a turn to its
  // provider without touching the global default client.
  OpenAIChatCompletionsModel,
  OpenAIResponsesModel,
  RunState,
  isOpenAIResponsesRawModelStreamEvent,
  run,
  Runner,
  setDefaultOpenAIClient,
  setDefaultOpenAIKey,
  setOpenAIResponsesTransport,
  setTracingDisabled,
  // Hosted web_search tool factory. Re-exported from @openai/agents-openai via
  // `export * from '@openai/agents-openai'` in @openai/agents' index (0.11.6);
  // it returns a { type: 'hosted_tool', providerData: { type: 'web_search' } }
  // descriptor the OpenAI Responses model serializes into request.tools[].
  webSearchTool,
  // The SDK's V4A-diff applier — the apply_patch host the filesystem capability's
  // editor uses. The agent-loop-free sandbox leaf cannot import it (it lives behind
  // the `@openai/agents` root the leaf forbids), so the barrel imports it here and
  // injects it into the selfhosted session's `createEditor` via setSelfhostedApplyDiff
  // (below, right after the leaf re-export). This lets a selfhosted active backend
  // apply file edits over its NATS fs ops using the SDK's exact diff semantics.
  applyDiff,
  type AgentInputItem,
  type CallModelInputFilter,
  type MCPServer,
  type MCPToolErrorFunction,
  type Model,
  type ModelProvider,
  type RunStreamEvent,
  type Tool,
} from "@openai/agents";
import {
  localDirLazySkillSource,
} from "@openai/agents/sandbox/local";
import {
  Capabilities,
  Manifest,
  SandboxAgent,
  StaticCompactionPolicy,
  azureBlobMount,
  compaction,
  dir,
  file,
  filesystem,
  gitRepo,
  inContainerMountStrategy,
  localDir,
  s3Mount,
  shell,
  skills,
  type Dir,
  type Entry,
  type LocalDirLazySkillSource,
  type SandboxClient,
  type SandboxSessionLike,
  type SandboxSessionState,
  type SandboxRunConfig,
  type SkillIndexEntry,
} from "@openai/agents/sandbox";
import { ModalCloudBucketMountStrategy } from "@openai/agents-extensions/sandbox/modal";
import OpenAI from "openai";
import { CODEX_APPS_MCP_SERVER_ID, CODEX_MODEL_ID_PREFIX, CODEX_ORIGINATOR, codexAppsSanitizingFetch, codexRequestStorage, codexSubscriptionFetch } from "@opengeni/codex";
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, posix as posixPath, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { computerCallNormalizingFetch, normalizeComputerCallActions, sanitizeHistoryItemsForModel } from "./history-sanitizer";
import { installCodexToolSearch } from "./codex-tool-search";
import { modelCallUsageTelemetry } from "./usage-telemetry";
import {
  CompactionNeededError,
  SUMMARY_BUFFER_TOKENS,
  clientCompactionThresholdTokens,
  enforceInputBudget,
  estimateItemTokens,
  estimateTokens,
  renderCompactionPromptInputForChat,
} from "./context-compaction";
import {
  createSandboxClient,
  deserializeSandboxSessionStateEnvelope,
  desktopCapableBackend,
  restoredSandboxSessionStateFromEntry,
  setSelfhostedApplyDiff,
} from "./sandbox";
import { computerUse, type ComputerToolMode } from "./sandbox-computer";
import type { RuntimeMetricsHooks } from "./metrics";

export type { RuntimeMetricsHooks } from "./metrics";

// P4.3 computer-use surface (the agent's :0 driver). Re-exported from the barrel
// so callers (the worker, live proofs) reach SandboxComputer/ComputerUseCapability
// alongside the rest of the runtime. NOT part of the agent-loop-free leaf (it
// imports computerTool from the @openai/agents root).
export {
  SandboxComputer,
  ComputerUseCapability,
  computerUse,
  ComputerUnavailableError,
  ComputerReadOnlyError,
  ComputerActionError,
  type SandboxComputerOptions,
  type ComputerUseArgs,
  type ComputerToolMode,
} from "./sandbox-computer";

// The agent-loop-free sandbox leaf (createSandboxClient + resume/recovery
// helpers + the config-owned env/port re-exports). Re-exported verbatim so the
// barrel surface is unchanged for apps/worker while @opengeni/runtime/sandbox
// stays importable by the API without the agent loop.
export * from "./sandbox";

// Inject the SDK's V4A `applyDiff` into the selfhosted session's apply_patch editor
// at module load. The leaf can't import `applyDiff` (agent-loop root), so the
// barrel — which already imports `@openai/agents` — wires it once. A selfhosted
// active backend can now apply file edits over its NATS fs ops with the SDK's exact
// diff semantics; without this, `createEditor()` throws a clear "not injected" error
// rather than mis-editing. Runs at import time, before any turn binds a capability.
setSelfhostedApplyDiff(applyDiff as unknown as (input: string, diff: string, mode?: "default" | "create") => string);

export { sanitizeHistoryItemsForModel, stripReasoningEncryptedContent, stripReasoningIdentityFromSerializedRunState, neutralizeToolSearchItemsInSerializedRunState } from "./history-sanitizer";
export type { HistoryItem } from "./history-sanitizer";

// The provider-bound Model classes used by buildModelInstance/resolveTurnModel.
// Re-exported so callers (and routing tests) can assert which wire API a
// resolved turn was bound to — OpenAIChatCompletionsModel for registry "chat"
// providers (Fireworks), OpenAIResponsesModel for the built-in "responses" path
// — without reaching into @openai/agents directly.
export { OpenAIChatCompletionsModel, OpenAIResponsesModel } from "@openai/agents";

export {
  CompactionNeededError,
  buildCompactionPromptInput,
  buildDeterministicFallbackCompactionHistory,
  buildCompactionReplacementHistory,
  clientCompactionThresholdTokens,
  clampCompactionThresholdRatio,
  decideClientCompaction,
  enforceInputBudget,
  buildSummaryItem,
  findCompactionNeededError,
  isCompactionSummary,
  isUserMessage,
  findKeepBoundary,
  estimateTokens,
  estimateItemTokens,
  renderCompactionPromptInputForChat,
  COMPACTION_SUMMARY_MARKER,
  COMPACTION_PROMPT,
  COMPACT_USER_MESSAGE_MAX_TOKENS,
  DEFAULT_COMPACTION_THRESHOLD_RATIO,
  MIN_COMPACTION_THRESHOLD_RATIO,
  MAX_COMPACTION_THRESHOLD_RATIO,
  SUMMARY_BUFFER_TOKENS,
  SUMMARY_PREFIX,
  USER_MESSAGE_TRUNCATION_MARKER,
} from "./context-compaction";
export type { ClientCompactionDecision, CompactionItem } from "./context-compaction";
export {
  modelCallUsageTelemetry,
} from "./usage-telemetry";
export type { ModelCallUsageTelemetry } from "./usage-telemetry";

ensureReadableStreamFrom();

const SANDBOX_LIFECYCLE_COMMAND_TIMEOUT_MS = 120_000;

export type NormalizedRuntimeEvent = {
  type: SessionEventType;
  payload: unknown;
};

export type ModelResponseUsage = {
  responseId?: string;
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    inputTokensDetails?: Record<string, number> | Array<Record<string, number>>;
    outputTokensDetails?: Record<string, number> | Array<Record<string, number>>;
  };
};

type RuntimeMcpTool = Awaited<ReturnType<MCPServer["listTools"]>>[number];

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ResolveConnectionCredentialInput = {
  workspaceId: string;
  subjectId?: string;
  serverId: string;
  toolName?: string;
  connectionRef: McpServerConnectionRef;
  forceRefresh?: boolean;
};

export type ResolveConnectionCredentialResult =
  | { status: "ok"; headers: Record<string, string>; connectionId: string; expiresAt?: Date | null }
  | {
    status: "auth_needed";
    reason: ToolAuthNeededPayload["reason"];
    providerDomain: string;
    connectionId?: string;
    scopes?: string[];
    resource?: string;
    authorizationUrl?: string;
  };

export function ensureReadableStreamFrom(): void {
  const ctor = globalThis.ReadableStream as (typeof ReadableStream & {
    from?: <T>(source: Iterable<T> | AsyncIterable<T>) => ReadableStream<T>;
  }) | undefined;
  if (!ctor || typeof ctor.from === "function") {
    return;
  }
  Object.defineProperty(ctor, "from", {
    configurable: true,
    writable: true,
    value<T>(source: Iterable<T> | AsyncIterable<T>): ReadableStream<T> {
      const iterator = isAsyncIterable(source)
        ? source[Symbol.asyncIterator]()
        : source[Symbol.iterator]();
      return new ReadableStream<T>({
        async pull(controller) {
          const next = await iterator.next();
          if (next.done) {
            controller.close();
          } else {
            controller.enqueue(next.value);
          }
        },
        async cancel() {
          await iterator.return?.();
        },
      });
    },
  });
}

export type AgentSegmentInput =
  | {
    kind: "message";
    text: string;
    serializedRunState?: string | null;
    // Items-mode conversation truth (issue #35): when provided, turn input is
    // built from these verbatim AgentInputItems and the stored sandbox
    // envelope — no RunState deserialization, no SDK-version coupling.
    historyItems?: AgentInputItem[] | null;
    sandboxEnvelope?: Record<string, unknown> | null;
  }
  | { kind: "approval"; serializedRunState: string; approvalId: string; decision: "approve" | "reject"; message?: string };

export type PreparedAgentInput = {
  input: string | AgentInputItem[] | RunState<any, any>;
  sandboxSessionState?: SandboxSessionState;
  serializedRunStateForSandbox?: string;
};

export type SandboxFileDownload = {
  fileId: string;
  mountPath: string;
  filename: string;
  url?: string;
  content?: Uint8Array;
  expiresAt?: Date | string;
  sizeBytes?: number;
};

export type SandboxFileDownloadFailure = {
  fileId: string;
  filename: string;
  path: string;
  reason: string;
  exitCode?: number;
  output?: string;
};

export type SandboxFileDownloadMaterializationResult = {
  failures: SandboxFileDownloadFailure[];
};

let runtimeMetricsHooks: RuntimeMetricsHooks | null = null;

export function configureRuntimeMetricsHooks(hooks: RuntimeMetricsHooks | null | undefined): void {
  runtimeMetricsHooks = hooks ?? null;
}

export type OpenGeniRuntime = {
  configure: (settings: Settings) => void;
  // Multi-provider per-turn model routing. Returns the resolved provider, its
  // (cached) client, the provider-bound Model instance, and the configured-model
  // shape; null when the turn's model is not in the registry, so the caller
  // falls back to the legacy global-client path (settings.openaiModel).
  resolveTurnModel: (settings: Settings, modelId: string) => ReturnType<typeof resolveTurnModel>;
  buildAgent: (settings: Settings, resources: ResourceRef[], options?: BuildAgentOptions) => Agent<any, any>;
  prepareTools: (settings: Settings, tools: ToolRef[], options?: PrepareToolsOptions) => Promise<PreparedAgentTools>;
  prepareInput: (agent: Agent<any, any>, input: AgentSegmentInput, options?: PrepareInputOptions) => Promise<PreparedAgentInput>;
  runStream: (agent: Agent<any, any>, input: PreparedAgentInput, settings: Settings, options?: RunAgentStreamOptions) => Promise<Awaited<ReturnType<typeof runAgentStream>>>;
  serializeApprovals: (interruptions: unknown[]) => unknown[];
};

export type ProductionRuntimeOverrides = {
  model?: Model;
  sandboxClient?: unknown;
  metrics?: RuntimeMetricsHooks;
};

export function createProductionAgentRuntime(overrides: ProductionRuntimeOverrides = {}): OpenGeniRuntime {
  return {
    configure: (settings) => {
      configureRuntimeMetricsHooks(overrides.metrics);
      configureOpenAI(settings);
    },
    // A test/override model shadows the registry routing entirely (the scripted
    // model used in worker tests is not in any provider's allow-list), so when
    // one is supplied resolveTurnModel reports "no resolution" and the caller
    // keeps the legacy global-client path with the override model.
    resolveTurnModel: (settings, modelId) => (overrides.model ? null : resolveTurnModel(settings, modelId)),
    buildAgent: (settings, resources, options) => buildOpenGeniAgent(settings, resources, {
      ...options,
      ...(overrides.model ? { model: overrides.model } : {}),
    }),
    prepareTools: prepareAgentTools,
    prepareInput: prepareRunInput,
    runStream: async (agent, input, settings, options) => await runAgentStream(agent, input, settings, {
      ...options,
      sandboxClient: overrides.sandboxClient,
    }),
    serializeApprovals,
  };
}

/**
 * Build an OpenAI client from settings for the configured provider. Mirrors the
 * client construction in configureOpenAI so a direct API call (the compaction
 * summarizer) uses the same Azure/OpenAI auth and base URL. Returns null when
 * the OpenAI-platform path has only a key (the SDK default client is used via
 * setDefaultOpenAIKey there); the caller then constructs a key-only client.
 */
export function buildOpenAIClientFromSettings(settings: Settings, providerId: string = settings.openaiProvider): OpenAI {
  if (settings.openaiProvider === "azure") {
    const baseURL = settings.azureOpenaiBaseUrl ?? azureDeploymentBaseUrl(settings);
    const apiKey = settings.azureOpenaiApiKey ?? settings.azureOpenaiAdToken ?? "azure-ad-token";
    return new OpenAI({
      apiKey,
      baseURL,
      maxRetries: settings.openaiMaxRetries,
      defaultQuery: azureOpenAIDefaultQuery(settings, baseURL),
      defaultHeaders: settings.azureOpenaiAdToken && !settings.azureOpenaiApiKey
        ? { Authorization: `Bearer ${settings.azureOpenaiAdToken}` }
        : undefined,
      // Rewrite every outbound /responses computer_call to the ACTIONS-ONLY shape
      // the GA Azure computer tool (gpt-5.5) accepts. This is the lowest reachable
      // seam — below the SDK responses converter, which always re-synthesizes BOTH
      // `action` and `actions` (rejected 400 "exactly one of action or actions").
      // See computerCallNormalizingFetch / rewriteComputerCallsToActionsOnly.
      fetch: computerCallNormalizingFetch(instrumentedModelFetch(providerId, globalThis.fetch)),
    });
  }
  return new OpenAI({
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
  const cached = providerClientCache.get(provider.id);
  if (cached) {
    return cached;
  }
  const client = provider.builtin
    ? buildOpenAIClientFromSettings(settings, provider.id)
    : provider.kind === "codex-subscription"
      // Codex subscription: the static apiKey is a placeholder — the real per-request
      // bearer + ChatGPT-Account-ID, the /responses->/codex/responses rewrite, and the
      // body normalization are all injected by codexSubscriptionFetch, which reads the
      // per-workspace token from codexRequestStorage (AsyncLocalStorage) at call time.
      // The provider id is constant ("codex-subscription"), so one cached client serves
      // every workspace without baking a token into it.
      ? new OpenAI({
        apiKey: provider.apiKey ?? "codex-subscription",
        ...(provider.baseUrl ? { baseURL: provider.baseUrl } : {}),
        maxRetries: settings.openaiMaxRetries,
        fetch: codexSubscriptionFetch(instrumentedModelFetch(provider.id, globalThis.fetch)),
      })
    // ResolvedModelProvider.apiKey is already the resolved key (configuredProviders
    // ran resolveProviderApiKey at config time, collapsing apiKey/apiKeyEnv), so it
    // is passed straight through here rather than re-resolved.
    : new OpenAI({
      ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
      ...(provider.baseUrl ? { baseURL: provider.baseUrl } : {}),
      maxRetries: settings.openaiMaxRetries,
      ...(provider.defaultQuery ? { defaultQuery: provider.defaultQuery } : {}),
      ...(provider.defaultHeaders ? { defaultHeaders: provider.defaultHeaders } : {}),
      fetch: instrumentedModelFetch(provider.id, globalThis.fetch),
    });
  providerClientCache.set(provider.id, client);
  return client;
}

/**
 * Bind a model id to a provider's OpenAI client as an @openai/agents `Model`
 * instance, choosing the wire API by the provider's declared `api`: the "chat"
 * providers (e.g. Fireworks) get an OpenAIChatCompletionsModel that speaks
 * /v1/chat/completions, the "responses" providers (built-in OpenAI/Azure) get
 * an OpenAIResponsesModel that speaks /v1/responses. Passing this Model into
 * the agent is what routes a turn to its provider without mutating the global
 * default client.
 */
export function buildModelInstance(provider: ResolvedModelProvider, client: OpenAI, modelId: string): Model {
  return provider.api === "chat"
    ? new OpenAIChatCompletionsModel(client, modelId)
    : new OpenAIResponsesModel(client, modelId);
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
): { provider: ResolvedModelProvider; client: OpenAI; model: Model; configured: ConfiguredModel } | null {
  const resolved = resolveModelProvider(settings, modelId);
  if (!resolved) {
    return null;
  }
  const client = buildProviderClient(resolved.provider, settings);
  return {
    provider: resolved.provider,
    client,
    model: buildModelInstance(resolved.provider, client, resolved.model.id),
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
 * run in runAgentStream goes through `runScopedRunner(settings)`, built from the
 * per-turn settings) and as the process default (see configureOpenAI). The
 * run-scoped instance is the load-bearing one: a `Runner` resolves string model
 * names against ITS OWN modelProvider, not the lazy global default, so each
 * concurrent turn routes codex/registry names against its own settings and a
 * foreign turn's setDefaultModelProvider can never clobber this turn's routing.
 * The process default remains only as a boot-time fallback. Falls back to the
 * SDK default provider for a model that is in no provider's allow-list.
 */
export class MultiProviderModelProvider implements ModelProvider {
  private fallback: OpenAIProvider | undefined;

  constructor(private readonly settings: Settings) {}

  async getModel(modelName?: string): Promise<Model> {
    if (modelName) {
      const resolved = resolveTurnModel(settingsForRunScopedModelResolution(this.settings, modelName), modelName);
      if (resolved) {
        // Fail-loud floor (defense in depth): a `codex/<slug>` id must only ever
        // resolve through the synthetic codex-subscription provider (which installs
        // fetch: codexSubscriptionFetch + the per-workspace bearer). If a future
        // settings path re-introduces a built-in/registry shadow that binds a
        // `codex/` id to any other provider kind, that would silently ship the id
        // to Azure/OpenAI as a deployment name (DeploymentNotFound 404). Refuse it
        // here so codex can never reach a non-codex client on ANY backend; the
        // primary fix (config configuredModels) keeps this a no-op in practice.
        if (modelName.startsWith(CODEX_MODEL_ID_PREFIX) && resolved.provider.kind !== "codex-subscription") {
          throw new CodexSubscriptionUnavailableError(modelName);
        }
        return resolved.model;
      }
      // A `codex/<slug>` id only resolves when the per-workspace worker overlay
      // (settingsWithCodexCredential) has injected the synthetic codex-subscription
      // provider — which it does ONLY for a workspace with an *active* connected
      // Codex subscription. If it did not resolve, the subscription is not
      // connected for this workspace, so the codex provider is absent. Falling
      // through to the built-in OpenAIProvider below would ship `codex/<slug>` to
      // the global default (Azure) client as a deployment name and surface a
      // misleading "DeploymentNotFound" 404. Throw a clear, user-actionable error
      // instead; it propagates through the worker's agentRunFailurePayload as the
      // turn.failed message the session UI shows. Mirrors the codex-prefix
      // awareness of assertConfiguredModel at apps/api/src/domain/sessions.ts.
      if (modelName.startsWith(CODEX_MODEL_ID_PREFIX)) {
        throw new CodexSubscriptionUnavailableError(modelName);
      }
    }
    // A non-codex model in no provider's allow-list falls back to the SDK's
    // default OpenAIProvider, which uses the global default client/key
    // configureOpenAI set up (the built-in OpenAI/Azure provider).
    this.fallback ??= new OpenAIProvider();
    return this.fallback.getModel(modelName);
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
  return builtinAllowed.includes(modelName) ? settings : { ...settings, openaiModel: fallbackBuiltin };
}

function splitOpenaiAllowedModels(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
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
      `Codex subscription model "${modelName}" is unavailable: no active Codex subscription is connected for this workspace. `
      + `Connect (or reconnect) your ChatGPT/Codex subscription in Settings, then retry.`,
    );
    this.name = "CodexSubscriptionUnavailableError";
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
  const rawUrl = typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : (input as { url?: unknown }).url;
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    return false;
  }
  try {
    const pathname = new URL(rawUrl, "http://opengeni.local").pathname;
    return pathname.endsWith("/responses")
      || pathname.endsWith("/chat/completions")
      || pathname.endsWith("/codex/responses");
  } catch {
    return /\/(?:codex\/)?responses(?:\?|$)|\/chat\/completions(?:\?|$)/.test(rawUrl);
  }
}

function recordModelCallMetric(provider: string, outcome: "completed" | "failed", started: number): void {
  const durationSeconds = Math.max(0, (performance.now() - started) / 1000);
  try {
    runtimeMetricsHooks?.onModelCall?.({ provider, outcome, durationSeconds });
  } catch {
    // Metrics emission must never affect a model call.
  }
}

/**
 * Run the compaction summarizer as one plain, tool-less, non-streaming model
 * call against the resolved provider. `input` is the active history plus
 * Codex's checkpoint prompt. Returns the trimmed summary text, or null on any
 * failure (the caller can retry with a harder-trimmed transcript, then fall
 * back to deterministic non-LLM compaction). The call deliberately does NOT
 * request reasoning encryption, tools, or server-side compaction; it is a
 * self-contained summarize.
 *
 * Provider-aware: the summary always runs on the SAME provider that serves the
 * turn (registry providers can't summarize through OpenAI/Azure, and vice
 * versa). `api: "chat"` providers (Fireworks) speak /v1/chat/completions, where
 * the summary is choices[0].message.content; `api: "responses"` (the default,
 * built-in OpenAI/Azure) speaks /v1/responses as before. When no client/api is
 * supplied it falls back to the built-in OpenAI/Azure Responses path so the
 * legacy global-client callers are byte-for-byte unchanged. store:false is set
 * only on the OpenAI-platform Responses path (Azure rejects it; chat ignores it).
 */
export async function summarizeForCompaction(
  settings: Settings,
  input: Array<Record<string, unknown>>,
  options: { client?: OpenAI; api?: ModelProviderApi; maxOutputTokens?: number; model?: string; maxTranscriptTokens?: number } = {},
): Promise<string | null> {
  const client = options.client ?? buildOpenAIClientFromSettings(settings);
  const api = options.api ?? "responses";
  const model = options.model ?? settings.openaiModel;
  const maxTokens = options.maxOutputTokens ?? SUMMARY_BUFFER_TOKENS;
  const transcript = renderCompactionPromptInputForChat(
    input,
    typeof options.maxTranscriptTokens === "number" && options.maxTranscriptTokens > 0
      ? { maxEstimatedTokens: options.maxTranscriptTokens }
      : {},
  );
  try {
    if (api === "chat") {
      const completion = await client.chat.completions.create({
        model,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: transcript }],
      } as any);
      const text = (completion as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content;
      const trimmed = typeof text === "string" ? text.trim() : "";
      return trimmed.length > 0 ? trimmed : null;
    }
    const response = await client.responses.create({
      model,
      // store:false is the OpenAI-platform-only storeless precondition; Azure
      // rejects it. The summarizer's resolved client is OpenAI/Azure on the
      // built-in path (api "responses"), so gate it on the built-in provider.
      ...(settings.openaiProvider === "azure" ? {} : { store: false }),
      max_output_tokens: maxTokens,
      input: transcript,
    } as any);
    const text = extractResponseOutputText(response);
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch (error) {
    console.error("context compaction summarize failed", error);
    return null;
  }
}

/**
 * Pull the assistant text out of a Responses API result, shape-tolerant. Only
 * `role === "assistant"` message items contribute: a provider whose Responses
 * endpoint echoes the user input back as an output `message` item (Fireworks'
 * beta /v1/responses does exactly this — see docs/model-providers.md) would
 * otherwise corrupt the summary with the prompt it was given. The OpenAI/Azure
 * Responses API only emits assistant messages, so this guard is a no-op there.
 */
export function extractResponseOutputText(response: unknown): string {
  if (!response || typeof response !== "object") {
    return "";
  }
  const direct = (response as { output_text?: unknown }).output_text;
  if (typeof direct === "string") {
    return direct;
  }
  const output = (response as { output?: unknown }).output;
  if (!Array.isArray(output)) {
    return "";
  }
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }
    if ((item as { type?: unknown }).type !== "message") {
      continue;
    }
    // Read assistant messages only; skip any input-echo (role "user"/"system").
    if ((item as { role?: unknown }).role !== "assistant") {
      continue;
    }
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
        parts.push((part as { text: string }).text);
      }
    }
  }
  return parts.join("");
}

export type BuildAgentOptions = {
  model?: Model;
  reasoningEffort?: ReasoningEffort;
  // Per-turn gating overrides for the multi-provider path. Each defaults to
  // today's settings-derived behaviour when omitted, so the legacy
  // global-client callers (no model resolution) are byte-for-byte unchanged.
  //
  // - compactionMode: the resolved context-compaction path. Drives whether the
  //   sandbox `compaction()` capability is attached AND whether `store: false`
  //   is set (the OpenAI-platform-only storeless precondition). Registry
  //   providers resolve to "client", so neither is applied to them.
  //   Default: resolveContextCompactionMode(settings).
  // - hostedWebSearch: attach the hosted web_search tool. Only the providers
  //   that actually execute it (built-in OpenAI/Azure; a registry model that
  //   opts in) should get it — Fireworks accepts the param but no-ops it, which
  //   would hand the agent a dead tool. Default: settings.webSearchEnabled.
  // - encryptedReasoning: round-trip reasoning.encrypted_content via
  //   providerData.include. Only the Responses API carries it; the chat wire
  //   API has no such field, so registry "chat" providers turn it off.
  //   Default: settings.openaiReasoningEncryptedContent.
  // - contextWindowTokens: the model's effective window, used to derive the
  //   server-path compaction threshold. A registry model can declare its own
  //   (e.g. GLM 5.2's 1,048,576). Default: settings.contextWindowTokens.
  // - structuredToolTransport: whether the backend supports the Responses
  //   STRUCTURED/HOSTED sandbox-tool transport — the hosted `apply_patch` tool
  //   type and structured `view_image` output. The SDK's sandbox capabilities
  //   pick hosted-vs-function purely from the bound model instance's constructor
  //   name (supportsApplyPatchTransport / supportsStructuredToolOutputTransport).
  //   Our codex turns run the OpenAIResponsesModel — which the SDK reads as
  //   hosted-capable — but route it to the ChatGPT/Codex backend, which REJECTS
  //   the hosted `apply_patch` type ("Unsupported tool type: apply_patch",
  //   verified live). Set false for that backend so filesystem emits the
  //   function `apply_patch` + text `view_image` variants it accepts. Default
  //   true (let the SDK decide from the model instance) — non-codex paths are
  //   byte-for-byte unchanged.
  compactionMode?: ContextCompactionMode;
  hostedWebSearch?: boolean;
  encryptedReasoning?: boolean;
  contextWindowTokens?: number;
  structuredToolTransport?: boolean;
  // EXPLICIT computer-use tool transport, decided where provider identity is
  // authoritative (the worker's model resolution — agent-turn.ts). Threaded into
  // buildAgentCapabilities → computerUse({toolMode}) so tool selection never rests
  // on the SDK's constructor-name sniff. When omitted, the legacy sniff +
  // `structuredToolTransport` neutralize path is preserved byte-for-byte.
  computerToolMode?: ComputerToolMode;
  // The LIVE, by-reference connector-namespace Set from prepareAgentTools
  // (codexConnectorNamespaces): fills during each turn's codex_apps tools/list,
  // read per model call by the codex tool_search description so the model sees
  // the account's ACTUALLY-connected sources (codex-rs parity). Only meaningful
  // on the codex tool-search path.
  codexConnectorNamespaces?: ReadonlySet<string>;
  sandboxEnvironment?: Record<string, string>;
  // The EFFECTIVE/active compute backend for this turn. `settings.sandboxBackend`
  // is the session's HOME backend (the default cloud group box it was created
  // with); when a session has swapped its active sandbox to a connected machine
  // (active_sandbox_id → a selfhosted lease, while the home backend stays the
  // cloud default), the worker passes that machine's backend here so
  // filesystem-touching lifecycle hooks key off where the agent ACTUALLY runs,
  // not where it was created. The one such hook today is the repository clone
  // (sandboxRepositoryCloneHooks): a bring-your-own machine owns its real disk,
  // so the platform must NEVER `git clone` onto it. Defaults to
  // settings.sandboxBackend, so the legacy cloud paths are byte-for-byte
  // unchanged and a session whose HOME backend is "selfhosted" is gated with no
  // caller change.
  activeSandboxBackend?: Settings["sandboxBackend"];
  fileResourceDownloads?: SandboxFileDownload[];
  mcpServers?: MCPServer[];
  workspaceEnvironment?: WorkspaceEnvironmentContext;
  // TOKEN-BROKER (B1): the run-scoped GitHub App installation token, minted ONCE
  // per turn by the worker (sandboxEnvironmentForRun's `gitToken`). Threaded here
  // OFF-MANIFEST — it is NOT part of sandboxEnvironment (the manifest env), so the
  // token VALUE never triggers the SDK's provided-session env-delta guard even
  // though it rotates every turn. buildAgent stashes it alongside the agent's
  // repository-clone hooks; runStream forwards it into the clone hook context, which
  // seeds it to the box's token FILE before the clone runs. Omitted on the
  // selfhosted path (the machine uses its own git creds) — a NO-OP there.
  gitTokenSeed?: string;
  // TOOLSPACE: the run-scoped delegated token to seed into
  // $OPENGENI_TOOLSPACE_TOKEN_FILE. Like gitTokenSeed, this stays off the
  // manifest/env delta and is written into the sandbox filesystem by a lifecycle
  // hook before the agent starts.
  toolspaceTokenSeed?: string;
  // Genesis turn only: append a one-shot instruction to the agent's system
  // prompt telling it to title the session via opengeni__set_session_title
  // before responding. Delivered through the instructions channel (where the
  // model actually obeys), appended AFTER the non-bypassable core so a
  // white-label persona template can't drop it.
  genesisTitleHint?: boolean;
  // Per-call agent persona override (the white-label surface). Resolved by the
  // caller as session > workspace > deployment default; when omitted the
  // runtime falls back to settings.agentInstructionsTemplate. The runtime
  // substitutes the non-bypassable CORE at AGENT_INSTRUCTIONS_CORE_PLACEHOLDER
  // (or appends it when the template omits the marker), so an override can
  // restyle the persona but never drop the goal-loop contract or environment
  // block.
  instructionsTemplate?: string;
  // Per-SESSION persona/system instructions (the per-agent-type prompt lever an
  // embedding host supplies at session create). Composed AFTER the workspace
  // instructionsTemplate + the non-bypassable CORE, so it refines the workspace
  // persona for this one session without dropping the goal-loop/environment
  // contract. Rides the SAME instructions channel (system-level) — NEVER a user/
  // timeline message. Omitted ⇒ the composed instructions are byte-identical to
  // a workspace-only persona.
  sessionInstructions?: string;
  // Skills delivered by enabled capability packs. They join the bundled
  // skills in the sandbox skill index (mounted under .agents/) so
  // skills/<name> references resolve like any other indexed skill.
  packSkills?: PackSkill[];
};

export type PackSkillFile = {
  // Relative POSIX path inside the skill directory, e.g. "SKILL.md" or
  // "references/runbook.md".
  path: string;
  content: string;
};

export type PackSkill = {
  name: string;
  description?: string | null;
  files: PackSkillFile[];
};

/**
 * Operator-facing metadata for the workspace environment attached to a run.
 * Surfaced verbatim in the agent instructions: the description is where
 * operators document how the exported credentials are meant to be used
 * (e.g. which variable holds a deploy key and how to clone with it), so an
 * agent must not have to rediscover that by enumerating `env` and guessing.
 * Only metadata belongs here — never variable values.
 */
export type WorkspaceEnvironmentContext = {
  name: string;
  description?: string | null;
  variableNames?: string[];
};

export function workspaceEnvironmentInstructions(environment: WorkspaceEnvironmentContext): string[] {
  const lines = [
    `A workspace environment named "${environment.name}" is attached to this session; its variables are exported in the sandbox shell environment.`,
  ];
  const variableNames = (environment.variableNames ?? []).filter((name) => name.length > 0);
  if (variableNames.length > 0) {
    lines.push(`Exported environment variables: ${[...variableNames].sort().join(", ")}.`);
  }
  const description = environment.description?.trim();
  if (description) {
    lines.push(`Environment notes from the operator: ${description}`);
  }
  return lines;
}

/**
 * The non-bypassable CORE of the agent instructions: the goal-loop ownership
 * line (which names the opengeni__goal_* tools and is what keeps a long-running
 * session driving itself) followed by the dynamic workspace-environment block.
 * Returned as ordered lines so the caller joins them with the rest of the
 * instructions by " ", exactly as the historical preamble did.
 *
 * This is the slice a white-labelled persona template must never be able to
 * drop: composeAgentInstructions() substitutes it at the persona template's
 * {{core}} marker, and appends it when the marker is absent.
 */
export function coreInstructions(workspaceEnvironment?: WorkspaceEnvironmentContext): string[] {
  return [
    "If the session has a goal, you own it: keep working until you call opengeni__goal_complete with concrete evidence or opengeni__goal_pause with a rationale; revise it with opengeni__goal_update; create one with opengeni__goal_set when given a long-running objective.",
    ...(workspaceEnvironment ? workspaceEnvironmentInstructions(workspaceEnvironment) : []),
  ];
}

/**
 * Composes the final agent instructions from a (possibly white-labelled)
 * persona template and the non-bypassable CORE. The CORE is substituted at the
 * template's {{core}} marker; if the template omits the marker, the CORE is
 * appended after it instead (the non-bypassable fail-safe). The substitution
 * and the append both join by " ", so the DEFAULT_AGENT_INSTRUCTIONS template
 * with an empty environment reproduces the historical preamble byte-for-byte.
 */
export function composeAgentInstructions(template: string, workspaceEnvironment?: WorkspaceEnvironmentContext): string {
  const core = coreInstructions(workspaceEnvironment).join(" ");
  if (template.includes(AGENT_INSTRUCTIONS_CORE_PLACEHOLDER)) {
    return template.split(AGENT_INSTRUCTIONS_CORE_PLACEHOLDER).join(core);
  }
  return core ? `${template} ${core}` : template;
}

/**
 * Appends the per-session persona instructions to the already-composed
 * (workspace + CORE) instructions, joined by " " — exactly the join used
 * throughout the persona composition. The session slice is intentionally LAST
 * (session-specific refinement of the workspace persona). An absent/blank value
 * is a no-op that returns the composed string byte-for-byte.
 */
export function appendSessionInstructions(composed: string, sessionInstructions?: string): string {
  const trimmed = sessionInstructions?.trim();
  return trimmed ? `${composed} ${trimmed}` : composed;
}

/**
 * Appends the generic programmatic-tool-calling (toolspace) directive to the
 * composed workspace + CORE instructions, joined by " ". This is GENERIC
 * substrate prompting — the same text for every host, never per-host copy.
 *
 * Included ONLY when `toolspaceAvailable` is true, which the caller sets from the
 * exact condition that gates the sandbox token mint: the toolspace feature is
 * enabled AND a toolspace token was minted for THIS turn. That mint now happens
 * on every backend including selfhosted (connected machines get the token too),
 * so the block appears there as well; a turn with no minted token (feature off)
 * has no toolspace URL/token in its sandbox and must not advertise a capability
 * that is not there — the gate is false and this is a no-op. Placed BEFORE the
 * per-session instructions so host/session specificity still wins over this
 * substrate note.
 */
export function appendToolspaceInstructions(composed: string, toolspaceAvailable: boolean): string {
  return toolspaceAvailable ? `${composed} ${TOOLSPACE_PROGRAMMATIC_DIRECTIVE}` : composed;
}

/**
 * Appends the one-shot genesis title directive (genesis turn only), joined by
 * " " and always LAST so a white-label persona template or a per-session
 * instruction can't drop it. A no-op when the hint is absent.
 */
export function appendGenesisTitleDirective(instructions: string, genesisTitleHint?: boolean): string {
  return genesisTitleHint ? `${instructions} ${GENESIS_TITLE_DIRECTIVE}` : instructions;
}

const agentFileDownloads = new WeakMap<object, SandboxFileDownload[]>();
const agentRepositoryCloneHooks = new WeakMap<object, SandboxLifecycleHook[]>();
// TOKEN-BROKER (B1): the per-turn git token seed, stashed alongside the agent's
// repository-clone hooks (a parallel map keyed by the agent). Kept OFF the
// manifest/defaultManifest so the rotating value never rides the SDK's provided-
// session env; runStream reads it to build the clone hook context. Absent when
// no repo is attached / on the selfhosted path.
const agentGitTokenSeed = new WeakMap<object, string>();
const agentToolspaceTokenSeed = new WeakMap<object, string>();
// The EFFECTIVE backend the turn resolved for this agent (undefined -> the home
// backend). Read by runStream's owned branch to keep platform box-setup hooks off
// connected machines (a user's real computer).
const agentActiveSandboxBackend = new WeakMap<object, Settings["sandboxBackend"]>();

/**
 * The tool output emitted for an MCP tool call that FAILED with a THROWN error
 * — a JSON-RPC protocol error (e.g. -32602 invalid params), an auth 401/403, a
 * transport failure, a timeout, or tool-not-found. Shaped as an MCP
 * `{ isError: true, content }` result so the failure is CARRIED on the tool
 * output rather than erased.
 *
 * The SDK's `defaultToolErrorFunction` would instead turn a thrown tool error
 * into a plain STRING ("An error occurred while running the tool…") returned as
 * a NORMAL, successful-looking result — so `agent.toolCall.output` carried no
 * error signal and the timeline rendered the failure as success. `normalizeSdkEvent`
 * captures `RunToolCallOutputItem.output` (the raw function return) verbatim, so
 * returning this object makes the emitted payload's `output.isError === true`,
 * which the timeline projection's `isErrorOutput` (packages/react/src/timeline/
 * projection.ts) settles to "failed" and downstream client normalizers read the same field.
 *
 * SCOPE: this only covers THROWN MCP failures (the ones that reach an
 * errorFunction). An MCP tool result carrying `isError: true` INLINE alongside
 * content is stripped to its `content` by @openai/agents-core's streamable-http
 * shim (dist/shims/mcp-server/node.js `callTool` returns `parsed.content`,
 * dropping `parsed.isError`) BEFORE the runtime ever sees it. Covering that mode
 * requires an SDK-level change (preserve `isError`) or reading the raw
 * CallToolResult — tracked separately.
 */
export function mcpToolErrorOutput(error: unknown): { isError: true; content: [{ type: "text"; text: string }] } {
  const details = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: "text", text: `An error occurred while running the tool. Please try again. Error: ${details}` }] };
}

// Applied to EVERY MCP server via the agent's `mcpConfig.errorFunction`
// (server-level errorFunctions would win, but PrefixedMcpServer sets none). The
// SDK types the return as `string`; the runtime actually stores the raw return
// as the tool output, so we return the MCP-shaped error object and cast — this
// is the only way to attach an `isError` flag to a failed MCP tool call's output.
const mcpToolErrorFunction: MCPToolErrorFunction = ({ error }) => mcpToolErrorOutput(error) as unknown as string;

export function buildOpenGeniAgent(settings: Settings, resources: ResourceRef[], options: BuildAgentOptions = {}): Agent<any, any> {
  // Resolved per-turn gating. Each override defaults to today's settings-derived
  // behaviour, so the legacy global-client callers (no resolved model) build the
  // exact same agent as before; the multi-provider worker path passes the
  // resolved provider's mode/api/window/web-search instead.
  const compactionMode = options.compactionMode ?? resolveContextCompactionMode(settings);
  const hostedWebSearch = options.hostedWebSearch ?? settings.webSearchEnabled;
  const encryptedReasoning = options.encryptedReasoning ?? settings.openaiReasoningEncryptedContent;
  const contextWindowTokens = options.contextWindowTokens ?? settings.contextWindowTokens;
  // Native hosted tools attached to every constructed agent. webSearchEnabled
  // is ON by default and provider-unconditional on the built-in path (the live
  // Azure Responses path executes the hosted web_search tool); a registry model
  // only gets it when it opts in (resolved via options.hostedWebSearch), since
  // a provider that no-ops the param would hand the agent a dead tool. The SDK
  // merges this explicit `tools` array with the MCP-server tools
  // (Agent.getAllTools = [...mcpTools, ...tools]) and, on the SandboxAgent path,
  // with the sandbox capability tools (prepareSandboxAgent: tools =
  // [...agent.tools, ...capability.tools()]), so hosted web_search coexists with
  // both rather than overriding them.
  const hostedTools = hostedWebSearch ? [webSearchTool()] : [];
  const baseConfig = {
    name: "OpenGeni Agent",
    model: options.model ?? settings.openaiModel,
    // White-label persona composition. The effective template is the per-call
    // override (options.instructionsTemplate, resolved by the caller as
    // session > workspace) falling back to the deployment default
    // (settings.agentInstructionsTemplate, default DEFAULT_AGENT_INSTRUCTIONS).
    // composeAgentInstructions substitutes the non-bypassable CORE (goal-loop
    // ownership + workspace-environment block) at the {{core}} marker, or
    // appends it when the template omits the marker. With the default template
    // and no environment this is byte-identical to the historical preamble.
    // Persona composition order (all one system-level instructions string):
    //   1. workspace instructionsTemplate (or deployment default) with the
    //      non-bypassable CORE substituted at {{core}} — composeAgentInstructions,
    //   2. + the generic programmatic-tool-calling (toolspace) directive, ONLY
    //      when a toolspace token was minted for this turn (feature enabled + a
    //      per-turn seed — the mint gate, which includes selfhosted turns since
    //      they now receive the token too) — appendToolspaceInstructions,
    //   3. + the per-session persona instructions (session-specific, so it
    //      refines both the workspace persona and the substrate note),
    //   4. + the one-shot genesis title directive (genesis turn only).
    // With no toolspace token, no session instructions, and no genesis hint this
    // is byte-identical to the historical composed instructions.
    instructions: appendGenesisTitleDirective(
      appendSessionInstructions(
        appendToolspaceInstructions(
          composeAgentInstructions(options.instructionsTemplate ?? settings.agentInstructionsTemplate, options.workspaceEnvironment),
          settings.toolspaceEnabled && Boolean(options.toolspaceTokenSeed),
        ),
        options.sessionInstructions,
      ),
      options.genesisTitleHint,
    ),
    modelSettings: {
      reasoning: { effort: options.reasoningEffort ?? settings.openaiReasoningEffort, summary: "detailed" },
      // Server-side compaction (OpenAI platform) requires store=false: the
      // server emits an opaque ENCRYPTED 'compaction' item that round-trips in
      // the request rather than being anchored to a stored response. OpenGeni
      // already runs storeless (provider item ids stripped, encrypted reasoning
      // round-tripped), so this is consistent with the existing design and
      // only set where the server compaction capability is attached. Gated on
      // the RESOLVED compaction mode (registry providers resolve to "client",
      // so they never carry store:false).
      ...(compactionMode === "server" ? { store: false } : {}),
      // Round-trip the encrypted reasoning payload with every call so chains
      // of thought survive without provider-side response storage (which is
      // what stripped provider item ids opt us out of — see
      // stripProviderItemIds). providerData.include replaces any
      // tool-derived include entries; OpenGeni's tools are MCP/sandbox
      // function tools, which contribute none. Gated on the resolved
      // encryptedReasoning flag: the chat wire API has no encrypted_content
      // field, so registry "chat" providers turn it off.
      ...(encryptedReasoning
        ? { providerData: { include: ["reasoning.encrypted_content"] } }
        : {}),
    },
    // Explicit hosted tools (web_search when enabled). Threaded into BOTH the
    // `new Agent(baseConfig)` path (sandboxBackend === "none") and the
    // `new SandboxAgent({ ...baseConfig, ... })` path via the shared baseConfig
    // spread; the SDK concatenates these with MCP and sandbox capability tools.
    ...(hostedTools.length ? { tools: hostedTools } : {}),
    ...(options.mcpServers?.length ? { mcpServers: options.mcpServers } : {}),
    // Surface FAILED MCP tool calls as `{ isError: true }` tool output (see
    // mcpToolErrorFunction / mcpToolErrorOutput) instead of the SDK's default
    // flat error string, so a thrown MCP failure (protocol error, auth, timeout,
    // tool-not-found) settles the timeline tool to "failed" rather than rendering
    // as success. Applies to every MCP server on this agent (session, first-party,
    // capability, codex_apps) since none set a server-level errorFunction.
    mcpConfig: { errorFunction: mcpToolErrorFunction },
  } as const;

  if (settings.sandboxBackend === "none") {
    const agent = new Agent(baseConfig);
    maybeInstallCodexToolSearch(agent, settings, options);
    applyMcpApprovalPolicy(agent, settings);
    return agent;
  }

  const runAs = sandboxRunAs(settings);
  const agent = new SandboxAgent({
    ...baseConfig,
    defaultManifest: buildManifest(settings, resources, options.sandboxEnvironment, options.fileResourceDownloads),
    ...(runAs ? { runAs } : {}),
    capabilities: buildAgentCapabilities(settings, options.packSkills ?? [], {
      compactionMode,
      contextWindowTokens,
      ...(options.structuredToolTransport !== undefined ? { structuredToolTransport: options.structuredToolTransport } : {}),
      ...(options.computerToolMode !== undefined ? { computerToolMode: options.computerToolMode } : {}),
    }),
  });
  agentFileDownloads.set(agent, normalizeSandboxFileDownloads(options.fileResourceDownloads ?? []).filter((download) => !download.content));
  agentRepositoryCloneHooks.set(agent, sandboxRepositoryCloneHooks(settings, resources, options.activeSandboxBackend));
  // Stash the EFFECTIVE backend so runStream's owned branch can skip the direct
  // beforeAgentStart hook run on a connected machine: the box there is the user's
  // REAL computer — the platform must not run setup (az login) against it. The
  // clone hooks are already excluded for selfhosted at construction (above); this
  // keeps the built-in hooks equally out.
  if (options.activeSandboxBackend) {
    agentActiveSandboxBackend.set(agent, options.activeSandboxBackend);
  }
  // TOKEN-BROKER (B1): stash the per-turn seed off-manifest so runStream can seed the
  // clone hook without the token ever touching defaultManifest / sandboxEnvironment.
  if (options.gitTokenSeed) {
    agentGitTokenSeed.set(agent, options.gitTokenSeed);
  }
  if (options.toolspaceTokenSeed) {
    agentToolspaceTokenSeed.set(agent, options.toolspaceTokenSeed);
  }
  maybeInstallCodexToolSearch(agent, settings, options);
  applyMcpApprovalPolicy(agent, settings);
  return agent;
}

/**
 * Enable Codex-CLI-style progressive connector disclosure on a codex turn when the
 * flag is on. Gated on `structuredToolTransport === false` — the same signal that
 * identifies a codex-subscription turn (the ChatGPT backend that rejects hosted
 * tools) — so no non-codex turn is ever touched. On qualifying turns it wraps
 * `getAllTools` (clone-survivingly — see {@link installCodexToolSearch}) to defer
 * codex_apps schemas + add the client tool_search tool, whose description renders
 * the live connector namespaces threaded from prepareAgentTools.
 */
function maybeInstallCodexToolSearch(agent: Agent<any, any>, settings: Settings, options: BuildAgentOptions): void {
  if (settings.codexToolSearchEnabled && options.structuredToolTransport === false) {
    installCodexToolSearch(
      agent as unknown as Parameters<typeof installCodexToolSearch>[0],
      options.codexConnectorNamespaces ?? new Set<string>(),
    );
  }
}

/** True when the unprefixed tool `name` requires approval under `policy`. */
function mcpToolRequiresApproval(policy: boolean | string[], unprefixedName: string): boolean {
  return policy === true || (Array.isArray(policy) && policy.includes(unprefixedName));
}

/** A per-server approval policy keyed by the server's `<id>__` tool prefix. */
type McpApprovalPolicy = { prefix: string; requireApproval: boolean | string[] };

/** The subset of the agent surface the approval wrap needs — including `clone`. */
type ApprovalCapableAgent = {
  getMcpTools: (runContext: unknown) => Promise<Tool<any>[]>;
  clone?: (config: unknown) => ApprovalCapableAgent;
};

/**
 * Install the approval wrap on a single agent instance: replace `getMcpTools`
 * with one that stamps `needsApproval: () => true` on every MCP tool whose
 * server policy demands it. Tools are matched by the server's `<id>__` prefix
 * (LONGEST prefix first — see {@link applyMcpApprovalPolicy}), then the
 * unprefixed tool name.
 *
 * CLONE SURVIVAL (mirrors {@link installCodexToolSearch}): the sandbox runtime
 * resolves tools not on the agent we build here but on a FRESH clone —
 * `prepareSandboxAgent` calls `agent.clone(...)`, and `SandboxAgent.clone`
 * reconstructs from a FIXED field list (name/tools/mcpServers/…), so an
 * instance-own `getMcpTools` override is dropped and approval would silently
 * bypass on every sandbox turn. We therefore also wrap `clone` to RE-INSTALL the
 * policy onto every clone, recursively — covering clone-of-clone and the resume
 * paths. The base (non-sandbox) `Agent.clone` spreads `...this` and would carry
 * the override, but re-installing is idempotent there and keeps one code path.
 */
function installMcpApprovalPolicy(agent: ApprovalCapableAgent, policies: McpApprovalPolicy[]): void {
  const listMcpTools = agent.getMcpTools.bind(agent);
  agent.getMcpTools = async (runContext: unknown) => {
    const tools = await listMcpTools(runContext);
    return tools.map((tool) => {
      if (tool.type !== "function") {
        return tool;
      }
      const policy = policies.find((entry) => tool.name.startsWith(entry.prefix));
      if (!policy) {
        return tool;
      }
      const unprefixed = tool.name.slice(policy.prefix.length);
      return mcpToolRequiresApproval(policy.requireApproval, unprefixed)
        ? { ...tool, needsApproval: async () => true }
        : tool;
    });
  };
  const originalClone = agent.clone?.bind(agent);
  if (originalClone) {
    agent.clone = (config: unknown) => {
      const cloned = originalClone(config);
      installMcpApprovalPolicy(cloned, policies);
      return cloned;
    };
  }
}

/**
 * Enforce per-MCP-server human approval. `settings.mcpServers[].requireApproval`
 * is `true` (every tool of that server requires approval) or a string[] of
 * UNPREFIXED tool names (only those do); absent = auto-run. The SDK converts MCP
 * tools to function tools with `needsApproval` unset (defaults false) and exposes
 * no per-server/agent approval knob, so we wrap the agent's `getMcpTools` to
 * attach a `needsApproval: () => true` predicate to the matching tools — matched
 * by the server's `<id>__` prefix, then the unprefixed tool name. A tool that
 * needs approval raises a run INTERRUPTION, which the worker turns into
 * `session.requiresAction` and resolves via `user.approvalDecision`
 * (resumeApproval) — the same generic path shell/computer-use approvals use, so
 * no extra plumbing. No-op when no server requests approval, so the default
 * (auto-run everything) is byte-for-byte unchanged.
 *
 * Two robustness properties the wrap must hold:
 *  - LONGEST-PREFIX-FIRST. Server ids can be prefixes of one another (`my` vs
 *    `my_`), so their tool prefixes collide (`my__` vs `my___`): a tool like
 *    `my___run` (from server `my_`) also `startsWith` `my__` (server `my`). A
 *    first-match `find` over unsorted policies could bind it to the WRONG
 *    server's policy and bypass gating. Sorting policies by DESCENDING prefix
 *    length makes the most-specific (longest) prefix win, so each tool resolves
 *    to its own server.
 *  - CLONE SURVIVAL. The wrap is re-installed onto every clone; see
 *    {@link installMcpApprovalPolicy}.
 */
function applyMcpApprovalPolicy(agent: Agent<any, any>, settings: Settings): void {
  const policies: McpApprovalPolicy[] = settings.mcpServers
    .filter((server) => server.requireApproval === true || (Array.isArray(server.requireApproval) && server.requireApproval.length > 0))
    .map((server) => ({ prefix: prefixedMcpToolName(server.id, ""), requireApproval: server.requireApproval as boolean | string[] }))
    .sort((a, b) => b.prefix.length - a.prefix.length);
  if (policies.length === 0) {
    return;
  }
  installMcpApprovalPolicy(agent as unknown as ApprovalCapableAgent, policies);
}

/**
 * Force a sandbox capability to emit its FUNCTION-transport tool variants instead
 * of the hosted ones, by dropping the model instance the SDK's transport
 * detection keys off. See {@link buildAgentCapabilities} for why (codex routes the
 * OpenAIResponsesModel to the ChatGPT backend, which rejects the hosted
 * `apply_patch` AND `computer_use_preview` tool types). The SDK reads
 * hosted-vs-function ONLY from `_modelInstance` (set via `bindModel`); overriding
 * `bindModel` to discard the instance leaves `_modelInstance` undefined, so
 * `supportsApplyPatchTransport` / `supportsStructuredToolOutputTransport` return
 * false and `tools()` emits the function variants — `apply_patch` + text
 * `view_image` for filesystem, and the `computer_*` function tools + text
 * `computer_screenshot` for computer-use. `bindModel` still returns the capability
 * so the SDK's bind chain (`.bind().bindRunAs().bindModel()`) is preserved.
 */
function neutralizeStructuredToolTransport(capability: ReturnType<typeof filesystem> | ReturnType<typeof computerUse>): void {
  // Use `this` (NOT a captured reference to `capability`): the SandboxAgent binds
  // via `cap.clone().bind(session).bindRunAs(runAs).bindModel(model, instance)` and
  // runs tools() on the object the CHAIN returns. Capability.clone() copies this
  // override onto the fresh per-run instance, so bindModel must operate on and
  // RETURN `this` (the clone) — a version that mutated/returned the ORIGINAL
  // capability leaves the clone (which .bind() set `_session` on) out of the chain,
  // so tools() runs on the unbound original and throws "Filesystem capability is
  // not bound to a SandboxSession". Dropping the model instance is all we need:
  // supportsApplyPatchTransport(undefined) is false → the function apply_patch.
  const forceFunctionTransport = function (this: Record<string, unknown>): unknown {
    this._modelInstance = undefined;
    return this;
  };
  (capability as unknown as { bindModel: typeof forceFunctionTransport }).bindModel = forceFunctionTransport;
}

/**
 * Build the SandboxAgent capability set provider-aware.
 *
 * The SDK's `Capabilities.default()` force-includes `compaction()`, whose
 * sampling params emit `context_management:[{type:'compaction', …}]` to the
 * Responses transport. The OpenAI platform honors that (server-side compaction);
 * AZURE rejects it with `400 unsupported_parameter` — which is exactly the live
 * production failure on Azure today. So we MUST NOT attach the compaction
 * capability on the Azure / client / off paths.
 *
 * We rebuild the base set explicitly (`filesystem()`, `shell()`, the same
 * factories the SDK default uses) and add `compaction()` ONLY on the server
 * path, with an explicit `StaticCompactionPolicy(threshold)` so gpt-5.5 — which
 * is absent from the SDK's hardcoded context-window map and would otherwise hit
 * the wrong 240k fallback — gets the correct threshold. The SDK has no
 * window-registration API, so an explicit threshold is the only way to fix it.
 *
 * The resolved compaction mode and the effective context window are now passed
 * IN (the multi-provider caller resolves them per provider/model) rather than
 * re-derived from settings here. Both default to the settings-derived value so
 * callers that don't route per-model (and the existing tests) keep today's exact
 * behaviour; the effective window only changes the server-path threshold when a
 * resolved model declares its own contextWindowTokens.
 */
export function buildAgentCapabilities(
  settings: Settings,
  packSkills: PackSkill[],
  options: {
    compactionMode?: ContextCompactionMode;
    contextWindowTokens?: number;
    structuredToolTransport?: boolean;
    // EXPLICIT computer-use transport (see BuildAgentOptions.computerToolMode). When
    // present, computerUse() is handed the mode directly and its tools() obeys it
    // without the constructor-name sniff. When absent, the legacy neutralize +
    // imageFunctionResults path (driven by structuredToolTransport) is unchanged.
    computerToolMode?: ComputerToolMode;
  } = {},
): ReturnType<typeof Capabilities.default> {
  const mode = options.compactionMode ?? resolveContextCompactionMode(settings);
  const contextWindowTokens = options.contextWindowTokens ?? settings.contextWindowTokens;
  // The `filesystem()` capability picks hosted-vs-function tool variants from the
  // bound model instance (supportsApplyPatchTransport / structured tool output).
  // When the caller declares the backend does NOT support that structured/hosted
  // transport (codex → the ChatGPT backend rejects the hosted `apply_patch` type),
  // neutralize this capability's model binding so tools() falls to the function
  // `apply_patch` + text `view_image` variants the backend accepts — the SDK
  // handles their function_call round-trip natively, so no reimplementation.
  // Scoped to filesystem: shell() (always function tools) and compaction() (a
  // sampling param, dropped by the codex normalizer) are untouched.
  const filesystemCapability = filesystem();
  if (options.structuredToolTransport === false) {
    neutralizeStructuredToolTransport(filesystemCapability);
  }
  const caps: ReturnType<typeof Capabilities.default> = [filesystemCapability, shell()];
  if (mode === "server") {
    caps.push(compaction({ policy: new StaticCompactionPolicy(contextServerCompactThreshold({ ...settings, contextWindowTokens })) }));
  }
  caps.push(skills({ lazyFrom: lazySkillSourceWithPackSkills(packSkills) }));
  // P4.3 computer-use: the agent drives the SAME :0 humans watch (xdotool/XTEST +
  // scrot), but only when the desktop tier is ON, computer-use is enabled, and the
  // backend is one whose image carries the X stack (descriptorgate — honest about
  // which backends are desktop-capable today; headless/dev backends never get the
  // tool, so a misconfigured non-desktop box can't register a tool that always
  // fails). The capability's tools() bind to the live externally-owned session at
  // run time (the SandboxAgent merge); xdotool drives :0 regardless of whether any
  // viewer is attached, so no pixel-tunnel dependency.
  if (
    settings.computerUseEnabled
    && settings.sandboxDesktopEnabled
    && desktopCapableBackend(settings.sandboxBackend)
  ) {
    // computer-use is transport-aware, exactly like filesystem: `tools()` emits the
    // HOSTED `computer_use_preview` tool on the structured transport and a set of
    // FUNCTION `computer_*` tools on the text transport. The ChatGPT/Codex backend
    // rejects hosted tool types (only function/custom/web_search accepted).
    //
    // HARDENING: when the caller declares an EXPLICIT `computerToolMode` (the worker
    // does, from its authoritative model resolution), thread it straight through —
    // tool selection then never depends on the SDK's model-instance constructor-name
    // sniff (which a wrapped/proxied model would defeat, silently 400ing a
    // chat-completions provider handed the hosted tool). When ABSENT, the legacy path
    // is preserved byte-for-byte: on the codex path (structuredToolTransport === false)
    // we set imageFunctionResults and neutralize the capability's model binding — the
    // SAME trick used for filesystem above — so `tools()` sees no model instance and
    // emits the function tools the backend can call, instead of suppressing the tier.
    const explicitMode = options.computerToolMode;
    const computerCapability = computerUse({
      dimensions: [settings.streamResolutionWidth, settings.streamResolutionHeight],
      readOnly: settings.computerUseReadOnly,
      ...(explicitMode
        ? { toolMode: explicitMode }
        // Legacy (no explicit mode): on the codex path the function tools deliver
        // screenshots as a real image the model can see. The ChatGPT/Codex backend
        // rejects HOSTED tool types but DOES accept `input_image` content items inside a
        // `function_call_output` (proven by openai/codex codex-rs, whose view_image tool
        // ships exactly that shape) — so a structured image tool result is seen, where a
        // text data-URL would be unreadable.
        : options.structuredToolTransport === false ? { imageFunctionResults: true } : {}),
    });
    // Neutralize ONLY on the legacy sniff path. With an explicit toolMode the mode
    // already forces the function tools, so the constructor-name override is moot.
    if (!explicitMode && options.structuredToolTransport === false) {
      neutralizeStructuredToolTransport(computerCapability);
    }
    caps.push(computerCapability as unknown as ReturnType<typeof Capabilities.default>[number]);
  }
  return caps;
}

export function sandboxRunAs(_settings: Settings): string | undefined {
  return undefined;
}

export type PreparedAgentTools = {
  mcpServers: MCPServer[];
  close: () => Promise<void>;
  // P4 (Part B.1): the live, by-reference Set of ORIGINAL-dotted connector
  // namespaces the codex_apps transport saw across this turn's tools/list calls.
  // Accumulates as the agent lists tools during the run, so the worker reads it
  // AFTER the turn (in its finally) to cache the serving account's connector set.
  // Empty when this turn has no codex_apps server (or it never listed any
  // namespaced tool) — the worker only persists a non-empty set.
  codexConnectorNamespaces: Set<string>;
};

export type PrepareToolsOptions = {
  accountId?: string;
  workspaceId?: string;
  // Worker-asserted session scope for first-party MCP calls; enables
  // session-scoped tools such as goal management on the API side.
  sessionId?: string;
  subjectId?: string;
  subjectLabel?: string;
  // Overrides the fixed first-party MCP permission set for this session's
  // delegated token (manager-style sessions). The caller is responsible for
  // having validated the set against the session creator's grant.
  firstPartyPermissions?: Permission[];
  resolveCredential?: (input: ResolveConnectionCredentialInput) => Promise<ResolveConnectionCredentialResult>;
  onAuthNeeded?: (payload: ToolAuthNeededPayload) => Promise<void> | void;
};

export async function prepareAgentTools(settings: Settings, tools: ToolRef[], options: PrepareToolsOptions = {}): Promise<PreparedAgentTools> {
  // P4 (Part B.1): one Set per prepareTools call, shared by reference into the
  // codex_apps sanitizing fetch so every tools/list this turn accumulates the
  // account's connector namespaces. Surfaced on PreparedAgentTools for the worker.
  const codexConnectorNamespaces = new Set<string>();
  if (tools.length === 0) {
    return { mcpServers: [], close: async () => {}, codexConnectorNamespaces };
  }
  const registry = new Map(settings.mcpServers.map((server) => [server.id, server]));
  const servers = await Promise.all(tools.map(async (tool) => {
    const config = registry.get(tool.id);
    if (!config) {
      throw new Error(`Unknown MCP server id: ${tool.id}`);
    }
    const url = firstPartyMcpServerUrlForRun(settings, config, options.workspaceId) ?? config.url;
    const baseFetch = isCodexAppsMcpServer(config)
      ? codexAppsSanitizingFetch(globalThis.fetch, codexConnectorNamespaces)
      : globalThis.fetch;
    const fetchImpl = config.connectionRef
      ? connectionBrokerFetch(baseFetch, config, options)
      : baseFetch;
    const server = new PrefixedMcpServer(new MCPServerStreamableHttp({
      url,
      name: config.name ?? config.id,
      cacheToolsList: config.cacheToolsList,
      // codex_apps returns connector tools with empty `outputSchema: {}` that the
      // MCP SDK's strict Tool schema rejects (fails the turn during tools/list);
      // sanitize the response on the wire before validation. The namespace Set
      // also captures each tool's original connector namespace (P4 Part B.1).
      ...(fetchImpl !== globalThis.fetch ? { fetch: fetchImpl } : {}),
      ...await mcpServerRequestInit(settings, config, options),
      ...(config.timeoutMs ? {
        timeout: config.timeoutMs,
        clientSessionTimeoutSeconds: Math.ceil(config.timeoutMs / 1000),
      } : {}),
    }), config.id, config.allowedTools);
    // A server is connected BEST-EFFORT (a connect / tools-list failure drops
    // it instead of failing the turn) in two cases:
    //  - codex_apps: connector availability is RUNTIME-DISCOVERED — the
    //    device-code login may lack the connector scopes, and the backend can
    //    reject the bearer at the initialize/tools-list handshake, so a 401/403
    //    (or a missing/failed token) drops the server.
    //  - an optional ToolRef: either an auto-attached workspace-default
    //    capability MCP or a client/pack-selected portable ref. A
    //    broken/expired credential or unavailable endpoint skips the server
    //    with a warning, never killing the turn before the model runs. Bare
    //    refs stay strict (below), preserving the fail-loud default.
    const optional = tool.optional === true;
    return { server, bestEffort: isCodexAppsMcpServer(config) || optional || !!config.connectionRef, optional };
  }));
  const requiredServers = servers.filter((entry) => !entry.bestEffort).map((entry) => entry.server);
  const bestEffortServers = servers.filter((entry) => entry.bestEffort).map((entry) => entry.server);
  // Names of the OPTIONAL servers (not codex_apps) so a drop is surfaced as a
  // warning; codex_apps keeps its historically-quiet drop (a not-logged-in
  // ChatGPT plan is a normal, non-noteworthy state).
  const optionalServerNames = new Set(
    servers.filter((entry) => entry.optional).map((entry) => entry.server.name),
  );
  const connectedRequired = await connectMcpServers(requiredServers, {
    connectInParallel: true,
    strict: true,
  });
  const connectedBestEffort = bestEffortServers.length
    ? await connectMcpServers(bestEffortServers, {
        connectInParallel: true,
        strict: false,
      })
    : null;
  if (connectedBestEffort) {
    for (const failed of connectedBestEffort.failed) {
      if (!optionalServerNames.has(failed.name)) {
        continue;
      }
      const error = connectedBestEffort.errors.get(failed);
      console.warn(
        `[mcp] optional server "${failed.name}" failed to connect/list tools; skipping it for this turn`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return {
    mcpServers: [...connectedRequired.active, ...(connectedBestEffort?.active ?? [])],
    close: async () => {
      await connectedRequired.close();
      if (connectedBestEffort) {
        await connectedBestEffort.close();
      }
    },
    codexConnectorNamespaces,
  };
}

function connectionBrokerFetch(
  baseFetch: FetchLike,
  config: Settings["mcpServers"][number],
  options: PrepareToolsOptions,
): FetchLike {
  const connectionRef = config.connectionRef;
  if (!connectionRef) {
    return baseFetch;
  }
  return async (input, init) => {
    const request = await mcpRequestInfo(input, init);
    const first = await resolveConnectionForRequest(options, config.id, connectionRef, request.toolName, false);
    if (first.status === "auth_needed") {
      return await authNeededFetchResponse(options, config.id, request, first, connectionRef);
    }
    const response = await baseFetch(fetchInputForAttempt(input), withConnectionHeaders(input, init, first.headers));
    if (response.status === 401) {
      const refreshed = await resolveConnectionForRequest(options, config.id, connectionRef, request.toolName, true);
      if (refreshed.status === "auth_needed") {
        return await authNeededFetchResponse(options, config.id, request, refreshed, connectionRef);
      }
      const retry = await baseFetch(fetchInputForAttempt(input), withConnectionHeaders(input, init, refreshed.headers));
      if (retry.status === 403) {
        const auth = insufficientScopeAuth(retry.headers, connectionRef, refreshed.connectionId);
        return auth ? await authNeededFetchResponse(options, config.id, request, auth, connectionRef) : retry;
      }
      if (retry.status === 401) {
        return await authNeededFetchResponse(options, config.id, request, {
          status: "auth_needed",
          reason: "expired",
          providerDomain: connectionRef.providerDomain,
          connectionId: refreshed.connectionId,
          ...(connectionRef.scopes ? { scopes: connectionRef.scopes } : {}),
          ...(connectionRef.resource ? { resource: connectionRef.resource } : {}),
        }, connectionRef);
      }
      return retry;
    }
    if (response.status === 403) {
      const auth = insufficientScopeAuth(response.headers, connectionRef, first.connectionId);
      return auth ? await authNeededFetchResponse(options, config.id, request, auth, connectionRef) : response;
    }
    return response;
  };
}

async function resolveConnectionForRequest(
  options: PrepareToolsOptions,
  serverId: string,
  connectionRef: McpServerConnectionRef,
  toolName: string | undefined,
  forceRefresh: boolean,
): Promise<ResolveConnectionCredentialResult> {
  if (!options.workspaceId || !options.resolveCredential) {
    return {
      status: "auth_needed",
      reason: "missing_connection",
      providerDomain: connectionRef.providerDomain,
      ...(connectionRef.connectionId ? { connectionId: connectionRef.connectionId } : {}),
      ...(connectionRef.scopes ? { scopes: connectionRef.scopes } : {}),
      ...(connectionRef.resource ? { resource: connectionRef.resource } : {}),
    };
  }
  const request: ResolveConnectionCredentialInput = {
    workspaceId: options.workspaceId,
    serverId,
    connectionRef,
    forceRefresh,
    ...(toolName ? { toolName } : {}),
    ...(options.subjectId ? { subjectId: options.subjectId } : {}),
  };
  try {
    return await options.resolveCredential(request);
  } catch {
    return {
      status: "auth_needed",
      reason: "refresh_failed",
      providerDomain: connectionRef.providerDomain,
      ...(connectionRef.connectionId ? { connectionId: connectionRef.connectionId } : {}),
      ...(connectionRef.scopes ? { scopes: connectionRef.scopes } : {}),
      ...(connectionRef.resource ? { resource: connectionRef.resource } : {}),
    };
  }
}

function insufficientScopeAuth(
  headers: Headers,
  connectionRef: McpServerConnectionRef,
  connectionId: string,
): Extract<ResolveConnectionCredentialResult, { status: "auth_needed" }> | null {
  const challenge = parseWwwAuthenticate(headers.get("www-authenticate"));
  if (challenge.error !== "insufficient_scope") {
    return null;
  }
  return {
    status: "auth_needed",
    reason: "insufficient_scope",
    providerDomain: connectionRef.providerDomain,
    connectionId,
    ...(challenge.scope?.length ? { scopes: challenge.scope } : connectionRef.scopes ? { scopes: connectionRef.scopes } : {}),
    ...(challenge.resource ? { resource: challenge.resource } : connectionRef.resource ? { resource: connectionRef.resource } : {}),
  };
}

async function authNeededFetchResponse(
  options: PrepareToolsOptions,
  serverId: string,
  request: McpRequestInfo,
  auth: Extract<ResolveConnectionCredentialResult, { status: "auth_needed" }>,
  connectionRef: McpServerConnectionRef,
): Promise<Response> {
  const connectionId = auth.connectionId ?? connectionRef.connectionId;
  await publishAuthNeeded(options, {
    serverId,
    toolName: request.toolName ?? null,
    providerDomain: auth.providerDomain,
    reason: auth.reason,
    ...(connectionId ? { connectionId } : {}),
    ...(auth.scopes ? { scopes: auth.scopes } : connectionRef.scopes ? { scopes: connectionRef.scopes } : {}),
    ...(auth.resource ? { resource: auth.resource } : connectionRef.resource ? { resource: connectionRef.resource } : {}),
    ...(auth.authorizationUrl ? { authorizationUrl: auth.authorizationUrl } : {}),
    ...(options.subjectId ? { subjectId: options.subjectId } : {}),
  });
  if (request.method === "tools/call") {
    return mcpToolAuthNeededResponse(request.id);
  }
  return new Response("Authentication required for MCP server connection", { status: 401 });
}

async function publishAuthNeeded(options: PrepareToolsOptions, payload: ToolAuthNeededPayload): Promise<void> {
  try {
    await options.onAuthNeeded?.(payload);
  } catch {
    // Auth-needed events are advisory UI/audit signals; a publisher failure must
    // not turn an auth-recoverable tool condition into a failed agent turn.
  }
}

type McpRequestInfo = {
  method?: string;
  id?: string | number | null;
  toolName?: string;
};

async function mcpRequestInfo(input: string | URL | Request, init?: RequestInit): Promise<McpRequestInfo> {
  const body = typeof init?.body === "string"
    ? init.body
    : input instanceof Request && (init?.method ?? input.method).toUpperCase() === "POST"
      ? await input.clone().text().catch(() => "")
      : "";
  if (!body) {
    return {};
  }
  try {
    const parsed = JSON.parse(body) as { id?: unknown; method?: unknown; params?: { name?: unknown } };
    const method = typeof parsed.method === "string" ? parsed.method : undefined;
    const id = typeof parsed.id === "string" || typeof parsed.id === "number" || parsed.id === null ? parsed.id : undefined;
    const toolName = method === "tools/call" && typeof parsed.params?.name === "string" ? parsed.params.name : undefined;
    return {
      ...(method ? { method } : {}),
      ...(id !== undefined ? { id } : {}),
      ...(toolName ? { toolName } : {}),
    };
  } catch {
    return {};
  }
}

function withConnectionHeaders(input: string | URL | Request, init: RequestInit | undefined, authHeaders: Record<string, string>): RequestInit {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  for (const [name, value] of Object.entries(authHeaders)) {
    headers.set(name, value);
  }
  return { ...init, headers };
}

function fetchInputForAttempt(input: string | URL | Request): string | URL | Request {
  return input instanceof Request ? input.clone() : input;
}

function parseWwwAuthenticate(header: string | null): { error?: string; scope?: string[]; resource?: string } {
  if (!header) {
    return {};
  }
  const bearerIndex = header.toLowerCase().indexOf("bearer");
  if (bearerIndex < 0) {
    return {};
  }
  const paramsText = header.slice(bearerIndex + "bearer".length);
  const params: Record<string, string> = {};
  const re = /([a-zA-Z_][a-zA-Z0-9_-]*)\s*=\s*("(?:[^"\\]|\\.)*"|[^,\s]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(paramsText)) !== null) {
    const raw = match[2]!;
    params[match[1]!.toLowerCase()] = raw.startsWith("\"") ? raw.slice(1, -1).replace(/\\"/g, "\"") : raw;
  }
  return {
    ...(params.error ? { error: params.error } : {}),
    ...(params.scope ? { scope: params.scope.split(/\s+/).filter(Boolean) } : {}),
    ...(params.resource ? { resource: params.resource } : {}),
  };
}

// Application-defined JSON-RPC error code marking "this tool call needs a
// connection". A RESULT carrying inline `isError: true` cannot be used here:
// the agents SDK's streamable-http shim strips `isError` and returns only the
// content, erasing the failure. A JSON-RPC error survives the shim as a thrown
// McpError, which PrefixedMcpServer.callTool converts back into an MCP-shaped
// `{ isError: true }` output for the model.
const MCP_AUTH_NEEDED_ERROR_CODE = -32001;
const MCP_AUTH_NEEDED_MESSAGE = "Authentication required - a connection link was posted to the session.";

function mcpToolAuthNeededResponse(id: string | number | null | undefined): Response {
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code: MCP_AUTH_NEEDED_ERROR_CODE,
      message: MCP_AUTH_NEEDED_MESSAGE,
    },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function isAuthNeededMcpError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === MCP_AUTH_NEEDED_ERROR_CODE || error.message.includes(MCP_AUTH_NEEDED_MESSAGE);
}

async function mcpServerRequestInit(settings: Settings, config: Settings["mcpServers"][number], options: PrepareToolsOptions): Promise<{ requestInit: { headers: Record<string, string> } } | {}> {
  // codex_apps is checked FIRST so the static-headers path can never apply to
  // it: its refreshing ChatGPT/Codex bearer is resolved per-connect from the
  // codex ALS, never from a baked `config.headers` value.
  if (isCodexAppsMcpServer(config)) {
    return await codexAppsMcpRequestInit(settings);
  }
  if (isFirstPartyMcpServer(settings, config)) {
    return await firstPartyMcpRequestInit(settings, config, options);
  }
  // Third-party MCP servers get their configured credential headers (for
  // example workspace-enabled capability MCP credentials) and nothing else —
  // never OpenGeni's own access key or delegated tokens.
  if (config.headers && Object.keys(config.headers).length > 0) {
    return { requestInit: { headers: { ...config.headers } } };
  }
  return {};
}

async function firstPartyMcpRequestInit(settings: Settings, config: Settings["mcpServers"][number], options: PrepareToolsOptions): Promise<{ requestInit: { headers: Record<string, string> } } | {}> {
  if (!isFirstPartyMcpServer(settings, config)) {
    return {};
  }
  const headers: Record<string, string> = {};
  if (settings.authRequired && settings.accessKey) {
    headers["x-opengeni-access-key"] = settings.accessKey;
  }
  if (settings.delegationSecret && options.accountId && options.workspaceId) {
    headers.authorization = `Bearer ${await signDelegatedAccessToken(settings.delegationSecret, {
      accountId: options.accountId,
      workspaceId: options.workspaceId,
      subjectId: options.subjectId ?? "worker:first-party-mcp",
      ...(options.subjectLabel ? { subjectLabel: options.subjectLabel } : {}),
      permissions: options.firstPartyPermissions ?? firstPartyMcpPermissions,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      exp: Math.floor(Date.now() / 1000) + 60 * 60,
    })}`;
  }
  if (Object.keys(headers).length === 0) {
    return {};
  }
  return {
    requestInit: {
      headers,
    },
  };
}

/**
 * Builds the connect-time auth headers for the codex_apps connectors MCP. The
 * bearer is resolved from codexRequestStorage — the SAME refreshing token source
 * the model fetch uses (proactive refresh + single-flight + db persist) — so the
 * token is valid at connect. A missing store (non-codex turn, or prepareTools
 * ran outside the ALS) or a token failure (needs_relogin) returns {} so the
 * best-effort connect drops the server rather than crashing the turn.
 */
async function codexAppsMcpRequestInit(settings: Settings): Promise<{ requestInit: { headers: Record<string, string> } } | {}> {
  const ctx = codexRequestStorage.getStore();
  if (!ctx) {
    return {};
  }
  let token;
  try {
    token = await ctx.getToken();
  } catch {
    return {};
  }
  const headers: Record<string, string> = {
    authorization: `Bearer ${token.accessToken}`,
    // The ChatGPT backend sits behind Cloudflare, which 403s requests bearing a
    // default runtime User-Agent (confirmed live: an HTML bot-block page, NOT an
    // auth failure). Send the codex client identity — the same originator/version/
    // User-Agent the model fetch uses — so the MCP connect handshake passes the edge.
    originator: CODEX_ORIGINATOR,
    "user-agent": `${CODEX_ORIGINATOR}/${ctx.clientVersion}`,
    version: ctx.clientVersion,
  };
  if (token.chatgptAccountId) {
    headers["chatgpt-account-id"] = token.chatgptAccountId;
  }
  if (settings.codexProductSku) {
    headers["X-OpenAI-Product-Sku"] = settings.codexProductSku;
  }
  return { requestInit: { headers } };
}

// The first-party MCP permission set signed into a worker's delegated token
// when the session does not specify its own. POWERFUL BY DEFAULT: it carries
// every permission that unlocks a first-party tool — session orchestration
// (sessions:*), workspace environments (environments:*), and GitHub
// (github:use) — so agents are fully capable out of the box. A user DEMOTES a
// specific session by setting a narrower session.firstPartyMcpPermissions (the
// create-session permission picker), which the worker uses instead. Account-
// level scopes (billing/account/members/api_keys/workspace:admin) are
// intentionally excluded: they gate no first-party tool and are not agent
// capabilities. (A finer-grained capability model comes later.)
const firstPartyMcpPermissions: Permission[] = [
  "workspace:read",
  "files:read",
  "documents:search",
  "scheduled_tasks:manage",
  "scheduled_tasks:run",
  "goals:manage",
  "sessions:read",
  "sessions:create",
  "sessions:control",
  "environments:use",
  "environments:manage",
  "github:use",
];

// codex_apps is third-party-by-trust (the external ChatGPT connectors backend)
// but needs DYNAMIC auth, so it is its own category — deliberately NOT folded
// into the first-party allowlist, which would wrongly sign an OpenGeni delegated
// token to chatgpt.com.
function isCodexAppsMcpServer(config: Settings["mcpServers"][number]): boolean {
  return config.id === CODEX_APPS_MCP_SERVER_ID;
}

function isFirstPartyMcpServer(settings: Settings, config: Settings["mcpServers"][number]): boolean {
  if (!["opengeni", "files", "docs"].includes(config.id)) {
    return false;
  }
  if (config.url.includes("{workspaceId}")) {
    return true;
  }
  const url = normalizeUrl(config.url);
  if (!url) {
    return false;
  }
  return firstPartyMcpUrls(settings).some((candidate) => candidate === url);
}

function firstPartyMcpServerUrlForRun(settings: Settings, config: Settings["mcpServers"][number], workspaceId: string | undefined): string | null {
  if (!workspaceId || !["opengeni", "files", "docs"].includes(config.id)) {
    return null;
  }
  if (config.url.includes("{workspaceId}")) {
    return config.url.replaceAll("{workspaceId}", workspaceId);
  }
  if (!isFirstPartyMcpServer(settings, config)) {
    return null;
  }
  const rawBase = settings.opengeniMcpUrl?.includes("{workspaceId}")
    ? settings.opengeniMcpUrl.replaceAll("{workspaceId}", workspaceId)
    : settings.opengeniMcpUrl
      ? scopedMcpUrlFromConfiguredBase(settings.opengeniMcpUrl, workspaceId)
      // unset → the shared loopback default (a `{workspaceId}` template owned by
      // @opengeni/config's firstPartyMcpBaseUrl), scoped to this run's workspace.
      : firstPartyMcpBaseUrl(settings).replaceAll("{workspaceId}", workspaceId);
  const url = new URL(rawBase);
  if (config.id === "docs") {
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/docs`;
  }
  return url.toString();
}

function scopedMcpUrlFromConfiguredBase(raw: string, workspaceId: string): string {
  const url = new URL(raw);
  url.pathname = `/v1/workspaces/${workspaceId}/mcp`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function firstPartyMcpUrls(settings: Settings): string[] {
  // Route the unset case through the shared loopback default so the literal
  // lives in exactly one place (@opengeni/config's firstPartyMcpBaseUrl).
  const base = normalizeUrl(settings.opengeniMcpUrl ?? firstPartyMcpBaseUrl(settings));
  if (!base) {
    return [];
  }
  const docs = new URL(base);
  docs.pathname = `${docs.pathname.replace(/\/+$/, "")}/docs`;
  return [base, normalizeUrl(docs.toString())].filter((value): value is string => Boolean(value));
}

function normalizeUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return null;
  }
}

export function prefixedMcpToolName(registryId: string, toolName: string): string {
  return sharedPrefixedMcpToolName(registryId, toolName);
}

class PrefixedMcpServer implements MCPServer {
  readonly cacheToolsList: boolean;
  readonly name: string;
  readonly prefix: string;
  private readonly allowedTools: Set<string> | undefined;

  constructor(private readonly inner: MCPServer, registryId: string, allowedTools?: string[]) {
    this.name = registryId;
    this.prefix = prefixedMcpToolName(registryId, "");
    this.cacheToolsList = inner.cacheToolsList;
    this.allowedTools = allowedTools ? new Set(allowedTools) : undefined;
  }

  connect(): Promise<void> {
    return this.inner.connect();
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  async listTools(): Promise<RuntimeMcpTool[]> {
    const tools = await this.inner.listTools();
    return tools
      .filter((tool) => this.isAllowed(tool.name))
      .map((tool) => ({ ...tool, name: prefixedMcpToolName(this.name, tool.name) }));
  }

  async callTool(toolName: string, args: Record<string, unknown> | null, meta?: Record<string, unknown> | null): Promise<any> {
    const unprefixed = this.unprefixToolName(toolName);
    if (!this.isAllowed(unprefixed)) {
      throw new Error(`MCP tool ${unprefixed} is not allowed for server ${this.name}`);
    }
    try {
      return await this.inner.callTool(unprefixed, args, meta);
    } catch (error) {
      // The connection broker's auth-needed short-circuit arrives as a thrown
      // JSON-RPC error (an inline isError result would be stripped by the SDK
      // shim). Surface it to the model as a failed-but-recoverable tool result
      // instead of failing the turn; the timeline chip was already published.
      if (isAuthNeededMcpError(error)) {
        return { isError: true, content: [{ type: "text", text: MCP_AUTH_NEEDED_MESSAGE }] };
      }
      throw error;
    }
  }

  invalidateToolsCache(): Promise<void> {
    return this.inner.invalidateToolsCache();
  }

  async listResources(params?: Record<string, unknown>): Promise<any> {
    const resourcesServer = this.inner as MCPServer & { listResources?: (params?: Record<string, unknown>) => Promise<any> };
    if (!resourcesServer.listResources) {
      throw new Error(`MCP server ${this.name} does not support resources`);
    }
    return await resourcesServer.listResources(params);
  }

  async listResourceTemplates(params?: Record<string, unknown>): Promise<any> {
    const resourcesServer = this.inner as MCPServer & { listResourceTemplates?: (params?: Record<string, unknown>) => Promise<any> };
    if (!resourcesServer.listResourceTemplates) {
      throw new Error(`MCP server ${this.name} does not support resource templates`);
    }
    return await resourcesServer.listResourceTemplates(params);
  }

  async readResource(uri: string): Promise<any> {
    const resourcesServer = this.inner as MCPServer & { readResource?: (uri: string) => Promise<any> };
    if (!resourcesServer.readResource) {
      throw new Error(`MCP server ${this.name} does not support resource reads`);
    }
    return await resourcesServer.readResource(uri);
  }

  private isAllowed(toolName: string): boolean {
    return !this.allowedTools || this.allowedTools.has(toolName);
  }

  private unprefixToolName(toolName: string): string {
    if (!toolName.startsWith(this.prefix)) {
      throw new Error(`MCP tool ${toolName} is missing expected ${this.name} prefix`);
    }
    return toolName.slice(this.prefix.length);
  }
}

// createSandboxClient (+ withDockerNetwork / connectDockerNetwork) moved to the
// agent-loop-free leaf ./sandbox; re-exported via `export * from "./sandbox"`.

export type PrepareInputOptions = {
  sandboxClient?: unknown;
  /**
   * Usable input-token budget B (window - reserved output). When set, the
   * assembled history is passed through `enforceInputBudget` so a single
   * over-budget input can never be sent — the last-resort backstop behind the
   * best-effort pre-turn compaction. Omitted (undefined) disables the guard
   * (no behaviour change for callers that don't opt in).
   */
  inputBudgetTokens?: number;
};

/**
 * Apply the read-path budget guard to an assembled model input: drop the oldest
 * history at a clean turn boundary until the request fits B. Orphan-safe (only
 * cuts at user-message boundaries) and only active when a budget is supplied.
 * The trailing user message is counted against the budget but never dropped.
 */
function guardAssembledInput(
  history: AgentInputItem[],
  trailing: AgentInputItem,
  inputBudgetTokens: number | undefined,
): AgentInputItem[] {
  if (typeof inputBudgetTokens !== "number" || inputBudgetTokens <= 0) {
    return [...history, trailing];
  }
  const trailingTokens = estimateItemTokens(trailing as unknown as Record<string, unknown>);
  const guarded = enforceInputBudget(
    history as unknown as Array<Record<string, unknown>>,
    inputBudgetTokens,
    trailingTokens,
  );
  if (guarded.trimmed) {
    console.warn(
      `read-path budget guard trimmed ${guarded.droppedCount} oldest history item(s) to fit input budget (${inputBudgetTokens} tokens); the over-budget input was NOT sent`,
    );
  }
  return [...(guarded.items as unknown as AgentInputItem[]), trailing];
}

export async function prepareRunInput(agent: Agent<any, any>, input: AgentSegmentInput, options: PrepareInputOptions = {}): Promise<PreparedAgentInput> {
  if (input.kind === "message") {
    if (input.historyItems && input.historyItems.length > 0) {
      // Items mode: conversation truth comes from the database, the sandbox
      // recovery descriptor from its own store. The RunState blob is not
      // touched at all on this path.
      const sandboxSessionState = input.sandboxEnvelope
        ? await restoredSandboxSessionStateFromEntry(input.sandboxEnvelope, options.sandboxClient)
        : undefined;
      // Replayed conversation truth is reloaded verbatim from the database, so
      // it can contain a tool-call pairing the Responses API rejects (most
      // destructively an orphaned function_call_result with no matching
      // function_call — which 400s every turn and bricks the session until the
      // row is hand-deleted). Sanitize the in-memory copy before it reaches the
      // model so existing corruption self-heals and a future write-path race is
      // non-fatal; the stored rows are never touched.
      const sanitizedHistory = sanitizeHistoryItemsForModel(
        input.historyItems as unknown as Array<Record<string, unknown>>,
      ) as unknown as AgentInputItem[];
      return {
        // Read-path budget guard: even after the orphan sanitizer, an assembled
        // input can exceed the model window (pre-turn compaction is best-effort
        // and can no-op). Trim the oldest history at a clean turn boundary so an
        // over-budget request is never sent. No-op when no budget is supplied.
        input: guardAssembledInput(
          sanitizedHistory,
          {
            type: "message",
            role: "user",
            content: input.text,
          } as AgentInputItem,
          options.inputBudgetTokens,
        ),
        ...(sandboxSessionState ? { sandboxSessionState } : {}),
      };
    }
    // No prior state, or a cleared sentinel: start fresh. The clear sentinel
    // ({@link CLEARED_RUN_STATE_BLOB}) is not a real serialized run state — it
    // carries no $schemaVersion, so RunState.fromString would throw on it. In
    // run_state history mode this message path is the one that reads the blob
    // after a /clear, so recognizing the sentinel here is what keeps the next
    // turn working (a fresh, empty context) instead of bricking on deserialize.
    if (!input.serializedRunState || isClearedRunStateBlob(input.serializedRunState)) {
      return { input: input.text };
    }
    const state = await RunState.fromString(agent, input.serializedRunState);
    const sandboxSessionState = await restoredSandboxSessionState(state, options.sandboxClient);
    // state.history already runs the SDK's own orphan-tool-call pruning, but
    // applying the same sanitizer keeps the legacy run-state resume path under
    // one invariant with the items path and is defensive against a corrupt blob.
    const sanitizedHistory = sanitizeHistoryItemsForModel(
      state.history as unknown as Array<Record<string, unknown>>,
    ) as unknown as AgentInputItem[];
    return {
      // Read-path budget guard (see the items path above): keep an over-budget
      // resumed history off the wire by trimming the oldest turns when a budget
      // is supplied.
      input: guardAssembledInput(
        sanitizedHistory,
        {
          type: "message",
          role: "user",
          content: input.text,
        } as AgentInputItem,
        options.inputBudgetTokens,
      ),
      ...(sandboxSessionState ? { sandboxSessionState } : {}),
      serializedRunStateForSandbox: input.serializedRunState,
    };
  }
  // An approval can only be resumed against a real saved run state. If the
  // latest blob is the cleared sentinel the awaiting turn was wiped (the API
  // refuses clear in requires_action, so this is a defensive guard) — fail with
  // an honest message instead of the cryptic SDK "missing schema version".
  if (isClearedRunStateBlob(input.serializedRunState)) {
    throw new Error("Cannot resume an approval: the session context was cleared, so the awaiting run state no longer exists.");
  }
  const state = await RunState.fromString(agent, input.serializedRunState);
  const interruptions = state.getInterruptions();
  const target = interruptions.find((item: any) => approvalIdentifier(item) === input.approvalId);
  if (!target) {
    throw new Error(`Approval not found in saved run state: ${input.approvalId}`);
  }
  if (input.decision === "approve") {
    state.approve(target as any);
  } else {
    state.reject(target as any, input.message ? { message: input.message } : undefined);
  }
  return { input: state };
}

export type RunAgentStreamOptions = {
  sandboxClient?: unknown;
  sandboxEnvironment?: Record<string, string>;
  onRuntimeEvent?: (event: NormalizedRuntimeEvent) => Promise<void> | void;
  contextCompactionSignalTokens?: () => number | null | undefined;
  // OWNERSHIP INVERSION (P1.2): an externally-owned, already-live sandbox
  // session resolved by the per-turn resume-by-id path. When present,
  // runAgentStream does NOT build (or resume, or discard) a client — it threads
  // these straight into runOptions.sandbox as a NON-OWNED session. The SDK
  // registers a provided session non-owned (manager.js) and NEVER reaps it on a
  // normal finish (proven by spikes/sdk-keystone) — that is the keystone: the
  // one box survives across turns. Mutually exclusive with the per-run
  // createSandboxClient path (the owned branch takes precedence when both set).
  // Agent-dependent decorators (file-downloads, lifecycle/repo-clone hooks) are
  // re-applied around the resumed client here; the live `session`/`sessionState`
  // carry the box, so no create()/resume() is re-invoked inside run().
  ownedSandbox?: {
    client: unknown;          // built by the per-turn resume path (the raw provider client)
    session: unknown;         // SandboxSessionLike — the live, NON-OWNED handle (never reaped)
    sessionState?: unknown;   // SandboxSessionState the box was resumed from
    // The UN-PROXIED established box for platform setup (lifecycle hooks + file
    // resource materialization). `session` may be the mid-turn routing proxy whose
    // every exec re-reads the active pointer — platform-initiated setup must NOT
    // follow a swap onto a connected machine (the user's real computer), so it
    // runs against this pinned handle instead. Absent -> falls back to `session`.
    setupSession?: unknown;
    // True when the caller already ran file-resource materialization for this
    // provided session and threaded any failures into the model input.
    fileDownloadsMaterialized?: boolean;
  };
  // A per-turn model-input filter chained AFTER the provider-item-id strip.
  // Used by the genesis-title injection to prepend a hidden, NON-PERSISTED
  // directive: a callModelInputFilter mutates only `modelData.input` for each
  // model call and never touches `state.history`/`originalInput`, so the
  // reconcile dual-write never sees it.
  callModelInputFilter?: CallModelInputFilter;
};

export type ContextRobustnessFilterOptions = {
  contextCompactionSignalTokens?: () => number | null | undefined;
  throwOnCompactionNeeded?: boolean;
};

// One-shot directive appended to the agent's system prompt on the genesis turn
// (see buildOpenGeniAgent's genesisTitleHint). Delivered through the
// authoritative instructions channel so the model reliably obeys; references
// the prefixed tool name the agent actually sees (opengeni__set_session_title).
// Appended after the non-bypassable core so a white-label persona can't drop it.
export const GENESIS_TITLE_DIRECTIVE =
  "This is the first turn of a new session. Before responding to the user, call the opengeni__set_session_title tool with a concise 3-7 word title that summarizes what this session is about, then address the user's request normally.";

// Generic substrate prompting for programmatic tool calling (toolspace). Same
// text for every host; gated per-turn by appendToolspaceInstructions on the
// presence of a minted toolspace token, so it only appears when the sandbox
// actually exposes the ogtool CLI + $OPENGENI_TOOLSPACE_URL/_TOKEN_FILE.
export const TOOLSPACE_PROGRAMMATIC_DIRECTIVE =
  "Every tool on your MCP surface is also callable programmatically from the sandbox shell, so scripts can invoke tools without a model round trip per call. Run `ogtool list` to see the available tools and their input schemas (from tools/list), then `ogtool call <tool-name> '<json-args>'`; equivalently, POST MCP JSON-RPC to $OPENGENI_TOOLSPACE_URL with the bearer token read from $OPENGENI_TOOLSPACE_TOKEN_FILE. Prefer programmatic calls for loops, polling, and bulk filtering: their results stay in the sandbox and do not consume your context window. Tools that require human approval must still be invoked normally — called programmatically they return a typed error.";

/**
 * callModelInputFilter that removes provider-assigned item ids (rs_/msg_/fc_…)
 * from every input item immediately before each model call. Responses-API
 * requests that carry item ids are resolved against the provider's stored
 * responses, and that store is not durable enough to anchor long runs on: a
 * response that streamed successfully can be missing from the store on the
 * very next call, which then fails with 400 "Item with id ... not found"
 * (observed live on Azure OpenAI mid-turn). All item content — including the
 * encrypted reasoning payload carried in providerData when
 * `openaiReasoningEncryptedContent` is on — is sent inline, so the ids add
 * fragility without adding information. Pairing fields (`call_id`/`callId`)
 * are separate properties and stay untouched; items are cloned, never mutated.
 */
export const stripProviderItemIdsFilter: CallModelInputFilter = ({ modelData }) => ({
  ...modelData,
  input: modelData.input.map((item) => {
    if (item && typeof item === "object" && "id" in item) {
      const { id: _id, ...rest } = item as Record<string, unknown>;
      return rest as AgentInputItem;
    }
    return item;
  }),
});

/**
 * callModelInputFilter that normalizes every `computer_call` carrying BOTH
 * `action` and `actions` down to EXACTLY ONE (keeps `actions`, drops `action`).
 * The Azure computer-use endpoint rejects a request whose computer_call has
 * both with `400 Computer call input must include exactly one of `action` or
 * `actions``; and (live-proven against gpt-5.5's GA computer tool) it also
 * rejects the `action`-only form, accepting ONLY the batched plural `actions`.
 * The SDK 0.11.6 schema allows both, so a freshly-emitted
 * screenshot call carries the redundant pair. This filter runs before EVERY
 * model call — the turn-start history replay AND every mid-turn follow-up — so
 * it covers the just-emitted (non-replayed) computer_call on the same turn,
 * which the turn-start `prepareRunInput` sanitizer never sees. Items are cloned,
 * never mutated.
 */
export const normalizeComputerCallsFilter: CallModelInputFilter = ({ modelData }) => ({
  ...modelData,
  input: normalizeComputerCallActions(
    modelData.input as unknown as Array<Record<string, unknown>>,
  ) as unknown as AgentInputItem[],
});

export function contextRobustnessFilterForSettings(
  settings: Settings,
  options: ContextRobustnessFilterOptions = {},
): CallModelInputFilter {
  const inputBudgetTokens = modelCallBudgetTokens(settings);
  const clientCompactionMode = resolveContextCompactionMode(settings) === "client";
  const compactionThresholdTokens = clientCompactionThresholdTokens(settings);
  return ({ modelData }) => {
    let input = modelData.input;
    if (inputBudgetTokens !== undefined) {
      const guarded = enforceInputBudget(
        input as unknown as Array<Record<string, unknown>>,
        inputBudgetTokens,
      );
      if (guarded.trimmed) {
        console.warn(
          `per-call budget guard trimmed ${guarded.droppedCount} oldest history item(s) to fit input budget (${inputBudgetTokens} tokens); the over-budget model call was NOT sent`,
        );
        input = guarded.items as unknown as AgentInputItem[];
      }
    }
    if (clientCompactionMode && options.throwOnCompactionNeeded) {
      const reported = options.contextCompactionSignalTokens?.();
      const hasReported = typeof reported === "number" && reported > 0;
      const signalTokens = hasReported
        ? reported
        : estimateTokens(input as unknown as Array<Record<string, unknown>>);
      if (signalTokens > compactionThresholdTokens) {
        throw new CompactionNeededError({
          signalTokens,
          thresholdTokens: compactionThresholdTokens,
          signalSource: hasReported ? "provider" : "estimate",
        });
      }
    }
    return { ...modelData, input };
  };
}

function modelCallBudgetTokens(settings: Settings): number | undefined {
  if (resolveContextCompactionMode(settings) !== "client") {
    return undefined;
  }
  const budget = contextInputBudgetTokens(settings);
  return budget > 0 ? budget : undefined;
}

/**
 * Compose a list of callModelInputFilters into one, applied left-to-right so
 * each sees the prior filter's output.
 */
function composeCallModelInputFilters(filters: CallModelInputFilter[]): CallModelInputFilter {
  return async (args) => {
    let modelData = args.modelData;
    for (const filter of filters) {
      modelData = await filter({ ...args, modelData });
    }
    return modelData;
  };
}

/**
 * The model-input filter applied before every model call. The computer_call
 * action/actions normalizer is ALWAYS on (the Azure endpoint 400s without it);
 * the provider-item-id strip is layered on top when the configured policy
 * selects it; the context-robustness guard then applies hard budget trimming
 * only on the client-compaction path and raises the proactive compaction signal.
 */
export function callModelInputFilterForSettings(
  settings: Settings,
  options: ContextRobustnessFilterOptions = {},
): CallModelInputFilter | undefined {
  const filters: CallModelInputFilter[] = [normalizeComputerCallsFilter];
  if (settings.openaiProviderItemIds === "strip") {
    filters.push(stripProviderItemIdsFilter);
  }
  filters.push(contextRobustnessFilterForSettings(settings, options));
  return composeCallModelInputFilters(filters);
}

export async function runAgentStream(agent: Agent<any, any>, input: PreparedAgentInput | string | RunState<any, any>, settings: Settings, overrides: RunAgentStreamOptions = {}) {
  const prepared: PreparedAgentInput = typeof input === "string" || input instanceof RunState ? { input } : input;
  const environment = overrides.sandboxEnvironment ?? collectSandboxEnvironment(settings);

  // OWNED PATH (P1.2 ownership inversion): the per-turn resume path injected a
  // live, externally-owned box. We thread the live `session` straight into
  // runOptions.sandbox so the SDK registers it NON-OWNED and never reaps it on
  // a normal finish (the keystone). We re-apply ONLY the agent-dependent
  // decorators (file-downloads + lifecycle/repo-clone hooks) around the resumed
  // client — the manifest-refresh-on-resume wrap is a no-op when a live
  // `session` is supplied (resume is not re-invoked). This branch is reached
  // ONLY when sandboxOwnershipEnabled gated the activity into resolving a box;
  // with the flag off the activity never sets `ownedSandbox` and this whole
  // block is skipped (byte-for-byte the legacy path).
  if (overrides.ownedSandbox) {
    const { client: ownedClient, session, sessionState } = overrides.ownedSandbox;
    // Platform setup (hooks + file materialization) execs against the UN-PROXIED
    // established box when the caller pinned one — never through the routing proxy,
    // whose per-op pointer re-read could land these execs on a machine swapped in
    // mid-turn.
    const setupSession = (overrides.ownedSandbox.setupSession ?? session) as SandboxSessionLike;
    // ENV PIN (provided sessions): the SDK validates the FULL recomputed manifest
    // env against the live box's baked env before applying its entry-only delta
    // (validateNoEnvironmentDelta — session-fatal on ANY drift; killed a 4-day
    // prod manager session 2026-07-06). Align the turn's manifest to the box's
    // own env and REPORT the drift instead of dying on it.
    await pinProvidedSessionManifestEnvironment(agent, session as SandboxSessionLike, {
      ...(overrides.onRuntimeEvent ? { onRuntimeEvent: overrides.onRuntimeEvent } : {}),
    });
    const runAs = sandboxRunAs(settings);
    const fileDownloads = sandboxFileDownloadsForAgent(agent);
    const resourceClient = fileDownloads.length > 0
      ? withSandboxFileDownloads(ownedClient as SandboxClient, fileDownloads, {
        ...(overrides.onRuntimeEvent ? { onRuntimeEvent: overrides.onRuntimeEvent } : {}),
        ...(runAs ? { runAs } : {}),
      })
      : (ownedClient as SandboxClient);
    // TOKEN-BROKER (B1): the per-turn git token seed, forwarded OFF-MANIFEST so the
    // repository-clone hook seeds it to the box's token file before the clone.
    const ownedGitTokenSeed = gitTokenSeedForAgent(agent);
    const ownedToolspaceTokenSeed = toolspaceTokenSeedForAgent(agent);
    const ownedHooks = [
      ...sandboxLifecycleHooksForIds(sandboxLifecycleHookIds(settings)),
      ...sandboxToolspaceTokenHooksForAgent(agent),
      ...sandboxRepositoryCloneHooksForAgent(agent),
    ];
    const ownedHookContext: SandboxLifecycleHookContext = {
      environment,
      ...(overrides.onRuntimeEvent ? { onRuntimeEvent: overrides.onRuntimeEvent } : {}),
      ...(runAs ? { runAs } : {}),
      ...(ownedGitTokenSeed ? { gitTokenSeed: ownedGitTokenSeed } : {}),
      ...(ownedToolspaceTokenSeed ? { toolspaceTokenSeed: ownedToolspaceTokenSeed } : {}),
    };
    // OWNED-PATH HOOKS: the SDK NEVER calls client.create/resume when handed a live
    // provided session (SandboxRuntimeManager uses `sandboxConfig.session` directly),
    // so the withSandboxLifecycleHooks decoration below can never fire on this branch —
    // it only wraps create/resume. Run the beforeAgentStart hooks directly against the
    // provided box, once per turn, BEFORE the run starts: this is what executes the
    // repository-clone hook (which also seeds the B1 askpass + token file) and the
    // azure-cli-login hook on lease-owned boxes. Re-running on a warm box is safe by
    // construction: clone skips when the target is already materialized, the token
    // seed OVERWRITES the file (the desired per-turn refresh), and az login is
    // idempotent. A turn resumed after preemption re-enters here and re-seeds the
    // freshly minted token — which is exactly what a >1h-old warm box needs.
    // EXCEPT on a connected machine (effective backend "selfhosted"): the box is the
    // user's REAL computer — the platform must not run setup against it (the clone
    // hooks are already empty there; this keeps az login off it too).
    if (agentActiveSandboxBackend.get(agent) !== "selfhosted") {
      await runBeforeAgentStartHooks(setupSession, ownedHooks, ownedHookContext);
      // FILE RESOURCES: withSandboxFileDownloads below has the IDENTICAL provided-
      // session blind spot (it too wraps only create/resume), so signed-URL file
      // materialization must also run directly against the pinned box. The download
      // command is idempotent (skips an existing file) and atomic (tmp + rename),
      // so the per-turn re-run is safe; the turn re-signs URLs each run, so a
      // re-warmed box always gets fresh links.
      if (fileDownloads.length > 0 && !overrides.ownedSandbox.fileDownloadsMaterialized) {
        const materialized = await materializeSandboxFileDownloads(setupSession, fileDownloads, {
          ...(overrides.onRuntimeEvent ? { onRuntimeEvent: overrides.onRuntimeEvent } : {}),
          ...(runAs ? { runAs } : {}),
        });
        appendSandboxFileDownloadFailureNote(prepared, materialized.failures);
      }
    } else {
      // SELFHOSTED TOOLSPACE (parity): the platform setup hooks (repository clone,
      // az login) and file materialization stay OFF the user's real machine — but
      // the toolspace token seed is the ONE piece of per-turn material that must
      // reach it. It writes a scoped, own-session-bound token to
      // $OPENGENI_TOOLSPACE_TOKEN_FILE over the SAME exec channel the clone-seed
      // uses (off-manifest, value never on the manifest), and it grants no more
      // than the machine owner's own authority (toolspace:call, this session, turn
      // TTL, budgeted, approval-tools excluded) — the invariant that makes it safe
      // to cross to a user machine when the git token is not. It is also the
      // machine's only path to programmatic tool calling. Seed it (only) here; the
      // hook list is empty when no toolspace token was minted for this turn.
      const toolspaceHooks = sandboxToolspaceTokenHooksForAgent(agent);
      if (toolspaceHooks.length > 0) {
        await runBeforeAgentStartHooks(setupSession, toolspaceHooks, ownedHookContext);
      }
    }
    // Keep the decoration as a safety net for any session the SDK does create/resume
    // through the client during this run (it is inert for the provided session).
    const decoratedClient = withSandboxLifecycleHooks(resourceClient, ownedHooks, ownedHookContext);
    const ownedFilter = composeCallModelInputFilters(
      [
        callModelInputFilterForSettings(settings, {
          throwOnCompactionNeeded: Boolean(overrides.contextCompactionSignalTokens),
          ...(overrides.contextCompactionSignalTokens
            ? { contextCompactionSignalTokens: overrides.contextCompactionSignalTokens }
            : {}),
        }),
        overrides.callModelInputFilter,
      ].filter(
        (f): f is CallModelInputFilter => Boolean(f),
      ),
    );
    const ownedRunOptions: Parameters<typeof run>[2] = {
      stream: true,
      maxTurns: settings.agentMaxModelCallsPerTurn,
      callModelInputFilter: ownedFilter,
    };
    ownedRunOptions.sandbox = {
      client: decoratedClient,
      session,
      ...(sessionState ? { sessionState } : {}),
    } as SandboxRunConfig;
    return await runScopedRunner(settings).run(agent, prepared.input, ownedRunOptions);
  }

  const rawClient = overrides.sandboxClient ?? createSandboxClient(settings, environment);
  const refreshedClient = rawClient
    ? withManifestRefreshOnResume(rawClient as SandboxClient, (agent as { defaultManifest?: Manifest }).defaultManifest, {
      ...(overrides.onRuntimeEvent ? { onRuntimeEvent: overrides.onRuntimeEvent } : {}),
    })
    : undefined;
  const runAs = sandboxRunAs(settings);
  const fileDownloads = sandboxFileDownloadsForAgent(agent);
  const resourceClient = refreshedClient && fileDownloads.length > 0
    ? withSandboxFileDownloads(refreshedClient, fileDownloads, {
      ...(overrides.onRuntimeEvent ? { onRuntimeEvent: overrides.onRuntimeEvent } : {}),
      ...(runAs ? { runAs } : {}),
    })
    : refreshedClient;
  // TOKEN-BROKER (B1): the per-turn git token seed, forwarded OFF-MANIFEST so the
  // repository-clone hook seeds it to the box's token file before the clone.
  const gitTokenSeed = gitTokenSeedForAgent(agent);
  const toolspaceTokenSeed = toolspaceTokenSeedForAgent(agent);
  const client = resourceClient
    ? withSandboxLifecycleHooks(resourceClient, [
      ...sandboxLifecycleHooksForIds(sandboxLifecycleHookIds(settings)),
      ...sandboxToolspaceTokenHooksForAgent(agent),
      ...sandboxRepositoryCloneHooksForAgent(agent),
    ], {
      environment,
      ...(overrides.onRuntimeEvent ? { onRuntimeEvent: overrides.onRuntimeEvent } : {}),
      ...(runAs ? { runAs } : {}),
      ...(gitTokenSeed ? { gitTokenSeed } : {}),
      ...(toolspaceTokenSeed ? { toolspaceTokenSeed } : {}),
    })
    : undefined;
  const sandboxSessionState = prepared.sandboxSessionState
    ?? (prepared.serializedRunStateForSandbox && client
      ? await restoredSandboxSessionState(await RunState.fromString(agent, prepared.serializedRunStateForSandbox), client)
      : undefined);
  // Apply the built-in per-call filters (computer-call normalization, optional
  // provider-id stripping, image/budget guard), then any per-turn filter
  // (genesis title directive). A callModelInputFilter only shapes the per-call
  // model input; the SDK persists filtered clones into its session view, while
  // OpenGeni's durable conversation truth is still reconciled explicitly below.
  const callModelInputFilter = composeCallModelInputFilters(
    [
      callModelInputFilterForSettings(settings, {
        throwOnCompactionNeeded: Boolean(overrides.contextCompactionSignalTokens),
        ...(overrides.contextCompactionSignalTokens
          ? { contextCompactionSignalTokens: overrides.contextCompactionSignalTokens }
          : {}),
      }),
      overrides.callModelInputFilter,
    ].filter(
      (f): f is CallModelInputFilter => Boolean(f),
    ),
  );
  const runOptions: Parameters<typeof run>[2] = {
    stream: true,
    maxTurns: settings.agentMaxModelCallsPerTurn,
    // Built-in per-call guard chain: normalize computer calls, optionally strip
    // provider ids, trim to the input budget on the client-compaction path, and
    // raise the proactive compaction signal. This runs for turn-start replay AND
    // every mid-turn follow-up.
    callModelInputFilter,
  };
  if (client) {
    runOptions.sandbox = {
      client,
      ...(sandboxSessionState ? { sessionState: sandboxSessionState } : {}),
    } as SandboxRunConfig;
  }
  return await runScopedRunner(settings).run(agent, prepared.input, runOptions);
}

function appendSandboxFileDownloadFailureNote(input: PreparedAgentInput, failures: SandboxFileDownloadFailure[]): void {
  const note = sandboxFileDownloadFailureNote(failures);
  if (!note) {
    return;
  }
  if (typeof input.input === "string") {
    input.input = [input.input, "", note].join("\n");
    return;
  }
  if (Array.isArray(input.input)) {
    input.input = [
      ...input.input,
      { type: "message", role: "user", content: note } as AgentInputItem,
    ];
  }
}

/**
 * A per-run `Runner` whose `modelProvider` is built from THIS turn's settings.
 *
 * The standalone `run()` uses a process-global default Runner whose modelProvider
 * is the lazy global default (whatever the last `configureOpenAI` /
 * `setDefaultModelProvider` installed). The worker runs ~100 activities
 * concurrently in one process, so a concurrently-starting turn for a DIFFERENT
 * workspace can overwrite that global between this turn's `configure` and a
 * per-call `getModel()` during the stream — leaving the global router with no
 * codex provider and throwing CodexSubscriptionUnavailableError on a
 * `codex/<slug>` name re-resolution (the SandboxAgent/Modal path drops the Model
 * instance and re-resolves by NAME). Pinning a run-scoped Runner makes the
 * mutable global irrelevant to correctness: each concurrent turn resolves names
 * against its OWN settings (which carry the codex-subscription provider via
 * withCodexProvider for an active workspace, and the registry providers). The
 * Runner inherits the SDK's default config for everything else, identical to the
 * default runner. setDefaultModelProvider remains only as a boot-time fallback.
 */
function runScopedRunner(settings: Settings): Runner {
  return new Runner({ modelProvider: new MultiProviderModelProvider(settings) });
}

export { MaxTurnsExceededError } from "@openai/agents";

/**
 * Detects the agents SDK per-segment turn cap. The cap is a pacing valve, not
 * a session failure: callers should end the segment gracefully (idle) so an
 * active goal's continuation loop -- or a follow-up user message -- resumes
 * the work. When the SDK attached the run state at the moment the cap hit,
 * the serialized form is returned so the resumed turn keeps full context.
 */
export function maxTurnsExceededRunState(error: unknown): { serializedRunState: string | null } | null {
  if (!(error instanceof MaxTurnsExceededError)) {
    return null;
  }
  try {
    return { serializedRunState: error.state ? error.state.toString() : null };
  } catch {
    return { serializedRunState: null };
  }
}

/**
 * Serialized run state attached to any agents SDK error, when present.
 * Provider failures usually surface as raw API errors without state; callers
 * must treat a null here as "resume from the previous snapshot" rather than
 * an error.
 */
export function agentsErrorRunState(error: unknown): string | null {
  if (!(error instanceof AgentsError) || !error.state) {
    return null;
  }
  try {
    return error.state.toString();
  } catch {
    return null;
  }
}

export function withManifestRefreshOnResume(
  client: SandboxClient,
  targetManifest: Manifest | undefined,
  context: Pick<SandboxLifecycleHookContext, "onRuntimeEvent"> = {},
): SandboxClient {
  if (!targetManifest || !client.resume) {
    return client;
  }
  return {
    backendId: client.backendId,
    ...(client.supportsDefaultOptions !== undefined ? { supportsDefaultOptions: client.supportsDefaultOptions } : {}),
    ...(client.create ? { create: async (...args: any[]) => await (client.create as any)(...args) } : {}),
    resume: async (state: SandboxSessionState) => {
      const session = await client.resume!(state);
      await applyMissingManifestEntries(session, targetManifest, context);
      return session;
    },
    ...(client.delete ? { delete: async (state: SandboxSessionState) => await client.delete!(state) } : {}),
    ...(client.serializeSessionState ? { serializeSessionState: async (state: SandboxSessionState, options) => await client.serializeSessionState!(state, options) } : {}),
    ...(client.canPersistOwnedSessionState ? { canPersistOwnedSessionState: async (state: SandboxSessionState) => await client.canPersistOwnedSessionState!(state) } : {}),
    ...(client.canReusePreservedOwnedSession ? { canReusePreservedOwnedSession: async (state: SandboxSessionState) => await client.canReusePreservedOwnedSession!(state) } : {}),
    ...(client.deserializeSessionState ? { deserializeSessionState: async (state: Record<string, unknown>) => await client.deserializeSessionState!(state) } : {}),
  };
}

// OWNED-RESUME manifest refresh. This path runs ONLY for SDK-owned sessions
// (withManifestRefreshOnResume wraps client.resume, which the SDK never calls
// when handed a live provided session — the ownedSandbox branch bypasses this
// entirely). Owned applyManifest MERGES env safely with no guard, and this
// refresh is a FEATURE: it is how a workspace-env edit reaches a long-lived
// owned local/docker box that rarely recycles. The provided-session env pin
// (pinProvidedSessionManifestEnvironment below) — NOT this function — is the
// fix for the SDK's validateNoEnvironmentDelta session-fatal guard. Drift is
// additionally REPORTED here (key names only, never values) so any env
// recompute change stays attributable from the DB alone.
export async function applyMissingManifestEntries(
  session: SandboxSessionLike,
  targetManifest: Manifest,
  context: Pick<SandboxLifecycleHookContext, "onRuntimeEvent"> = {},
): Promise<void> {
  const currentManifestValue = (session as { state?: { manifest?: Manifest | { root?: string; entries?: Record<string, any>; environment?: Record<string, any> } } }).state?.manifest;
  const currentManifest = currentManifestValue ? ensureManifest(currentManifestValue) : undefined;
  const target = ensureManifest(targetManifest);
  if (!currentManifest) {
    if (Object.keys(target.entries).length === 0) {
      return;
    }
    throw new Error("Resumed sandbox session cannot apply new manifest entries because current manifest state is unavailable");
  }
  // Drift detection runs on EVERY resume (even no-op ones): the durable trace
  // that makes an env-recompute regression attributable from the DB instead of
  // from rotated worker logs.
  await reportManifestEnvironmentDrift(currentManifest, target, context);
  if (!session.applyManifest && !session.materializeEntry) {
    if (Object.keys(target.entries).length === 0) {
      return;
    }
    throw new Error("Resumed sandbox session cannot apply new manifest entries because it does not support applyManifest() or materializeEntry()");
  }
  if (Object.keys(target.entries).length === 0) {
    return;
  }
  if (currentManifest.root !== target.root) {
    throw new Error("Cannot apply per-turn resources to a sandbox with a different manifest root");
  }
  const entries: Record<string, any> = {};
  for (const [path, entry] of Object.entries(target.entries)) {
    const existing = (currentManifest.entries as Record<string, unknown>)[path];
    if (existing === undefined) {
      entries[path] = entry;
      continue;
    }
    if (stableJson(existing) !== stableJson(entry)) {
      throw new Error(`Cannot replace existing sandbox manifest entry: ${path}`);
    }
  }
  const environmentChanged = stableJson(currentManifest.environment) !== stableJson(target.environment);
  if (environmentChanged && !session.applyManifest) {
    throw new Error("Resumed sandbox session cannot refresh manifest environment because it does not support applyManifest()");
  }
  if (Object.keys(entries).length === 0 && !environmentChanged) {
    return;
  }
  // Carry path grants through manifest rebuilds: since @openai/agents 0.11.0
  // they gate local source materialization, and run states saved before the
  // upgrade have manifests without grants.
  const extraPathGrants = mergePathGrants(currentManifest.extraPathGrants, target.extraPathGrants);
  const delta = new Manifest({
    root: currentManifest.root,
    entries,
    environment: target.environment,
    ...(extraPathGrants.length ? { extraPathGrants } : {}),
  });
  if (session.applyManifest) {
    await session.applyManifest(delta);
  } else {
    for (const [path, entry] of Object.entries(entries)) {
      await session.materializeEntry!({ path, entry });
    }
  }
  (session as { state?: { manifest?: Manifest } }).state!.manifest = new Manifest({
    root: currentManifest.root,
    environment: environmentChanged ? target.environment : currentManifest.environment,
    entries: {
      ...currentManifest.entries,
      ...entries,
    },
    ...(extraPathGrants.length ? { extraPathGrants } : {}),
  });
}

/**
 * Key-level diff of the live box's baked manifest env vs the freshly recomputed
 * target env. Returns null when identical. Key NAMES only — values are secrets
 * and must never leave this function's comparison.
 */
export function manifestEnvironmentDrift(
  current: Manifest,
  target: Manifest,
): { added: string[]; removed: string[]; changed: string[] } | null {
  const currentEnv = (current.environment ?? {}) as Record<string, unknown>;
  const targetEnv = (target.environment ?? {}) as Record<string, unknown>;
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const key of Object.keys(targetEnv)) {
    if (!(key in currentEnv)) {
      added.push(key);
    } else if (stableJson(currentEnv[key]) !== stableJson(targetEnv[key])) {
      changed.push(key);
    }
  }
  for (const key of Object.keys(currentEnv)) {
    if (!(key in targetEnv)) {
      removed.push(key);
    }
  }
  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    return null;
  }
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}

async function reportManifestEnvironmentDrift(
  current: Manifest,
  target: Manifest,
  context: Pick<SandboxLifecycleHookContext, "onRuntimeEvent">,
): Promise<ReturnType<typeof manifestEnvironmentDrift>> {
  const drift = manifestEnvironmentDrift(current, target);
  if (!drift) {
    return null;
  }
  // Reporting must never break a resume: the drift itself is benign under the
  // env pin (the box keeps running on its baked env); only the SIGNAL matters.
  try {
    await context.onRuntimeEvent?.({ type: "sandbox.env.drift", payload: drift });
  } catch {
    // Swallow: a failed emit must not fail the turn.
  }
  return drift;
}

/**
 * ENV PIN for provided sessions (the ownership-inversion turn path). The SDK
 * validates the FULL target manifest environment against a live provided
 * session's baked env BEFORE reducing to its entry-only delta
 * (validateNoEnvironmentDelta -> session-fatal UserError on ANY difference).
 * So a turn resuming an existing box must declare the box's OWN env,
 * byte-identical — never the fresh recompute. This replaces the agent's
 * defaultManifest environment with the baked one and reports the drift (key
 * names only) instead of letting it kill the session. Fresh env lands at the
 * next cold-create; rotating values ride OFF-manifest (TOKEN-BROKER B1/B2).
 */
export async function pinProvidedSessionManifestEnvironment(
  agent: Agent<any, any>,
  session: SandboxSessionLike,
  context: Pick<SandboxLifecycleHookContext, "onRuntimeEvent"> = {},
): Promise<void> {
  const holder = agent as { defaultManifest?: Manifest };
  const currentManifestValue = (session as { state?: { manifest?: Manifest | { root?: string; entries?: Record<string, any>; environment?: Record<string, any> } } }).state?.manifest;
  if (!holder.defaultManifest || !currentManifestValue) {
    return;
  }
  const current = ensureManifest(currentManifestValue);
  const target = ensureManifest(holder.defaultManifest);
  const drift = await reportManifestEnvironmentDrift(current, target, context);
  if (!drift) {
    return;
  }
  holder.defaultManifest = new Manifest({
    ...(target.root ? { root: target.root } : {}),
    entries: target.entries,
    environment: current.environment,
    ...(target.extraPathGrants?.length ? { extraPathGrants: target.extraPathGrants } : {}),
  });
}

function mergePathGrants(
  current: Manifest["extraPathGrants"] | undefined,
  target: Manifest["extraPathGrants"] | undefined,
): Manifest["extraPathGrants"] {
  const merged = new Map<string, Manifest["extraPathGrants"][number]>();
  for (const grant of [...(current ?? []), ...(target ?? [])]) {
    merged.set(grant.path, grant);
  }
  return [...merged.values()];
}

export function withSandboxFileDownloads(
  client: SandboxClient,
  downloads: SandboxFileDownload[],
  context: Pick<SandboxLifecycleHookContext, "onRuntimeEvent" | "runAs"> = {},
): SandboxClient {
  const normalizedDownloads = normalizeSandboxFileDownloads(downloads);
  if (normalizedDownloads.length === 0) {
    return client;
  }
  const completed = new WeakSet<object>();
  const wrapSession = async <T extends SandboxSessionLike>(session: T): Promise<T> => {
    if (typeof session === "object" && session !== null && !completed.has(session)) {
      await materializeSandboxFileDownloads(session, normalizedDownloads, context);
      completed.add(session);
    }
    return session;
  };
  return {
    backendId: client.backendId,
    ...(client.supportsDefaultOptions !== undefined ? { supportsDefaultOptions: client.supportsDefaultOptions } : {}),
    ...(client.create ? { create: async (...args: any[]) => await wrapSession(await (client.create as any)(...args)) } : {}),
    ...(client.resume ? { resume: async (state: SandboxSessionState) => await wrapSession(await client.resume!(state)) } : {}),
    ...(client.delete ? { delete: async (state: SandboxSessionState) => await client.delete!(state) } : {}),
    ...(client.serializeSessionState ? { serializeSessionState: async (state: SandboxSessionState, options) => await client.serializeSessionState!(state, options) } : {}),
    ...(client.canPersistOwnedSessionState ? { canPersistOwnedSessionState: async (state: SandboxSessionState) => await client.canPersistOwnedSessionState!(state) } : {}),
    ...(client.canReusePreservedOwnedSession ? { canReusePreservedOwnedSession: async (state: SandboxSessionState) => await client.canReusePreservedOwnedSession!(state) } : {}),
    ...(client.deserializeSessionState ? { deserializeSessionState: async (state: Record<string, unknown>) => await client.deserializeSessionState!(state) } : {}),
  };
}

export async function materializeSandboxFileDownloads(
  session: SandboxSessionLike,
  downloads: SandboxFileDownload[],
  context: Pick<SandboxLifecycleHookContext, "onRuntimeEvent" | "runAs"> = {},
): Promise<SandboxFileDownloadMaterializationResult> {
  const normalizedDownloads = normalizeSandboxFileDownloads(downloads);
  if (normalizedDownloads.length === 0) {
    return { failures: [] };
  }
  const failures: SandboxFileDownloadFailure[] = [];
  for (const download of normalizedDownloads) {
    const targetPath = sandboxDownloadTargetPath(download);
    const payload = {
      fileId: download.fileId,
      path: targetPath,
      sizeBytes: download.sizeBytes ?? null,
      expiresAt: download.expiresAt ? new Date(download.expiresAt).toISOString() : null,
    };
    await context.onRuntimeEvent?.({ type: "sandbox.operation.started", payload: { name: "file-resource-download", ...payload } });
    if (!session.exec && !session.execCommand) {
      const failure = sandboxFileDownloadFailure(download, targetPath, "Sandbox file download materialization requires command execution support");
      failures.push(failure);
      await context.onRuntimeEvent?.({
        type: "sandbox.operation.failed",
        payload: {
          name: "file-resource-download",
          ...payload,
          error: failure.reason,
        },
      });
      continue;
    }
    let result: unknown;
    try {
      result = session.exec
        ? await session.exec({
          cmd: sandboxFileDownloadCommand(download, targetPath),
          workdir: "/workspace",
          ...(context.runAs ? { runAs: context.runAs } : {}),
          yieldTimeMs: SANDBOX_LIFECYCLE_COMMAND_TIMEOUT_MS,
          maxOutputTokens: 20_000,
        })
        : await session.execCommand!({
          cmd: sandboxFileDownloadCommand(download, targetPath),
          workdir: "/workspace",
          ...(context.runAs ? { runAs: context.runAs } : {}),
          yieldTimeMs: SANDBOX_LIFECYCLE_COMMAND_TIMEOUT_MS,
          maxOutputTokens: 20_000,
        });
      assertSandboxCommandSucceeded(result, `Sandbox file resource download ${download.fileId}`);
      await context.onRuntimeEvent?.({ type: "sandbox.operation.completed", payload: { name: "file-resource-download", ...payload } });
    } catch (error) {
      const failure = sandboxFileDownloadFailure(download, targetPath, error, result);
      failures.push(failure);
      await context.onRuntimeEvent?.({
        type: "sandbox.operation.failed",
        payload: {
          name: "file-resource-download",
          ...payload,
          error: failure.reason,
          ...(failure.exitCode !== undefined ? { exitCode: failure.exitCode } : {}),
          ...(failure.output ? { output: failure.output } : {}),
        },
      });
    }
  }
  return { failures };
}

function sandboxFileDownloadFailure(
  download: SandboxFileDownload,
  targetPath: string,
  error: unknown,
  result?: unknown,
): SandboxFileDownloadFailure {
  const exitCode = sandboxCommandExitCode(result);
  const output = sandboxCommandOutput(result);
  return {
    fileId: download.fileId,
    filename: download.filename,
    path: targetPath,
    reason: error instanceof Error ? error.message : String(error),
    ...(exitCode !== null ? { exitCode } : {}),
    ...(output ? { output } : {}),
  };
}

export function sandboxFileDownloadFailureNote(failures: SandboxFileDownloadFailure[]): string {
  if (failures.length === 0) {
    return "";
  }
  return [
    "The following attached files could not be loaded into the sandbox and are unavailable this turn:",
    ...failures.map((failure) => `- ${failure.filename} (${failure.reason})`),
    "Continue without them or tell the user.",
  ].join("\n");
}

export function sandboxFileDownloadsForAgent(agent: unknown): SandboxFileDownload[] {
  return typeof agent === "object" && agent !== null
    ? [...(agentFileDownloads.get(agent) ?? [])]
    : [];
}

function ensureManifest(manifest: Manifest | { root?: string; entries?: Record<string, any>; environment?: Record<string, any>; extraPathGrants?: any[] }): Manifest {
  if (manifest instanceof Manifest && typeof manifest.mountTargetsForMaterialization === "function") {
    return manifest;
  }
  return new Manifest({
    ...(manifest.root ? { root: manifest.root } : {}),
    entries: manifest.entries ?? {},
    environment: manifest.environment ?? {},
    ...(manifest.extraPathGrants?.length ? { extraPathGrants: manifest.extraPathGrants } : {}),
  });
}

/** Coerce the various binary shapes a tool-output image `data` field can take into
 *  a Uint8Array. Handles a live `Uint8Array`, a plain number[] , and the
 *  object-of-numbers (`{"0":137,"1":80,…}`) that a `Uint8Array` degrades into after
 *  a JSON round-trip — the exact 10x-bloat shape this normalizer exists to kill. */
function toImageBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (Array.isArray(data)) {
    return data.every((n) => typeof n === "number") ? Uint8Array.from(data as number[]) : null;
  }
  if (data && typeof data === "object") {
    const values = Object.values(data as Record<string, unknown>);
    if (values.length > 0 && values.every((n) => typeof n === "number")) {
      return Uint8Array.from(values as number[]);
    }
  }
  return null;
}

/** Compact a structured image tool output — the SDK's `{type:'image', image:{data,mediaType}}`
 *  shape (produced by the codex-path `computer_screenshot` function tool) OR the already-
 *  normalized protocol `{type:'input_image', image:'data:…'}` item — into a `data:<mt>;base64,…`
 *  string. Returns null when `value` is not an image output. */
function structuredImageToDataUrl(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const v = value as { type?: unknown; image?: unknown };
  if (v.type === "input_image") {
    // Protocol item: `image` is already a `data:…` (or plain URL) string.
    return typeof v.image === "string" && v.image.length > 0 ? v.image : null;
  }
  if (v.type !== "image" || !v.image || typeof v.image !== "object") {
    return null;
  }
  const image = v.image as { data?: unknown; mediaType?: unknown; url?: unknown };
  if (typeof image.url === "string" && image.url.length > 0) {
    return image.url;
  }
  const mediaType = typeof image.mediaType === "string" && image.mediaType.length > 0 ? image.mediaType : "image/png";
  if (typeof image.data === "string") {
    return image.data.startsWith("data:") ? image.data : `data:${mediaType};base64,${image.data}`;
  }
  const bytes = toImageBytes(image.data);
  return bytes ? `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}` : null;
}

/**
 * Compact a tool-call output for the `agent.toolCall.output` SESSION EVENT so it
 * never carries a raw binary payload. The codex-path `computer_screenshot` function
 * tool returns a structured `{type:'image', image:{data: Uint8Array, mediaType}}`;
 * captured verbatim its `Uint8Array` JSON-serializes as an object-of-numbers (~12.7MB
 * per screenshot in session_events — ~10x the base64 form). This mirrors the desktop
 * screenshot to the SAME compact `data:<mediaType>;base64,…` STRING the HOSTED
 * `computer_call` event already carries (agents-core sets its output to that data-URL),
 * so both computer-use transports emit one representation. The full data-URL is kept
 * (not truncated) because the web timeline RENDERS the screenshot from this event
 * payload — packages/react/src/timeline/tool-renderers.tsx ComputerCallRenderer
 * (`out.startsWith("data:image")` → <ScreenshotFigure src={out}/>) and ViewImageRenderer.
 * Non-image outputs (text strings, MCP `{isError,content}` objects, hosted computer_call
 * data-URL strings) pass through unchanged.
 */
export function normalizeToolOutputForEvent(output: unknown): unknown {
  const single = structuredImageToDataUrl(output);
  if (single !== null) {
    return single;
  }
  if (Array.isArray(output)) {
    const normalized = output.map((el) => structuredImageToDataUrl(el) ?? el);
    // A lone image content item unwraps to the bare data-URL string the timeline
    // image renderers expect; a mixed/multi array keeps its (now-compact) shape.
    if (normalized.length === 1 && typeof normalized[0] === "string") {
      return normalized[0];
    }
    return normalized;
  }
  return output;
}

export function normalizeSdkEvent(event: RunStreamEvent): NormalizedRuntimeEvent[] {
  const out: NormalizedRuntimeEvent[] = [];
  if (event.type === "raw_model_stream_event") {
    const data = (event as any).data;
    if (data?.type === "output_text_delta" && typeof data.delta === "string") {
      out.push({ type: "agent.message.delta", payload: { text: data.delta } });
      return out;
    }
    if (data?.type === "response_done") {
      const responseUsage = modelResponseUsageFromSdkEvent(event);
      if (responseUsage) {
        out.push({
          type: "agent.model.usage",
          payload: {
            responseId: responseUsage.responseId ?? null,
            ...modelCallUsageTelemetry(responseUsage.usage),
          },
        });
      }
      return out;
    }
  }
  if (isOpenAIResponsesRawModelStreamEvent(event)) {
    const raw = (event as any).data?.event;
    if (raw?.type === "response.reasoning_summary_text.delta" && typeof raw.delta === "string") {
      out.push({ type: "agent.reasoning.delta", payload: { text: raw.delta } });
    }
    if (raw?.type === "response.completed") {
      const responseUsage = modelResponseUsageFromSdkEvent(event);
      if (responseUsage) {
        out.push({
          type: "agent.model.usage",
          payload: {
            responseId: responseUsage.responseId ?? null,
            ...modelCallUsageTelemetry(responseUsage.usage),
          },
        });
      }
    }
    return out;
  }
  if (event.type === "agent_updated_stream_event") {
    out.push({ type: "agent.updated", payload: { agent: (event as any).agent?.name ?? null } });
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
    out.push({
      type: "agent.toolCall.created",
      payload: {
        id: raw.callId ?? raw.id ?? item.id ?? null,
        name: raw.name ?? raw.type ?? "tool",
        arguments: raw.arguments ?? raw.input ?? null,
        raw,
      },
    });
  } else if (item.type === "tool_call_output_item") {
    out.push({
      type: "agent.toolCall.output",
      payload: {
        id: item.rawItem?.callId ?? item.id ?? null,
        // Compact any structured/binary image output to a data-URL string so a
        // screenshot never bloats session_events ~10x as an object-of-numbers.
        output: normalizeToolOutputForEvent(item.output),
      },
    });
  } else if (item.type === "tool_search_call_item") {
    // Progressive connector disclosure: surface the model's tool search as a
    // regular tool-call event so the session stream shows the step (parity with
    // the Codex CLI, which renders its searches). Arguments may be an object
    // (the live wire shape) or a string.
    const raw = item.rawItem ?? {};
    out.push({
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
      ? raw.tools.map((tool: { name?: unknown }) => (typeof tool?.name === "string" ? tool.name : "")).filter(Boolean)
      : [];
    out.push({
      type: "agent.toolCall.output",
      payload: {
        id: raw.call_id ?? raw.callId ?? item.id ?? null,
        output: { type: "text", text: disclosed.length > 0 ? `Disclosed tools: ${disclosed.join(", ")}` : "No matching tools found." },
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
  const response = modelResponseFromSdkEvent(event);
  const usage = usageFromResponse(response);
  if (!usage) {
    return null;
  }
  const responseId = typeof response?.id === "string"
    ? response.id
    : typeof response?.responseId === "string"
      ? response.responseId
      : undefined;
  return {
    ...(responseId ? { responseId } : {}),
    usage,
  };
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

function usageFromResponse(response: any): ModelResponseUsage["usage"] | null {
  const raw = response?.usage;
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const usage = {
    ...numberProp(raw, "inputTokens", "inputTokens", "input_tokens"),
    ...numberProp(raw, "outputTokens", "outputTokens", "output_tokens"),
    ...numberProp(raw, "totalTokens", "totalTokens", "total_tokens"),
    ...inputTokenDetailsProp(raw),
    ...outputTokenDetailsProp(raw),
  };
  return Object.keys(usage).length > 0 ? usage : null;
}

function numberProp(raw: Record<string, unknown>, outputKey: "inputTokens" | "outputTokens" | "totalTokens", camel: string, snake: string): Partial<ModelResponseUsage["usage"]> {
  const value = raw[camel] ?? raw[snake];
  return typeof value === "number" && Number.isFinite(value) ? { [outputKey]: value } : {};
}

function inputTokenDetailsProp(raw: Record<string, unknown>): Partial<ModelResponseUsage["usage"]> {
  const details = raw.inputTokensDetails ?? raw.input_tokens_details;
  if (!details || typeof details !== "object") {
    return {};
  }
  return { inputTokensDetails: details as Record<string, number> | Array<Record<string, number>> };
}

function outputTokenDetailsProp(raw: Record<string, unknown>): Partial<ModelResponseUsage["usage"]> {
  const details = raw.outputTokensDetails ?? raw.output_tokens_details;
  if (!details || typeof details !== "object") {
    return {};
  }
  return { outputTokensDetails: details as Record<string, number> | Array<Record<string, number>> };
}

export function serializeApprovals(interruptions: unknown[]): unknown[] {
  return interruptions.map((item: any) => {
    if (typeof item?.toJSON === "function") {
      return item.toJSON();
    }
    return {
      id: approvalIdentifier(item),
      name: item?.name ?? item?.rawItem?.name ?? "tool",
      arguments: item?.arguments ?? item?.rawItem?.arguments ?? null,
      raw: item,
    };
  });
}

export function buildManifest(
  settings: Settings,
  resources: ResourceRef[],
  environment = collectSandboxEnvironment(settings),
  fileResourceDownloads: SandboxFileDownload[] = [],
): Manifest {
  const entries: Record<string, any> = {};
  const downloadsByFileId = new Map(normalizeSandboxFileDownloads(fileResourceDownloads).map((download) => [download.fileId, download]));
  for (const resource of resources) {
    if (resource.kind === "repository") {
      const url = new URL(resource.uri);
      const host = url.hostname.toLowerCase();
      const repo = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
      const mountPath = normalizeManifestPath(resource.mountPath ?? `repos/${repo}`);
      if (repositoryUsesSandboxClone(settings, resource)) {
        entries[mountPath] = dir();
        continue;
      }
      entries[mountPath] = gitRepo({
        host,
        repo,
        ref: resource.ref,
        ...(resource.subpath ? { subpath: normalizeManifestPath(resource.subpath) } : {}),
      });
      continue;
    }
    if (resource.kind === "file") {
      const mountPath = normalizeManifestPath(resource.mountPath ?? `files/${resource.fileId}`);
      const download = downloadsByFileId.get(resource.fileId);
      entries[mountPath] = download
        ? sandboxDownloadDirectory(download, mountPath)
        : objectStorageFileMount(settings, `files/${resource.fileId}/original`);
    }
  }
  // No extraPathGrants here: remote sandbox clients (Modal) reject manifests
  // that carry them at create/apply time, which broke every Modal session.
  // The lazy bundled-skills source no longer needs a grant because
  // bundledSkillsDir() stages the skills inside the process working directory
  // whenever the packaged copy lives outside it.
  return new Manifest({
    root: "/workspace",
    entries,
    environment,
  });
}

function sandboxDownloadDirectory(download: SandboxFileDownload, mountPath: string): any {
  if (download.mountPath !== mountPath) {
    throw new Error(`File download materialization path mismatch for ${download.fileId}: expected ${mountPath}, got ${download.mountPath}`);
  }
  assertSafeSandboxFilename(download.filename, download.fileId);
  if (download.content) {
    return dir({
      children: {
        [download.filename]: file({ content: download.content }),
      },
    });
  }
  return dir();
}

function objectStorageFileMount(settings: Settings, prefix: string): any {
  // Descriptor-driven: a nativeBucketMount backend (modal) mounts via the
  // provider's own bucket-mount strategy and cannot mount Azure Blob entries —
  // it needs pre-signed downloads instead. Reading the descriptor (not a
  // hard-coded backend name) keeps this honest as providers are added.
  const nativeBucketMount = CAPABILITY_DESCRIPTORS[settings.sandboxBackend].nativeBucketMount;
  if (settings.objectStorageBackend === "azure-blob") {
    if (nativeBucketMount) {
      throw new Error("Modal sandbox Azure Blob file resources require pre-signed download materialization because the current OpenAI Agents SDK Modal client does not support Azure Blob mount entries.");
    }
    const config = azureBlobMountConfig(settings);
    return azureBlobMount({
      container: config.container,
      prefix,
      accountName: config.accountName,
      accountKey: config.accountKey,
      endpointUrl: config.endpointUrl,
      readOnly: true,
      mountStrategy: inContainerMountStrategy({ pattern: { type: "rclone", mode: "fuse" } }),
    });
  }
  if (settings.objectStorageBackend === "aws-s3" || settings.objectStorageBackend === "gcs") {
    throw new Error(`${settings.objectStorageBackend} file resources require pre-signed download materialization`);
  }
  const config = s3CompatibleMountConfig(settings);
  return s3Mount({
    bucket: config.bucket,
    prefix,
    endpointUrl: config.endpointUrl,
    region: config.region,
    s3Provider: config.s3Provider,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    readOnly: true,
    mountStrategy: nativeBucketMount
      ? new ModalCloudBucketMountStrategy()
      : inContainerMountStrategy({ pattern: { type: "rclone", mode: "fuse" } }),
  });
}

function s3CompatibleMountConfig(settings: Settings): {
  bucket: string;
  endpointUrl: string;
  region: string;
  s3Provider: string;
  accessKeyId: string;
  secretAccessKey: string;
} {
  const endpointUrl = settings.objectStorageSandboxEndpoint ?? settings.objectStorageEndpoint;
  if (!endpointUrl || !settings.objectStorageAccessKeyId || !settings.objectStorageSecretAccessKey) {
    throw new Error("File resources require configured S3-compatible object storage");
  }
  return {
    bucket: settings.objectStorageBucket,
    endpointUrl,
    region: settings.objectStorageRegion,
    s3Provider: settings.objectStorageS3Provider,
    accessKeyId: settings.objectStorageAccessKeyId,
    secretAccessKey: settings.objectStorageSecretAccessKey,
  };
}

function azureBlobMountConfig(settings: Settings): {
  container: string;
  accountName: string;
  accountKey: string;
  endpointUrl?: string;
} {
  const parsed = settings.objectStorageAzureConnectionString
    ? parseAzureConnectionString(settings.objectStorageAzureConnectionString)
    : {};
  const accountName = settings.objectStorageAzureAccountName ?? parsed.AccountName;
  const accountKey = settings.objectStorageAzureAccountKey ?? parsed.AccountKey;
  if (!accountName || !accountKey) {
    throw new Error("File resources require Azure Blob account name and account key");
  }
  const endpointUrl = azureBlobManifestEndpoint(settings.objectStorageAzureEndpoint ?? parsed.BlobEndpoint, accountName);
  return {
    container: settings.objectStorageBucket,
    accountName,
    accountKey,
    ...(endpointUrl ? { endpointUrl } : {}),
  };
}

function azureBlobManifestEndpoint(endpoint: string | undefined, accountName: string): string | undefined {
  if (!endpoint) {
    return undefined;
  }
  const normalized = endpoint.replace(/\/+$/, "");
  const standardAccountEndpoint = `https://${accountName}.blob.core.windows.net`;
  return normalized === standardAccountEndpoint ? undefined : normalized;
}

function parseAzureConnectionString(value: string): Record<string, string> {
  return Object.fromEntries(value.split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf("=");
      return index === -1 ? [part, ""] : [part.slice(0, index), part.slice(index + 1)];
    }));
}

function normalizeManifestPath(path: string): string {
  const normalized = path.replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.includes("..")) {
    throw new Error(`Invalid sandbox resource path: ${path}`);
  }
  return normalized;
}

function normalizeSandboxFileDownloads(downloads: SandboxFileDownload[]): SandboxFileDownload[] {
  return downloads.map((download) => {
    const mountPath = normalizeManifestPath(download.mountPath);
    assertSafeSandboxFilename(download.filename, download.fileId);
    if (!download.content && !download.url?.trim()) {
      throw new Error(`File download materialization requires content or a URL for ${download.fileId}`);
    }
    return {
      ...download,
      mountPath,
    };
  });
}

function assertSafeSandboxFilename(filename: string, fileId: string): void {
  if (!filename || filename.includes("/") || filename.includes("\\") || filename === "." || filename === ".." || filename.includes("..")) {
    throw new Error(`Invalid sandbox file name for ${fileId}: ${filename}`);
  }
}

function sandboxDownloadTargetPath(download: SandboxFileDownload): string {
  return posixPath.join("/workspace", download.mountPath, download.filename);
}

function sandboxFileDownloadCommand(download: SandboxFileDownload, targetPath: string): string {
  if (!download.url) {
    throw new Error(`File download materialization URL is empty for ${download.fileId}`);
  }
  const targetDir = posixPath.dirname(targetPath);
  const tmpPath = `${targetPath}.opengeni-download-$$`;
  return [
    "set -eu",
    `mkdir -p -- ${shellQuote(targetDir)}`,
    `if [ ! -f ${shellQuote(targetPath)} ]; then`,
    `  tmp=${shellQuote(tmpPath)}`,
    "  cleanup() { rm -f -- \"$tmp\"; }",
    "  trap cleanup EXIT",
    `  curl --fail --location --silent --show-error --retry 3 --retry-delay 1 --output "$tmp" ${shellQuote(download.url)}`,
    `  mv -- "$tmp" ${shellQuote(targetPath)}`,
    "  trap - EXIT",
    "fi",
    `chmod a-w -- ${shellQuote(targetPath)} 2>/dev/null || true`,
  ].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function restoredSandboxSessionState(state: RunState<any, any>, client: unknown): Promise<SandboxSessionState | undefined> {
  if (!client) {
    return undefined;
  }
  const sandboxState = (state as any)._sandbox;
  const entry = sandboxState?.sessionsByAgent?.[sandboxState.currentAgentKey]
    ?? (sandboxState?.currentAgentKey && sandboxState?.sessionState
      ? {
        backendId: sandboxState.backendId,
        currentAgentKey: sandboxState.currentAgentKey,
        currentAgentName: sandboxState.currentAgentName,
        sessionState: sandboxState.sessionState,
      }
      : undefined);
  if (!entry) {
    return undefined;
  }
  if ((client as SandboxClient).backendId !== entry.backendId) {
    throw new Error("RunState sandbox backend does not match the configured sandbox client");
  }
  return await deserializeSandboxSessionStateEnvelope(client as SandboxClient, entry.sessionState);
}

// sandboxStateEntryFromRunState + restoredSandboxSessionStateFromEntry +
// deserializeSandboxSessionStateEnvelope moved to the agent-loop-free leaf
// ./sandbox; re-exported via `export * from "./sandbox"`. The private
// restoredSandboxSessionState above (which takes an agent-loop RunState) calls
// the moved deserializeSandboxSessionStateEnvelope, imported from ./sandbox.

export type SandboxLifecycleHookPhase = "beforeAgentStart";

export type SandboxLifecycleHookContext = {
  environment: Record<string, string>;
  onRuntimeEvent?: (event: NormalizedRuntimeEvent) => Promise<void> | void;
  runAs?: string;
  // TOKEN-BROKER (B1): the run-scoped GitHub token to seed into the box's token
  // FILE before the repository clone runs. Threaded OFF-MANIFEST — it rides ONLY
  // the clone exec's per-call env (OPENGENI_GIT_TOKEN_SEED), NEVER the box/agent
  // manifest env (validateNoEnvironmentDelta must never see a rotating value).
  gitTokenSeed?: string;
  toolspaceTokenSeed?: string;
};

export type SandboxLifecycleHook = {
  id: string;
  phase: SandboxLifecycleHookPhase;
  shouldRun?: (context: SandboxLifecycleHookContext) => boolean;
  run: (session: SandboxSessionLike, context: SandboxLifecycleHookContext) => Promise<void>;
};

const builtInSandboxLifecycleHooks: Record<string, SandboxLifecycleHook> = {
  "azure-cli-login": {
    id: "azure-cli-login",
    phase: "beforeAgentStart",
    shouldRun: ({ environment }) => hasAzureServicePrincipal(environment),
    run: runAzureCliLoginHook,
  },
};

export function sandboxLifecycleHooksForIds(ids: string[]): SandboxLifecycleHook[] {
  return ids.map((id) => {
    const hook = builtInSandboxLifecycleHooks[id];
    if (!hook) {
      throw new Error(`Unknown sandbox lifecycle hook ${id}`);
    }
    return hook;
  });
}

function applicableBeforeAgentStartHooks(
  hooks: SandboxLifecycleHook[],
  context: SandboxLifecycleHookContext,
): SandboxLifecycleHook[] {
  return hooks.filter((hook) => hook.phase === "beforeAgentStart" && (hook.shouldRun?.(context) ?? true));
}

/**
 * Run the beforeAgentStart lifecycle hooks directly against an already-live box.
 *
 * The create/resume decoration (withSandboxLifecycleHooks) is structurally blind to
 * the PROVIDED-session path: when runStream hands the SDK a live `session`
 * (runOptions.sandbox.session — the lease-owned box resolved by the turn activity),
 * SandboxRuntimeManager uses it as-is and never calls client.create/resume, so a
 * wrapper around those methods never fires. Callers on that path invoke this
 * before starting the run so the box still gets its beforeAgentStart preparation
 * (repository clone + B1 askpass/token-file seed, azure-cli-login).
 */
export async function runBeforeAgentStartHooks(
  session: SandboxSessionLike,
  hooks: SandboxLifecycleHook[],
  context: SandboxLifecycleHookContext,
): Promise<void> {
  for (const hook of applicableBeforeAgentStartHooks(hooks, context)) {
    await hook.run(session, context);
  }
}

export function withSandboxLifecycleHooks(
  client: SandboxClient,
  hooks: SandboxLifecycleHook[],
  context: SandboxLifecycleHookContext,
): SandboxClient {
  const beforeAgentStartHooks = applicableBeforeAgentStartHooks(hooks, context);
  if (beforeAgentStartHooks.length === 0) {
    return client;
  }
  const seen = new WeakSet<object>();
  const wrapSession = async <T extends SandboxSessionLike>(session: T): Promise<T> => {
    if (typeof session === "object" && session !== null && !seen.has(session)) {
      for (const hook of beforeAgentStartHooks) {
        await hook.run(session, context);
      }
      seen.add(session);
    }
    return session;
  };
  const wrapped: SandboxClient = {
    backendId: client.backendId,
    ...(client.supportsDefaultOptions !== undefined ? { supportsDefaultOptions: client.supportsDefaultOptions } : {}),
    ...(client.create ? { create: async (...args: any[]) => await wrapSession(await (client.create as any)(...args)) } : {}),
    ...(client.resume ? { resume: async (state: SandboxSessionState) => await wrapSession(await client.resume!(state)) } : {}),
    ...(client.delete ? { delete: async (state: SandboxSessionState) => await client.delete!(state) } : {}),
    ...(client.serializeSessionState ? { serializeSessionState: async (state: SandboxSessionState, options) => await client.serializeSessionState!(state, options) } : {}),
    ...(client.canPersistOwnedSessionState ? { canPersistOwnedSessionState: async (state: SandboxSessionState) => await client.canPersistOwnedSessionState!(state) } : {}),
    ...(client.canReusePreservedOwnedSession ? { canReusePreservedOwnedSession: async (state: SandboxSessionState) => await client.canReusePreservedOwnedSession!(state) } : {}),
    ...(client.deserializeSessionState ? { deserializeSessionState: async (state: Record<string, unknown>) => await client.deserializeSessionState!(state) } : {}),
  };
  return wrapped;
}

function sandboxRepositoryCloneHooksForAgent(agent: Agent<any, any>): SandboxLifecycleHook[] {
  return agentRepositoryCloneHooks.get(agent) ?? [];
}

// TOKEN-BROKER (B1): the per-turn git token seed stashed for this agent (undefined
// when no repo is attached / on the selfhosted path). Read into the clone hook
// context at runStream so the token is seeded off-manifest.
function gitTokenSeedForAgent(agent: Agent<any, any>): string | undefined {
  return agentGitTokenSeed.get(agent);
}

function toolspaceTokenSeedForAgent(agent: Agent<any, any>): string | undefined {
  return agentToolspaceTokenSeed.get(agent);
}

function sandboxToolspaceTokenHooksForAgent(agent: Agent<any, any>): SandboxLifecycleHook[] {
  return toolspaceTokenSeedForAgent(agent)
    ? [{
        id: "toolspace-token",
        phase: "beforeAgentStart",
        run: runToolspaceTokenSeedHook,
      }]
    : [];
}

function sandboxRepositoryCloneHooks(
  settings: Settings,
  resources: ResourceRef[],
  activeSandboxBackend: Settings["sandboxBackend"] = settings.sandboxBackend,
): SandboxLifecycleHook[] {
  const repositories = resources.filter((resource): resource is Extract<ResourceRef, { kind: "repository" }> => (
    resource.kind === "repository" && repositoryUsesSandboxClone(settings, resource, activeSandboxBackend)
  ));
  if (repositories.length === 0) {
    return [];
  }
  return [{
    id: "repository-clone",
    phase: "beforeAgentStart",
    run: async (session, context) => {
      await runRepositoryCloneHook(session, repositories, context);
    },
  }];
}

/**
 * Whether the platform should seed a repository resource by `git clone` inside
 * the sandbox before the agent starts.
 *
 * SAFETY GATE (selfhosted/bring-your-own machine): the clone hook writes into
 * `posixPath.join("/workspace", mountPath)`, which a selfhosted agent rewrites
 * to a path under its REAL launch directory — so a platform-initiated clone
 * lands on the user's actual disk. A connected machine already owns its
 * filesystem; the platform must NEVER clone onto it. We therefore key the
 * decision off the EFFECTIVE/active backend, not just the session's HOME backend
 * (`settings.sandboxBackend`): a session can run on the cloud default while its
 * active sandbox has been swapped to a connected machine (active_sandbox_id → a
 * selfhosted lease), in which case the agent actually executes on the user's
 * machine even though the home backend is e.g. "modal". `activeSandboxBackend`
 * defaults to the home backend, so a session whose HOME backend is "selfhosted"
 * is gated with no caller change, and every cloud path is byte-for-byte
 * unchanged.
 */
export function repositoryUsesSandboxClone(
  settings: Settings,
  resource: Extract<ResourceRef, { kind: "repository" }>,
  activeSandboxBackend: Settings["sandboxBackend"] = settings.sandboxBackend,
): boolean {
  if (activeSandboxBackend === "selfhosted") {
    return false;
  }
  return settings.sandboxBackend === "modal" || Boolean(resource.githubInstallationId && resource.githubRepositoryId);
}

export function repositoryCloneCommand(resources: Extract<ResourceRef, { kind: "repository" }>[]): string {
  const commands = [
    "set -eu",
    "export HOME=\"${HOME:-/workspace}\"",
    "export GIT_TERMINAL_PROMPT=\"${GIT_TERMINAL_PROMPT:-0}\"",
    // TOKEN-BROKER (B1/B2): seed the run-scoped GitHub token into the STABLE token FILE
    // AND provision the git-askpass helper into the box AT SETUP (runtime) BEFORE any
    // clone runs, so GIT_ASKPASS points at a per-box, user-writable script that reads
    // that file for the fetch below. Provisioning the askpass here (rather than relying
    // on a baked image script at /usr/local/bin/opengeni-git-askpass) removes the
    // image-rebuild rollout gate: the askpass is correct on ANY box image, including
    // pre-existing warm boxes on their next turn's clone hook, and no product image has
    // to carry it. The seed rides the per-exec env (OPENGENI_GIT_TOKEN_SEED) — NEVER the
    // box/agent manifest (validateNoEnvironmentDelta must not see a rotating value), so
    // this whole block is a no-op when the seed is absent (e.g. the selfhosted path,
    // which uses its own git creds). The token file lives at $OPENGENI_GIT_TOKEN_FILE
    // (stable, from the shared base) with a $HOME/.opengeni/git-token fallback.
    // $GIT_ASKPASS is on the box manifest env (set by
    // sandboxEnvironmentForRun to $HOME/.opengeni/askpass), so it is available to this
    // exec; the askpass script we write is byte-identical to docker/opengeni-git-askpass
    // and is written via a QUOTED heredoc (<<'ASKPASS_EOF') so NOTHING inside it expands
    // ($1, $HOME, ${OPENGENI_GIT_TOKEN_FILE:-...}, and the literal \n in printf all land
    // verbatim), then chmod 0755 so git can exec it.
    //
    // ATOMIC REWRITE: this block now re-runs at the start of EVERY turn on a warm box
    // that other turn holders may be actively using — an in-flight `git fetch` from a
    // concurrent turn can invoke the askpass (which cats the token file) at any moment.
    // Both files are therefore written to a pid-suffixed temp under umask 077 and
    // renamed into place: rename is atomic, concurrent readers keep the old inode, and
    // the token is never observable world-readable (no post-hoc chmod window).
    "if [ -n \"${OPENGENI_GIT_TOKEN_SEED:-}\" ]; then",
    "  seed_umask=\"$(umask)\"",
    "  umask 077",
    "  git_token_file=\"${OPENGENI_GIT_TOKEN_FILE:-$HOME/.opengeni/git-token}\"",
    "  mkdir -p \"$(dirname \"$git_token_file\")\"",
    "  printf '%s' \"$OPENGENI_GIT_TOKEN_SEED\" > \"$git_token_file.tmp.$$\"",
    "  mv -f \"$git_token_file.tmp.$$\" \"$git_token_file\"",
    "  git_askpass=\"${GIT_ASKPASS:-$HOME/.opengeni/askpass}\"",
    "  mkdir -p \"$(dirname \"$git_askpass\")\"",
    "  cat > \"$git_askpass.tmp.$$\" <<'ASKPASS_EOF'",
    "#!/usr/bin/env sh",
    "case \"$1\" in",
    "  *Username*) printf '%s\\n' \"x-access-token\" ;;",
    "  *Password*) cat \"${OPENGENI_GIT_TOKEN_FILE:-$HOME/.opengeni/git-token}\" 2>/dev/null || printf '\\n' ;;",
    "  *) printf '\\n' ;;",
    "esac",
    "ASKPASS_EOF",
    "  chmod 0755 \"$git_askpass.tmp.$$\"",
    "  mv -f \"$git_askpass.tmp.$$\" \"$git_askpass\"",
    "  umask \"$seed_umask\"",
    "fi",
    "ensure_git() {",
    "  if command -v git >/dev/null 2>&1; then",
    "    return 0",
    "  fi",
    "  if command -v apt-get >/dev/null 2>&1; then",
    "    export DEBIAN_FRONTEND=noninteractive",
    "    apt-get update >/dev/null",
    "    apt-get install -y --no-install-recommends ca-certificates git >/dev/null",
    "    rm -rf /var/lib/apt/lists/*",
    "    command -v git >/dev/null 2>&1 && return 0",
    "  fi",
    "  echo \"git is not installed in the sandbox and could not be bootstrapped\" >&2",
    "  exit 127",
    "}",
    "ensure_git",
    "clone_repository() {",
    "  target=\"$1\"",
    "  uri=\"$2\"",
    "  ref=\"$3\"",
    "  subpath=\"$4\"",
    "  if [ -e \"$target\" ] && { [ -f \"$target\" ] || [ -n \"$(find \"$target\" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)\" ]; }; then",
    // This hook re-runs every turn on a long-lived box, so \"non-empty\" alone is not
    // proof of a completed materialization: an interrupted clone (worker crash /
    // lifecycle timeout mid-mv/cp) leaves a partial tree that would otherwise pass
    // this check forever. A full-repo target must actually BE a work tree to be
    // skipped; a partial one is wiped and rebuilt (nothing legitimate writes under
    // the mount path before the repo exists). Subpath extracts are not git repos —
    // for those the plain non-empty check stands (no stronger signal available).
    "    if [ -n \"$subpath\" ] || git -C \"$target\" rev-parse --is-inside-work-tree >/dev/null 2>&1; then",
    "      echo \"Repository resource already present at $target\"",
    "      return 0",
    "    fi",
    "    echo \"Re-materializing partial repository resource at $target\" >&2",
    "    find \"$target\" -mindepth 1 -maxdepth 1 -exec rm -rf {} +",
    "  fi",
    "  mkdir -p \"$(dirname \"$target\")\"",
    "  tmp=\"${target}.tmp.$$\"",
    "  rm -rf \"$tmp\"",
    // Fetch failures must not leak the pid-suffixed tmp clone beside the mount
    // (set -eu would exit before any cleanup).
    "  if ! { git init \"$tmp\" >/dev/null && git -C \"$tmp\" remote add origin \"$uri\" && git -C \"$tmp\" fetch --depth 1 --no-tags --filter=blob:none origin \"$ref\" && git -C \"$tmp\" checkout --detach FETCH_HEAD >/dev/null; }; then",
    "    rm -rf \"$tmp\"",
    "    echo \"Repository resource fetch failed for $target\" >&2",
    "    exit 1",
    "  fi",
    "  if [ -n \"$subpath\" ]; then",
    "    if [ ! -e \"$tmp/$subpath\" ]; then",
    "      echo \"Repository subpath not found: $subpath\" >&2",
    "      rm -rf \"$tmp\"",
    "      exit 1",
    "    fi",
    "    if [ -d \"$tmp/$subpath\" ]; then",
    "      mkdir -p \"$target\"",
    "      cp -a \"$tmp/$subpath/.\" \"$target/\"",
    "    else",
    "      rmdir \"$target\" 2>/dev/null || true",
    "      cp -a \"$tmp/$subpath\" \"$target\"",
    "    fi",
    "    rm -rf \"$tmp\"",
    "  else",
    "    rmdir \"$target\" 2>/dev/null || true",
    // Two concurrent turn holders can race this install: without the existence
    // re-check the loser's un-flagged `mv` would nest its tmp clone INSIDE the
    // winner's tree as <name>.tmp.<pid>. If the winner produced a valid work tree,
    // accept it; a non-empty non-repo survivor here is a mount point the manifest
    // re-filled — install into it by content copy instead of rename.
    "    if [ -e \"$target\" ]; then",
    "      if git -C \"$target\" rev-parse --is-inside-work-tree >/dev/null 2>&1; then",
    "        rm -rf \"$tmp\"",
    "        echo \"Repository resource already present at $target\"",
    "        return 0",
    "      fi",
    "      cp -a \"$tmp/.\" \"$target/\"",
    "      rm -rf \"$tmp\"",
    "    else",
    "      mv \"$tmp\" \"$target\"",
    "    fi",
    "    git -C \"$target\" rev-parse --is-inside-work-tree >/dev/null",
    "  fi",
    "  if [ ! -e \"$target\" ]; then",
    "    echo \"Repository resource was not materialized at $target\" >&2",
    "    exit 1",
    "  fi",
    "  echo \"Repository resource ready at $target\"",
    "}",
  ];
  for (const resource of resources) {
    const url = new URL(resource.uri);
    const repo = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
    const mountPath = normalizeManifestPath(resource.mountPath ?? `repos/${repo}`);
    commands.push([
      "clone_repository",
      shellQuote(posixPath.join("/workspace", mountPath)),
      shellQuote(resource.uri),
      shellQuote(resource.ref),
      shellQuote(resource.subpath ? normalizeManifestPath(resource.subpath) : ""),
    ].join(" "));
  }
  return commands.join("\n");
}

export function toolspaceTokenSeedCommand(): string {
  return [
    "set -eu",
    "export HOME=\"${HOME:-/workspace}\"",
    "if [ -n \"${OPENGENI_TOOLSPACE_TOKEN_SEED:-}\" ]; then",
    "  seed_umask=\"$(umask)\"",
    "  umask 077",
    "  token_file=\"${OPENGENI_TOOLSPACE_TOKEN_FILE:-$HOME/.opengeni/toolspace-token}\"",
    "  mkdir -p \"$(dirname \"$token_file\")\"",
    "  printf '%s' \"$OPENGENI_TOOLSPACE_TOKEN_SEED\" > \"$token_file.tmp.$$\"",
    "  mv -f \"$token_file.tmp.$$\" \"$token_file\"",
    "  umask \"$seed_umask\"",
    "fi",
  ].join("\n");
}

export async function runToolspaceTokenSeedHook(
  session: SandboxSessionLike,
  context: SandboxLifecycleHookContext,
): Promise<void> {
  if (!context.toolspaceTokenSeed) {
    return;
  }
  const command = `export OPENGENI_TOOLSPACE_TOKEN_SEED=${shellQuote(context.toolspaceTokenSeed)}\n${toolspaceTokenSeedCommand()}`;
  if (session.exec) {
    const result = await session.exec({
      cmd: command,
      workdir: "/workspace",
      ...(context.runAs ? { runAs: context.runAs } : {}),
      yieldTimeMs: SANDBOX_LIFECYCLE_COMMAND_TIMEOUT_MS,
      maxOutputTokens: 4_000,
    });
    assertSandboxCommandSucceeded(result, "Toolspace token seed hook");
  } else if (session.execCommand) {
    const result = await session.execCommand({
      cmd: command,
      workdir: "/workspace",
      ...(context.runAs ? { runAs: context.runAs } : {}),
      yieldTimeMs: SANDBOX_LIFECYCLE_COMMAND_TIMEOUT_MS,
      maxOutputTokens: 4_000,
    });
    assertSandboxCommandSucceeded(result, "Toolspace token seed hook");
  } else {
    throw new Error("Sandbox session does not support command execution");
  }
}

export async function runRepositoryCloneHook(
  session: SandboxSessionLike,
  resources: Extract<ResourceRef, { kind: "repository" }>[],
  context: SandboxLifecycleHookContext = { environment: {} },
): Promise<void> {
  const payload = { name: "repository-clone", repositoryCount: resources.length };
  await context.onRuntimeEvent?.({ type: "sandbox.operation.started", payload });
  try {
    // TOKEN-BROKER (B1): thread the run-scoped GitHub token PER-EXEC, never on the
    // manifest. The SDK's ExecCommandArgs has no `environment` field (exec inherits
    // the box's manifest env), so we can't hand the seed through an exec option — and
    // we MUST NOT put it on the manifest (validateNoEnvironmentDelta would see a
    // rotating value). We therefore inline it as an ephemeral `export` prefix on THIS
    // exec's command text only: it lives in the command, not the box/agent manifest,
    // and never persists. The clone command's gated seed block then writes it to the
    // token FILE before the fetch, so GIT_ASKPASS reads it. Absent seed (e.g. the
    // selfhosted path) -> no prefix, the clone runs byte-for-byte as before.
    const command = context.gitTokenSeed
      ? `export OPENGENI_GIT_TOKEN_SEED=${shellQuote(context.gitTokenSeed)}\n${repositoryCloneCommand(resources)}`
      : repositoryCloneCommand(resources);
    if (session.exec) {
      const result = await session.exec({
        cmd: command,
        workdir: "/workspace",
        ...(context.runAs ? { runAs: context.runAs } : {}),
        yieldTimeMs: SANDBOX_LIFECYCLE_COMMAND_TIMEOUT_MS,
        maxOutputTokens: 20_000,
      });
      assertSandboxCommandSucceeded(result, "Repository clone hook");
    } else if (session.execCommand) {
      const result = await session.execCommand({
        cmd: command,
        workdir: "/workspace",
        ...(context.runAs ? { runAs: context.runAs } : {}),
        yieldTimeMs: SANDBOX_LIFECYCLE_COMMAND_TIMEOUT_MS,
        maxOutputTokens: 20_000,
      });
      assertSandboxCommandSucceeded(result, "Repository clone hook");
    } else {
      throw new Error("Sandbox session does not support command execution");
    }
    await context.onRuntimeEvent?.({ type: "sandbox.operation.completed", payload });
  } catch (error) {
    await context.onRuntimeEvent?.({
      type: "sandbox.operation.failed",
      payload: {
        ...payload,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
}

export function azureCliLoginCommand(): string {
  return [
    "export HOME=\"${HOME:-/workspace}\"",
    "mkdir -p \"$HOME/.azure\"",
    "CLIENT_ID=\"${AZURE_CLIENT_ID:-${ARM_CLIENT_ID:-}}\"",
    "CLIENT_SECRET=\"${AZURE_CLIENT_SECRET:-${ARM_CLIENT_SECRET:-}}\"",
    "TENANT_ID=\"${AZURE_TENANT_ID:-${ARM_TENANT_ID:-}}\"",
    "SUBSCRIPTION_ID=\"${AZURE_SUBSCRIPTION_ID:-${ARM_SUBSCRIPTION_ID:-}}\"",
    "if [ -n \"$CLIENT_ID\" ] && [ -n \"$CLIENT_SECRET\" ] && [ -n \"$TENANT_ID\" ]; then",
    "  command -v az >/dev/null 2>&1 || { echo \"Azure CLI is not installed in the sandbox\" >&2; exit 127; }",
    "  az account show --only-show-errors >/dev/null 2>&1 || az login --service-principal --username \"$CLIENT_ID\" --password \"$CLIENT_SECRET\" --tenant \"$TENANT_ID\" --allow-no-subscriptions --only-show-errors --output none",
    // if/fi, NOT `[ -n ] && az`: this line ends the credentialed if-body, so with a
    // no-subscription SP (an explicitly supported config — the login above passes
    // --allow-no-subscriptions) the bare `[ -n ]` would exit the whole script 1 and
    // fail the turn.
    "  if [ -n \"$SUBSCRIPTION_ID\" ]; then az account set --subscription \"$SUBSCRIPTION_ID\" --only-show-errors; fi",
    "fi",
  ].join("\n");
}

export function sandboxCommandExitCode(result: unknown): number | null {
  if (typeof result === "string") {
    const match = result.match(/Process exited with code (-?\d+)/);
    return match ? Number(match[1]) : null;
  }
  if (!result || typeof result !== "object") {
    return null;
  }
  const candidate = result as {
    exitCode?: unknown;
    exit_code?: unknown;
    code?: unknown;
    status?: unknown;
  };
  for (const value of [candidate.exitCode, candidate.exit_code, candidate.code, candidate.status]) {
    if (typeof value === "number") {
      return value;
    }
  }
  return null;
}

export function sandboxCommandOutput(result: unknown): string {
  if (typeof result === "string") {
    const outputIndex = result.indexOf("Output:");
    return outputIndex >= 0 ? result.slice(outputIndex + "Output:".length).trim() : result.trim();
  }
  if (!result || typeof result !== "object") {
    return "";
  }
  const candidate = result as {
    output?: unknown;
    stdout?: unknown;
    stderr?: unknown;
  };
  return [candidate.output, candidate.stderr, candidate.stdout]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");
}

function assertSandboxCommandSucceeded(result: unknown, operation: string): void {
  const output = sandboxCommandOutput(result);
  if (sandboxCommandStillRunning(result)) {
    throw new Error(`${operation} did not finish before the lifecycle command timeout${output ? `:\n${output}` : ""}`);
  }
  const exitCode = sandboxCommandExitCode(result);
  if (exitCode !== null && exitCode !== 0) {
    throw new Error(`${operation} failed with exit code ${exitCode}${output ? `:\n${output}` : ""}`);
  }
  if (exitCode === null) {
    throw new Error(output || `${operation} did not return a command exit code`);
  }
}

export function sandboxCommandStillRunning(result: unknown): boolean {
  if (typeof result === "string") {
    return /Process running with session ID \d+/u.test(result);
  }
  if (!result || typeof result !== "object") {
    return false;
  }
  const candidate = result as { sessionId?: unknown; session_id?: unknown };
  return typeof candidate.sessionId === "number" || typeof candidate.session_id === "number";
}

function hasAzureServicePrincipal(environment: Record<string, string>): boolean {
  const clientId = environment.AZURE_CLIENT_ID || environment.ARM_CLIENT_ID;
  const clientSecret = environment.AZURE_CLIENT_SECRET || environment.ARM_CLIENT_SECRET;
  const tenantId = environment.AZURE_TENANT_ID || environment.ARM_TENANT_ID;
  return Boolean(clientId && clientSecret && tenantId);
}

export async function runAzureCliLoginHook(
  session: SandboxSessionLike,
  context: SandboxLifecycleHookContext = { environment: {} },
): Promise<void> {
  const payload = { name: "azure-cli-login", command: "az login --service-principal" };
  await context.onRuntimeEvent?.({ type: "sandbox.operation.started", payload });
  try {
    if (session.exec) {
      const result = await session.exec({
        cmd: azureCliLoginCommand(),
        workdir: "/workspace",
        ...(context.runAs ? { runAs: context.runAs } : {}),
        yieldTimeMs: SANDBOX_LIFECYCLE_COMMAND_TIMEOUT_MS,
        maxOutputTokens: 20_000,
      });
      assertSandboxCommandSucceeded(result, "Azure CLI login hook");
    } else if (session.execCommand) {
      const result = await session.execCommand({
        cmd: azureCliLoginCommand(),
        workdir: "/workspace",
        ...(context.runAs ? { runAs: context.runAs } : {}),
        yieldTimeMs: SANDBOX_LIFECYCLE_COMMAND_TIMEOUT_MS,
        maxOutputTokens: 20_000,
      });
      assertSandboxCommandSucceeded(result, "Azure CLI login hook");
    } else {
      throw new Error("Sandbox session does not support command execution");
    }
    await context.onRuntimeEvent?.({ type: "sandbox.operation.completed", payload });
  } catch (error) {
    await context.onRuntimeEvent?.({
      type: "sandbox.operation.failed",
      payload: {
        ...payload,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
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

// Since @openai/agents 0.11.0 local sandbox sources (including the lazy
// bundled-skills source) must stay within the SDK process working directory:
// reads outside it require manifest.extraPathGrants, and remote sandbox
// clients such as Modal reject manifests that carry extra path grants. The
// packaged skills live inside the runtime package — outside the worker's cwd
// in production — so stage a copy under the working directory once per
// process instead of granting the packaged path.
let stagedBundledSkillsDir: string | null = null;

function bundledSkillsDir(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const packaged = [
    join(moduleDir, "bundled_hashicorp_terraform_skills"),
    join(moduleDir, "..", "src", "bundled_hashicorp_terraform_skills"),
  ].find((candidate) => existsSync(candidate)) ?? join(moduleDir, "bundled_hashicorp_terraform_skills");
  if (isPathWithin(process.cwd(), packaged)) {
    return packaged;
  }
  if (!stagedBundledSkillsDir) {
    stagedBundledSkillsDir = stageBundledSkills(packaged, join(process.cwd(), ".opengeni", "bundled_hashicorp_terraform_skills"));
  }
  return stagedBundledSkillsDir;
}

function stageBundledSkills(packaged: string, target: string): string {
  const tmp = `${target}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(dirname(tmp), { recursive: true });
  cpSync(packaged, tmp, { recursive: true });
  rmSync(target, { recursive: true, force: true });
  try {
    renameSync(tmp, target);
  } catch (error) {
    // Another process staged the same content between our rm and rename.
    rmSync(tmp, { recursive: true, force: true });
    if (!existsSync(target)) {
      throw error;
    }
  }
  return target;
}

function isPathWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

/**
 * The skill source fed to the SDK Skills capability. Without pack skills this
 * is the plain bundled local-dir source, byte-for-byte the pre-pack behavior.
 * With pack skills it becomes a single in-memory dir source combining bundled
 * skill directories (as local_dir entries the SDK materializes lazily) with
 * pack skill directories built from manifest-carried file content — one skill
 * index, one `## Skills` instruction section, lazy `load_skill` for all of
 * them. A pack skill shadows a bundled skill with the same directory name.
 */
export function lazySkillSourceWithPackSkills(packSkills: PackSkill[]): LocalDirLazySkillSource {
  const bundledDir = bundledSkillsDir();
  const bundled = localDirLazySkillSource({ src: bundledDir });
  if (packSkills.length === 0) {
    return bundled;
  }
  const children: Record<string, Entry> = {};
  for (const name of bundledSkillDirNames(bundledDir)) {
    children[name] = localDir({ src: join(bundledDir, name) });
  }
  const packIndex: SkillIndexEntry[] = [];
  const packNames = new Set<string>();
  const packNameKeys = new Set<string>();
  for (const skill of packSkills) {
    assertSafePackSkillName(skill.name);
    if (packNameKeys.has(skill.name.toLowerCase())) {
      throw new Error(`Duplicate pack skill name: ${skill.name}`);
    }
    packNameKeys.add(skill.name.toLowerCase());
    packNames.add(skill.name);
    children[skill.name] = packSkillDirEntry(skill);
    packIndex.push({ name: skill.name, description: packSkillDescription(skill), path: skill.name });
  }
  return {
    source: dir({ children }),
    getIndex: (manifest, skillsPath) => [
      ...(bundled.getIndex?.(manifest, skillsPath) ?? []).filter((entry) => !packNames.has(entry.path ?? entry.name)),
      ...packIndex,
    ],
  };
}

function bundledSkillDirNames(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();
}

type PackSkillDirNode = {
  dirs: Map<string, PackSkillDirNode>;
  files: Map<string, string>;
};

function packSkillDirEntry(skill: PackSkill): Dir {
  const root: PackSkillDirNode = { dirs: new Map(), files: new Map() };
  for (const skillFile of skill.files) {
    const segments = packSkillPathSegments(skill.name, skillFile.path);
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      if (node.files.has(segment)) {
        throw new Error(`Pack skill ${skill.name} uses ${segment} as both a file and a directory`);
      }
      let next = node.dirs.get(segment);
      if (!next) {
        next = { dirs: new Map(), files: new Map() };
        node.dirs.set(segment, next);
      }
      node = next;
    }
    const filename = segments[segments.length - 1]!;
    if (node.dirs.has(filename) || node.files.has(filename)) {
      throw new Error(`Duplicate pack skill file path in ${skill.name}: ${skillFile.path}`);
    }
    node.files.set(filename, skillFile.content);
  }
  if (!root.files.has("SKILL.md")) {
    throw new Error(`Pack skill ${skill.name} is missing a top-level SKILL.md file`);
  }
  return packSkillDirFromNode(root);
}

function packSkillDirFromNode(node: PackSkillDirNode): Dir {
  const children: Record<string, Entry> = {};
  for (const [name, child] of node.dirs) {
    children[name] = packSkillDirFromNode(child);
  }
  for (const [name, content] of node.files) {
    children[name] = file({ content });
  }
  return dir({ children });
}

function assertSafePackSkillName(name: string): void {
  if (packSkillPathSegments(name, name).length !== 1) {
    throw new Error(`Invalid pack skill name: ${name}`);
  }
}

function packSkillPathSegments(skillName: string, path: string): string[] {
  const segments = path.split("/");
  if (path.startsWith("/") || path.includes("\\") || segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`Invalid pack skill file path for ${skillName}: ${path}`);
  }
  return segments;
}

function packSkillDescription(skill: PackSkill): string {
  const explicit = skill.description?.trim();
  if (explicit) {
    return explicit;
  }
  const markdown = skill.files.find((skillFile) => skillFile.path === "SKILL.md")?.content ?? "";
  return skillFrontmatterDescription(markdown) ?? "No description provided.";
}

function skillFrontmatterDescription(markdown: string): string | null {
  const lines = markdown.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return null;
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end === -1) {
    return null;
  }
  const collected: string[] = [];
  let inDescription = false;
  for (const line of lines.slice(1, end)) {
    const match = line.match(/^description:\s*(.*)$/);
    if (match) {
      const inline = match[1]!.trim();
      if (inline && inline !== ">-" && inline !== ">" && inline !== "|" && inline !== "|-") {
        return unquoteFrontmatterValue(inline);
      }
      inDescription = true;
      continue;
    }
    if (inDescription) {
      if (/^\s+\S/.test(line)) {
        collected.push(line.trim());
        continue;
      }
      break;
    }
  }
  const blockValue = collected.join(" ").trim();
  return blockValue ? blockValue : null;
}

function unquoteFrontmatterValue(value: string): string {
  if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isAsyncIterable<T>(source: Iterable<T> | AsyncIterable<T>): source is AsyncIterable<T> {
  return typeof (source as AsyncIterable<T>)[Symbol.asyncIterator] === "function";
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, sortJson(nested)]));
  }
  return value;
}

function approvalIdentifier(item: any): string {
  return String(item?.rawItem?.callId ?? item?.rawItem?.id ?? item?.id ?? item?.name ?? "approval");
}
