import {
  tool as agentTool,
  toolSearchTool,
  type Model,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type SerializedTool,
  type StreamEvent,
  type Tool,
} from "@openai/agents";
import { isSearchableMcpFunctionTool, searchToolPool } from "./codex-tool-search";
import { MCP_MAX_TOOL_SEARCH_DISCLOSURE_BYTES } from "./mcp-network";

/** Provider-contained progressive-disclosure strategy for one resolved turn. */
export type LazyToolTransport = "codex_native" | "openai_native" | "generic_dispatch";

const TOOL_SEARCH_NAME = "tool_search";
const TOOL_INVOKE_NAME = "tool_invoke";
/**
 * Base runtime tools that stay in the first request on every transport. These
 * have no MCP connection to prepare, so "eager" here means schema visibility
 * only, not a first-request preparation barrier. Literal rather than
 * HUMAN_INPUT_TOOL_NAME: run-events imports this module.
 */
const ALWAYS_VISIBLE_BASE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "exec_command",
  "write_stdin",
  "view_image",
  // A plain function tool on Chat Completions; Responses uses type apply_patch.
  "apply_patch",
  // The SDK skills capability prints the skill index in the instructions and
  // mandates this call before any SKILL.md read.
  "load_skill",
  "request_human_input",
]);
const DISPATCH_MARKER_KEY = "opengeni.lazy_dispatch.v1";
const SEARCH_MARKER_KEY = "opengeni.lazy_search.v1";
const INTERNAL_REGISTRATION_TOOL_MARKER_KEY = "opengeni.internal_lazy_registration.v1";
const INTERNAL_DISPATCH_REGISTRATION_CALL_PREFIX = "opengeni:lazy-dispatch:register:";

const SEARCH_DESCRIPTION =
  "Search the currently authorized tools by capability. Describe what you need to do in plain language. Returns only matching tool names and input schemas.";
const INVOKE_DESCRIPTION =
  "Invoke a tool returned by tool_search. Pass the exact returned tool name and put that tool's arguments in the nested arguments object.";

const SEARCH_PARAMETERS = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Plain-language description of the capability you need.",
    },
    limit: {
      type: "number",
      minimum: 1,
      maximum: 20,
      description: "Maximum matching tools to return (default 8).",
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

const INVOKE_PARAMETERS = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description: "Exact tool name returned by tool_search.",
    },
    arguments: {
      type: "object",
      description: "Arguments matching that tool's returned input schema.",
      additionalProperties: true,
    },
  },
  required: ["name", "arguments"],
  additionalProperties: false,
} as const;

type CloneCapableAgent = {
  getAllTools: (runContext: unknown) => Promise<Tool[]>;
  clone?: (config: unknown) => CloneCapableAgent;
  model?: string | Model;
};

type GenericDispatchMarker = {
  version: 1;
  arguments: string;
};

type GenericSearchMarker = {
  version: 1;
  output: string;
};

