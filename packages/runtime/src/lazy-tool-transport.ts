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
import {
  DEFAULT_MODEL_TOOL_OUTPUT_TRUNCATION_TOKENS,
  modelToolOutputSerializationBudgetTokens,
} from "@opengeni/codex";
import { isSearchableMcpFunctionTool, searchMcpTools } from "./codex-tool-search";

/** Provider-contained progressive-disclosure strategy for one resolved turn. */
export type LazyToolTransport = "codex_native" | "openai_native" | "generic_dispatch";

const TOOL_SEARCH_NAME = "tool_search";
const TOOL_INVOKE_NAME = "tool_invoke";
const DISPATCH_MARKER_KEY = "opengeni.lazy_dispatch.v1";

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
  readonly controlTools: Tool[];

  constructor(
    readonly transport: Exclude<LazyToolTransport, "codex_native">,
    private readonly mcpServerIds: ReadonlySet<string>,
    modelToolOutputTruncationTokens = DEFAULT_MODEL_TOOL_OUTPUT_TRUNCATION_TOKENS,
  ) {
    this.genericSearchResultMaxBytes =
      modelToolOutputSerializationBudgetTokens(modelToolOutputTruncationTokens) * 4;
    this.controlTools =
      transport === "openai_native"
        ? [this.buildNativeSearchTool()]
        : [this.buildGenericSearchTool(), this.buildGenericInvokeTool()];
  }

  private readonly genericSearchResultMaxBytes: number;

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
      if (isSearchableMcpFunctionTool(tool, this.mcpServerIds)) {
        // Native OpenAI client search and generic dispatch keep the real tool
        // in Runner's registry but deliberately do not use the SDK's deferred
        // gate. Enforce that invariant even if an upstream tool object was
        // previously tagged; only Codex's separate transport uses deferLoading.
        tool.deferLoading = false;
        this.searchableToolNames.add(tool.name);
      }
    }
  }

  shouldHideSerializedTool(tool: SerializedTool): boolean {
    return tool.type === "function" && this.searchableToolNames.has(tool.name);
  }

  resolveFunctionTool(name: string): Tool | undefined {
    return this.functionTools.get(name);
  }

  wrapModel(model: Model): Model {
    const existing = this.wrappedModels.get(model);
    if (existing) return existing;
    const wrapped = new LazyToolModel(model, this);
    this.wrappedModels.set(model, wrapped);
    this.wrappedModels.set(wrapped, wrapped);
    return wrapped;
  }

  search(rawArguments: unknown): Tool[] {
    return searchMcpTools(this.currentTools, rawArguments, this.mcpServerIds);
  }

  private buildNativeSearchTool(): Tool {
    return toolSearchTool({
      execution: "client",
      description: SEARCH_DESCRIPTION,
      parameters: SEARCH_PARAMETERS as never,
      execute: ((args: { availableTools?: Tool[]; toolCall?: { arguments?: unknown } }) =>
        searchMcpTools(
          args.availableTools ?? [],
          args.toolCall?.arguments,
          this.mcpServerIds,
        )) as never,
    }) as unknown as Tool;
  }

  private buildGenericSearchTool(): Tool {
    return agentTool({
      name: TOOL_SEARCH_NAME,
      description: SEARCH_DESCRIPTION,
      parameters: SEARCH_PARAMETERS as never,
      strict: false,
      execute: (input: unknown) => {
        const emptyResult = JSON.stringify({ tools: [] });
        if (Buffer.byteLength(emptyResult) > this.genericSearchResultMaxBytes) {
          return "{}";
        }
        const definitions: Record<string, unknown>[] = [];
        for (const tool of this.search(input)) {
          const definition = modelVisibleToolDefinition(tool);
          if (!definition) continue;
          const candidate = JSON.stringify({ tools: [...definitions, definition] });
          if (Buffer.byteLength(candidate) > this.genericSearchResultMaxBytes) continue;
          definitions.push(definition);
        }
        // Always return complete JSON. Never let ordinary function-output
        // truncation silently mutate a disclosed schema.
        return definitions.length === 0 ? emptyResult : JSON.stringify({ tools: definitions });
      },
    }) as unknown as Tool;
  }

  private buildGenericInvokeTool(): Tool {
    return agentTool({
      name: TOOL_INVOKE_NAME,
      description: INVOKE_DESCRIPTION,
      parameters: INVOKE_PARAMETERS as never,
      strict: false,
      // A valid call is rewritten to the real runtime tool before Runner sees it.
      // Reaching this executor therefore means the requested tool is absent or
      // the dispatcher arguments were malformed; never bypass approval/guardrails
      // by invoking a real tool from inside this control tool.
      execute: (input: unknown) => unavailableToolResult(input),
    }) as unknown as Tool;
  }
}

