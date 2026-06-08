import type { Settings } from "@opengeni/config";
import { collectSandboxEnvironment, parseExposedPorts, sandboxLifecycleHookIds } from "@opengeni/config";
import { signDelegatedAccessToken, type Permission, type ReasoningEffort, type ResourceRef, type SessionEventType, type ToolRef } from "@opengeni/contracts";
import {
  Agent,
  connectMcpServers,
  MCPServerStreamableHttp,
  RunState,
  isOpenAIResponsesRawModelStreamEvent,
  run,
  setDefaultOpenAIClient,
  setDefaultOpenAIKey,
  setOpenAIResponsesTransport,
  type AgentInputItem,
  type MCPServer,
  type Model,
  type RunStreamEvent,
} from "@openai/agents";
import {
  DockerSandboxClient,
  localDirLazySkillSource,
  UnixLocalSandboxClient,
} from "@openai/agents/sandbox/local";
import {
  Capabilities,
  Manifest,
  SandboxAgent,
  azureBlobMount,
  dir,
  file,
  gitRepo,
  inContainerMountStrategy,
  localDir,
  localFile,
  s3Mount,
  skills,
  type SandboxClient,
  type SandboxSessionLike,
  type SandboxSessionState,
  type SandboxRunConfig,
} from "@openai/agents/sandbox";
import { ModalCloudBucketMountStrategy, ModalImageSelector, ModalSandboxClient } from "@openai/agents-extensions/sandbox/modal";
import OpenAI from "openai";
import { userInfo } from "node:os";
import { dirname, join, posix as posixPath } from "node:path";
import { fileURLToPath } from "node:url";

ensureReadableStreamFrom();

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
  | { kind: "message"; text: string; serializedRunState?: string | null }
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

export type SandboxRepositoryMaterialization = {
  mountPath: string;
  sourcePath: string;
  sourceType: "directory" | "file";
};

