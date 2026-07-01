import type { ConfiguredModel, ContextCompactionMode, ModelProviderApi, ResolvedModelProvider, Settings } from "@opengeni/config";
import { AGENT_INSTRUCTIONS_CORE_PLACEHOLDER, collectSandboxEnvironment, contextServerCompactThreshold, parseExposedPorts, resolveContextCompactionMode, resolveModelProvider, sandboxLifecycleHookIds } from "@opengeni/config";
import { CAPABILITY_DESCRIPTORS, isClearedRunStateBlob, signDelegatedAccessToken, type Permission, type ReasoningEffort, type ResourceRef, type SessionEventType, type ToolRef } from "@opengeni/contracts";
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
  type Model,
  type ModelProvider,
  type RunStreamEvent,
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
import { enforceInputBudget, estimateItemTokens } from "./context-compaction";
import {
  createSandboxClient,
  deserializeSandboxSessionStateEnvelope,
  desktopCapableBackend,
  restoredSandboxSessionStateFromEntry,
  setSelfhostedApplyDiff,
} from "./sandbox";
import { computerUse } from "./sandbox-computer";

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

export { sanitizeHistoryItemsForModel, stripReasoningEncryptedContent, stripReasoningIdentityFromSerializedRunState } from "./history-sanitizer";
export type { HistoryItem } from "./history-sanitizer";

// The provider-bound Model classes used by buildModelInstance/resolveTurnModel.
// Re-exported so callers (and routing tests) can assert which wire API a
// resolved turn was bound to — OpenAIChatCompletionsModel for registry "chat"
// providers (Fireworks), OpenAIResponsesModel for the built-in "responses" path
// — without reaching into @openai/agents directly.
export { OpenAIChatCompletionsModel, OpenAIResponsesModel } from "@openai/agents";

export {
  planCompaction,
  enforceInputBudget,
  buildSummaryItem,
  buildCompactionMessages,
  isCompactionSummary,
  isUserMessage,
  findKeepBoundary,
  estimateTokens,
  estimateItemTokens,
  compactionSummaryText,
  renderPrefixTranscript,
  COMPACTION_SUMMARY_MARKER,
  SUMMARY_PREFIX,
  SUMMARY_INSTRUCTIONS,
} from "./context-compaction";
export type { CompactionItem, CompactionPlan, PlanCompactionInput } from "./context-compaction";

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
  };
};

type RuntimeMcpTool = Awaited<ReturnType<MCPServer["listTools"]>>[number];

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
};

