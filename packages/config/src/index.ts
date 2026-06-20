import {
  BillingMode,
  Entitlements,
  EntitlementsMode,
  ProductAccessMode,
  ReasoningEffort,
  SandboxBackend,
  StaticUsageLimits,
  UsageLimitsMode,
} from "@opengeni/contracts";
import { z } from "zod";

const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const registryId = /^[A-Za-z0-9_-]+$/;
const EnvBoolean = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return value;
}, z.boolean());

export const sandboxPreparationProfiles: Record<string, { env: string[]; hooks: string[] }> = {
  none: {
    env: [],
    hooks: [],
  },
  azure: {
    env: [
      "ARM_CLIENT_ID",
      "ARM_CLIENT_SECRET",
      "ARM_TENANT_ID",
      "ARM_SUBSCRIPTION_ID",
      "AZURE_CLIENT_ID",
      "AZURE_CLIENT_SECRET",
      "AZURE_TENANT_ID",
      "AZURE_SUBSCRIPTION_ID",
      "AZURE_AUTHORITY_HOST",
    ],
    hooks: ["azure-cli-login"],
  },
  github: {
    env: [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GIT_AUTHOR_NAME",
      "GIT_AUTHOR_EMAIL",
      "GIT_COMMITTER_NAME",
      "GIT_COMMITTER_EMAIL",
    ],
    hooks: [],
  },
};

/**
 * Placeholder token inside an agent-instructions persona template. The runtime
 * substitutes the non-bypassable CORE (goal-loop ownership + the dynamic
 * workspace-environment block) at this marker. A template that omits the
 * marker still gets the CORE appended after it (a non-bypassable fail-safe),
 * so a white-labelled persona can never drop the goal-loop contract or the
 * environment metadata the agent depends on.
 */
export const AGENT_INSTRUCTIONS_CORE_PLACEHOLDER = "{{core}}";

/**
 * Default per-workspace agent persona template. This is the BRAND + tool-usage
 * opinion (the white-labellable surface): the "You are an OpenGeni workspace
 * agent." identity line, the framing/opinion lines, and the mount-path facts.
 *
 * The CORE that MUST survive any override — the goal-loop ownership line (which
 * names the opengeni__goal_* tools) and the dynamic workspace-environment block
 * — is injected at AGENT_INSTRUCTIONS_CORE_PLACEHOLDER by the runtime, never
 * baked into this overridable string.
 *
 * INVARIANT: with no per-workspace override and an empty environment, the
 * runtime's composed instructions are BYTE-IDENTICAL to the historical
 * hardcoded preamble. The template below is exactly the historical lines 1–11
 * joined by " ", followed by " " + the placeholder. Changing a single
 * character here changes that default; a runtime test pins it.
 */
export const DEFAULT_AGENT_INSTRUCTIONS = [
  "You are an OpenGeni workspace agent.",
  "Follow the user's task and any enabled pack or skill instructions for the current role.",
  "Work inside the sandbox workspace and use filesystem and shell tools when useful.",
  "Repository resources are mounted under repos/<owner>/<repo>.",
  "File resources are mounted under files/<file-id>/ unless the session specifies another mount path.",
  "Attached files are mounted read-only; copy them before modifying.",
  "Bundled skills are under .agents/ and can include infrastructure, marketing, or other role-specific guidance.",
  "Use Checkov, Terraform, Azure CLI, GitHub CLI, and repository tools when relevant.",
  "When the Azure sandbox preparation profile is enabled and service-principal variables are present, the sandbox is pre-authenticated with normal Azure CLI before work starts.",
  "Treat code-changing work as GitOps work: create a focused branch/commit/PR when GitHub credentials are available; otherwise report exact commands and blockers.",
  "Return concise, factual summaries with files changed, commands run, and remaining blockers.",
  AGENT_INSTRUCTIONS_CORE_PLACEHOLDER,
].join(" ");

