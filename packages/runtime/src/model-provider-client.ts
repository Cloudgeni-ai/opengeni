import { configuredModels, type ResolvedModelProvider, type Settings } from "@opengeni/config";
import OpenAI from "openai";
import { createHash } from "node:crypto";
import { CODEX_RESPONSE_SDK_OUTER_TIMEOUT_MS, codexSubscriptionFetch } from "@opengeni/codex";
import {
  XAI_RESPONSE_SDK_OUTER_TIMEOUT_MS,
  xaiSubscriptionFetch,
} from "@opengeni/xai-subscription";

import type {
  McpLifecycleOutcome,
  McpLifecyclePhase,
  McpLifecyclePolicy,
  McpToolCallOutcome,
  RuntimeMetricsHooks,
} from "./metrics";
import {
  WorkspaceGatewayUnavailableError,
  WorkspaceOpenRouterUnavailableError,
} from "./model-provider-errors";
import {
  azureModelRequestPolicy,
  modelRequestPolicyForProvider,
} from "./model-provider-request-policy";
import { isModelCallFetch, vercelGatewayRoutingFetch } from "./model-provider-transport";
import { ReplayableJsonOpenAI } from "./replayable-json-body";
import { recordModelTransportStarted } from "./model-preparation-diagnostics";

let runtimeMetricsHooks: RuntimeMetricsHooks | null = null;

export function configureRuntimeMetricsHooks(hooks: RuntimeMetricsHooks | null | undefined): void {
  runtimeMetricsHooks = hooks ?? null;
}

export function recordRuntimeMcpToolCallMetric(
  outcome: McpToolCallOutcome,
  startedAt: number,
): void {
  const durationSeconds = Math.max(0, (performance.now() - startedAt) / 1_000);
  try {
    runtimeMetricsHooks?.onMcpToolCall?.({ outcome, durationSeconds });
  } catch {
    // Metrics emission must never affect an MCP call or rewrite its result.
  }
}

export function recordRuntimeMcpLifecycleMetric(
  phase: McpLifecyclePhase,
  policy: McpLifecyclePolicy,
  outcome: McpLifecycleOutcome,
  startedAt: number,
): void {
  const durationSeconds = Math.max(0, (performance.now() - startedAt) / 1_000);
  try {
    runtimeMetricsHooks?.onMcpLifecycle?.({ phase, policy, outcome, durationSeconds });
  } catch {
    // Metrics emission must never affect MCP connection lifecycle behavior.
  }
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
 * One OpenAI client per deployment-scoped provider configuration, built lazily
 * and cached for the process. Workspace-connection providers are deliberately
 * rebuilt per immutable turn settings snapshot so a workspace key never enters
 * a cross-workspace cache. The built-in openai/azure provider reuses
 * buildOpenAIClientFromSettings verbatim (so its Azure AD/api-version/base-URL
 * construction stays byte-for-byte identical to configureOpenAI); a registry
 * provider gets a plain client pointed at its base URL with its resolved key,
 * the shared maxRetries budget, and its declared defaultQuery/defaultHeaders.
 * The cache key includes credential/configuration and Gateway request-policy
 * digests so a live database-catalog update cannot reuse a stale client while
 * unchanged concurrent turns still share one connection pool.
 */
const providerClientCache = new Map<string, OpenAI>();

function canonicalCacheJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input)
          .filter(([, child]) => child !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, normalize(child)]),
      );
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