export function createProductionAgentRuntime(overrides: ProductionRuntimeOverrides = {}): OpenGeniRuntime {
  return {
    configure: configureOpenAI,
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
export function buildOpenAIClientFromSettings(settings: Settings): OpenAI {
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
      fetch: computerCallNormalizingFetch(globalThis.fetch),
    });
  }
  return new OpenAI({
    apiKey: settings.openaiApiKey ?? process.env.OPENAI_API_KEY,
    ...(settings.openaiBaseUrl ? { baseURL: settings.openaiBaseUrl } : {}),
    maxRetries: settings.openaiMaxRetries,
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
    ? buildOpenAIClientFromSettings(settings)
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
        fetch: codexSubscriptionFetch(globalThis.fetch),
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
      const resolved = resolveTurnModel(this.settings, modelName);
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

/**
 * Run the compaction summarizer as one plain, tool-less, non-streaming model
 * call against the resolved provider. `system`/`user` come from
 * buildCompactionMessages. Returns the trimmed summary text, or null on any
 * failure (the caller treats a failed summarize as "skip compaction this turn"
 * — never fatal). The call deliberately does NOT request reasoning encryption,
 * tools, or server-side compaction; it is a self-contained summarize.
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
  messages: { system: string; user: string },
  options: { client?: OpenAI; api?: ModelProviderApi; maxOutputTokens?: number; model?: string } = {},
): Promise<string | null> {
  const client = options.client ?? buildOpenAIClientFromSettings(settings);
  const api = options.api ?? "responses";
  const model = options.model ?? settings.openaiModel;
  const maxTokens = options.maxOutputTokens ?? settings.contextSummaryMaxTokens;
  try {
    if (api === "chat") {
      const completion = await client.chat.completions.create({
        model,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: messages.system },
          { role: "user", content: messages.user },
        ],
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
      input: [
        { role: "system", content: messages.system },
        { role: "user", content: messages.user },
      ],
    } as any);
    const text = extractResponseOutputText(response);
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch (error) {
    console.error("context compaction summarize failed (compaction skipped this turn)", error);
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
  compactionMode?: ContextCompactionMode;
  hostedWebSearch?: boolean;
  encryptedReasoning?: boolean;
  contextWindowTokens?: number;
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

const agentFileDownloads = new WeakMap<object, SandboxFileDownload[]>();
const agentRepositoryCloneHooks = new WeakMap<object, SandboxLifecycleHook[]>();
// TOKEN-BROKER (B1): the per-turn git token seed, stashed alongside the agent's
// repository-clone hooks (a parallel map keyed by the agent). Kept OFF the
// manifest/defaultManifest so the rotating value never rides the SDK's provided-
// session env; runStream reads it to build the clone hook context. Absent when
// no repo is attached / on the selfhosted path.
const agentGitTokenSeed = new WeakMap<object, string>();

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
    instructions: options.genesisTitleHint
      ? `${composeAgentInstructions(options.instructionsTemplate ?? settings.agentInstructionsTemplate, options.workspaceEnvironment)} ${GENESIS_TITLE_DIRECTIVE}`
      : composeAgentInstructions(options.instructionsTemplate ?? settings.agentInstructionsTemplate, options.workspaceEnvironment),
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
  } as const;

  if (settings.sandboxBackend === "none") {
    return new Agent(baseConfig);
  }

  const runAs = sandboxRunAs(settings);
  const agent = new SandboxAgent({
    ...baseConfig,
    defaultManifest: buildManifest(settings, resources, options.sandboxEnvironment, options.fileResourceDownloads),
    ...(runAs ? { runAs } : {}),
    capabilities: buildAgentCapabilities(settings, options.packSkills ?? [], { compactionMode, contextWindowTokens }),
  });
  agentFileDownloads.set(agent, normalizeSandboxFileDownloads(options.fileResourceDownloads ?? []).filter((download) => !download.content));
  agentRepositoryCloneHooks.set(agent, sandboxRepositoryCloneHooks(settings, resources, options.activeSandboxBackend));
  // TOKEN-BROKER (B1): stash the per-turn seed off-manifest so runStream can seed the
  // clone hook without the token ever touching defaultManifest / sandboxEnvironment.
  if (options.gitTokenSeed) {
    agentGitTokenSeed.set(agent, options.gitTokenSeed);
  }
  return agent;
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
  options: { compactionMode?: ContextCompactionMode; contextWindowTokens?: number } = {},
): ReturnType<typeof Capabilities.default> {
  const mode = options.compactionMode ?? resolveContextCompactionMode(settings);
  const contextWindowTokens = options.contextWindowTokens ?? settings.contextWindowTokens;
  const caps: ReturnType<typeof Capabilities.default> = [filesystem(), shell()];
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
    caps.push(computerUse({
      dimensions: [settings.streamResolutionWidth, settings.streamResolutionHeight],
      readOnly: settings.computerUseReadOnly,
    }) as unknown as ReturnType<typeof Capabilities.default>[number]);
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
    const server = new PrefixedMcpServer(new MCPServerStreamableHttp({
      url,
      name: config.name ?? config.id,
      cacheToolsList: config.cacheToolsList,
      // codex_apps returns connector tools with empty `outputSchema: {}` that the
      // MCP SDK's strict Tool schema rejects (fails the turn during tools/list);
      // sanitize the response on the wire before validation. The namespace Set
      // also captures each tool's original connector namespace (P4 Part B.1).
      ...(isCodexAppsMcpServer(config) ? { fetch: codexAppsSanitizingFetch(globalThis.fetch, codexConnectorNamespaces) } : {}),
      ...await mcpServerRequestInit(settings, config, options),
      ...(config.timeoutMs ? {
        timeout: config.timeoutMs,
        clientSessionTimeoutSeconds: Math.ceil(config.timeoutMs / 1000),
      } : {}),
    }), config.id, config.allowedTools);
    // codex_apps connector availability is RUNTIME-DISCOVERED: the device-code
    // login may lack the connector scopes, and the backend can reject the bearer
    // at the initialize/tools-list handshake. Connect it best-effort so a 401/403
    // (or a missing/failed token) drops the server rather than failing the turn.
    return { server, bestEffort: isCodexAppsMcpServer(config) };
  }));
  const requiredServers = servers.filter((entry) => !entry.bestEffort).map((entry) => entry.server);
  const bestEffortServers = servers.filter((entry) => entry.bestEffort).map((entry) => entry.server);
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
      : `http://127.0.0.1:${settings.apiPort}/v1/workspaces/${workspaceId}/mcp`;
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
  const base = normalizeUrl(settings.opengeniMcpUrl ?? `http://127.0.0.1:${settings.apiPort}/v1/workspaces/{workspaceId}/mcp`);
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
  return `${registryId}__${toolName}`;
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
    return await this.inner.callTool(unprefixed, args, meta);
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
  };
  // A per-turn model-input filter chained AFTER the provider-item-id strip.
  // Used by the genesis-title injection to prepend a hidden, NON-PERSISTED
  // directive: a callModelInputFilter mutates only `modelData.input` for each
  // model call and never touches `state.history`/`originalInput`, so the
  // reconcile dual-write never sees it.
  callModelInputFilter?: CallModelInputFilter;
};

// One-shot directive appended to the agent's system prompt on the genesis turn
// (see buildOpenGeniAgent's genesisTitleHint). Delivered through the
// authoritative instructions channel so the model reliably obeys; references
// the prefixed tool name the agent actually sees (opengeni__set_session_title).
// Appended after the non-bypassable core so a white-label persona can't drop it.
export const GENESIS_TITLE_DIRECTIVE =
  "This is the first turn of a new session. Before responding to the user, call the opengeni__set_session_title tool with a concise 3-7 word title that summarizes what this session is about, then address the user's request normally.";

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
 * selects it.
 */
export function callModelInputFilterForSettings(settings: Settings): CallModelInputFilter | undefined {
  const filters: CallModelInputFilter[] = [normalizeComputerCallsFilter];
  if (settings.openaiProviderItemIds === "strip") {
    filters.push(stripProviderItemIdsFilter);
  }
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
    const decoratedClient = withSandboxLifecycleHooks(resourceClient, [
      ...sandboxLifecycleHooksForIds(sandboxLifecycleHookIds(settings)),
      ...sandboxRepositoryCloneHooksForAgent(agent),
    ], {
      environment,
      ...(overrides.onRuntimeEvent ? { onRuntimeEvent: overrides.onRuntimeEvent } : {}),
      ...(runAs ? { runAs } : {}),
      ...(ownedGitTokenSeed ? { gitTokenSeed: ownedGitTokenSeed } : {}),
    });
    const ownedFilter = composeCallModelInputFilters(
      [callModelInputFilterForSettings(settings), overrides.callModelInputFilter].filter(
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
    ? withManifestRefreshOnResume(rawClient as SandboxClient, (agent as { defaultManifest?: Manifest }).defaultManifest)
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
  const client = resourceClient
    ? withSandboxLifecycleHooks(resourceClient, [
      ...sandboxLifecycleHooksForIds(sandboxLifecycleHookIds(settings)),
      ...sandboxRepositoryCloneHooksForAgent(agent),
    ], {
      environment,
      ...(overrides.onRuntimeEvent ? { onRuntimeEvent: overrides.onRuntimeEvent } : {}),
      ...(runAs ? { runAs } : {}),
      ...(gitTokenSeed ? { gitTokenSeed } : {}),
    })
    : undefined;
  const sandboxSessionState = prepared.sandboxSessionState
    ?? (prepared.serializedRunStateForSandbox && client
      ? await restoredSandboxSessionState(await RunState.fromString(agent, prepared.serializedRunStateForSandbox), client)
      : undefined);
  // Strip provider item ids first, then apply any per-turn filter (genesis
  // title directive). Composed left-to-right so the directive lands on the
  // already-id-stripped input. A callModelInputFilter only shapes the per-call
  // model input, never the persisted run-state history.
  const callModelInputFilter = composeCallModelInputFilters(
    [callModelInputFilterForSettings(settings), overrides.callModelInputFilter].filter(
      (f): f is CallModelInputFilter => Boolean(f),
    ),
  );
  const runOptions: Parameters<typeof run>[2] = {
    stream: true,
    maxTurns: settings.agentMaxModelCallsPerTurn,
    // Strip provider-assigned item ids from every model call (turn-start
    // history replay AND mid-turn follow-ups) so requests never depend on the
    // provider's server-side response store. A stored response can vanish
    // between two calls of the same turn, failing the run with 400 "Item with
    // id 'rs_…' not found"; with the ids gone the request is self-contained.
    callModelInputFilter,
  };
  void settings.disableOpenaiTracing;
  if (client) {
    runOptions.sandbox = {
      client,
      ...(sandboxSessionState ? { sessionState: sandboxSessionState } : {}),
    } as SandboxRunConfig;
  }
  return await runScopedRunner(settings).run(agent, prepared.input, runOptions);
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

export function withManifestRefreshOnResume(client: SandboxClient, targetManifest: Manifest | undefined): SandboxClient {
  if (!targetManifest || !client.resume) {
    return client;
  }
  return {
    backendId: client.backendId,
    ...(client.supportsDefaultOptions !== undefined ? { supportsDefaultOptions: client.supportsDefaultOptions } : {}),
    ...(client.create ? { create: async (...args: any[]) => await (client.create as any)(...args) } : {}),
    resume: async (state: SandboxSessionState) => {
      const session = await client.resume!(state);
      await applyMissingManifestEntries(session, targetManifest);
      return session;
    },
    ...(client.delete ? { delete: async (state: SandboxSessionState) => await client.delete!(state) } : {}),
    ...(client.serializeSessionState ? { serializeSessionState: async (state: SandboxSessionState, options) => await client.serializeSessionState!(state, options) } : {}),
    ...(client.canPersistOwnedSessionState ? { canPersistOwnedSessionState: async (state: SandboxSessionState) => await client.canPersistOwnedSessionState!(state) } : {}),
    ...(client.canReusePreservedOwnedSession ? { canReusePreservedOwnedSession: async (state: SandboxSessionState) => await client.canReusePreservedOwnedSession!(state) } : {}),
    ...(client.deserializeSessionState ? { deserializeSessionState: async (state: Record<string, unknown>) => await client.deserializeSessionState!(state) } : {}),
  };
}

export async function applyMissingManifestEntries(session: SandboxSessionLike, targetManifest: Manifest): Promise<void> {
  const currentManifestValue = (session as { state?: { manifest?: Manifest | { root?: string; entries?: Record<string, any>; environment?: Record<string, any> } } }).state?.manifest;
  const currentManifest = currentManifestValue ? ensureManifest(currentManifestValue) : undefined;
  const target = ensureManifest(targetManifest);
  if (!currentManifest) {
    if (Object.keys(target.entries).length === 0) {
      return;
    }
    throw new Error("Resumed sandbox session cannot apply new manifest entries because current manifest state is unavailable");
  }
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
): Promise<void> {
  const normalizedDownloads = normalizeSandboxFileDownloads(downloads);
  if (normalizedDownloads.length === 0) {
    return;
  }
  if (!session.exec && !session.execCommand) {
    throw new Error("Sandbox file download materialization requires command execution support");
  }
  for (const download of normalizedDownloads) {
    const targetPath = sandboxDownloadTargetPath(download);
    const payload = {
      fileId: download.fileId,
      path: targetPath,
      sizeBytes: download.sizeBytes ?? null,
      expiresAt: download.expiresAt ? new Date(download.expiresAt).toISOString() : null,
    };
    await context.onRuntimeEvent?.({ type: "sandbox.operation.started", payload: { name: "file-resource-download", ...payload } });
    try {
      const result = session.exec
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
      await context.onRuntimeEvent?.({
        type: "sandbox.operation.failed",
        payload: {
          name: "file-resource-download",
          ...payload,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
  }
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

export function normalizeSdkEvent(event: RunStreamEvent): NormalizedRuntimeEvent[] {
  const out: NormalizedRuntimeEvent[] = [];
  if (event.type === "raw_model_stream_event") {
    const data = (event as any).data;
    if (data?.type === "output_text_delta" && typeof data.delta === "string") {
      out.push({ type: "agent.message.delta", payload: { text: data.delta } });
      return out;
    }
  }
  if (isOpenAIResponsesRawModelStreamEvent(event)) {
    const raw = (event as any).data?.event;
    if (raw?.type === "response.reasoning_summary_text.delta" && typeof raw.delta === "string") {
      out.push({ type: "agent.reasoning.delta", payload: { text: raw.delta } });
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
        output: item.output,
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
    "set -euo pipefail",
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

export function withSandboxLifecycleHooks(
  client: SandboxClient,
  hooks: SandboxLifecycleHook[],
  context: SandboxLifecycleHookContext,
): SandboxClient {
  const beforeAgentStartHooks = hooks.filter((hook) => hook.phase === "beforeAgentStart" && (hook.shouldRun?.(context) ?? true));
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
    // (stable, from the shared base) with a $HOME/.opengeni/git-token fallback; chmod 600
    // keeps the token private. $GIT_ASKPASS is on the box manifest env (set by
    // sandboxEnvironmentForRun to $HOME/.opengeni/askpass), so it is available to this
    // exec; the askpass script we write is byte-identical to docker/opengeni-git-askpass
    // and is written via a QUOTED heredoc (<<'ASKPASS_EOF') so NOTHING inside it expands
    // ($1, $HOME, ${OPENGENI_GIT_TOKEN_FILE:-...}, and the literal \n in printf all land
    // verbatim), then chmod 0755 so git can exec it.
    "if [ -n \"${OPENGENI_GIT_TOKEN_SEED:-}\" ]; then",
    "  git_token_file=\"${OPENGENI_GIT_TOKEN_FILE:-$HOME/.opengeni/git-token}\"",
    "  mkdir -p \"$(dirname \"$git_token_file\")\"",
    "  printf '%s' \"$OPENGENI_GIT_TOKEN_SEED\" > \"$git_token_file\"",
    "  chmod 600 \"$git_token_file\"",
    "  git_askpass=\"${GIT_ASKPASS:-$HOME/.opengeni/askpass}\"",
    "  mkdir -p \"$(dirname \"$git_askpass\")\"",
    "  cat > \"$git_askpass\" <<'ASKPASS_EOF'",
    "#!/usr/bin/env sh",
    "case \"$1\" in",
    "  *Username*) printf '%s\\n' \"x-access-token\" ;;",
    "  *Password*) cat \"${OPENGENI_GIT_TOKEN_FILE:-$HOME/.opengeni/git-token}\" 2>/dev/null || printf '\\n' ;;",
    "  *) printf '\\n' ;;",
    "esac",
    "ASKPASS_EOF",
    "  chmod 0755 \"$git_askpass\"",
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
    "    echo \"Repository resource already present at $target\"",
    "    return 0",
    "  fi",
    "  mkdir -p \"$(dirname \"$target\")\"",
    "  tmp=\"${target}.tmp.$$\"",
    "  rm -rf \"$tmp\"",
    "  git init \"$tmp\" >/dev/null",
    "  git -C \"$tmp\" remote add origin \"$uri\"",
    "  git -C \"$tmp\" fetch --depth 1 --no-tags --filter=blob:none origin \"$ref\"",
    "  git -C \"$tmp\" checkout --detach FETCH_HEAD >/dev/null",
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
    "    mv \"$tmp\" \"$target\"",
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
    "  [ -n \"$SUBSCRIPTION_ID\" ] && az account set --subscription \"$SUBSCRIPTION_ID\" --only-show-errors",
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
    throw new Error(output || `${operation} failed with exit code ${exitCode}`);
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
  const packaged = join(dirname(fileURLToPath(import.meta.url)), "bundled_hashicorp_terraform_skills");
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