const SettingsSchema = z.object({
  serviceName: z.string().default("opengeni"),
  environment: z.string().default("local"),
  deploymentRevision: z.string().default("dev"),
  databaseUrl: z.string().default("postgres://opengeni:opengeni@127.0.0.1:5432/opengeni"),
  natsUrl: z.string().default("nats://127.0.0.1:4222"),
  temporalHost: z.string().default("127.0.0.1:7233"),
  temporalNamespace: z.string().default("default"),
  temporalTaskQueue: z.string().default("opengeni-runs-ts"),
  startupDependencyRetryAttempts: z.coerce.number().int().positive().default(30),
  startupDependencyRetryInitialDelayMs: z.coerce.number().int().positive().default(1000),
  startupDependencyRetryMaxDelayMs: z.coerce.number().int().positive().default(5000),
  observabilityStructuredLogs: EnvBoolean.default(false),
  observabilityMetricsEnabled: EnvBoolean.default(true),
  observabilityOtlpEndpoint: z.string().url().optional(),
  observabilityOtlpHeaders: z.string().default(""),
  publicBaseUrl: z.string().url().optional(),
  productAccessMode: ProductAccessMode.default("local"),
  billingMode: BillingMode.default("disabled"),
  entitlementsMode: EntitlementsMode.default("none"),
  usageLimitsMode: UsageLimitsMode.default("none"),
  staticEntitlementsJson: z.string().default("{}"),
  staticUsageLimitsJson: z.string().default("{}"),
  delegationSecret: z.string().optional(),
  environmentsEncryptionKey: z.string().optional(),
  // Session goal guard rails. Goals are designed for runs that legitimately
  // span days, so length is bounded by pathology detection (no-progress
  // streaks, budget exhaustion), never by count. goalMaxAutoContinuations is
  // therefore UNSET by default (no cap); deployments may configure one, and
  // it then acts as a hard ceiling that per-goal overrides can only lower.
  goalMaxAutoContinuations: z.coerce.number().int().positive().optional(),
  goalNoProgressLimit: z.coerce.number().int().positive().default(3),
  // Per-segment ceiling on agent loop turns (model calls) within a single
  // session turn. Effectively unbounded by default for the same reason as
  // above; the graceful max-turns valve (idle + goal continuation, never a
  // session failure) remains as inert safety should a deployment set a cap.
  agentMaxModelCallsPerTurn: z.coerce.number().int().positive().default(1_000_000),
  // Where turn-input conversation history comes from (issue #35):
  // "items" (default) = the session_history_items table (SDK-native,
  // version-stable conversation truth); "run_state" = the legacy serialized
  // RunState blob. Items and the sandbox envelope are dual-written
  // unconditionally; this flag governs the read path only, so flipping back to
  // "run_state" remains a safe rollback at any time.
  sessionHistorySource: z.enum(["run_state", "items"]).default("items"),
  // Provider-aware conversation context management (long-lived sessions
  // otherwise grow unbounded until they overflow the model context window and
  // hard-fail every turn). Resolution (see resolveContextCompactionMode):
  //   "auto" (default) -> "server" when openaiProvider === "openai" (the
  //     OpenAI platform Responses API honors server-side context_management),
  //     else "client" (Azure rejects context_management with a 400, so we run
  //     our own client-side compaction).
  //   "server" / "client" -> force that path regardless of provider.
  //   "off" -> neither path (legacy unbounded growth; escape hatch only).
  contextCompactionMode: z.enum(["auto", "server", "client", "off"]).default("auto"),
  // The model's real context window in tokens. gpt-5.5's true window is
  // 1,050,000; it is absent from the SDK's hardcoded compaction window map (it
  // knows only up to gpt-5.4), so the SDK's DynamicCompactionPolicy would fall
  // back to a wrong 240k. We pass an explicit StaticCompactionPolicy threshold
  // derived from these settings on the server path, and use the same numbers to
  // budget the client path.
  contextWindowTokens: z.coerce.number().int().positive().default(1_050_000),
  // Tokens reserved for model output; subtracted from the window to get the
  // usable input budget B = contextWindowTokens - contextReservedOutputTokens.
  contextReservedOutputTokens: z.coerce.number().int().nonnegative().default(128_000),
  // Server path only: explicit compact_threshold (tokens) handed to the SDK's
  // StaticCompactionPolicy. Defaults to floor(B * contextCompactSoftFraction)
  // when unset.
  contextServerCompactThresholdTokens: z.coerce.number().int().positive().optional(),
  // Client path: compact pre-turn when the last turn's actual input tokens
  // reach softFraction*B; hard-force at hardFraction*B.
  contextCompactSoftFraction: z.coerce.number().positive().max(1).default(0.70),
  contextCompactHardFraction: z.coerce.number().positive().max(1).default(0.85),
  // Client path: tokens of the most recent FULL turns kept verbatim after a
  // compaction (the live working set: recent tool results, not just messages).
  contextKeepRecentTokens: z.coerce.number().int().positive().default(32_000),
  // Client path: token ceiling on the generated summary body.
  contextSummaryMaxTokens: z.coerce.number().int().positive().default(20_000),
  authRequired: EnvBoolean.default(false),
  accessKey: z.string().optional(),
  authAllowHealth: EnvBoolean.default(true),
  authAllowMetrics: EnvBoolean.default(false),
  apiHost: z.string().default("0.0.0.0"),
  apiPort: z.coerce.number().int().positive().default(8000),
  opengeniMcpUrl: z.string().url().optional(),
  corsAllowOriginRegex: z.string().default(String.raw`^https?://(localhost|127\.0\.0\.1)(:\d+)?$`),
  openaiProvider: z.enum(["openai", "azure"]).default("openai"),
  openaiApiKey: z.string().optional(),
  openaiBaseUrl: z.string().optional(),
  openaiModel: z.string().default("gpt-5.5"),
  openaiAllowedModels: z.string().default("gpt-5.5,gpt-5.4,gpt-5.4-mini"),
  modelPricingJson: z.string().default("{}"),
  // Extra (non-built-in) model providers, declared by the host as a JSON
  // provider registry. Each entry carries its own base URL, API key, wire API
  // ("responses" | "chat") and the models it exposes. The models a client may
  // use are the UNION of the built-in provider's allowed models and every
  // registry provider's models. validateSettings parses this at boot so a
  // malformed registry / unresolvable key / id collision fails fast.
  modelProvidersJson: z.string().default("[]"),
  openaiReasoningEffort: ReasoningEffort.default("low"),
  openaiAllowedReasoningEfforts: z.string().default("low,medium,high,xhigh"),
  openaiResponsesTransport: z.enum(["http", "websocket"]).default("http"),
  // Provider-assigned item ids (rs_/msg_/fc_…) in Responses API input are
  // resolved against the provider's server-side response store. That store is
  // not durable enough to anchor long runs on: a response that streamed fine
  // can be missing from the store on the very next model call, which then
  // fails with 400 "Item with id ... not found". "strip" removes the ids from
  // every model-call input so requests are self-contained — conversation
  // truth already lives client-side in session_history_items. "preserve"
  // keeps the SDK's pass-through behavior.
  openaiProviderItemIds: z.enum(["strip", "preserve"]).default("strip"),
  // With ids stripped the provider cannot resolve prior reasoning server-side,
  // so request reasoning.encrypted_content and send it back with each call:
  // reasoning continuity without depending on provider-side storage.
  openaiReasoningEncryptedContent: EnvBoolean.default(true),
  // Model-call retry budget for transient provider failures (429s and friends).
  // The openai client default of 2 retries is too small for sustained TPM
  // backpressure during long autonomous runs.
  openaiMaxRetries: z.coerce.number().int().nonnegative().default(5),
  // Native hosted web search. The live Azure Responses path executes the
  // hosted web_search tool, so this is provider-unconditional: ON by default
  // on every provider, exposed only so operators can disable it. When true,
  // buildOpenGeniAgent attaches webSearchTool() to the agent's tools — it is
  // merged with the MCP-server tools (getAllTools = [...mcpTools, ...tools])
  // and the sandbox capability tools, never replacing them.
  webSearchEnabled: EnvBoolean.default(true),
  // Deployment-default agent persona template (the white-label surface). The
  // runtime resolves the effective template per turn as
  // per-session-override > per-workspace override > this default, substitutes
  // the non-bypassable CORE at AGENT_INSTRUCTIONS_CORE_PLACEHOLDER (or appends
  // it when the template omits the marker), and uses the result as the agent's
  // instructions. Defaulting to DEFAULT_AGENT_INSTRUCTIONS keeps the composed
  // default byte-identical to the historical hardcoded preamble.
  agentInstructionsTemplate: z.string().default(DEFAULT_AGENT_INSTRUCTIONS),
  azureOpenaiBaseUrl: z.string().optional(),
  azureOpenaiEndpoint: z.string().optional(),
  azureOpenaiDeployment: z.string().optional(),
  azureOpenaiApiVersion: z.string().optional(),
  azureOpenaiApiKey: z.string().optional(),
  azureOpenaiAdToken: z.string().optional(),
  disableOpenaiTracing: EnvBoolean.default(false),
  sandboxBackend: SandboxBackend.default("docker"),
  dockerImage: z.string().default("opengeni-sandbox:local"),
  dockerExposedPorts: z.string().default(""),
  dockerNetwork: z.string().optional(),
  modalAppName: z.string().default("opengeni-sandbox"),
  modalImageRef: z.string().optional(),
  modalTimeoutSeconds: z.coerce.number().int().positive().default(900),
  modalTokenId: z.string().optional(),
  modalTokenSecret: z.string().optional(),
  modalEnvironment: z.string().optional(),
  sandboxPreparationProfiles: z.string().default("none"),
  sandboxEnvAllowlist: z.string().default(""),
  objectStorageEndpoint: z.string().url().optional(),
  objectStorageSandboxEndpoint: z.string().url().optional(),
  objectStorageBackend: z.enum(["s3-compatible", "aws-s3", "azure-blob", "gcs"]).default("s3-compatible"),
  objectStorageBucket: z.string().min(1).default("opengeni-files"),
  objectStorageRegion: z.string().min(1).default("us-east-1"),
  objectStorageS3Provider: z.string().min(1).default("Minio"),
  objectStorageAccessKeyId: z.string().optional(),
  objectStorageSecretAccessKey: z.string().optional(),
  objectStorageForcePathStyle: EnvBoolean.default(true),
  objectStorageAzureConnectionString: z.string().optional(),
  objectStorageAzureAccountName: z.string().optional(),
  objectStorageAzureAccountKey: z.string().optional(),
  objectStorageAzureEndpoint: z.string().url().optional(),
  objectStorageGcsProjectId: z.string().optional(),
  objectStorageGcsCredentialsJson: z.string().optional(),
  objectStorageGcsKeyFilename: z.string().optional(),
  objectStorageGcsApiEndpoint: z.string().url().optional(),
  documentParser: z.string().min(1).default("liteparse"),
  documentChunkSize: z.coerce.number().int().positive().default(1200),
  documentChunkOverlap: z.coerce.number().int().nonnegative().default(160),
  documentEmbeddingProvider: z.enum(["openai", "deterministic"]).default("openai"),
  documentEmbeddingModel: z.string().min(1).default("text-embedding-3-large"),
  documentEmbeddingDimensions: z.coerce.number().int().positive().default(3072),
  documentEmbeddingApiKey: z.string().optional(),
  documentEmbeddingBaseUrl: z.string().url().optional(),
  gitAuthorName: z.string().optional(),
  gitAuthorEmail: z.string().optional(),
  gitCommitterName: z.string().optional(),
  gitCommitterEmail: z.string().optional(),
  githubAppManifestBaseUrl: z.string().optional(),
  githubAppManifestStateSecret: z.string().optional(),
  githubAppId: z.string().optional(),
  githubClientId: z.string().optional(),
  githubClientSecret: z.string().optional(),
  githubAppSlug: z.string().optional(),
  githubWebhookSecret: z.string().optional(),
  githubAppPrivateKey: z.string().optional(),
  betterAuthSecret: z.string().optional(),
  betterAuthAllowedHosts: z.string().default(""),
  betterAuthCookieDomain: z.string().optional(),
  betterAuthTrustedOrigins: z.string().default(""),
  resendApiKey: z.string().optional(),
  emailFrom: z.string().default("OpenGeni <auth@mail.opengeni.ai>"),
  stripeSecretKey: z.string().optional(),
  stripePublishableKey: z.string().optional(),
  stripeWebhookSecret: z.string().optional(),
  stripeCreditsProductId: z.string().optional(),
  mcpServers: z.array(z.object({
    id: z.string().min(1).regex(registryId),
    name: z.string().min(1).optional(),
    url: z.string().url(),
    allowedTools: z.array(z.string().min(1)).optional(),
    timeoutMs: z.number().int().positive().optional(),
    cacheToolsList: z.boolean().default(false),
    /**
     * Extra request headers sent to this MCP server (credential injection
     * for workspace-enabled capability MCPs). Populated at runtime from
     * encrypted capability-installation credentials; do not put secrets in
     * OPENGENI_MCP_SERVERS.
     */
    headers: z.record(z.string(), z.string()).optional(),
  })).default([]),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type McpServerConfig = Settings["mcpServers"][number];
export type ModelPricing = {
  inputMicrosPerMillionTokens: number;
  cachedInputMicrosPerMillionTokens?: number | undefined;
  outputMicrosPerMillionTokens: number;
  marginBps?: number | undefined;
};
export type ModelUsageInput = {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
  inputTokensDetails?: Record<string, number> | Array<Record<string, number>> | undefined;
  requestUsageEntries?: ModelUsageInput[] | undefined;
};

export type StaticUsageLimitsConfig = StaticUsageLimits;
export type EntitlementsConfig = Entitlements;

const ModelPricingSchema = z.object({
  inputMicrosPerMillionTokens: z.number().int().nonnegative(),
  cachedInputMicrosPerMillionTokens: z.number().int().nonnegative().optional(),
  outputMicrosPerMillionTokens: z.number().int().nonnegative(),
  marginBps: z.number().int().min(0).max(100_000).optional(),
});

/**
 * Wire API a provider speaks. The built-in OpenAI/Azure provider always uses
 * "responses" (the OpenAI Responses API). Extra registry providers default to
 * "chat" (the broadly compatible /v1/chat/completions surface); Fireworks is
 * wired as "chat" because its beta Responses endpoint echoes input back and
 * silently no-ops hosted tools (see docs/model-providers.md).
 */
export const ModelProviderApi = z.enum(["responses", "chat"]);
export type ModelProviderApi = z.infer<typeof ModelProviderApi>;

/** A single model exposed by a registry provider. */
const RegistryModelSchema = z.object({
  id: z.string().min(1),                 // model id sent to the provider, e.g. "accounts/fireworks/models/glm-5p2"
  label: z.string().min(1).optional(),   // display name; defaults to id
  contextWindowTokens: z.number().int().positive().optional(),
  reasoningEffort: z.boolean().optional(),  // model accepts a reasoning-effort control
  hostedWebSearch: z.boolean().optional(),  // provider executes the hosted web_search tool for this model
  pricing: ModelPricingSchema.optional(),
});

/** A non-built-in provider declared by the host via OPENGENI_MODEL_PROVIDERS_JSON. */
const RegistryProviderSchema = z.object({
  id: z.string().min(1).regex(registryId),  // stable provider id, e.g. "fireworks"
  label: z.string().min(1).optional(),
  api: ModelProviderApi.default("chat"),
  baseUrl: z.string().url(),
  apiKey: z.string().optional(),         // inline key (pragmatic) ...
  apiKeyEnv: z.string().optional(),      // ... OR name of the env var holding the key (preferred)
  defaultQuery: z.record(z.string(), z.string()).optional(),
  defaultHeaders: z.record(z.string(), z.string()).optional(),
  models: z.array(RegistryModelSchema).min(1),
});
export type RegistryProvider = z.infer<typeof RegistryProviderSchema>;

/**
 * Runtime-resolved provider (built-in or registry), client-construction-ready.
 * The built-in OpenAI/Azure provider is always present and always "responses";
 * registry providers carry their own base URL / key / wire API. compactionMode
 * is "server" only for the built-in OpenAI platform provider (its Responses API
 * honors server-side context_management) and "client" for everything else.
 */
export interface ResolvedModelProvider {
  id: string;                  // "openai" | "azure" | registry id
  label: string;
  api: ModelProviderApi;
  builtin: boolean;
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  defaultQuery?: Record<string, string> | undefined;
  defaultHeaders?: Record<string, string> | undefined;
  compactionMode: ContextCompactionMode;   // "server" only for built-in OpenAI; "client" otherwise
}

/** A single exposed model + the provider that serves it. */
export interface ConfiguredModel {
  id: string;
  label: string;
  providerId: string;
  providerLabel: string;
  api: ModelProviderApi;
  contextWindowTokens?: number | undefined;
  reasoningEffort: boolean;
  hostedWebSearch: boolean;
}

export const defaultModelPricing: Record<string, ModelPricing> = {
  "gpt-5.5": {
    inputMicrosPerMillionTokens: 5_000_000,
    cachedInputMicrosPerMillionTokens: 500_000,
    outputMicrosPerMillionTokens: 30_000_000,
    marginBps: 2_500,
  },
  "gpt-5.4": {
    inputMicrosPerMillionTokens: 2_500_000,
    cachedInputMicrosPerMillionTokens: 250_000,
    outputMicrosPerMillionTokens: 15_000_000,
    marginBps: 2_500,
  },
  "gpt-5.4-mini": {
    inputMicrosPerMillionTokens: 750_000,
    cachedInputMicrosPerMillionTokens: 75_000,
    outputMicrosPerMillionTokens: 4_500_000,
    marginBps: 2_500,
  },
  "gpt-5.2": {
    inputMicrosPerMillionTokens: 1_750_000,
    cachedInputMicrosPerMillionTokens: 175_000,
    outputMicrosPerMillionTokens: 14_000_000,
    marginBps: 2_500,
  },
  "gpt-5.2-chat-latest": {
    inputMicrosPerMillionTokens: 1_750_000,
    cachedInputMicrosPerMillionTokens: 175_000,
    outputMicrosPerMillionTokens: 14_000_000,
    marginBps: 2_500,
  },
  "gpt-5.2-codex": {
    inputMicrosPerMillionTokens: 1_750_000,
    cachedInputMicrosPerMillionTokens: 175_000,
    outputMicrosPerMillionTokens: 14_000_000,
    marginBps: 2_500,
  },
  "gpt-5.1": {
    inputMicrosPerMillionTokens: 1_250_000,
    cachedInputMicrosPerMillionTokens: 125_000,
    outputMicrosPerMillionTokens: 10_000_000,
    marginBps: 2_500,
  },
  "gpt-5": {
    inputMicrosPerMillionTokens: 1_250_000,
    cachedInputMicrosPerMillionTokens: 125_000,
    outputMicrosPerMillionTokens: 10_000_000,
    marginBps: 2_500,
  },
  "gpt-5-mini": {
    inputMicrosPerMillionTokens: 250_000,
    cachedInputMicrosPerMillionTokens: 25_000,
    outputMicrosPerMillionTokens: 2_000_000,
    marginBps: 2_500,
  },
  "gpt-5-nano": {
    inputMicrosPerMillionTokens: 50_000,
    cachedInputMicrosPerMillionTokens: 5_000,
    outputMicrosPerMillionTokens: 400_000,
    marginBps: 2_500,
  },
  // Fireworks AI / GLM 5.2 — the first shipped non-OpenAI registry model. A
  // built-in default pricing entry makes managed billing work out of the box
  // for hosts that expose this model via OPENGENI_MODEL_PROVIDERS_JSON without
  // also setting OPENGENI_MODEL_PRICING_JSON.
  "accounts/fireworks/models/glm-5p2": {
    inputMicrosPerMillionTokens: 1_400_000,
    cachedInputMicrosPerMillionTokens: 260_000,
    outputMicrosPerMillionTokens: 4_400_000,
    marginBps: 2_500,
  },
};

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : undefined;
}

export function getSettings(): Settings {
  const raw = {
    serviceName: optional("OPENGENI_SERVICE_NAME"),
    environment: optional("OPENGENI_ENVIRONMENT"),
    deploymentRevision: optional("OPENGENI_DEPLOYMENT_REVISION") ?? optional("SOURCE_VERSION") ?? optional("GITHUB_SHA"),
    databaseUrl: optional("OPENGENI_DATABASE_URL"),
    natsUrl: optional("OPENGENI_NATS_URL"),
    temporalHost: optional("OPENGENI_TEMPORAL_HOST"),
    temporalNamespace: optional("OPENGENI_TEMPORAL_NAMESPACE"),
    temporalTaskQueue: optional("OPENGENI_TEMPORAL_TASK_QUEUE"),
    startupDependencyRetryAttempts: optional("OPENGENI_STARTUP_DEPENDENCY_RETRY_ATTEMPTS"),
    startupDependencyRetryInitialDelayMs: optional("OPENGENI_STARTUP_DEPENDENCY_RETRY_INITIAL_DELAY_MS"),
    startupDependencyRetryMaxDelayMs: optional("OPENGENI_STARTUP_DEPENDENCY_RETRY_MAX_DELAY_MS"),
    observabilityStructuredLogs: optional("OPENGENI_OBSERVABILITY_STRUCTURED_LOGS"),
    observabilityMetricsEnabled: optional("OPENGENI_OBSERVABILITY_METRICS_ENABLED"),
    observabilityOtlpEndpoint: optional("OPENGENI_OTEL_EXPORTER_OTLP_ENDPOINT") ?? optional("OTEL_EXPORTER_OTLP_ENDPOINT"),
    observabilityOtlpHeaders: optional("OPENGENI_OTEL_EXPORTER_OTLP_HEADERS") ?? optional("OTEL_EXPORTER_OTLP_HEADERS"),
    publicBaseUrl: optional("OPENGENI_PUBLIC_BASE_URL"),
    productAccessMode: optional("OPENGENI_PRODUCT_ACCESS_MODE"),
    billingMode: optional("OPENGENI_BILLING_MODE"),
    entitlementsMode: optional("OPENGENI_ENTITLEMENTS_MODE"),
    usageLimitsMode: optional("OPENGENI_USAGE_LIMITS_MODE"),
    staticEntitlementsJson: optional("OPENGENI_STATIC_ENTITLEMENTS_JSON"),
    staticUsageLimitsJson: optional("OPENGENI_STATIC_USAGE_LIMITS_JSON"),
    delegationSecret: optional("OPENGENI_DELEGATION_SECRET"),
    environmentsEncryptionKey: optional("OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY"),
    goalMaxAutoContinuations: optional("OPENGENI_GOAL_MAX_AUTO_CONTINUATIONS"),
    goalNoProgressLimit: optional("OPENGENI_GOAL_NO_PROGRESS_LIMIT"),
    agentMaxModelCallsPerTurn: optional("OPENGENI_AGENT_MAX_MODEL_CALLS_PER_TURN"),
    sessionHistorySource: optional("OPENGENI_SESSION_HISTORY_SOURCE"),
    contextCompactionMode: optional("OPENGENI_CONTEXT_COMPACTION_MODE"),
    contextWindowTokens: optional("OPENGENI_CONTEXT_WINDOW_TOKENS"),
    contextReservedOutputTokens: optional("OPENGENI_CONTEXT_RESERVED_OUTPUT_TOKENS"),
    contextServerCompactThresholdTokens: optional("OPENGENI_CONTEXT_SERVER_COMPACT_THRESHOLD_TOKENS"),
    contextCompactSoftFraction: optional("OPENGENI_CONTEXT_COMPACT_SOFT_FRACTION"),
    contextCompactHardFraction: optional("OPENGENI_CONTEXT_COMPACT_HARD_FRACTION"),
    contextKeepRecentTokens: optional("OPENGENI_CONTEXT_KEEP_RECENT_TOKENS"),
    contextSummaryMaxTokens: optional("OPENGENI_CONTEXT_SUMMARY_MAX_TOKENS"),
    authRequired: optional("OPENGENI_AUTH_REQUIRED"),
    accessKey: optional("OPENGENI_ACCESS_KEY"),
    authAllowHealth: optional("OPENGENI_AUTH_ALLOW_HEALTH"),
    authAllowMetrics: optional("OPENGENI_AUTH_ALLOW_METRICS"),
    apiHost: optional("OPENGENI_API_HOST"),
    apiPort: optional("OPENGENI_API_PORT"),
    opengeniMcpUrl: optional("OPENGENI_MCP_URL"),
    corsAllowOriginRegex: optional("OPENGENI_CORS_ALLOW_ORIGIN_REGEX"),
    openaiProvider: optional("OPENGENI_OPENAI_PROVIDER"),
    openaiApiKey: optional("OPENGENI_OPENAI_API_KEY") ?? optional("OPENAI_API_KEY"),
    openaiBaseUrl: optional("OPENGENI_OPENAI_BASE_URL") ?? optional("OPENAI_BASE_URL"),
    openaiModel: optional("OPENGENI_OPENAI_MODEL"),
    openaiAllowedModels: optional("OPENGENI_OPENAI_ALLOWED_MODELS"),
    modelPricingJson: optional("OPENGENI_MODEL_PRICING_JSON"),
    modelProvidersJson: optional("OPENGENI_MODEL_PROVIDERS_JSON"),
    openaiReasoningEffort: optional("OPENGENI_OPENAI_REASONING_EFFORT"),
    openaiAllowedReasoningEfforts: optional("OPENGENI_OPENAI_ALLOWED_REASONING_EFFORTS"),
    openaiResponsesTransport: optional("OPENGENI_OPENAI_RESPONSES_TRANSPORT"),
    openaiProviderItemIds: optional("OPENGENI_OPENAI_PROVIDER_ITEM_IDS"),
    openaiReasoningEncryptedContent: optional("OPENGENI_OPENAI_REASONING_ENCRYPTED_CONTENT"),
    openaiMaxRetries: optional("OPENGENI_OPENAI_MAX_RETRIES"),
    webSearchEnabled: optional("OPENGENI_WEB_SEARCH_ENABLED"),
    agentInstructionsTemplate: optional("OPENGENI_AGENT_INSTRUCTIONS_TEMPLATE"),
    azureOpenaiBaseUrl: optional("OPENGENI_AZURE_OPENAI_BASE_URL"),
    azureOpenaiEndpoint: optional("OPENGENI_AZURE_OPENAI_ENDPOINT"),
    azureOpenaiDeployment: optional("OPENGENI_AZURE_OPENAI_DEPLOYMENT"),
    azureOpenaiApiVersion: optional("OPENGENI_AZURE_OPENAI_API_VERSION"),
    azureOpenaiApiKey: optional("OPENGENI_AZURE_OPENAI_API_KEY"),
    azureOpenaiAdToken: optional("OPENGENI_AZURE_OPENAI_AD_TOKEN"),
    disableOpenaiTracing: optional("OPENGENI_DISABLE_OPENAI_TRACING"),
    sandboxBackend: optional("OPENGENI_SANDBOX_BACKEND"),
    dockerImage: optional("OPENGENI_DOCKER_IMAGE"),
    dockerExposedPorts: optional("OPENGENI_DOCKER_EXPOSED_PORTS"),
    dockerNetwork: optional("OPENGENI_DOCKER_NETWORK"),
    modalAppName: optional("OPENGENI_MODAL_APP_NAME"),
    modalImageRef: optional("OPENGENI_MODAL_IMAGE_REF"),
    modalTimeoutSeconds: optional("OPENGENI_MODAL_TIMEOUT_SECONDS"),
    modalTokenId: optional("OPENGENI_MODAL_TOKEN_ID"),
    modalTokenSecret: optional("OPENGENI_MODAL_TOKEN_SECRET"),
    modalEnvironment: optional("OPENGENI_MODAL_ENVIRONMENT"),
    sandboxPreparationProfiles: optional("OPENGENI_SANDBOX_PREPARATION_PROFILES"),
    sandboxEnvAllowlist: optional("OPENGENI_SANDBOX_ENV_ALLOWLIST"),
    objectStorageEndpoint: optional("OPENGENI_OBJECT_STORAGE_ENDPOINT"),
    objectStorageSandboxEndpoint: optional("OPENGENI_OBJECT_STORAGE_SANDBOX_ENDPOINT"),
    objectStorageBackend: optional("OPENGENI_OBJECT_STORAGE_BACKEND"),
    objectStorageBucket: optional("OPENGENI_OBJECT_STORAGE_BUCKET"),
    objectStorageRegion: optional("OPENGENI_OBJECT_STORAGE_REGION"),
    objectStorageS3Provider: optional("OPENGENI_OBJECT_STORAGE_S3_PROVIDER"),
    objectStorageAccessKeyId: optional("OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID"),
    objectStorageSecretAccessKey: optional("OPENGENI_OBJECT_STORAGE_SECRET_ACCESS_KEY"),
    objectStorageForcePathStyle: optional("OPENGENI_OBJECT_STORAGE_FORCE_PATH_STYLE"),
    objectStorageAzureConnectionString: optional("OPENGENI_OBJECT_STORAGE_AZURE_CONNECTION_STRING"),
    objectStorageAzureAccountName: optional("OPENGENI_OBJECT_STORAGE_AZURE_ACCOUNT_NAME"),
    objectStorageAzureAccountKey: optional("OPENGENI_OBJECT_STORAGE_AZURE_ACCOUNT_KEY"),
    objectStorageAzureEndpoint: optional("OPENGENI_OBJECT_STORAGE_AZURE_ENDPOINT"),
    objectStorageGcsProjectId: optional("OPENGENI_OBJECT_STORAGE_GCS_PROJECT_ID"),
    objectStorageGcsCredentialsJson: optional("OPENGENI_OBJECT_STORAGE_GCS_CREDENTIALS_JSON"),
    objectStorageGcsKeyFilename: optional("OPENGENI_OBJECT_STORAGE_GCS_KEY_FILENAME"),
    objectStorageGcsApiEndpoint: optional("OPENGENI_OBJECT_STORAGE_GCS_API_ENDPOINT"),
    documentParser: optional("OPENGENI_DOCUMENT_PARSER"),
    documentChunkSize: optional("OPENGENI_DOCUMENT_CHUNK_SIZE"),
    documentChunkOverlap: optional("OPENGENI_DOCUMENT_CHUNK_OVERLAP"),
    documentEmbeddingProvider: optional("OPENGENI_DOCUMENT_EMBEDDING_PROVIDER"),
    documentEmbeddingModel: optional("OPENGENI_DOCUMENT_EMBEDDING_MODEL"),
    documentEmbeddingDimensions: optional("OPENGENI_DOCUMENT_EMBEDDING_DIMENSIONS"),
    documentEmbeddingApiKey: optional("OPENGENI_DOCUMENT_EMBEDDING_API_KEY"),
    documentEmbeddingBaseUrl: optional("OPENGENI_DOCUMENT_EMBEDDING_BASE_URL"),
    gitAuthorName: optional("OPENGENI_GIT_AUTHOR_NAME"),
    gitAuthorEmail: optional("OPENGENI_GIT_AUTHOR_EMAIL"),
    gitCommitterName: optional("OPENGENI_GIT_COMMITTER_NAME"),
    gitCommitterEmail: optional("OPENGENI_GIT_COMMITTER_EMAIL"),
    githubAppManifestBaseUrl: optional("OPENGENI_GITHUB_APP_MANIFEST_BASE_URL"),
    githubAppManifestStateSecret: optional("OPENGENI_GITHUB_APP_MANIFEST_STATE_SECRET"),
    githubAppId: optional("OPENGENI_GITHUB_APP_ID"),
    githubClientId: optional("OPENGENI_GITHUB_CLIENT_ID"),
    githubClientSecret: optional("OPENGENI_GITHUB_CLIENT_SECRET"),
    githubAppSlug: optional("OPENGENI_GITHUB_APP_SLUG"),
    githubWebhookSecret: optional("OPENGENI_GITHUB_WEBHOOK_SECRET"),
    githubAppPrivateKey: optional("OPENGENI_GITHUB_APP_PRIVATE_KEY"),
    betterAuthSecret: optional("OPENGENI_BETTER_AUTH_SECRET"),
    betterAuthAllowedHosts: optional("OPENGENI_BETTER_AUTH_ALLOWED_HOSTS"),
    betterAuthCookieDomain: optional("OPENGENI_BETTER_AUTH_COOKIE_DOMAIN"),
    betterAuthTrustedOrigins: optional("OPENGENI_BETTER_AUTH_TRUSTED_ORIGINS"),
    resendApiKey: optional("OPENGENI_RESEND_API_KEY"),
    emailFrom: optional("OPENGENI_EMAIL_FROM"),
    stripeSecretKey: optional("OPENGENI_STRIPE_SECRET_KEY"),
    stripePublishableKey: optional("OPENGENI_STRIPE_PUBLISHABLE_KEY"),
    stripeWebhookSecret: optional("OPENGENI_STRIPE_WEBHOOK_SECRET"),
    stripeCreditsProductId: optional("OPENGENI_STRIPE_CREDITS_PRODUCT_ID"),
    mcpServers: parseMcpServers(optional("OPENGENI_MCP_SERVERS")),
  };
  const parsed = SettingsSchema.parse(raw);
  const settings = {
    ...parsed,
    mcpServers: ensureBuiltInMcpServers(parsed),
  };
  validateSettings(settings);
  return settings;
}

export function collectSandboxEnvironment(settings: Settings, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of sandboxEnvironmentVariableNames(settings)) {
    const value = source[name];
    if (value) {
      out[name] = value;
    }
  }
  return out;
}