export type OpenGeniRuntime = {
  configure: (settings: Settings) => void;
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

export function configureOpenAI(settings: Settings): void {
  setOpenAIResponsesTransport(settings.openaiResponsesTransport);
  if (settings.openaiProvider === "azure") {
    const baseURL = settings.azureOpenaiBaseUrl ?? azureDeploymentBaseUrl(settings);
    const apiKey = settings.azureOpenaiApiKey ?? settings.azureOpenaiAdToken ?? "azure-ad-token";
    setDefaultOpenAIClient(new OpenAI({
      apiKey,
      baseURL,
      defaultQuery: azureOpenAIDefaultQuery(settings, baseURL),
      defaultHeaders: settings.azureOpenaiAdToken && !settings.azureOpenaiApiKey
        ? { Authorization: `Bearer ${settings.azureOpenaiAdToken}` }
        : undefined,
    }));
    return;
  }
  if (settings.openaiApiKey) {
    setDefaultOpenAIKey(settings.openaiApiKey);
  }
  if (settings.openaiBaseUrl) {
    setDefaultOpenAIClient(new OpenAI({
      apiKey: settings.openaiApiKey ?? process.env.OPENAI_API_KEY,
      baseURL: settings.openaiBaseUrl,
    }));
  }
}

export type BuildAgentOptions = {
  model?: Model;
  reasoningEffort?: ReasoningEffort;
  sandboxEnvironment?: Record<string, string>;
  fileResourceDownloads?: SandboxFileDownload[];
  repositoryMaterializations?: SandboxRepositoryMaterialization[];
  mcpServers?: MCPServer[];
};

const agentFileDownloads = new WeakMap<object, SandboxFileDownload[]>();

export function buildOpenGeniAgent(settings: Settings, resources: ResourceRef[], options: BuildAgentOptions = {}): Agent<any, any> {
  const baseConfig = {
    name: "OpenGeni Agent",
    model: options.model ?? settings.openaiModel,
    instructions: [
      "You are a standalone infrastructure engineering agent.",
      "Work inside the sandbox workspace and use filesystem and shell tools when useful.",
      "Repository resources are mounted under repos/<owner>/<repo>.",
      "File resources are mounted under files/<file-id>/ unless the session specifies another mount path.",
      "Attached files are mounted read-only; copy them before modifying.",
      "Terraform and infrastructure skills are under .agents/ including terraform style, terraform test, terraform stacks, Azure verified modules, search/import, refactor module, and checkov.",
      "Use Checkov, Terraform, Azure CLI, GitHub CLI, and repository tools when relevant.",
      "When the Azure sandbox preparation profile is enabled and service-principal variables are present, the sandbox is pre-authenticated with normal Azure CLI before work starts.",
      "Treat code-changing work as GitOps work: create a focused branch/commit/PR when GitHub credentials are available; otherwise report exact commands and blockers.",
      "Return concise, factual summaries with files changed, commands run, and remaining blockers.",
    ].join(" "),
    modelSettings: {
      reasoning: { effort: options.reasoningEffort ?? settings.openaiReasoningEffort, summary: "detailed" },
    },
    ...(options.mcpServers?.length ? { mcpServers: options.mcpServers } : {}),
  } as const;

  if (settings.sandboxBackend === "none") {
    return new Agent(baseConfig);
  }

  const runAs = sandboxRunAs(settings);
  const agent = new SandboxAgent({
    ...baseConfig,
    defaultManifest: buildManifest(settings, resources, options.sandboxEnvironment, options.fileResourceDownloads, options.repositoryMaterializations),
    ...(runAs ? { runAs } : {}),
    capabilities: [
      ...Capabilities.default(),
      skills({ lazyFrom: localDirLazySkillSource({ src: bundledSkillsDir() }) }),
    ],
  });
  agentFileDownloads.set(agent, normalizeSandboxFileDownloads(options.fileResourceDownloads ?? []).filter((download) => !download.content));
  return agent;
}

export function sandboxRunAs(settings: Settings): string | undefined {
  if (settings.sandboxBackend === "docker") {
    return "sandbox";
  }
  if (settings.sandboxBackend === "local") {
    return userInfo().username;
  }
  return undefined;
}

export type PreparedAgentTools = {
  mcpServers: MCPServer[];
  close: () => Promise<void>;
};

export type PrepareToolsOptions = {
  accountId?: string;
  workspaceId?: string;
  subjectId?: string;
  subjectLabel?: string;
};

export async function prepareAgentTools(settings: Settings, tools: ToolRef[], options: PrepareToolsOptions = {}): Promise<PreparedAgentTools> {
  if (tools.length === 0) {
    return { mcpServers: [], close: async () => {} };
  }
  const registry = new Map(settings.mcpServers.map((server) => [server.id, server]));
  const servers = await Promise.all(tools.map(async (tool) => {
    const config = registry.get(tool.id);
    if (!config) {
      throw new Error(`Unknown MCP server id: ${tool.id}`);
    }
    const url = firstPartyMcpServerUrlForRun(settings, config, options.workspaceId) ?? config.url;
    return new PrefixedMcpServer(new MCPServerStreamableHttp({
      url,
      name: config.name ?? config.id,
      cacheToolsList: config.cacheToolsList,
      ...await firstPartyMcpRequestInit(settings, config, options),
      ...(config.timeoutMs ? {
        timeout: config.timeoutMs,
        clientSessionTimeoutSeconds: Math.ceil(config.timeoutMs / 1000),
      } : {}),
    }), config.id, config.allowedTools);
  }));
  const connected = await connectMcpServers(servers, {
    connectInParallel: true,
    strict: true,
  });
  return {
    mcpServers: connected.active,
    close: async () => {
      await connected.close();
    },
  };
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
      permissions: firstPartyMcpPermissions,
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

const firstPartyMcpPermissions: Permission[] = [
  "workspace:read",
  "files:read",
  "documents:search",
  "scheduled_tasks:manage",
  "scheduled_tasks:run",
];

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

export function createSandboxClient(settings: Settings, environment = collectSandboxEnvironment(settings)): unknown {
  if (settings.sandboxBackend === "docker") {
    return withDockerNetwork(new DockerSandboxClient({
      image: settings.dockerImage,
      exposedPorts: parseExposedPorts(settings.dockerExposedPorts),
    }), settings.dockerNetwork);
  }
  if (settings.sandboxBackend === "modal") {
    const options: ConstructorParameters<typeof ModalSandboxClient>[0] = {
      appName: settings.modalAppName,
      timeoutMs: settings.modalTimeoutSeconds * 1000,
      exposedPorts: parseExposedPorts(settings.dockerExposedPorts),
      env: environment,
    };
    if (settings.modalImageRef) {
      options.image = ModalImageSelector.fromTag(settings.modalImageRef);
    }
    if (settings.modalTokenId) {
      options.tokenId = settings.modalTokenId;
    }
    if (settings.modalTokenSecret) {
      options.tokenSecret = settings.modalTokenSecret;
    }
    if (settings.modalEnvironment) {
      options.environment = settings.modalEnvironment;
    }
    return new ModalSandboxClient(options);
  }
  if (settings.sandboxBackend === "local") {
    return new UnixLocalSandboxClient();
  }
  return undefined;
}

function withDockerNetwork(client: SandboxClient, network: string | undefined): SandboxClient {
  const trimmed = network?.trim();
  if (!trimmed) {
    return client;
  }
  const wrapSession = async <T extends SandboxSessionLike>(session: T): Promise<T> => {
    const containerId = (session as { state?: { containerId?: unknown } }).state?.containerId;
    if (typeof containerId === "string" && containerId.length > 0) {
      await connectDockerNetwork(trimmed, containerId);
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

async function connectDockerNetwork(network: string, containerId: string): Promise<void> {
  const result = Bun.spawnSync(["docker", "network", "connect", network, containerId], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode === 0) {
    return;
  }
  const stderr = new TextDecoder().decode(result.stderr);
  if (stderr.includes("already exists")) {
    return;
  }
  throw new Error(`Failed to connect Docker sandbox container to network ${network}: ${stderr.trim()}`);
}

export type PrepareInputOptions = {
  sandboxClient?: unknown;
};

export async function prepareRunInput(agent: Agent<any, any>, input: AgentSegmentInput, options: PrepareInputOptions = {}): Promise<PreparedAgentInput> {
  if (input.kind === "message") {
    if (!input.serializedRunState) {
      return { input: input.text };
    }
    const state = await RunState.fromString(agent, input.serializedRunState);
    const sandboxSessionState = await restoredSandboxSessionState(state, options.sandboxClient);
    return {
      input: [
        ...state.history,
        {
          type: "message",
          role: "user",
          content: input.text,
        } as AgentInputItem,
      ],
      ...(sandboxSessionState ? { sandboxSessionState } : {}),
      serializedRunStateForSandbox: input.serializedRunState,
    };
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
};

export async function runAgentStream(agent: Agent<any, any>, input: PreparedAgentInput | string | RunState<any, any>, settings: Settings, overrides: RunAgentStreamOptions = {}) {
  const prepared: PreparedAgentInput = typeof input === "string" || input instanceof RunState ? { input } : input;
  const environment = overrides.sandboxEnvironment ?? collectSandboxEnvironment(settings);
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
  const client = resourceClient
    ? withSandboxLifecycleHooks(resourceClient, sandboxLifecycleHooksForIds(sandboxLifecycleHookIds(settings)), {
      environment,
      ...(overrides.onRuntimeEvent ? { onRuntimeEvent: overrides.onRuntimeEvent } : {}),
      ...(runAs ? { runAs } : {}),
    })
    : undefined;
  const sandboxSessionState = prepared.sandboxSessionState
    ?? (prepared.serializedRunStateForSandbox && client
      ? await restoredSandboxSessionState(await RunState.fromString(agent, prepared.serializedRunStateForSandbox), client)
      : undefined);
  const runOptions: Parameters<typeof run>[2] = {
    stream: true,
    maxTurns: 40,
  };
  void settings.disableOpenaiTracing;
  if (client) {
    runOptions.sandbox = {
      client,
      ...(sandboxSessionState ? { sessionState: sandboxSessionState } : {}),
    } as SandboxRunConfig;
  }
  return await run(agent, prepared.input, runOptions);
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
  const delta = new Manifest({
    root: currentManifest.root,
    entries,
    environment: target.environment,
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
  });
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
          yieldTimeMs: 1_000,
          maxOutputTokens: 20_000,
        })
        : await session.execCommand!({
          cmd: sandboxFileDownloadCommand(download, targetPath),
          workdir: "/workspace",
          ...(context.runAs ? { runAs: context.runAs } : {}),
          yieldTimeMs: 1_000,
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

function ensureManifest(manifest: Manifest | { root?: string; entries?: Record<string, any>; environment?: Record<string, any> }): Manifest {
  if (manifest instanceof Manifest && typeof manifest.mountTargetsForMaterialization === "function") {
    return manifest;
  }
  return new Manifest({
    ...(manifest.root ? { root: manifest.root } : {}),
    entries: manifest.entries ?? {},
    environment: manifest.environment ?? {},
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
  repositoryMaterializations: SandboxRepositoryMaterialization[] = [],
): Manifest {
  const entries: Record<string, any> = {};
  const downloadsByFileId = new Map(normalizeSandboxFileDownloads(fileResourceDownloads).map((download) => [download.fileId, download]));
  const repositoriesByMountPath = new Map(normalizeSandboxRepositoryMaterializations(repositoryMaterializations).map((materialization) => [materialization.mountPath, materialization]));
  for (const resource of resources) {
    if (resource.kind === "repository") {
      const url = new URL(resource.uri);
      const host = url.hostname.toLowerCase();
      const repo = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
      const mountPath = normalizeManifestPath(resource.mountPath ?? `repos/${repo}`);
      const materialization = repositoriesByMountPath.get(mountPath);
      entries[mountPath] = materialization
        ? sandboxRepositorySource(materialization)
        : gitRepo({
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
  return new Manifest({
    root: "/workspace",
    entries,
    environment,
  });
}

function sandboxRepositorySource(materialization: SandboxRepositoryMaterialization): any {
  if (materialization.sourceType === "file") {
    return localFile({ src: materialization.sourcePath });
  }
  return localDir({ src: materialization.sourcePath });
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
  if (settings.objectStorageBackend === "azure-blob") {
    if (settings.sandboxBackend === "modal") {
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
    mountStrategy: settings.sandboxBackend === "modal"
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

function normalizeSandboxRepositoryMaterializations(materializations: SandboxRepositoryMaterialization[]): SandboxRepositoryMaterialization[] {
  return materializations.map((materialization) => ({
    ...materialization,
    mountPath: normalizeManifestPath(materialization.mountPath),
  }));
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

export async function deserializeSandboxSessionStateEnvelope(client: SandboxClient, envelope: unknown): Promise<SandboxSessionState | undefined> {
  if (!envelope || typeof envelope !== "object") {
    return undefined;
  }
  if (!client.deserializeSessionState) {
    throw new Error("Sandbox client must implement deserializeSessionState() to resume RunState sandbox state");
  }
  const state = envelope as {
    providerState?: Record<string, unknown>;
    manifest?: unknown;
    snapshot?: unknown;
    snapshotFingerprint?: unknown;
    snapshotFingerprintVersion?: unknown;
    workspaceReady?: unknown;
    exposedPorts?: unknown;
  };
  return await client.deserializeSessionState({
    ...(state.providerState ?? {}),
    manifest: state.manifest,
    ...(state.snapshot !== undefined ? { snapshot: state.snapshot } : {}),
    ...(state.snapshotFingerprint !== undefined ? { snapshotFingerprint: state.snapshotFingerprint } : {}),
    ...(state.snapshotFingerprintVersion !== undefined ? { snapshotFingerprintVersion: state.snapshotFingerprintVersion } : {}),
    workspaceReady: state.workspaceReady,
    ...(state.exposedPorts ? { exposedPorts: structuredClone(state.exposedPorts) } : {}),
  });
}

export type SandboxLifecycleHookPhase = "beforeAgentStart";

export type SandboxLifecycleHookContext = {
  environment: Record<string, string>;
  onRuntimeEvent?: (event: NormalizedRuntimeEvent) => Promise<void> | void;
  runAs?: string;
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

function sandboxCommandOutput(result: unknown): string {
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
  const exitCode = sandboxCommandExitCode(result);
  if (exitCode !== null && exitCode !== 0) {
    throw new Error(sandboxCommandOutput(result) || `${operation} failed with exit code ${exitCode}`);
  }
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
        yieldTimeMs: 1_000,
        maxOutputTokens: 20_000,
      });
      assertSandboxCommandSucceeded(result, "Azure CLI login hook");
    } else if (session.execCommand) {
      const result = await session.execCommand({
        cmd: azureCliLoginCommand(),
        workdir: "/workspace",
        ...(context.runAs ? { runAs: context.runAs } : {}),
        yieldTimeMs: 1_000,
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

function bundledSkillsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "bundled_hashicorp_terraform_skills");
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