const lazyToolRuntimeByAgent = new WeakMap<object, LazyToolRuntime>();

export function lazyToolRuntimeForAgent(agent: object): LazyToolRuntime | undefined {
  return lazyToolRuntimeByAgent.get(agent);
}

/**
 * Install native OpenAI/Azure or generic progressive disclosure on an agent.
 * The full tools remain in Runner's execution registry; only the model wrapper
 * projects searchable schemas out of provider requests.
 */
export function installLazyToolRuntime(
  agent: CloneCapableAgent,
  transport: Exclude<LazyToolTransport, "codex_native">,
  mcpServerIds: ReadonlySet<string>,
  modelToolOutputTruncationTokens = DEFAULT_MODEL_TOOL_OUTPUT_TRUNCATION_TOKENS,
): LazyToolRuntime {
  const runtime = new LazyToolRuntime(transport, mcpServerIds, modelToolOutputTruncationTokens);
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
  agent.getAllTools = (async (runContext: unknown) => {
    const tools = await originalGetAllTools(runContext);
    runtime.refresh(tools);
    return [...tools, ...runtime.controlTools];
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
  return Object.keys(restored).length > 0 ? restored : undefined;
}

/** Restore internal real-tool calls to the provider's original dispatcher transcript. */
export function restoreGenericDispatchHistory(input: ModelRequest["input"]): ModelRequest["input"] {
  if (!Array.isArray(input)) return input;
  let changed = false;
  const restoredInput = input.map((candidate) => {
    const restored = restoreGenericDispatchHistoryItem(candidate);
    changed ||= restored !== candidate;
    return restored;
  });
  return changed ? restoredInput : input;
}

/** Per-item form used by the run-local memoized wire projector. */
export function restoreGenericDispatchHistoryItem<T>(candidate: T): T {
  if (!isRecord(candidate) || candidate.type !== "function_call") return candidate;
  const providerData = isRecord(candidate.providerData) ? candidate.providerData : undefined;
  const marker = providerData?.[DISPATCH_MARKER_KEY];
  if (!isRecord(marker) || marker.version !== 1 || typeof marker.arguments !== "string") {
    return candidate;
  }
  const restored = {
    ...candidate,
    name: TOOL_INVOKE_NAME,
    arguments: marker.arguments,
  } as Record<string, unknown>;
  const cleanProviderData = restoredProviderData(providerData);
  if (cleanProviderData) restored.providerData = cleanProviderData;
  else delete restored.providerData;
  return restored as T;
}

/** Restore every historical generic-dispatch call to its provider-visible transcript. */
export function restoreGenericDispatchHistoryItems(
  input: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return restoreGenericDispatchHistory(input as ModelRequest["input"]) as Array<
    Record<string, unknown>
  >;
}

function transformGenericDispatchCall(candidate: unknown, runtime: LazyToolRuntime): unknown {
  if (!isRecord(candidate) || candidate.type !== "function_call") return candidate;
  if (candidate.name !== TOOL_INVOKE_NAME || typeof candidate.arguments !== "string") {
    return candidate;
  }
  const dispatch = parseJsonObject(candidate.arguments);
  const name = dispatch && typeof dispatch.name === "string" ? dispatch.name : null;
  const args = dispatch?.arguments;
  if (!name || !isRecord(args) || !runtime.resolveFunctionTool(name)) {
    return candidate;
  }
  const providerData = isRecord(candidate.providerData) ? candidate.providerData : {};
  if (DISPATCH_MARKER_KEY in providerData) {
    throw new Error("Provider function call collided with OpenGeni lazy-dispatch metadata");
  }
  return {
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
  } as unknown as FunctionCallItem;
}

export function transformGenericDispatchResponse(
  response: ModelResponse,
  runtime: LazyToolRuntime,
): ModelResponse {
  return {
    ...response,
    output: response.output.map((item) =>
      transformGenericDispatchCall(item, runtime),
    ) as ModelResponse["output"],
  };
}

function prepareLazyToolRequest(request: ModelRequest, runtime: LazyToolRuntime): ModelRequest {
  return {
    ...request,
    // Historical generic-dispatch calls must be restored even after switching
    // the current turn to native OpenAI search.
    input: restoreGenericDispatchHistory(request.input),
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
    return this.runtime.transport === "generic_dispatch"
      ? transformGenericDispatchResponse(response, this.runtime)
      : response;
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    for await (const event of this.inner.getStreamedResponse(
      prepareLazyToolRequest(request, this.runtime),
    )) {
      if (this.runtime.transport === "generic_dispatch" && event.type === "response_done") {
        yield {
          ...event,
          response: {
            ...event.response,
            output: event.response.output.map((item) =>
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