/**
 * Resolved API key for a registry provider: the inline `apiKey` when present,
 * else the value of the env var named by `apiKeyEnv`. The preferred form is
 * `apiKeyEnv` (the secret stays out of OPENGENI_MODEL_PROVIDERS_JSON). Reads
 * from `source` (defaults to process.env) so callers can resolve against an
 * explicit environment in tests.
 */
export function resolveProviderApiKey(
  provider: Pick<RegistryProvider, "apiKey" | "apiKeyEnv">,
  source: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (provider.apiKey) {
    return provider.apiKey;
  }
  if (provider.apiKeyEnv) {
    const value = source[provider.apiKeyEnv];
    return value && value.trim().length > 0 ? value : undefined;
  }
  return undefined;
}

/** The built-in provider's stable id: "openai" on the OpenAI platform, "azure" on Azure. */
function builtinProviderId(settings: Pick<Settings, "openaiProvider">): string {
  return settings.openaiProvider === "azure" ? "azure" : "openai";
}

function builtinProviderLabel(settings: Pick<Settings, "openaiProvider">): string {
  return settings.openaiProvider === "azure" ? "Azure OpenAI" : "OpenAI";
}

/**
 * Every provider a client may route to: the built-in OpenAI/Azure provider
 * first (id "openai"/"azure", always "responses", compactionMode from
 * resolveContextCompactionMode), then each registry provider in declaration
 * order (compactionMode "client"). Client-construction inputs are filled from
 * the existing flat openai/azure settings for the built-in, and from the
 * registry entry for the rest. Registry ids may not collide with the built-in
 * id — validateSettings rejects that at boot.
 */