function providerClientCacheKey(
  provider: ResolvedModelProvider,
  settings: Settings,
  gatewayPolicies: ReadonlyMap<string, unknown> | undefined,
): string {
  const sortedRecord = (value: Record<string, string> | undefined) =>
    value
      ? Object.fromEntries(
          Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
        )
      : null;
  const apiKeyDigest = provider.apiKey
    ? createHash("sha256").update(provider.apiKey, "utf8").digest("hex")
    : null;
  const digest = createHash("sha256")
    .update(
      canonicalCacheJson({
        provider: {
          id: provider.id,
          kind: provider.kind,
          api: provider.api,
          wireProfile: provider.wireProfile,
          builtin: provider.builtin,
          baseUrl: provider.baseUrl ?? null,
          apiKeyDigest,
          defaultQuery: sortedRecord(provider.defaultQuery),
          defaultHeaders: sortedRecord(provider.defaultHeaders),
          publicDefaultQueryNames: [...(provider.publicDefaultQueryNames ?? [])].sort(),
          publicDefaultHeaderNames: [...(provider.publicDefaultHeaderNames ?? [])].sort(),
        },
        gatewayPolicies: gatewayPolicies
          ? [...gatewayPolicies.entries()].sort(([left], [right]) => left.localeCompare(right))
          : null,
        openaiMaxRetries: settings.openaiMaxRetries,
        builtin:
          provider.builtin && settings.openaiProvider === "azure"
            ? {
                azureOpenaiBaseUrl: settings.azureOpenaiBaseUrl ?? null,
                azureOpenaiEndpoint: settings.azureOpenaiEndpoint ?? null,
                azureOpenaiDeployment: settings.azureOpenaiDeployment ?? null,
                azureOpenaiApiVersion: settings.azureOpenaiApiVersion ?? null,
                usesAdToken: Boolean(settings.azureOpenaiAdToken && !settings.azureOpenaiApiKey),
              }
            : null,
      }),
      "utf8",
    )
    .digest("hex");
  return `${provider.id}:${digest}`;
}

function cacheProviderClient(cacheKey: string, providerId: string, client: OpenAI): void {
  const prefix = `${providerId}:`;
  for (const existingKey of providerClientCache.keys()) {
    if (existingKey !== cacheKey && existingKey.startsWith(prefix)) {
      providerClientCache.delete(existingKey);
    }
  }
  providerClientCache.set(cacheKey, client);
}

const ANONYMOUS_PROVIDER_AUTHENTICATION_HEADERS = new Set([
  "api-key",
  "authorization",
  "cookie",
  "cookie2",
  "openai-organization",
  "openai-project",
  "proxy-authorization",
  "set-cookie",
  "x-api-key",
]);
const ANONYMOUS_PROVIDER_AUTHENTICATION_HEADER_PARTS = new Set([
  "apikey",
  "auth",
  "authorization",
  "bearer",
  "cookie",
  "credential",
  "password",
  "secret",
  "session",
  "signature",
  "token",
]);

function isAnonymousProviderAuthenticationHeader(name: string): boolean {
  const normalized = name.toLowerCase();
  if (ANONYMOUS_PROVIDER_AUTHENTICATION_HEADERS.has(normalized)) {
    return true;
  }
  const parts = normalized.split(/[-_.]/u);
  if (parts.some((part) => ANONYMOUS_PROVIDER_AUTHENTICATION_HEADER_PARTS.has(part))) {
    return true;
  }
  return (
    parts.includes("key") &&
    parts.some((part) => ["access", "api", "auth", "client", "credential", "secret"].includes(part))
  );
}

function withoutAuthenticationHeaders(inner: typeof fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const mergedHeaders = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => mergedHeaders.set(name, value));
    const headers = new Headers();
    mergedHeaders.forEach((value, name) => {
      if (!isAnonymousProviderAuthenticationHeader(name)) {
        headers.set(name, value);
      }
    });
    return await inner(input, { ...init, headers });
  }) as typeof fetch;
}

