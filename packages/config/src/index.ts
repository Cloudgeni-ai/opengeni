import { ReasoningEffort, SandboxBackend } from "@infra-agents/contracts";
import { z } from "zod";

const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const registryId = /^[A-Za-z0-9_-]+$/;

export const sandboxEnvProfiles: Record<string, string[]> = {
  azure: [
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
  github: [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
  ],
};

const SettingsSchema = z.object({
  serviceName: z.string().default("infra-agents"),
  environment: z.string().default("local"),
  databaseUrl: z.string().default("postgres://infra_agents:infra_agents@127.0.0.1:5432/infra_agents"),
  natsUrl: z.string().default("nats://127.0.0.1:4222"),
  temporalHost: z.string().default("127.0.0.1:7233"),
  temporalNamespace: z.string().default("default"),
  temporalTaskQueue: z.string().default("infra-agent-runs-ts"),
  apiHost: z.string().default("0.0.0.0"),
  apiPort: z.coerce.number().int().positive().default(8000),
  infraAgentsMcpUrl: z.string().url().optional(),
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
  disableOpenaiTracing: z.coerce.boolean().default(false),
  sandboxBackend: SandboxBackend.default("docker"),
  dockerImage: z.string().default("infra-agents-sandbox:local"),
  dockerExposedPorts: z.string().default(""),
  modalAppName: z.string().default("infra-agents-sandbox"),
  modalImageRef: z.string().optional(),
  modalTimeoutSeconds: z.coerce.number().int().positive().default(900),
  modalTokenId: z.string().optional(),
  modalTokenSecret: z.string().optional(),
  modalEnvironment: z.string().optional(),
  sandboxEnvProfiles: z.string().default("azure,github"),
  sandboxEnvExtraVars: z.string().default(""),
  sandboxEnvVars: z.string().optional(),
  objectStorageEndpoint: z.string().url().optional(),
  objectStorageSandboxEndpoint: z.string().url().optional(),
  objectStorageBucket: z.string().min(1).default("infra-agents-files"),
  objectStorageRegion: z.string().min(1).default("us-east-1"),
  objectStorageS3Provider: z.string().min(1).default("Minio"),
  objectStorageAccessKeyId: z.string().optional(),
  objectStorageSecretAccessKey: z.string().optional(),
  objectStorageForcePathStyle: z.coerce.boolean().default(true),
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
    serviceName: optional("INFRA_AGENT_SERVICE_NAME"),
    environment: optional("INFRA_AGENT_ENVIRONMENT"),
    databaseUrl: optional("INFRA_AGENT_DATABASE_URL"),
    natsUrl: optional("INFRA_AGENT_NATS_URL"),
    temporalHost: optional("INFRA_AGENT_TEMPORAL_HOST"),
    temporalNamespace: optional("INFRA_AGENT_TEMPORAL_NAMESPACE"),
    temporalTaskQueue: optional("INFRA_AGENT_TEMPORAL_TASK_QUEUE"),
    apiHost: optional("INFRA_AGENT_API_HOST"),
    apiPort: optional("INFRA_AGENT_API_PORT"),
    infraAgentsMcpUrl: optional("INFRA_AGENT_MCP_URL"),
    corsAllowOriginRegex: optional("INFRA_AGENT_CORS_ALLOW_ORIGIN_REGEX"),
    openaiProvider: optional("INFRA_AGENT_OPENAI_PROVIDER"),
    openaiApiKey: optional("INFRA_AGENT_OPENAI_API_KEY") ?? optional("OPENAI_API_KEY"),
    openaiBaseUrl: optional("INFRA_AGENT_OPENAI_BASE_URL") ?? optional("OPENAI_BASE_URL"),
    openaiModel: optional("INFRA_AGENT_OPENAI_MODEL"),
    openaiAllowedModels: optional("INFRA_AGENT_OPENAI_ALLOWED_MODELS"),
    openaiReasoningEffort: optional("INFRA_AGENT_OPENAI_REASONING_EFFORT"),
    openaiAllowedReasoningEfforts: optional("INFRA_AGENT_OPENAI_ALLOWED_REASONING_EFFORTS"),
    openaiResponsesTransport: optional("INFRA_AGENT_OPENAI_RESPONSES_TRANSPORT"),
    azureOpenaiBaseUrl: optional("INFRA_AGENT_AZURE_OPENAI_BASE_URL"),
    azureOpenaiEndpoint: optional("INFRA_AGENT_AZURE_OPENAI_ENDPOINT"),
    azureOpenaiDeployment: optional("INFRA_AGENT_AZURE_OPENAI_DEPLOYMENT"),
    azureOpenaiApiVersion: optional("INFRA_AGENT_AZURE_OPENAI_API_VERSION"),
    azureOpenaiApiKey: optional("INFRA_AGENT_AZURE_OPENAI_API_KEY"),
    azureOpenaiAdToken: optional("INFRA_AGENT_AZURE_OPENAI_AD_TOKEN"),
    disableOpenaiTracing: optional("INFRA_AGENT_DISABLE_OPENAI_TRACING"),
    sandboxBackend: optional("INFRA_AGENT_SANDBOX_BACKEND"),
    dockerImage: optional("INFRA_AGENT_DOCKER_IMAGE"),
    dockerExposedPorts: optional("INFRA_AGENT_DOCKER_EXPOSED_PORTS"),
    modalAppName: optional("INFRA_AGENT_MODAL_APP_NAME"),
    modalImageRef: optional("INFRA_AGENT_MODAL_IMAGE_REF"),
    modalTimeoutSeconds: optional("INFRA_AGENT_MODAL_TIMEOUT_SECONDS"),
    modalTokenId: optional("INFRA_AGENT_MODAL_TOKEN_ID"),
    modalTokenSecret: optional("INFRA_AGENT_MODAL_TOKEN_SECRET"),
    modalEnvironment: optional("INFRA_AGENT_MODAL_ENVIRONMENT"),
    sandboxEnvProfiles: optional("INFRA_AGENT_SANDBOX_ENV_PROFILES"),
    sandboxEnvExtraVars: optional("INFRA_AGENT_SANDBOX_ENV_EXTRA_VARS"),
    sandboxEnvVars: optional("INFRA_AGENT_SANDBOX_ENV_VARS"),
    objectStorageEndpoint: optional("INFRA_AGENT_OBJECT_STORAGE_ENDPOINT"),
    objectStorageSandboxEndpoint: optional("INFRA_AGENT_OBJECT_STORAGE_SANDBOX_ENDPOINT"),
    objectStorageBucket: optional("INFRA_AGENT_OBJECT_STORAGE_BUCKET"),
    objectStorageRegion: optional("INFRA_AGENT_OBJECT_STORAGE_REGION"),
    objectStorageS3Provider: optional("INFRA_AGENT_OBJECT_STORAGE_S3_PROVIDER"),
    objectStorageAccessKeyId: optional("INFRA_AGENT_OBJECT_STORAGE_ACCESS_KEY_ID"),
    objectStorageSecretAccessKey: optional("INFRA_AGENT_OBJECT_STORAGE_SECRET_ACCESS_KEY"),
    objectStorageForcePathStyle: optional("INFRA_AGENT_OBJECT_STORAGE_FORCE_PATH_STYLE"),
    documentParser: optional("INFRA_AGENT_DOCUMENT_PARSER"),
    documentChunkSize: optional("INFRA_AGENT_DOCUMENT_CHUNK_SIZE"),
    documentChunkOverlap: optional("INFRA_AGENT_DOCUMENT_CHUNK_OVERLAP"),
    documentEmbeddingProvider: optional("INFRA_AGENT_DOCUMENT_EMBEDDING_PROVIDER"),
    documentEmbeddingModel: optional("INFRA_AGENT_DOCUMENT_EMBEDDING_MODEL"),
    documentEmbeddingDimensions: optional("INFRA_AGENT_DOCUMENT_EMBEDDING_DIMENSIONS"),
    documentEmbeddingApiKey: optional("INFRA_AGENT_DOCUMENT_EMBEDDING_API_KEY"),
    documentEmbeddingBaseUrl: optional("INFRA_AGENT_DOCUMENT_EMBEDDING_BASE_URL"),
    gitAuthorName: optional("INFRA_AGENT_GIT_AUTHOR_NAME") ?? optional("GIT_AUTHOR_NAME"),
    gitAuthorEmail: optional("INFRA_AGENT_GIT_AUTHOR_EMAIL") ?? optional("GIT_AUTHOR_EMAIL"),
    gitCommitterName: optional("INFRA_AGENT_GIT_COMMITTER_NAME") ?? optional("GIT_COMMITTER_NAME"),
    gitCommitterEmail: optional("INFRA_AGENT_GIT_COMMITTER_EMAIL") ?? optional("GIT_COMMITTER_EMAIL"),
    githubAppManifestBaseUrl: optional("INFRA_AGENT_GITHUB_APP_MANIFEST_BASE_URL"),
    githubAppManifestStateSecret: optional("INFRA_AGENT_GITHUB_APP_MANIFEST_STATE_SECRET"),
    githubAppId: optional("INFRA_AGENT_GITHUB_APP_ID"),
    githubClientId: optional("INFRA_AGENT_GITHUB_CLIENT_ID"),
    githubClientSecret: optional("INFRA_AGENT_GITHUB_CLIENT_SECRET"),
    githubAppSlug: optional("INFRA_AGENT_GITHUB_APP_SLUG"),
    githubWebhookSecret: optional("INFRA_AGENT_GITHUB_WEBHOOK_SECRET"),
    githubAppPrivateKey: optional("INFRA_AGENT_GITHUB_APP_PRIVATE_KEY"),
    mcpServers: parseMcpServers(optional("INFRA_AGENT_MCP_SERVERS")),
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

export function sandboxEnvironmentVariableNames(settings: Settings): string[] {
  if (settings.sandboxEnvVars !== undefined) {
    return uniqueEnvNames(splitCsv(settings.sandboxEnvVars), "INFRA_AGENT_SANDBOX_ENV_VARS");
  }
  let profiles = splitCsv(settings.sandboxEnvProfiles).map((value) => value.toLowerCase());
  if (profiles.includes("none")) {
    if (profiles.length > 1) {
      throw new Error("INFRA_AGENT_SANDBOX_ENV_PROFILES cannot combine none with other profiles");
    }
    profiles = [];
  }
  const names: string[] = [];
  for (const profile of profiles) {
    const profileVars = sandboxEnvProfiles[profile];
    if (!profileVars) {
      throw new Error(`Unknown sandbox env profile ${profile}`);
    }
    names.push(...profileVars);
  }
  names.push(...splitCsv(settings.sandboxEnvExtraVars));
  return uniqueEnvNames(names, "sandbox env");
}

export function parseExposedPorts(raw: string): number[] {
  return splitCsv(raw).map((value) => {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("INFRA_AGENT_DOCKER_EXPOSED_PORTS must contain TCP port numbers");
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
    throw new Error(`INFRA_AGENT_MCP_SERVERS must be a JSON array: ${message}`);
  }
}

function ensureBuiltInMcpServers(settings: Settings): Settings["mcpServers"] {
  const existing = settings.mcpServers.filter((server) => server.id !== "infra_agents");
  const firstPartyMcpUrl = settings.infraAgentsMcpUrl ?? `http://127.0.0.1:${settings.apiPort}/v1/mcp`;
  const hasFiles = existing.some((server) => server.id === "files");
  const hasDocs = existing.some((server) => server.id === "docs");
  return [
    {
      id: "infra_agents",
      name: "Infra Agents",
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
      url: `http://127.0.0.1:${settings.apiPort}/v1/mcp/docs`,
      allowedTools: ["search_documents", "fetch_document_chunk", "list_document_bases"],
      cacheToolsList: false,
    }]),
    ...existing,
  ];
}

function validateSettings(settings: Settings): void {
  if (settings.openaiProvider === "azure") {
    if (!settings.azureOpenaiBaseUrl && !settings.azureOpenaiEndpoint) {
      throw new Error("Azure OpenAI requires INFRA_AGENT_AZURE_OPENAI_BASE_URL or INFRA_AGENT_AZURE_OPENAI_ENDPOINT");
    }
    if (!settings.azureOpenaiBaseUrl && !settings.azureOpenaiDeployment) {
      throw new Error("Azure OpenAI endpoint mode requires INFRA_AGENT_AZURE_OPENAI_DEPLOYMENT");
    }
    if (!settings.azureOpenaiBaseUrl && !settings.azureOpenaiApiVersion) {
      throw new Error("Azure OpenAI endpoint mode requires INFRA_AGENT_AZURE_OPENAI_API_VERSION");
    }
    if (!settings.azureOpenaiApiKey && !settings.azureOpenaiAdToken) {
      throw new Error("Azure OpenAI requires an API key or AD token");
    }
  }
  if (Boolean(settings.modalTokenId) !== Boolean(settings.modalTokenSecret)) {
    throw new Error("INFRA_AGENT_MODAL_TOKEN_ID and INFRA_AGENT_MODAL_TOKEN_SECRET must both be set or both omitted");
  }
  if (Boolean(settings.objectStorageAccessKeyId) !== Boolean(settings.objectStorageSecretAccessKey)) {
    throw new Error("INFRA_AGENT_OBJECT_STORAGE_ACCESS_KEY_ID and INFRA_AGENT_OBJECT_STORAGE_SECRET_ACCESS_KEY must both be set or both omitted");
  }
  if ((settings.objectStorageEndpoint || settings.objectStorageSandboxEndpoint) && (!settings.objectStorageAccessKeyId || !settings.objectStorageSecretAccessKey)) {
    throw new Error("Object storage endpoints require INFRA_AGENT_OBJECT_STORAGE_ACCESS_KEY_ID and INFRA_AGENT_OBJECT_STORAGE_SECRET_ACCESS_KEY");
  }
  if (settings.documentChunkOverlap >= settings.documentChunkSize) {
    throw new Error("INFRA_AGENT_DOCUMENT_CHUNK_OVERLAP must be smaller than INFRA_AGENT_DOCUMENT_CHUNK_SIZE");
  }
  parseExposedPorts(settings.dockerExposedPorts);
  sandboxEnvironmentVariableNames(settings);
  const serverIds = new Set<string>();
  for (const server of settings.mcpServers) {
    if (serverIds.has(server.id)) {
      throw new Error(`INFRA_AGENT_MCP_SERVERS contains duplicate id ${server.id}`);
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