export function configuredProviders(settings: Settings): ResolvedModelProvider[] {
  const builtin: ResolvedModelProvider = {
    id: builtinProviderId(settings),
    label: builtinProviderLabel(settings),
    api: "responses",
    builtin: true,
    compactionMode: resolveContextCompactionMode(settings),
  };
  if (settings.openaiProvider === "azure") {
    builtin.baseUrl = settings.azureOpenaiBaseUrl ?? settings.azureOpenaiEndpoint;
    builtin.apiKey = settings.azureOpenaiApiKey ?? settings.azureOpenaiAdToken;
  } else {
    builtin.baseUrl = settings.openaiBaseUrl;
    builtin.apiKey = settings.openaiApiKey;
  }
  const registry = parseModelProvidersJson(settings.modelProvidersJson).map((provider): ResolvedModelProvider => ({
    id: provider.id,
    label: provider.label ?? provider.id,
    api: provider.api,
    builtin: false,
    baseUrl: provider.baseUrl,
    apiKey: resolveProviderApiKey(provider),
    defaultQuery: provider.defaultQuery,
    defaultHeaders: provider.defaultHeaders,
    compactionMode: "client",
  }));
  return [builtin, ...registry];
}

/**
 * Every model a client may use, the built-in provider's models first
 * (configuredAllowedModels-from-openai, mapped to "responses" with
 * hostedWebSearch/contextWindow/reasoningEffort from the flat settings), then
 * each registry provider's models (label→id, hostedWebSearch/reasoningEffort
 * default false). De-duplicated by id (first wins) so the default model stays
 * first and the built-in allow-list takes precedence over registry entries.
 */