type FunctionCallItem = {
  type: "function_call";
  callId: string;
  name: string;
  arguments: string;
  providerData?: Record<string, unknown>;
  [key: string]: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFunctionTool(tool: Tool): tool is Tool & {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: boolean;
} {
  return tool.type === "function" && typeof (tool as { name?: unknown }).name === "string";
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function modelVisibleToolDefinition(tool: Tool): Record<string, unknown> | null {
  if (!isFunctionTool(tool)) return null;
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: tool.strict,
  };
}

function unavailableToolResult(input: unknown): string {
  const name = isRecord(input) && typeof input.name === "string" ? input.name : null;
  return JSON.stringify({
    ok: false,
    error: {
      code: name ? "tool_unavailable" : "invalid_tool_invoke",
      message: name
        ? `Tool ${JSON.stringify(name)} is not currently authorized or available. Search again before retrying.`
        : "tool_invoke requires an exact tool name and a nested arguments object.",
    },
  });
}

/** Shared live registry populated from the exact tool snapshot prepared by Runner. */
export class LazyToolRuntime {
  readonly wrappedAgents = new WeakSet<object>();
  readonly wrappedModels = new WeakMap<Model, Model>();
  private currentTools: Tool[] = [];
  private readonly functionTools = new Map<string, Tool>();
  private readonly searchableToolNames = new Set<string>();
  private readonly originalToolLoaders = new WeakMap<
    object,
    (runContext: unknown) => Promise<Tool[]>
  >();
  private preparationSettled = false;
  private preparedToolsLoaded = false;
  private activeAgent: object | null = null;
  private activeRunContext: unknown;
  readonly controlTools: Tool[];

  constructor(
    readonly transport: LazyToolTransport,
    private readonly mcpServerIds: ReadonlySet<string>,
    private readonly toolPreparationReady?: Promise<void>,
    private readonly deferredMcpServerIds: ReadonlySet<string> = mcpServerIds,
    private readonly preparationIndependentToolNames: ReadonlySet<string> = new Set(),
  ) {
    this.controlTools =
      transport !== "generic_dispatch"
        ? [this.buildNativeSearchTool()]
        : [this.buildGenericSearchTool(), this.buildGenericInvokeTool()];
    if (toolPreparationReady) {
      void toolPreparationReady.then(
        () => {
          this.preparationSettled = true;
        },
        () => {
          // The exact failure is rethrown at the model-response/tool boundary.
        },
      );
    } else {
      this.preparationSettled = true;
    }
  }

  hasPendingPreparation(): boolean {
    return !this.preparationSettled;
  }

  async ensurePrepared(): Promise<void> {
    await this.toolPreparationReady;
    this.preparationSettled = true;
    if (!this.preparedToolsLoaded && this.activeAgent) {
      const loader = this.originalToolLoaders.get(this.activeAgent);
      if (!loader) {
        throw new Error("Lazy tool search lost the agent's exact tool loader");
      }
      const loaded = await loader(this.activeRunContext);
      this.refresh(loaded);
      this.preparedToolsLoaded = true;
    }
  }

  async resolveAuthorizedFunctionTool(name: string): Promise<Tool | null> {
    await this.ensurePrepared();
    const direct = this.resolveFunctionTool(name);
    if (direct && isFunctionTool(direct)) return direct;
    const separator = name.lastIndexOf(".");
    if (separator > 0) {
      const suffix = name.slice(separator + 1);
      const bySuffix = this.resolveFunctionTool(suffix);
      if (bySuffix && isFunctionTool(bySuffix)) return bySuffix;
    }
    return null;
  }

  noteToolResolution(agent: object, runContext: unknown): void {
    this.activeAgent = agent;
    this.activeRunContext = runContext;
  }

  registerOriginalToolLoader(
    agent: object,
    loader: (runContext: unknown) => Promise<Tool[]>,
  ): void {
    this.originalToolLoaders.set(agent, loader);
  }

  async preparedToolsForAgent(
    agent: object,
    runContext: unknown,
    availableTools: readonly Tool[],
  ): Promise<Tool[]> {
    await this.ensurePrepared();
    const loader = this.originalToolLoaders.get(agent);
    if (!loader) {
      throw new Error("Lazy tool search lost the agent's exact tool loader");
    }
    const preparedTools = await loader(runContext);
    const availableFunctionsByName = new Map(
      availableTools.filter(isFunctionTool).map((tool) => [tool.name, tool] as const),
    );
    // Preserve the exact configured object already held by Runner, adding only
    // tools that did not exist when the first request began. Returning a newly
    // materialized duplicate for an existing routing key is correctly rejected
    // by the SDK as an authority/identity collision.
    const tools = preparedTools.map((tool) =>
      isFunctionTool(tool) ? (availableFunctionsByName.get(tool.name) ?? tool) : tool,
    );
    this.refresh(tools);
    this.preparedToolsLoaded = true;
    return tools;
  }

  refresh(tools: Tool[]): void {
    for (const tool of tools) {
      if (
        isFunctionTool(tool) &&
        (tool.name === TOOL_SEARCH_NAME ||
          (this.transport === "generic_dispatch" && tool.name === TOOL_INVOKE_NAME))
      ) {
        throw new Error(
          `Tool name ${JSON.stringify(tool.name)} is reserved by progressive tool disclosure`,
        );
      }
    }
    this.currentTools = tools;
    this.functionTools.clear();
    this.searchableToolNames.clear();
    for (const tool of tools) {
      if (!isFunctionTool(tool)) continue;
      this.functionTools.set(tool.name, tool);
      if (ALWAYS_VISIBLE_BASE_TOOL_NAMES.has(tool.name)) continue;
      if (this.preparationIndependentToolNames.has(tool.name)) continue;
      // Origin, not transport: deferred MCP plus every non-MCP function tool
      // outside the base set. ToolRef.eager still decides the MCP arm.
      const lazy =
        isSearchableMcpFunctionTool(tool, this.deferredMcpServerIds) ||
        !isSearchableMcpFunctionTool(tool, this.mcpServerIds);
      if (lazy) {
        // After the preparation fence, deferred tools stay off the Agent
        // list. Search teaches names; a remembered raw name binds later
        // through resolveMissingFunctionTool. Do not use the SDK's
        // deferLoading gate — installLazyToolRuntime clears it. Browser,
        // Computer, and image/video schemas hide behind search on every
        // transport; the base set stays in the first request.
        tool.deferLoading = false;
        this.searchableToolNames.add(tool.name);
      }
    }
  }

  shouldHideSerializedTool(tool: SerializedTool): boolean {
    if (tool.type === "function") return this.searchableToolNames.has(tool.name);
    return (
      this.transport === "generic_dispatch" &&
      tool.type === "hosted_tool" &&
      tool.providerData?.type === "tool_search" &&
      tool.providerData[INTERNAL_REGISTRATION_TOOL_MARKER_KEY] === true
    );
  }

  configuredExecutionTools(tools: Tool[]): Tool[] {
    if (!this.toolPreparationReady) return tools;
    // Required/eager tools stay on the Agent list. Deferred tools stay off
    // getAllTools so the first-request schema stays cache-prefix stable; a
    // remembered raw name binds through resolveMissingFunctionTool instead.
    return tools.filter((tool) => {
      if (!isFunctionTool(tool)) return true;
      return !this.searchableToolNames.has(tool.name);
    });
  }

  resolveFunctionTool(name: string): Tool | undefined {
    return this.functionTools.get(name);
  }

  requiresPreparationForFunctionCall(name: string): boolean {
    // Deferred preparation is one attempt-wide authority boundary, not only a
    // schema-discovery dependency. Keep the stable always-visible base tool
    // schemas on the first request, but make every ordinary function call join
    // the exact shared promise before Runner can dispatch it. The only
    // exceptions are exact attempt-local names supplied by the host. This
    // prevents an eager tool such as exec_command from launching an
    // out-of-process Codemode client before the attempt catalog has been
    // persisted and activated.
    return (
      !this.preparationIndependentToolNames.has(name) &&
      this.toolPreparationReady !== undefined &&
      !this.preparationSettled
    );
  }

  wrapModel(model: Model): Model {
    const existing = this.wrappedModels.get(model);
    if (existing) return existing;
    const wrapped = new LazyToolModel(model, this);
    this.wrappedModels.set(model, wrapped);
    this.wrappedModels.set(wrapped, wrapped);
    return wrapped;
  }

  private searchableTools(tools: readonly Tool[]): Tool[] {
    return tools.filter((tool) => isFunctionTool(tool) && this.searchableToolNames.has(tool.name));
  }

  search(rawArguments: unknown): Tool[] {
    return searchToolPool(this.searchableTools(this.currentTools), rawArguments);
  }

  genericSearchOutput(rawArguments: unknown): string {
    const definitions: Record<string, unknown>[] = [];
    for (const tool of this.search(rawArguments)) {
      const definition = modelVisibleToolDefinition(tool);
      if (!definition) continue;
      const candidate = JSON.stringify({ tools: [...definitions, definition] });
      if (Buffer.byteLength(candidate) > MCP_MAX_TOOL_SEARCH_DISCLOSURE_BYTES) continue;
      definitions.push(definition);
    }
    return JSON.stringify({ tools: definitions });
  }

  private buildNativeSearchTool(): Tool {
    return toolSearchTool({
      execution: "client",
      description: SEARCH_DESCRIPTION,
      parameters: SEARCH_PARAMETERS as never,
      execute: (async (args: {
        agent?: object;
        availableTools?: Tool[];
        runContext?: unknown;
        toolCall?: { arguments?: unknown };
      }) => {
        const tools = args.agent
          ? await this.preparedToolsForAgent(args.agent, args.runContext, args.availableTools ?? [])
          : (args.availableTools ?? []);
        // Eager MCP and the always-visible base set are already direct
        // configured tools on this request. Search may disclose only the
        // lazy set; returning an eager tool again would create a second
        // routed identity for one tool.
        return searchToolPool(this.searchableTools(tools), args.toolCall?.arguments);
      }) as never,
    }) as unknown as Tool;
  }

  private buildGenericSearchTool(): Tool {
    return agentTool({
      name: TOOL_SEARCH_NAME,
      description: SEARCH_DESCRIPTION,
      parameters: SEARCH_PARAMETERS as never,
      strict: false,
      execute: async (input: unknown) => {
        await this.ensurePrepared();
        return this.genericSearchOutput(input);
      },
    }) as unknown as Tool;
  }

  private buildGenericInvokeTool(): Tool {
    return agentTool({
      name: TOOL_INVOKE_NAME,
      description: INVOKE_DESCRIPTION,
      parameters: INVOKE_PARAMETERS as never,
      strict: false,
      // A valid call is rewritten to the real tool name before Runner sees it.
      // Reaching this executor therefore means the requested tool is absent or
      // the dispatcher arguments were malformed; never bypass approval/guardrails
      // by invoking a real tool from inside this control tool.
      execute: (input: unknown) => unavailableToolResult(input),
    }) as unknown as Tool;
  }
}

/** Bind a remembered raw name from the current authorized catalog, or null. */
export function createResolveMissingFunctionTool(runtime: LazyToolRuntime) {
  return async ({ name, toolCall }: { name: string; toolCall?: unknown }) => {
    const names = [name];
    if (isRecord(toolCall) && typeof toolCall.name === "string" && toolCall.name !== name) {
      names.push(toolCall.name);
    }
    for (const candidate of names) {
      const tool = await runtime.resolveAuthorizedFunctionTool(candidate);
      if (tool && isFunctionTool(tool)) return tool;
    }
    return null;
  };
}

const lazyToolRuntimeByAgent = new WeakMap<object, LazyToolRuntime>();

export function lazyToolRuntimeForAgent(agent: object): LazyToolRuntime | undefined {
  return lazyToolRuntimeByAgent.get(agent);
}

/**
 * Install native OpenAI/Azure or generic progressive disclosure on an agent.
 * Deferred schemas stay off the first-request tool block. A remembered raw
 * name binds through resolveMissingFunctionTool after the catalog is ready.
 * Classification is origin, not transport: the always-visible base set and
 * eager MCP tools stay in the first request; everything else is searchable.
 * Generic dispatch adds stable ordinary tool_search/tool_invoke schemas.
 */
export function installLazyToolRuntime(
  agent: CloneCapableAgent,
  transport: LazyToolTransport,
  mcpServerIds: ReadonlySet<string>,
  toolPreparationReady?: Promise<void>,
  deferredMcpServerIds: ReadonlySet<string> = mcpServerIds,
  preparationIndependentToolNames: ReadonlySet<string> = new Set(),
): LazyToolRuntime {
  const runtime = new LazyToolRuntime(
    transport,
    mcpServerIds,
    toolPreparationReady,
    deferredMcpServerIds,
    preparationIndependentToolNames,
  );
  installLazyToolRuntimeOnAgent(agent, runtime);
  return runtime;
}

function installLazyToolRuntimeOnAgent(agent: CloneCapableAgent, runtime: LazyToolRuntime): void {
  if (runtime.wrappedAgents.has(agent)) return;
  runtime.wrappedAgents.add(agent);
  lazyToolRuntimeByAgent.set(agent, runtime);

  if (
    agent.model &&
    typeof agent.model === "object" &&
    typeof agent.model.getResponse === "function" &&
    typeof agent.model.getStreamedResponse === "function"
  ) {
    agent.model = runtime.wrapModel(agent.model);
  }

  const originalGetAllTools = agent.getAllTools.bind(agent);
  runtime.registerOriginalToolLoader(agent, originalGetAllTools);
  agent.getAllTools = (async (runContext: unknown) => {
    runtime.noteToolResolution(agent, runContext);
    if (runtime.hasPendingPreparation()) {
      // Deferred MCP projections return an empty list until their shared
      // preparation fence settles, while required/eager MCP and ordinary agent
      // tools resolve normally through the policy-wrapped SDK path.
      const tools = await originalGetAllTools(runContext);
      runtime.refresh(tools);
      return [...tools, ...runtime.controlTools];
    }
    const tools = await originalGetAllTools(runContext);
    runtime.refresh(tools);
    return [...runtime.configuredExecutionTools(tools), ...runtime.controlTools];
  }) as typeof agent.getAllTools;

  const originalClone = agent.clone?.bind(agent);
  if (originalClone) {
    agent.clone = ((config: unknown) => {
      const cloned = originalClone(config);
      installLazyToolRuntimeOnAgent(cloned, runtime);
      return cloned;
    }) as NonNullable<CloneCapableAgent["clone"]>;
  }
}

function restoredProviderData(providerData: unknown): Record<string, unknown> | undefined {
  if (!isRecord(providerData)) return undefined;
  const restored = { ...providerData };
  delete restored[DISPATCH_MARKER_KEY];
  delete restored[SEARCH_MARKER_KEY];
  return Object.keys(restored).length > 0 ? restored : undefined;
}

/** Restore internal real-tool calls to the provider's original dispatcher transcript. */
export function restoreGenericDispatchHistory(input: ModelRequest["input"]): ModelRequest["input"] {
  if (!Array.isArray(input)) return input;
  let changed = false;
  const restoredInput: typeof input = [];
  for (const candidate of input) {
    if (isInternalGenericDispatchRegistrationItem(candidate)) {
      changed = true;
      continue;
    }
    const restored = restoreGenericDispatchHistoryItem(candidate);
    changed ||= restored !== candidate;
    restoredInput.push(restored);
  }
  return changed ? restoredInput : input;
}

/** Per-item form used by the run-local memoized wire projector. */
export function restoreGenericDispatchHistoryItem<T>(candidate: T): T {
  if (!isRecord(candidate) || candidate.type !== "function_call") return candidate;
  const providerData = isRecord(candidate.providerData) ? candidate.providerData : undefined;
  const marker = providerData?.[DISPATCH_MARKER_KEY];
  const hasDispatchMarker =
    isRecord(marker) && marker.version === 1 && typeof marker.arguments === "string";
  const searchMarker = providerData?.[SEARCH_MARKER_KEY];
  const hasSearchMarker =
    isRecord(searchMarker) && searchMarker.version === 1 && typeof searchMarker.output === "string";
  if (!hasDispatchMarker && !hasSearchMarker) {
    return candidate;
  }
  const restored = { ...candidate } as Record<string, unknown>;
  if (hasDispatchMarker) {
    restored.name = TOOL_INVOKE_NAME;
    restored.arguments = marker.arguments;
  }
  const cleanProviderData = restoredProviderData(providerData);
  if (cleanProviderData) restored.providerData = cleanProviderData;
  else delete restored.providerData;
  return restored as T;
}

function callId(candidate: Record<string, unknown>): string | null {
  if (typeof candidate.callId === "string") return candidate.callId;
  if (typeof candidate.call_id === "string") return candidate.call_id;
  const providerData = isRecord(candidate.providerData) ? candidate.providerData : null;
  return providerData && typeof providerData.call_id === "string" ? providerData.call_id : null;
}

export function isInternalGenericDispatchRegistrationItem(candidate: unknown): boolean {
  if (!isRecord(candidate)) return false;
  if (candidate.type !== "tool_search_call" && candidate.type !== "tool_search_output")
    return false;
  return callId(candidate)?.startsWith(INTERNAL_DISPATCH_REGISTRATION_CALL_PREFIX) ?? false;
}

function restoreGenericSearchResults(input: ModelRequest["input"]): ModelRequest["input"] {
  if (!Array.isArray(input)) return input;
  const disclosures = new Map<string, string>();
  for (const candidate of input) {
    if (!isRecord(candidate) || candidate.type !== "function_call") continue;
    const id = callId(candidate);
    const marker = isRecord(candidate.providerData)
      ? candidate.providerData[SEARCH_MARKER_KEY]
      : undefined;
    if (id && isRecord(marker) && marker.version === 1 && typeof marker.output === "string") {
      disclosures.set(id, marker.output);
    }
  }
  if (disclosures.size === 0) return input;
  let changed = false;
  const restored = input.map((candidate) => {
    if (!isRecord(candidate) || candidate.type !== "function_call_result") {
      return candidate;
    }
    const id = callId(candidate);
    const output = id ? disclosures.get(id) : undefined;
    if (output === undefined || candidate.output === output) return candidate;
    changed = true;
    return { ...candidate, output };
  });
  return changed ? restored : input;
}

/** Restore every historical generic-dispatch call to its provider-visible transcript. */
export function restoreGenericDispatchHistoryItems(
  input: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return restoreGenericDispatchHistory(input as ModelRequest["input"]) as Array<
    Record<string, unknown>
  >;
}

function transformGenericDispatchCall(candidate: unknown, runtime: LazyToolRuntime): unknown[] {
  if (!isRecord(candidate) || candidate.type !== "function_call") return [candidate];
  if (candidate.name === TOOL_SEARCH_NAME && typeof candidate.arguments === "string") {
    const providerData = isRecord(candidate.providerData) ? candidate.providerData : {};
    if (SEARCH_MARKER_KEY in providerData) {
      throw new Error("Provider function call collided with OpenGeni lazy-search metadata");
    }
    return [
      {
        ...candidate,
        providerData: {
          ...providerData,
          [SEARCH_MARKER_KEY]: {
            version: 1,
            output: runtime.genericSearchOutput(candidate.arguments),
          } satisfies GenericSearchMarker,
        },
      },
    ];
  }
  if (candidate.name !== TOOL_INVOKE_NAME || typeof candidate.arguments !== "string") {
    return [candidate];
  }
  const dispatch = parseJsonObject(candidate.arguments);
  const name = dispatch && typeof dispatch.name === "string" ? dispatch.name : null;
  const args = dispatch?.arguments;
  const originalCallId = callId(candidate);
  if (!name || !isRecord(args) || !runtime.resolveFunctionTool(name) || !originalCallId) {
    return [candidate];
  }
  const providerData = isRecord(candidate.providerData) ? candidate.providerData : {};
  if (DISPATCH_MARKER_KEY in providerData) {
    throw new Error("Provider function call collided with OpenGeni lazy-dispatch metadata");
  }
  return [
    {
      ...candidate,
      name,
      arguments: JSON.stringify(args),
      providerData: {
        ...providerData,
        [DISPATCH_MARKER_KEY]: {
          version: 1,
          arguments: candidate.arguments,
        } satisfies GenericDispatchMarker,
      },
    } as unknown as FunctionCallItem,
  ];
}

export function transformGenericDispatchResponse(
  response: ModelResponse,
  runtime: LazyToolRuntime,
): ModelResponse {
  return {
    ...response,
    output: response.output.flatMap((item) =>
      transformGenericDispatchCall(item, runtime),
    ) as ModelResponse["output"],
  };
}

function prepareLazyToolRequest(request: ModelRequest, runtime: LazyToolRuntime): ModelRequest {
  const input = restoreGenericSearchResults(request.input);
  return {
    ...request,
    // Historical generic-dispatch calls must be restored even after switching
    // the current turn to native OpenAI search.
    input: restoreGenericDispatchHistory(input),
    tools: request.tools.filter((tool) => !runtime.shouldHideSerializedTool(tool)),
  };
}

class LazyToolModel implements Model {
  constructor(
    private readonly inner: Model,
    private readonly runtime: LazyToolRuntime,
  ) {}

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const response = await this.inner.getResponse(prepareLazyToolRequest(request, this.runtime));
    if (responseRequiresToolPreparation(response, this.runtime)) {
      await this.runtime.ensurePrepared();
    }
    return this.runtime.transport === "generic_dispatch"
      ? transformGenericDispatchResponse(response, this.runtime)
      : response;
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    for await (const event of this.inner.getStreamedResponse(
      prepareLazyToolRequest(request, this.runtime),
    )) {
      if (event.type === "response_done") {
        if (responseRequiresToolPreparation(event.response, this.runtime)) {
          await this.runtime.ensurePrepared();
        }
      }
      if (this.runtime.transport === "generic_dispatch" && event.type === "response_done") {
        yield {
          ...event,
          response: {
            ...event.response,
            output: event.response.output.flatMap((item) =>
              transformGenericDispatchCall(item, this.runtime),
            ) as typeof event.response.output,
          },
        } as StreamEvent;
      } else {
        yield event;
      }
    }
  }

  getRetryAdvice(args: Parameters<NonNullable<Model["getRetryAdvice"]>>[0]) {
    return this.inner.getRetryAdvice?.({
      ...args,
      request: prepareLazyToolRequest(args.request, this.runtime),
    });
  }
}

function responseRequiresToolPreparation(
  response: { output: ModelResponse["output"] },
  runtime: LazyToolRuntime,
): boolean {
  return response.output.some(
    (item) =>
      isRecord(item) &&
      item.type === "function_call" &&
      typeof item.name === "string" &&
      runtime.requiresPreparationForFunctionCall(item.name),
  );
}

/** Wrap per-run model resolution without changing any provider client or SDK tool object. */
export class LazyToolModelProvider implements ModelProvider {
  constructor(
    private readonly inner: ModelProvider,
    private readonly runtime: LazyToolRuntime,
  ) {}

  async getModel(modelName?: string): Promise<Model> {
    const model = await this.inner.getModel(modelName);
    return this.runtime.wrapModel(model);
  }
}
