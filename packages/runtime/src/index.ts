import type { Settings } from "@infra-agents/config";
import { collectSandboxEnvironment, parseExposedPorts } from "@infra-agents/config";
import type { ReasoningEffort, ResourceRef, SessionEventType } from "@infra-agents/contracts";
import {
  Agent,
  RunState,
  isOpenAIResponsesRawModelStreamEvent,
  run,
  setDefaultOpenAIClient,
  setDefaultOpenAIKey,
  setOpenAIResponsesTransport,
  type AgentInputItem,
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
  gitRepo,
  skills,
  type SandboxClient,
  type SandboxSessionLike,
  type SandboxSessionState,
  type SandboxRunConfig,
} from "@openai/agents/sandbox";
import { ModalImageSelector, ModalSandboxClient } from "@openai/agents-extensions/sandbox/modal";
import OpenAI from "openai";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

ensureReadableStreamFrom();

export type NormalizedRuntimeEvent = {
  type: SessionEventType;
  payload: unknown;
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
  | { kind: "message"; text: string; serializedRunState?: string | null }
  | { kind: "approval"; serializedRunState: string; approvalId: string; decision: "approve" | "reject"; message?: string };

export type PreparedAgentInput = {
  input: string | AgentInputItem[] | RunState<any, any>;
  sandboxSessionState?: SandboxSessionState;
  serializedRunStateForSandbox?: string;
};

export type InfraAgentRuntime = {
  configure: (settings: Settings) => void;
  buildAgent: (settings: Settings, resources: ResourceRef[], options?: BuildAgentOptions) => Agent<any, any>;
  prepareInput: (agent: Agent<any, any>, input: AgentSegmentInput, options?: PrepareInputOptions) => Promise<PreparedAgentInput>;
  runStream: (agent: Agent<any, any>, input: PreparedAgentInput, settings: Settings, options?: RunAgentStreamOptions) => Promise<Awaited<ReturnType<typeof runAgentStream>>>;
  serializeApprovals: (interruptions: unknown[]) => unknown[];
};

export type ProductionRuntimeOverrides = {
  model?: Model;
  sandboxClient?: unknown;
};

export function createProductionAgentRuntime(overrides: ProductionRuntimeOverrides = {}): InfraAgentRuntime {
  return {
    configure: configureOpenAI,
    buildAgent: (settings, resources, options) => buildInfraAgent(settings, resources, {
      ...options,
      ...(overrides.model ? { model: overrides.model } : {}),
    }),
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
      defaultQuery: settings.azureOpenaiBaseUrl ? undefined : { "api-version": settings.azureOpenaiApiVersion },
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
};

export function buildInfraAgent(settings: Settings, resources: ResourceRef[], options: BuildAgentOptions = {}): Agent<any, any> {
  const baseConfig = {
    name: "Infra Agent",
    model: options.model ?? settings.openaiModel,
    instructions: [
      "You are a standalone infrastructure engineering agent.",
      "Work inside the sandbox workspace and use filesystem and shell tools when useful.",
      "Repository resources are mounted under repos/<owner>/<repo>.",
      "Terraform and infrastructure skills are under .agents/ including terraform style, terraform test, terraform stacks, Azure verified modules, search/import, refactor module, and checkov.",
      "Use Checkov, Terraform, Azure CLI, GitHub CLI, and repository tools when relevant.",
      "When Azure credentials are available, the sandbox is pre-authenticated with normal Azure CLI before work starts.",
      "Treat code-changing work as GitOps work: create a focused branch/commit/PR when GitHub credentials are available; otherwise report exact commands and blockers.",
      "Return concise, factual summaries with files changed, commands run, and remaining blockers.",
    ].join(" "),
    modelSettings: {
      reasoning: { effort: options.reasoningEffort ?? settings.openaiReasoningEffort, summary: "detailed" },
    },
  } as const;

  if (settings.sandboxBackend === "none") {
    return new Agent(baseConfig);
  }

  return new SandboxAgent({
    ...baseConfig,
    defaultManifest: buildManifest(settings, resources, options.sandboxEnvironment),
    capabilities: [
      ...Capabilities.default(),
      skills({ lazyFrom: localDirLazySkillSource({ src: bundledSkillsDir() }) }),
    ],
  });
}

export function createSandboxClient(settings: Settings, environment = collectSandboxEnvironment(settings)): unknown {
  if (settings.sandboxBackend === "docker") {
    return new DockerSandboxClient({
      image: settings.dockerImage,
      exposedPorts: parseExposedPorts(settings.dockerExposedPorts),
    });
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
  const client = rawClient ? withAzurePreflight(rawClient as SandboxClient, environment, overrides.onRuntimeEvent) : undefined;
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
  } else if (item.type === "reasoning_item") {
    out.push({ type: "agent.reasoning.delta", payload: { item } });
  }
  return out;
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

function buildManifest(settings: Settings, resources: ResourceRef[], environment = collectSandboxEnvironment(settings)): Manifest {
  const entries: Record<string, any> = {};
  for (const resource of resources) {
    if (resource.kind !== "repository") {
      continue;
    }
    const metadata = resource.metadata;
    const host = stringValue(metadata.host);
    const repo = stringValue(metadata.repo);
    const ref = stringValue(metadata.ref);
    const mountPath = stringValue(metadata.mount_path)?.replace(/^\/+|\/+$/g, "");
    const subpath = stringValue(metadata.subpath) ?? undefined;
    if (host && repo && ref && mountPath) {
      entries[mountPath] = gitRepo({
        host,
        repo,
        ref,
        ...(subpath ? { subpath } : {}),
      });
    }
  }
  return new Manifest({
    root: "/workspace",
    entries,
    environment,
  });
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
  const envelope = entry.sessionState;
  if (!envelope || typeof envelope !== "object") {
    return undefined;
  }
  return {
    ...(envelope.providerState ?? {}),
    manifest: envelope.manifest,
    ...(envelope.snapshot !== undefined ? { snapshot: envelope.snapshot } : {}),
    ...(envelope.snapshotFingerprint !== undefined ? { snapshotFingerprint: envelope.snapshotFingerprint } : {}),
    ...(envelope.snapshotFingerprintVersion !== undefined ? { snapshotFingerprintVersion: envelope.snapshotFingerprintVersion } : {}),
    workspaceReady: envelope.workspaceReady,
    ...(envelope.exposedPorts ? { exposedPorts: structuredClone(envelope.exposedPorts) } : {}),
  } as SandboxSessionState;
}

function withAzurePreflight(
  client: SandboxClient,
  environment: Record<string, string>,
  onRuntimeEvent?: (event: NormalizedRuntimeEvent) => Promise<void> | void,
): SandboxClient {
  if (!hasAzureServicePrincipal(environment)) {
    return client;
  }
  const seen = new WeakSet<object>();
  const wrapSession = async <T extends SandboxSessionLike>(session: T): Promise<T> => {
    if (typeof session === "object" && session !== null && !seen.has(session)) {
      seen.add(session);
      await runAzurePreflight(session, onRuntimeEvent);
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

export function azurePreflightCommand(): string {
  return [
    "CLIENT_ID=\"${AZURE_CLIENT_ID:-${ARM_CLIENT_ID:-}}\"",
    "CLIENT_SECRET=\"${AZURE_CLIENT_SECRET:-${ARM_CLIENT_SECRET:-}}\"",
    "TENANT_ID=\"${AZURE_TENANT_ID:-${ARM_TENANT_ID:-}}\"",
    "SUBSCRIPTION_ID=\"${AZURE_SUBSCRIPTION_ID:-${ARM_SUBSCRIPTION_ID:-}}\"",
    "if [ -n \"$CLIENT_ID\" ] && [ -n \"$CLIENT_SECRET\" ] && [ -n \"$TENANT_ID\" ]; then",
    "  az account show --only-show-errors >/dev/null 2>&1 || az login --service-principal --username \"$CLIENT_ID\" --password \"$CLIENT_SECRET\" --tenant \"$TENANT_ID\" --allow-no-subscriptions --only-show-errors --output none",
    "  [ -n \"$SUBSCRIPTION_ID\" ] && az account set --subscription \"$SUBSCRIPTION_ID\" --only-show-errors",
    "fi",
  ].join("\n");
}

function hasAzureServicePrincipal(environment: Record<string, string>): boolean {
  const clientId = environment.AZURE_CLIENT_ID || environment.ARM_CLIENT_ID;
  const clientSecret = environment.AZURE_CLIENT_SECRET || environment.ARM_CLIENT_SECRET;
  const tenantId = environment.AZURE_TENANT_ID || environment.ARM_TENANT_ID;
  return Boolean(clientId && clientSecret && tenantId);
}

async function runAzurePreflight(
  session: SandboxSessionLike,
  onRuntimeEvent?: (event: NormalizedRuntimeEvent) => Promise<void> | void,
): Promise<void> {
  const payload = { name: "azure-cli-login", command: "az login --service-principal" };
  await onRuntimeEvent?.({ type: "sandbox.operation.started", payload });
  try {
    if (session.exec) {
      const result = await session.exec({
        cmd: azurePreflightCommand(),
        workdir: "/workspace",
        yieldTimeMs: 1_000,
        maxOutputTokens: 20_000,
      });
      if (result.exitCode && result.exitCode !== 0) {
        throw new Error(result.output || result.stderr || `Azure CLI preflight failed with exit code ${result.exitCode}`);
      }
    } else if (session.execCommand) {
      await session.execCommand({
        cmd: azurePreflightCommand(),
        workdir: "/workspace",
        yieldTimeMs: 1_000,
        maxOutputTokens: 20_000,
      });
    } else {
      throw new Error("Sandbox session does not support command execution");
    }
    await onRuntimeEvent?.({ type: "sandbox.operation.completed", payload });
  } catch (error) {
    await onRuntimeEvent?.({
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

function bundledSkillsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "bundled_hashicorp_terraform_skills");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isAsyncIterable<T>(source: Iterable<T> | AsyncIterable<T>): source is AsyncIterable<T> {
  return typeof (source as AsyncIterable<T>)[Symbol.asyncIterator] === "function";
}

function approvalIdentifier(item: any): string {
  return String(item?.rawItem?.callId ?? item?.rawItem?.id ?? item?.id ?? item?.name ?? "approval");
}