export function configuredModels(settings: Settings): ConfiguredModel[] {
  const builtinId = builtinProviderId(settings);
  const builtinLabel = builtinProviderLabel(settings);
  const out: ConfiguredModel[] = uniqueValues([settings.openaiModel, ...splitCsv(settings.openaiAllowedModels)]).map((id) => ({
    id,
    label: id,
    providerId: builtinId,
    providerLabel: builtinLabel,
    api: "responses" as const,
    contextWindowTokens: settings.contextWindowTokens,
    reasoningEffort: true,
    hostedWebSearch: settings.webSearchEnabled,
  }));
  for (const provider of parseModelProvidersJson(settings.modelProvidersJson)) {
    const providerLabel = provider.label ?? provider.id;
    for (const model of provider.models) {
      out.push({
        id: model.id,
        label: model.label ?? model.id,
        providerId: provider.id,
        providerLabel,
        api: provider.api,
        ...(model.contextWindowTokens === undefined ? {} : { contextWindowTokens: model.contextWindowTokens }),
        reasoningEffort: model.reasoningEffort ?? false,
        hostedWebSearch: model.hostedWebSearch ?? false,
      });
    }
  }
  const seen = new Set<string>();
  return out.filter((model) => {
    if (seen.has(model.id)) {
      return false;
    }
    seen.add(model.id);
    return true;
  });
}

/**
 * Allowed model ids in selection order. Reimplemented on top of
 * configuredModels so it is the union of the built-in allow-list and every
 * registry provider's ids, de-duplicated. INVARIANT (existing callers + tests
 * depend on it): settings.openaiModel is always first, then the rest of the
 * openai allow-list, then registry ids.
 */