export function buildProviderClient(provider: ResolvedModelProvider, settings: Settings): OpenAI {
  const workspaceGateway = provider.kind === "vercel-gateway-workspace";
  const workspaceCredentialProvider = provider.credentialSource?.kind === "workspace_connection";
  const gatewayProvider = workspaceGateway || provider.kind === "vercel-gateway-managed";
  const openRouterProvider =
    provider.kind === "openrouter-managed" || provider.kind === "openrouter-workspace";
  const gatewayPolicies = gatewayProvider
    ? new Map(
        configuredModels(settings)
          .filter((model) => model.providerId === provider.id)
          .map((model) => [model.upstreamModelId, model.requestPolicy] as const),
      )
    : undefined;
  const cacheKey = providerClientCacheKey(provider, settings, gatewayPolicies);
  const cached = workspaceCredentialProvider ? undefined : providerClientCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  if (workspaceCredentialProvider && !provider.apiKey) {
    if (provider.kind === "openrouter-workspace") {
      throw new WorkspaceOpenRouterUnavailableError();
    }
    throw new WorkspaceGatewayUnavailableError();
  }
  const anonymousProvider = provider.kind === "anonymous";
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
          { modelRequestPolicy: modelRequestPolicyForProvider(provider, gatewayPolicies) },
        )
      : provider.kind === "xai-subscription"
        ? // SuperGrok subscription uses one workspace-scoped request context.
          // The cached client contains no credential: xaiSubscriptionFetch
          // resolves the exact frozen account token at request time, stamps the
          // Grok CLI proxy headers, and owns the sole definitive 401 refresh.
          new ReplayableJsonOpenAI(
            {
              apiKey: provider.apiKey ?? "supergrok-subscription",
              ...(provider.baseUrl ? { baseURL: provider.baseUrl } : {}),
              // Never let the SDK replay a request that may have reached the
              // provider. The subscription transport retries only a definitive
              // pre-acceptance authentication failure (401).
              maxRetries: 0,
              timeout: XAI_RESPONSE_SDK_OUTER_TIMEOUT_MS,
              fetch: xaiSubscriptionFetch(instrumentedModelFetch(provider.id, globalThis.fetch)),
            },
            { modelRequestPolicy: modelRequestPolicyForProvider(provider, gatewayPolicies) },
          )
        : // ResolvedModelProvider.apiKey is already the resolved key (configuredProviders
          // ran resolveProviderApiKey at config time, collapsing apiKey/apiKeyEnv), so it
          // is passed straight through here rather than re-resolved.
          new ReplayableJsonOpenAI(
            {
              ...(anonymousProvider
                ? {
                    // The OpenAI SDK requires a constructor credential. It must
                    // never reach the wire for an explicitly anonymous provider.
                    apiKey: "opengeni-anonymous-provider",
                    adminAPIKey: null,
                    organization: null,
                    project: null,
                  }
                : provider.apiKey
                  ? { apiKey: provider.apiKey }
                  : {}),
              ...(provider.baseUrl ? { baseURL: provider.baseUrl } : {}),
              // Gateway and OpenRouter requests can incur upstream work or charges
              // before a retryable response failure reaches this process. Neither
              // transport has a provider idempotency key tied to our durable call,
              // so never let the SDK replay them blindly.
              maxRetries: gatewayProvider || openRouterProvider ? 0 : settings.openaiMaxRetries,
              ...(provider.defaultQuery ? { defaultQuery: provider.defaultQuery } : {}),
              ...(provider.defaultHeaders ? { defaultHeaders: provider.defaultHeaders } : {}),
              fetch: anonymousProvider
                ? withoutAuthenticationHeaders(
                    instrumentedModelFetch(provider.id, globalThis.fetch),
                  )
                : gatewayProvider
                  ? vercelGatewayRoutingFetch(
                      provider.kind as "vercel-gateway-managed" | "vercel-gateway-workspace",
                      instrumentedModelFetch(provider.id, globalThis.fetch),
                      gatewayPolicies,
                    )
                  : instrumentedModelFetch(provider.id, globalThis.fetch),
            },
            { modelRequestPolicy: modelRequestPolicyForProvider(provider, gatewayPolicies) },
          );
  if (!workspaceCredentialProvider) {
    cacheProviderClient(cacheKey, provider.id, client);
  }
  return client;
}

export function instrumentedModelFetch(provider: string, inner: typeof fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (!isModelCallFetch(input)) {
      return await inner(input, init);
    }
    // The attempt-local observer durably checkpoints provider dispatch before
    // this process can place request bytes on the network.
    await recordModelTransportStarted();
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
