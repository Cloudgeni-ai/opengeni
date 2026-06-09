import { ReasoningEffort, SandboxBackend } from "@opengeni/contracts";
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

const SettingsSchema = z.object({
  serviceName: z.string().default("opengeni"),
  environment: z.string().default("local"),
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
  openaiReasoningEffort: ReasoningEffort.default("high"),
  openaiAllowedReasoningEfforts: z.string().default("low,medium,high,xhigh"),
  openaiResponsesTransport: z.enum(["http", "websocket"]).default("http"),
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
  mcpServers: z.array(z.object({
    id: z.string().min(1).regex(registryId),
    name: z.string().min(1).optional(),
    url: z.string().url(),
    allowedTools: z.array(z.string().min(1)).optional(),
    timeoutMs: z.number().int().positive().optional(),
    cacheToolsList: z.boolean().default(false),
  })).default([]),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type McpServerConfig = Settings["mcpServers"][number];

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : undefined;
}

export function getSettings(): Settings {
  const raw = {
    serviceName: optional("OPENGENI_SERVICE_NAME"),
    environment: optional("OPENGENI_ENVIRONMENT"),
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
    openaiReasoningEffort: optional("OPENGENI_OPENAI_REASONING_EFFORT"),
    openaiAllowedReasoningEfforts: optional("OPENGENI_OPENAI_ALLOWED_REASONING_EFFORTS"),
    openaiResponsesTransport: optional("OPENGENI_OPENAI_RESPONSES_TRANSPORT"),
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

export function configuredAllowedModels(settings: Settings): string[] {
  return uniqueValues([settings.openaiModel, ...splitCsv(settings.openaiAllowedModels)]);
}

export function configuredAllowedReasoningEfforts(settings: Settings): Array<z.infer<typeof ReasoningEffort>> {
  return uniqueValues([settings.openaiReasoningEffort, ...splitCsv(settings.openaiAllowedReasoningEfforts)])
    .map((value) => ReasoningEffort.parse(value));
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
      cacheToolsList: true,
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
      allowedTools: [
        "search_documents",
        "fetch_document_chunk",
        "list_document_bases",
        "knowledge_search",
        "knowledge_fetch",
        "memory_search",
        "memory_propose",
      ],
      cacheToolsList: false,
    }]),
    ...existing,
  ];
}

function firstPartyMcpServerUrl(settings: Settings): string {
  return settings.opengeniMcpUrl ?? `http://127.0.0.1:${settings.apiPort}/v1/mcp`;
}

function firstPartyDocumentsMcpServerUrl(mcpUrl: string): string {
  const url = new URL(mcpUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/docs`;
  return url.toString();
}

function validateSettings(settings: Settings): void {
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