export function configuredAllowedModels(settings: Settings): string[] {
  return configuredModels(settings).map((model) => model.id);
}

/**
 * Resolve a model string to the provider that serves it and its configured
 * shape. Returns undefined when the id is not exposed (built-in allow-list nor
 * any registry provider), so the runtime can fall back to the legacy global
 * client path.
 */
export function resolveModelProvider(
  settings: Settings,
  modelId: string,
): { provider: ResolvedModelProvider; model: ConfiguredModel } | undefined {
  const model = configuredModels(settings).find((candidate) => candidate.id === modelId);
  if (!model) {
    return undefined;
  }
  const provider = configuredProviders(settings).find((candidate) => candidate.id === model.providerId);
  if (!provider) {
    return undefined;
  }
  return { provider, model };
}

/**
 * Effective per-model pricing. Merge order (later wins):
 *   defaultModelPricing → registry model `pricing` entries (keyed by model id)
 *   → parseModelPricingJson(settings.modelPricingJson) (explicit JSON wins).
 */
export function configuredModelPricing(settings: Settings): Record<string, ModelPricing> {
  const registry: Record<string, ModelPricing> = {};
  for (const provider of parseModelProvidersJson(settings.modelProvidersJson)) {
    for (const model of provider.models) {
      if (model.pricing) {
        registry[model.id] = model.pricing;
      }
    }
  }
  const configured = parseModelPricingJson(settings.modelPricingJson);
  return {
    ...defaultModelPricing,
    ...registry,
    ...configured,
  };
}

/**
 * Resolved conversation-context compaction path for a run.
 *  - "server": let the OpenAI platform Responses API compact server-side (the
 *    SDK emits context_management; we pass the correct gpt-5.5 threshold).
 *  - "client": run OpenGeni's own client-side compaction (Azure and any other
 *    backend that rejects/ignores context_management).
 *  - "off": neither (legacy unbounded growth; escape hatch).
 *
 * "auto" maps to "server" on the OpenAI platform provider and "client"
 * otherwise — Azure's Responses API returns 400 unsupported_parameter for
 * context_management, so it must never take the server path.
 */
export type ContextCompactionMode = "server" | "client" | "off";

export function resolveContextCompactionMode(settings: Pick<Settings, "contextCompactionMode" | "openaiProvider">): ContextCompactionMode {
  switch (settings.contextCompactionMode) {
    case "server":
      return "server";
    case "client":
      return "client";
    case "off":
      return "off";
    case "auto":
    default:
      return settings.openaiProvider === "openai" ? "server" : "client";
  }
}

/** Usable input-token budget B = window - reserved output. */
export function contextInputBudgetTokens(settings: Pick<Settings, "contextWindowTokens" | "contextReservedOutputTokens">): number {
  return Math.max(0, settings.contextWindowTokens - settings.contextReservedOutputTokens);
}

/**
 * Server-path compact_threshold (tokens) handed to the SDK's
 * StaticCompactionPolicy: the explicit override when set, else
 * floor(B * softFraction). This is what sidesteps the SDK's wrong 240k
 * fallback for gpt-5.5 (which is absent from its hardcoded window map).
 */
export function contextServerCompactThreshold(settings: Pick<Settings, "contextWindowTokens" | "contextReservedOutputTokens" | "contextServerCompactThresholdTokens" | "contextCompactSoftFraction">): number {
  if (settings.contextServerCompactThresholdTokens) {
    return settings.contextServerCompactThresholdTokens;
  }
  return Math.floor(contextInputBudgetTokens(settings) * settings.contextCompactSoftFraction);
}

export function configuredStaticUsageLimits(settings: Settings): StaticUsageLimitsConfig {
  return parseStaticUsageLimitsJson(settings.staticUsageLimitsJson);
}

export function configuredEntitlements(settings: Settings): EntitlementsConfig {
  if (settings.entitlementsMode === "none") {
    return {};
  }
  const configured = parseStaticEntitlementsJson(settings.staticEntitlementsJson);
  if (settings.entitlementsMode === "static") {
    return configured;
  }
  return {
    "managed.auth.email_password": true,
    "managed.billing.prepaid_credits": settings.billingMode === "stripe",
    "managed.api_keys": true,
    "managed.workspaces": true,
    "managed.github_app": Boolean(settings.githubAppId && settings.githubAppPrivateKey),
    ...configured,
  };
}

export function calculateModelUsageCostMicros(settings: Settings, model: string, usage: ModelUsageInput): number {
  const pricing = configuredModelPricing(settings)[model];
  if (!pricing) {
    throw new Error(`Missing model pricing for ${model}`);
  }
  const entries = usage.requestUsageEntries && usage.requestUsageEntries.length > 0 ? usage.requestUsageEntries : [usage];
  const rawCost = entries.reduce((sum, entry) => sum + calculateEntryCostMicros(pricing, entry), 0);
  const marginBps = pricing.marginBps ?? 0;
  return Math.ceil(rawCost * (10_000 + marginBps) / 10_000);
}

export function configuredAllowedReasoningEfforts(settings: Settings): Array<z.infer<typeof ReasoningEffort>> {
  return uniqueValues([settings.openaiReasoningEffort, ...splitCsv(settings.openaiAllowedReasoningEfforts)])
    .map((value) => ReasoningEffort.parse(value));
}

/**
 * Decodes OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY (base64, exactly 32 bytes) for
 * AES-256-GCM workspace environment value encryption. Returns null when unset.
 * Throws naming only the env var, never echoing its value.
 */
export function environmentsEncryptionKeyBytes(settings: Settings): Uint8Array | null {
  if (!settings.environmentsEncryptionKey) {
    return null;
  }
  const decoded = Buffer.from(settings.environmentsEncryptionKey, "base64");
  if (decoded.length !== 32) {
    throw new Error("OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY must be base64 for exactly 32 bytes (generate with: openssl rand -base64 32)");
  }
  return new Uint8Array(decoded);
}

export function collectGitIdentityEnvironment(settings: Settings): Record<string, string> {
  return Object.fromEntries(Object.entries({
    GIT_AUTHOR_NAME: settings.gitAuthorName,
    GIT_AUTHOR_EMAIL: settings.gitAuthorEmail,
    GIT_COMMITTER_NAME: settings.gitCommitterName ?? settings.gitAuthorName,
    GIT_COMMITTER_EMAIL: settings.gitCommitterEmail ?? settings.gitAuthorEmail,
  }).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0));
}

export type StartupRetryOptions = {
  attempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (event: {
    label: string;
    attempt: number;
    attempts: number;
    delayMs: number;
    error: unknown;
  }) => void;
};

export function startupRetryOptions(settings: Settings): Required<Omit<StartupRetryOptions, "onRetry">> {
  return {
    attempts: settings.startupDependencyRetryAttempts,
    initialDelayMs: settings.startupDependencyRetryInitialDelayMs,
    maxDelayMs: settings.startupDependencyRetryMaxDelayMs,
  };
}

export async function retryStartupDependency<T>(
  label: string,
  operation: () => Promise<T>,
  options: StartupRetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? 30));
  const initialDelayMs = Math.max(0, Math.floor(options.initialDelayMs ?? 1000));
  const maxDelayMs = Math.max(initialDelayMs, Math.floor(options.maxDelayMs ?? 5000));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts) {
        throw error;
      }
      const delayMs = Math.min(maxDelayMs, initialDelayMs * 2 ** (attempt - 1));
      options.onRetry?.({ label, attempt, attempts, delayMs, error });
      await delay(delayMs);
    }
  }
  throw new Error(`unreachable startup retry state for ${label}`);
}

export function sandboxEnvironmentVariableNames(settings: Settings): string[] {
  const profiles = sandboxPreparationProfileNames(settings);
  const names: string[] = [];
  for (const profile of profiles) {
    names.push(...sandboxPreparationProfiles[profile]!.env);
  }
  names.push(...splitCsv(settings.sandboxEnvAllowlist));
  return uniqueEnvNames(names, "sandbox env");
}

export function sandboxLifecycleHookIds(settings: Settings): string[] {
  const ids: string[] = [];
  for (const profile of sandboxPreparationProfileNames(settings)) {
    ids.push(...sandboxPreparationProfiles[profile]!.hooks);
  }
  return uniqueValues(ids);
}

function sandboxPreparationProfileNames(settings: Settings): string[] {
  const profiles = splitCsv(settings.sandboxPreparationProfiles).map((value) => value.toLowerCase());
  if (profiles.includes("none")) {
    if (profiles.length > 1) {
      throw new Error("OPENGENI_SANDBOX_PREPARATION_PROFILES cannot combine none with other profiles");
    }
    return ["none"];
  }
  for (const profile of profiles) {
    if (!sandboxPreparationProfiles[profile]) {
      throw new Error(`Unknown sandbox preparation profile ${profile}`);
    }
  }
  return profiles;
}

export function parseExposedPorts(raw: string): number[] {
  return splitCsv(raw).map((value) => {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("OPENGENI_DOCKER_EXPOSED_PORTS must contain TCP port numbers");
    }
    return port;
  });
}

export function parseMcpServers(raw: string | undefined): unknown[] | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error("value must be a JSON array");
    }
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`OPENGENI_MCP_SERVERS must be a JSON array: ${message}`);
  }
}

export function parseModelPricingJson(raw: string): Record<string, ModelPricing> {
  if (!raw.trim() || raw.trim() === "{}") {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`OPENGENI_MODEL_PRICING_JSON must be valid JSON: ${message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OPENGENI_MODEL_PRICING_JSON must be a JSON object keyed by model name");
  }
  const out: Record<string, ModelPricing> = {};
  for (const [model, value] of Object.entries(parsed)) {
    if (!model.trim()) {
      throw new Error("OPENGENI_MODEL_PRICING_JSON contains an empty model name");
    }
    out[model] = ModelPricingSchema.parse(value);
  }
  return out;
}

/**
 * Parse + validate the extra-provider registry JSON. `[]` (or empty/whitespace)
 * yields an empty list. Surfaces JSON and zod errors prefixed with the env-var
 * name so a malformed registry fails fast at boot (validateSettings calls this).
 */
export function parseModelProvidersJson(raw: string): RegistryProvider[] {
  if (!raw.trim() || raw.trim() === "[]") {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`OPENGENI_MODEL_PROVIDERS_JSON must be valid JSON: ${message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("OPENGENI_MODEL_PROVIDERS_JSON must be a JSON array of providers");
  }
  return parsed.map((entry, index) => {
    const result = RegistryProviderSchema.safeParse(entry);
    if (!result.success) {
      throw new Error(`OPENGENI_MODEL_PROVIDERS_JSON provider[${index}] is invalid: ${result.error.message}`);
    }
    return result.data;
  });
}

export function parseStaticUsageLimitsJson(raw: string): StaticUsageLimitsConfig {
  if (!raw.trim() || raw.trim() === "{}") {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`OPENGENI_STATIC_USAGE_LIMITS_JSON must be valid JSON: ${message}`);
  }
  return StaticUsageLimits.parse(parsed);
}

export function parseStaticEntitlementsJson(raw: string): EntitlementsConfig {
  if (!raw.trim() || raw.trim() === "{}") {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`OPENGENI_STATIC_ENTITLEMENTS_JSON must be valid JSON: ${message}`);
  }
  return Entitlements.parse(parsed);
}

function calculateEntryCostMicros(pricing: ModelPricing, entry: ModelUsageInput): number {
  const inputTokens = positiveInt(entry.inputTokens);
  const outputTokens = positiveInt(entry.outputTokens);
  const cachedTokens = Math.min(inputTokens, cachedInputTokens(entry));
  const uncachedInputTokens = Math.max(0, inputTokens - cachedTokens);
  const cachedInputRate = pricing.cachedInputMicrosPerMillionTokens ?? pricing.inputMicrosPerMillionTokens;
  return Math.ceil((uncachedInputTokens * pricing.inputMicrosPerMillionTokens) / 1_000_000)
    + Math.ceil((cachedTokens * cachedInputRate) / 1_000_000)
    + Math.ceil((outputTokens * pricing.outputMicrosPerMillionTokens) / 1_000_000);
}

function cachedInputTokens(entry: ModelUsageInput): number {
  const details = Array.isArray(entry.inputTokensDetails)
    ? entry.inputTokensDetails
    : entry.inputTokensDetails
      ? [entry.inputTokensDetails]
      : [];
  let total = 0;
  for (const detail of details) {
    total += positiveInt(detail.cached_tokens)
      + positiveInt(detail.cachedInputTokens)
      + positiveInt(detail.cached_input_tokens);
  }
  return total;
}

function positiveInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function ensureBuiltInMcpServers(settings: Settings): Settings["mcpServers"] {
  const existing = settings.mcpServers.filter((server) => server.id !== "opengeni");
  const firstPartyMcpUrl = firstPartyMcpServerUrl(settings);
  const firstPartyDocsMcpUrl = firstPartyDocumentsMcpServerUrl(firstPartyMcpUrl);
  const hasFiles = existing.some((server) => server.id === "files");
  const hasDocs = existing.some((server) => server.id === "docs");
  return [
    {
      id: "opengeni",
      name: "OpenGeni",
      url: firstPartyMcpUrl,
      // The opengeni server's tools/list response is permission-scoped: it
      // varies by the calling session's delegated grant (e.g. a manager
      // session sees sessions_*/environment_* tools that a worker session
      // does not). The OpenAI Agents SDK caches tools/list in a process-global
      // map keyed only by the MCP server name, which is identical for every
      // session in the worker process. Caching here would let the first
      // session to warm the cache dictate what every later session sees,
      // regardless of permissions. tools/list is a cheap per-turn call, so we
      // never cache it. (The files server pins allowedTools to a single
      // permission-invariant tool and docs is already uncached, so both stay
      // safe to cache / leave as-is.)
      cacheToolsList: false,
    },
    ...(hasFiles ? [] : [{
      id: "files",
      name: "Files",
      url: firstPartyMcpUrl,
      allowedTools: ["files_get_download_url"],
      cacheToolsList: true,
    }]),
    ...(hasDocs ? [] : [{
      id: "docs",
      name: "Document Search",
      url: firstPartyDocsMcpUrl,
      allowedTools: ["search_documents", "fetch_document_chunk", "list_document_bases"],
      cacheToolsList: false,
    }]),
    ...existing,
  ];
}

function firstPartyMcpServerUrl(settings: Settings): string {
  return settings.opengeniMcpUrl ?? `http://127.0.0.1:${settings.apiPort}/v1/workspaces/{workspaceId}/mcp`;
}

function firstPartyDocumentsMcpServerUrl(mcpUrl: string): string {
  return `${mcpUrl.replace(/\/+$/, "")}/docs`;
}

function validateSettings(settings: Settings): void {
  if (settings.productAccessMode === "managed") {
    if (!settings.publicBaseUrl) {
      throw new Error("OPENGENI_PUBLIC_BASE_URL is required when OPENGENI_PRODUCT_ACCESS_MODE=managed");
    }
    if (!settings.betterAuthSecret) {
      throw new Error("OPENGENI_BETTER_AUTH_SECRET is required when OPENGENI_PRODUCT_ACCESS_MODE=managed");
    }
    if (!settings.delegationSecret) {
      throw new Error("OPENGENI_DELEGATION_SECRET is required when OPENGENI_PRODUCT_ACCESS_MODE=managed");
    }
    if (!["local", "test"].includes(settings.environment) && !settings.resendApiKey) {
      throw new Error("OPENGENI_RESEND_API_KEY is required for managed mode outside local/test");
    }
    if (!["local", "test"].includes(settings.environment) && !settings.environmentsEncryptionKey) {
      throw new Error("OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY is required for managed mode outside local/test");
    }
  }
  environmentsEncryptionKeyBytes(settings);
  if (
    settings.productAccessMode === "configured"
    && !["local", "test"].includes(settings.environment)
    && !settings.delegationSecret
    && !settings.authRequired
  ) {
    throw new Error("OPENGENI_PRODUCT_ACCESS_MODE=configured requires OPENGENI_DELEGATION_SECRET or OPENGENI_AUTH_REQUIRED=true outside local/test");
  }
  if (settings.billingMode === "stripe") {
    if (!settings.stripeSecretKey || !settings.stripeWebhookSecret) {
      throw new Error("OPENGENI_STRIPE_SECRET_KEY and OPENGENI_STRIPE_WEBHOOK_SECRET are required when OPENGENI_BILLING_MODE=stripe");
    }
  }
  if (settings.productAccessMode !== "managed" && settings.billingMode === "stripe") {
    throw new Error("OPENGENI_BILLING_MODE=stripe requires OPENGENI_PRODUCT_ACCESS_MODE=managed");
  }
  if (settings.billingMode === "stripe" || settings.usageLimitsMode === "managed") {
    const pricing = configuredModelPricing(settings);
    const missing = configuredAllowedModels(settings).filter((model) => !pricing[model]);
    if (missing.length > 0) {
      throw new Error(`Missing model pricing for managed billing model(s): ${missing.join(", ")}. Set OPENGENI_MODEL_PRICING_JSON.`);
    }
  }
  if (settings.usageLimitsMode === "static") {
    const limits = configuredStaticUsageLimits(settings);
    if (Object.keys(limits).length === 0) {
      throw new Error("OPENGENI_STATIC_USAGE_LIMITS_JSON must define at least one cap when OPENGENI_USAGE_LIMITS_MODE=static");
    }
  } else {
    parseStaticUsageLimitsJson(settings.staticUsageLimitsJson);
  }
  if (settings.entitlementsMode === "static") {
    const entitlements = parseStaticEntitlementsJson(settings.staticEntitlementsJson);
    if (Object.keys(entitlements).length === 0) {
      throw new Error("OPENGENI_STATIC_ENTITLEMENTS_JSON must define at least one feature when OPENGENI_ENTITLEMENTS_MODE=static");
    }
  } else {
    parseStaticEntitlementsJson(settings.staticEntitlementsJson);
  }
  if (settings.authRequired && !settings.accessKey) {
    throw new Error("OPENGENI_ACCESS_KEY is required when OPENGENI_AUTH_REQUIRED=true");
  }
  if (settings.openaiProvider === "azure") {
    if (!settings.azureOpenaiBaseUrl && !settings.azureOpenaiEndpoint) {
      throw new Error("Azure OpenAI requires OPENGENI_AZURE_OPENAI_BASE_URL or OPENGENI_AZURE_OPENAI_ENDPOINT");
    }
    if (!settings.azureOpenaiBaseUrl && !settings.azureOpenaiDeployment) {
      throw new Error("Azure OpenAI endpoint mode requires OPENGENI_AZURE_OPENAI_DEPLOYMENT");
    }
    if (!settings.azureOpenaiBaseUrl && !settings.azureOpenaiApiVersion) {
      throw new Error("Azure OpenAI endpoint mode requires OPENGENI_AZURE_OPENAI_API_VERSION");
    }
    if (!settings.azureOpenaiApiKey && !settings.azureOpenaiAdToken) {
      throw new Error("Azure OpenAI requires an API key or AD token");
    }
  }
  if (Boolean(settings.modalTokenId) !== Boolean(settings.modalTokenSecret)) {
    throw new Error("OPENGENI_MODAL_TOKEN_ID and OPENGENI_MODAL_TOKEN_SECRET must both be set or both omitted");
  }
  if (settings.objectStorageBackend === "s3-compatible" || settings.objectStorageBackend === "aws-s3") {
    if (Boolean(settings.objectStorageAccessKeyId) !== Boolean(settings.objectStorageSecretAccessKey)) {
      throw new Error("OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID and OPENGENI_OBJECT_STORAGE_SECRET_ACCESS_KEY must both be set or both omitted");
    }
    if (settings.objectStorageBackend === "s3-compatible" && (settings.objectStorageEndpoint || settings.objectStorageSandboxEndpoint) && (!settings.objectStorageAccessKeyId || !settings.objectStorageSecretAccessKey)) {
      throw new Error("S3-compatible object storage endpoints require OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID and OPENGENI_OBJECT_STORAGE_SECRET_ACCESS_KEY");
    }
    if (settings.objectStorageAzureConnectionString || settings.objectStorageAzureAccountName || settings.objectStorageAzureAccountKey || settings.objectStorageAzureEndpoint) {
      throw new Error("S3 object storage uses OPENGENI_OBJECT_STORAGE_* S3 settings, not OPENGENI_OBJECT_STORAGE_AZURE_* settings");
    }
    if (settings.objectStorageGcsProjectId || settings.objectStorageGcsCredentialsJson || settings.objectStorageGcsKeyFilename || settings.objectStorageGcsApiEndpoint) {
      throw new Error("S3 object storage uses OPENGENI_OBJECT_STORAGE_* S3 settings, not OPENGENI_OBJECT_STORAGE_GCS_* settings");
    }
  } else if (settings.objectStorageBackend === "azure-blob") {
    if (settings.objectStorageEndpoint || settings.objectStorageSandboxEndpoint || settings.objectStorageAccessKeyId || settings.objectStorageSecretAccessKey) {
      throw new Error("Azure Blob storage uses OPENGENI_OBJECT_STORAGE_AZURE_* settings, not S3-compatible object storage settings");
    }
    if (settings.objectStorageGcsProjectId || settings.objectStorageGcsCredentialsJson || settings.objectStorageGcsKeyFilename || settings.objectStorageGcsApiEndpoint) {
      throw new Error("Azure Blob storage uses OPENGENI_OBJECT_STORAGE_AZURE_* settings, not OPENGENI_OBJECT_STORAGE_GCS_* settings");
    }
    const hasConnectionString = Boolean(settings.objectStorageAzureConnectionString);
    const hasSharedKey = Boolean(settings.objectStorageAzureAccountName) && Boolean(settings.objectStorageAzureAccountKey);
    if (!hasConnectionString && !hasSharedKey) {
      throw new Error("Azure Blob storage requires OPENGENI_OBJECT_STORAGE_AZURE_CONNECTION_STRING or OPENGENI_OBJECT_STORAGE_AZURE_ACCOUNT_NAME plus OPENGENI_OBJECT_STORAGE_AZURE_ACCOUNT_KEY");
    }
  } else {
    if (settings.objectStorageEndpoint || settings.objectStorageSandboxEndpoint || settings.objectStorageAccessKeyId || settings.objectStorageSecretAccessKey) {
      throw new Error("GCS object storage uses OPENGENI_OBJECT_STORAGE_GCS_* settings, not S3-compatible object storage settings");
    }
    if (settings.objectStorageAzureConnectionString || settings.objectStorageAzureAccountName || settings.objectStorageAzureAccountKey || settings.objectStorageAzureEndpoint) {
      throw new Error("GCS object storage uses OPENGENI_OBJECT_STORAGE_GCS_* settings, not OPENGENI_OBJECT_STORAGE_AZURE_* settings");
    }
    if (settings.objectStorageGcsCredentialsJson) {
      parseGcsCredentialsJson(settings.objectStorageGcsCredentialsJson);
    }
  }
  if (settings.documentChunkOverlap >= settings.documentChunkSize) {
    throw new Error("OPENGENI_DOCUMENT_CHUNK_OVERLAP must be smaller than OPENGENI_DOCUMENT_CHUNK_SIZE");
  }
  parseExposedPorts(settings.dockerExposedPorts);
  sandboxEnvironmentVariableNames(settings);
  sandboxLifecycleHookIds(settings);
  const serverIds = new Set<string>();
  for (const server of settings.mcpServers) {
    if (serverIds.has(server.id)) {
      throw new Error(`OPENGENI_MCP_SERVERS contains duplicate id ${server.id}`);
    }
    serverIds.add(server.id);
  }
  // Model provider registry: parse it here so JSON/zod errors surface at boot,
  // reject a registry id colliding with the built-in provider id (it would
  // shadow the built-in in configuredProviders), reject duplicate registry
  // ids, and require a resolvable API key for every registry provider (a
  // provider with no usable key can never serve a turn). Registry models flow
  // through configuredAllowedModels, so the managed-billing pricing check above
  // already covers them.
  const registryProviders = parseModelProvidersJson(settings.modelProvidersJson);
  const builtinId = builtinProviderId(settings);
  const providerIds = new Set<string>();
  for (const provider of registryProviders) {
    if (provider.id === builtinId) {
      throw new Error(`OPENGENI_MODEL_PROVIDERS_JSON provider id ${provider.id} collides with the built-in provider id`);
    }
    if (providerIds.has(provider.id)) {
      throw new Error(`OPENGENI_MODEL_PROVIDERS_JSON contains duplicate provider id ${provider.id}`);
    }
    providerIds.add(provider.id);
    if (!resolveProviderApiKey(provider)) {
      throw new Error(`OPENGENI_MODEL_PROVIDERS_JSON provider ${provider.id} requires a resolvable API key (set apiKey or apiKeyEnv)`);
    }
  }
}

function splitCsv(raw: string): string[] {
  return raw.split(",").map((value) => value.trim()).filter(Boolean);
}

function uniqueEnvNames(raw: string[], fieldName: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of raw) {
    if (!envName.test(name)) {
      throw new Error(`${fieldName} contains invalid variable name ${name}`);
    }
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

function uniqueValues(raw: string[]): string[] {
  return [...new Set(raw.filter(Boolean))];
}

function parseGcsCredentialsJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`OPENGENI_OBJECT_STORAGE_GCS_CREDENTIALS_JSON must be valid JSON: ${message}`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
