import { rememberPreparedModelRequest } from "./prepared-compaction-request";
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
  isHarnessControlMcpFunctionTool,
  interactionEntryCompanions,
  INTEGRATION_CARD_TOOL_NAME,
  INTEGRATION_CATALOG_TOOL_NAME,
  integrationSetupToolNames,
  isIntegrationSetupToolName,
  isInteractionEntryFunctionTool,
  isInteractionEntryToolName,
  isSearchableMcpFunctionTool,
  searchToolPool,
  rankToolPool,
  parseSearchArgs,
  toolsNamedInQuery,
  shortNameAlternatives,
  unresolvedToolNames,
} from "./codex-tool-search";
import { isOperationWord, ToolSearchIndex } from "./tool-discovery-ranking";
import { decisionCandidate, type ToolSelector } from "./tool-discovery-decision";
import { toolDescriptor, toolGroup, toolGroups } from "./tool-discovery-catalog";
import { toolDisclosureItem } from "./provider-history-adapter";
import { restoreDeferredToolArgumentTypes } from "./deferred-tool-arguments";
import {
  beforeModelRequest,
  modelResponseSettlement,
  notifyModelRequestCapture,
  streamPreemptibleModelRequest,
} from "./model-request-capture";

/** Provider-contained progressive-disclosure strategy for one resolved turn. */
export type LazyToolTransport = "codex_native" | "openai_native" | "generic_dispatch";

const TOOL_SEARCH_NAME = "tool_search";
const TOOL_LIST_NAME = "tool_list";
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
  // The server-backed reader needs neither sandbox setup nor tool search.
  "skill_read",
  // Repository descriptors route to the live sandbox reader.
  "repository_skill_read",
  "request_human_input",
  "list_models",
  // Jev-backed code search. Present only when the deployment and workspace
  // enable it; hiding it behind search would spend a model round trip to find
  // the tool that exists to save round trips.
  "code_search",
  // Provider web search, offered where the model has no hosted search. Hosted
  // search is never deferred, so neither is its replacement.
  "web_search",
  "web_fetch",
]);
const DISPATCH_MARKER_KEY = "opengeni.lazy_dispatch.v1";
const SEARCH_MARKER_KEY = "opengeni.lazy_search.v1";
/** Frozen companion schemas an entry-tool call disclosed, kept on the call itself. */
const FAMILY_DISCLOSURE_MARKER_KEY = "opengeni.family_disclosure.v1";
const INTERNAL_REGISTRATION_TOOL_MARKER_KEY = "opengeni.internal_lazy_registration.v1";
const INTERNAL_DISPATCH_REGISTRATION_CALL_PREFIX = "opengeni:lazy-dispatch:register:";

const SEARCH_DESCRIPTION =
  "Find currently authorized tools by capability. Describe the action and resource you need; separate independent tasks with semicolons and include useful context. Loads the strongest match and returns compact alternatives; ranking is not certainty, so check the match. If a decision model is configured, it can select tools for ambiguous searches. With schemasLoaded:true, only tools have loaded schemas; suggestions are unloaded alternatives. With schemasLoaded:false, load chosen exact names with query:'' before invoking. Known exact names bypass ranking and inference. Call loaded tools by name or through tool_invoke. Search is not exhaustive: tool_list view:'groups' shows available groups. Discovery never grants access.";
const NATIVE_SEARCH_DESCRIPTION =
  "Find currently authorized tools by capability. Describe the action and resource you need; separate independent tasks with semicolons and include useful context. Loads complete schemas for the strongest matches; ranking is not certainty, so check the match. If a decision model is configured, it can select tools for ambiguous searches. Call loaded functions directly. For compact alternatives or an empty result, use tool_list view:'groups' and browse a group, then load chosen exact names with query:''. Known exact names bypass ranking and inference. Discovery never grants access.";
const INVOKE_DESCRIPTION =
  "Invoke a tool whose complete schema was loaded by tool_search or an entry-tool disclosure. Pass its exact name and put its arguments in the nested arguments object.";

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
    names: {
      type: "array",
      items: { type: "string", maxLength: 512 },
      maxItems: 20,
      description:
        "Exact tool names to load with complete schemas. Replaces ranking; use query: ''.",
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
  version: 1 | 2;
  output: string;
  /** Version 2 distinguishes compact hits from actually loaded definitions. */
  tools?: Record<string, unknown>[];
  /**
   * Native routes only: integrations this search named that the person can
   * connect, said after the search result (generic routes put it in output).
   */
  notice?: string;
};

/** A catalog integration the person can connect from a card in this chat. */
export type ConnectableIntegration = { capabilityId: string; name: string };

/**
 * Reads catalog integrations matching a search query that the person can
 * connect from a card (setup status authorization required). Best effort:
 * a failure only means the search result names none.
 */
export type ConnectableIntegrationLookup = (
  query: string,
  signal?: AbortSignal,
) => Promise<readonly ConnectableIntegration[]>;

function normalizedWords(text: string): string {
  return ` ${text
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .join(" ")} `;
}

/**
 * The catalog matches the query actually names: the whole integration name as
 * words of the query ("Gmail", "Google Calendar"), never a description or
 * spelling-similarity hit. A one-word name the ranker reads as an operation
 * ("Send", "Make") names nothing: the query means the verb. At most three, in
 * catalog order.
 */
export function connectableIntegrationsNamedIn(
  query: string,
  matches: readonly ConnectableIntegration[],
): ConnectableIntegration[] {
  const words = normalizedWords(query);
  const named: ConnectableIntegration[] = [];
  for (const match of matches) {
    const name = normalizedWords(match.name);
    if (
      name.trim() &&
      !isOperationWord(match.name) &&
      words.includes(name) &&
      !named.some((n) => n.capabilityId === match.capabilityId)
    )
      named.push(match);
    if (named.length === 3) break;
  }
  return named;
}

/** The plain sentence a search result carries for connectable integrations. */
export function connectableIntegrationNotice(
  integrations: readonly ConnectableIntegration[],
): string {
  const listed = integrations
    .map(
      (integration) =>
        `${integration.name} (capabilityId ${JSON.stringify(integration.capabilityId)})`,
    )
    .join(", ");
  return integrations.length === 1
    ? `Not connected yet: ${listed}. If the task needs it, call capability_authorization_request with that capabilityId and a short rationale to show the person its Connect card.`
    : `Not connected yet: ${listed}. If the task needs one, call capability_authorization_request with its capabilityId and a short rationale to show the person its Connect card.`;
}

/**
 * The connected account a tool reaches: its source (one per account route),
 * how the account is named ("Gmail" or "Gmail (alice@example.com)"), its
 * connector, and the kind of need it serves (the connector's catalog
 * category, such as "communication") when one is known.
 */
export type ConnectedToolAccount = {
  source: string;
  label: string;
  connector: string;
  kind?: string;
};

/** At most this many other accounts are named; the rest are counted. */
const CONNECTED_ACCOUNTS_NAMED = 10;

/** The plain sentence a search result carries about the person's other connected accounts. */
export function connectedAccountsNotice(
  reached: readonly string[],
  others: readonly string[],
): string {
  const named = others.slice(0, CONNECTED_ACCOUNTS_NAMED).join(", ");
  const more = others.length - CONNECTED_ACCOUNTS_NAMED;
  return `These tools reach ${reached.join(", ")}. Also connected: ${named}${more > 0 ? `, and ${more} more` : ""}. If the request could mean those accounts too (the person's email, calendar or files), check each that fits, or say which account you checked and offer the others.`;
}

/**
 * A native search that loads nothing but ranked candidates lists them here,
 * as the generic output lists compact candidates: a native search output
 * carries loaded tools only, so without this it reads as "no matching tools".
 */
export function rankedCandidatesNotice(
  candidates: readonly { name: string; description: string }[],
): string {
  const listed = candidates
    .map(({ name, description }) => `- ${name}${description ? `: ${description}` : ""}`)
    .join("\n");
  return `No tool was loaded because none clearly matches. Closest candidates, not loaded:\n${listed}\nLoad the ones that fit by exact names with query:'', or search again in other words.`;
}

/**
 * The exact (not spelling-approximate) capability_catalog_search matches whose
 * next step is a Connect card the person completes themselves (connect or add
 * credentials), not one a workspace admin must enable. Accepts the MCP content
 * array or a full result.
 */
export function connectableIntegrationsFromCatalogResult(
  result: unknown,
): ConnectableIntegration[] {
  const content = Array.isArray(result)
    ? result
    : isRecord(result) && Array.isArray(result.content)
      ? result.content
      : [];
  if (isRecord(result) && result.isError === true) return [];
  const found: ConnectableIntegration[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(block.text);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.matches)) continue;
    for (const match of parsed.matches) {
      if (!isRecord(match) || match.approximate === true) continue;
      const setup = isRecord(match.setup) ? match.setup : null;
      const next = setup && isRecord(setup.nextAction) ? setup.nextAction : null;
      if (next?.toolName !== "capability_authorization_request") continue;
      if (setup!.action === "enable") continue;
      if (typeof match.capabilityId !== "string" || typeof match.name !== "string") continue;
      found.push({ capabilityId: match.capabilityId, name: match.name });
    }
  }
  return found;
}

/** Bounded so a slow catalog read never holds a search result back for long. */
const CONNECTABLE_LOOKUP_TIMEOUT_MS = 2_000;
/**
 * Only the catalog's best matches may be named: a common word that is also an
 * integration's name ("Send") ranks below the integration the query is about.
 */
const CONNECTABLE_LOOKUP_LIMIT = 3;

/**
 * Looks a search query up with the harness control server's catalog search,
 * through the same authorized call path as a model call of that tool.
 */
export function catalogConnectableIntegrationLookup(server: {
  callTool(
    toolName: string,
    args: Record<string, unknown> | null,
    meta?: Record<string, unknown> | null,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
  callToolResult?(
    toolName: string,
    args: Record<string, unknown> | null,
    meta?: Record<string, unknown> | null,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
}): ConnectableIntegrationLookup {
  return async (query, signal) => {
    const timeout = AbortSignal.timeout(CONNECTABLE_LOOKUP_TIMEOUT_MS);
    const options = { signal: signal ? AbortSignal.any([signal, timeout]) : timeout };
    const args = {
      query: Array.from(query).slice(0, 500).join(""),
      limit: CONNECTABLE_LOOKUP_LIMIT,
    };
    const result = server.callToolResult
      ? await server.callToolResult(INTEGRATION_CATALOG_TOOL_NAME, args, null, options)
      : await server.callTool(INTEGRATION_CATALOG_TOOL_NAME, args, null, options);
    return connectableIntegrationsFromCatalogResult(result);
  };
}

/**
 * Written once when the model calls an interaction entry tool (browser_open,
 * computer_open). The schemas are frozen at that moment so the disclosure the
 * provider sees after the step's results never changes on later requests,
 * even after a deploy changes the live catalog.
 */
type FamilyDisclosureMarker = {
  version: 1;
  tools: Record<string, unknown>[];
  /**
   * Native routes retain native loading; generic routes use tool_invoke.
   * Preserve the originating route on replay, never rewrite an old receipt.
   */
  viaToolInvoke: boolean;
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
  private routerWasExposed: boolean;
  private searchIndex: ToolSearchIndex | undefined;
  /** Whether a search this turn already named the person's connected accounts. */
  private connectedAccountsNamed = false;

  constructor(
    readonly transport: LazyToolTransport,
    private readonly mcpServerIds: ReadonlySet<string>,
    private readonly toolPreparationReady?: Promise<void>,
    private readonly deferredMcpServerIds: ReadonlySet<string> = mcpServerIds,
    private readonly preparationIndependentToolNames: ReadonlySet<string> = new Set(),
    private readonly modelMcpServerIds: () => ReadonlyMap<string, string> = () => new Map(),
    private readonly conditionalRouter = false,
    routerInHistory = false,
    private readonly startToolPreparation?: () => void,
    private readonly pendingMcpServerIds: ReadonlySet<string> = deferredMcpServerIds,
    /**
     * Exact model names a prepared deferred server keeps on the first request
     * (its harness control tools and the session's ToolRef.eager list).
     */
    private readonly firstRequestMcpToolNames: () => ReadonlySet<string> = () => new Set(),
    private readonly decisionModel?: ToolSelector,
    /** Best-effort MCP servers whose tools are missing this attempt, and why. */
    private readonly unavailableMcpServers: () => ReadonlyMap<string, string> = () => new Map(),
    /** Catalog integrations a search names that the person could connect. */
    private readonly connectableLookup?: ConnectableIntegrationLookup,
    /** The connected account each tool reaches, by model tool name. */
    private readonly connectedAccounts?: () => ReadonlyMap<string, ConnectedToolAccount>,
  ) {
    this.routerWasExposed = routerInHistory;
    this.controlTools =
      transport !== "generic_dispatch"
        ? [this.buildNativeSearchTool(), this.buildListTool()]
        : [
            this.buildGenericSearchTool(),
            this.buildGenericInvokeTool(),
            this.buildListTool(),
            this.buildNativeSearchTool(true),
          ];
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

  async prepareConditionalRouter(): Promise<void> {
    // Router visibility already accounts for authorized pending server IDs.
    // Joining their catalog here would put background MCP setup back on the
    // first-request path for configured agents. Tool demand still joins the
    // exact preparation fence; settled empty catalogs keep the router hidden.
    if (this.conditionalRouter && !this.hasPendingPreparation()) await this.ensurePrepared();
  }

  visibleControlTools(): Tool[] {
    // Pending servers are genuinely deferred, even before tools/list completes.
    this.routerWasExposed ||=
      !this.conditionalRouter ||
      this.searchableToolNames.size > 0 ||
      (this.hasPendingPreparation() && this.pendingMcpServerIds.size > 0);
    return this.routerWasExposed ? this.controlTools : [];
  }

  startPreparation(): void {
    this.startToolPreparation?.();
  }

  async ensurePrepared(): Promise<void> {
    this.startPreparation();
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
          tool.name === TOOL_LIST_NAME ||
          (this.transport === "generic_dispatch" && tool.name === TOOL_INVOKE_NAME))
      ) {
        throw new Error(
          `Tool name ${JSON.stringify(tool.name)} is reserved by progressive tool disclosure`,
        );
      }
    }
    this.currentTools = tools;
    this.searchIndex = undefined;
    this.functionTools.clear();
    this.searchableToolNames.clear();
    const modelServerIds = this.modelMcpServerIds();
    const firstRequestMcpToolNames = this.firstRequestMcpToolNames();
    for (const tool of tools) {
      if (!isFunctionTool(tool)) continue;
      this.functionTools.set(tool.name, tool);
      if (ALWAYS_VISIBLE_BASE_TOOL_NAMES.has(tool.name)) continue;
      if (this.preparationIndependentToolNames.has(tool.name)) continue;
      // Exact first-party harness control tools (goal lifecycle, command
      // polling, wait_for_input) stay visible on every transport when the
      // authorized opengeni server listed them; its other tools stay deferred.
      if (isHarnessControlMcpFunctionTool(tool, this.mcpServerIds, modelServerIds)) continue;
      // The session's exact eager tool list (ToolRef.eager as names): those
      // tools of an authorized prepared server stay in the first request; the
      // server's other tools stay searchable.
      if (
        firstRequestMcpToolNames.has(tool.name) &&
        isSearchableMcpFunctionTool(tool, this.mcpServerIds, modelServerIds)
      )
        continue;
      // Each interaction family's entry tool (browser_open, computer_open)
      // stays visible so a browser or computer task starts without a search
      // round trip; calling it discloses the rest of the family.
      if (isInteractionEntryFunctionTool(tool, this.mcpServerIds, modelServerIds)) continue;
      // Origin, not transport: deferred MCP plus every non-MCP function tool
      // outside the base set. ToolRef.eager still decides the MCP arm.
      const lazy =
        isSearchableMcpFunctionTool(tool, this.deferredMcpServerIds, modelServerIds) ||
        !isSearchableMcpFunctionTool(tool, this.mcpServerIds, modelServerIds);
      if (lazy) {
        // After the preparation fence, deferred tools stay off the Agent
        // list. Search teaches names; a remembered raw name binds later
        // through resolveMissingFunctionTool. Do not use the SDK's
        // deferLoading gate — installLazyToolRuntime clears it. Browser and
        // Computer tools other than their entry tools, and image/video
        // schemas, hide behind search on every transport; the base set stays
        // in the first request.
        tool.deferLoading = false;
        this.searchableToolNames.add(tool.name);
      }
    }
  }

  shouldHideSerializedTool(tool: SerializedTool): boolean {
    if (tool.type === "function") return this.searchableToolNames.has(tool.name);
    return (
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

  /** True for a tool disclosed through search rather than sent on every request. */
  isDeferredFunctionTool(name: string): boolean {
    return this.searchableToolNames.has(name);
  }

  inspectSearchableTools(): ReadonlyArray<{
    name: string;
    description: string;
    parameters: unknown;
    strict?: boolean;
  }> {
    const tools: Array<{
      name: string;
      description: string;
      parameters: unknown;
      strict?: boolean;
    }> = [];
    for (const name of [...this.searchableToolNames].sort()) {
      const tool = this.functionTools.get(name);
      if (!tool || !isFunctionTool(tool)) continue;
      tools.push({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        ...(typeof tool.strict === "boolean" ? { strict: tool.strict } : {}),
      });
    }
    return tools;
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

  /**
   * Integrations selected for this turn whose tools could not be loaded, so a
   * search that finds nothing is not read as "this integration has no such
   * tool". Absent when every server loaded; read live, never recomputed for
   * an earlier result.
   */
  private unavailableSources(): { unavailableSources?: { server: string; reason: string }[] } {
    const unavailable = [...this.unavailableMcpServers()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, 20)
      .map(([server, reason]) => ({ server, reason }));
    return unavailable.length ? { unavailableSources: unavailable } : {};
  }

  search(rawArguments: unknown): Tool[] {
    return searchToolPool(this.searchableTools(this.currentTools), rawArguments);
  }

  /** Compact discovery has no schema byte exclusions and discloses no companions. */
  matches(rawArguments: unknown): Tool[] {
    const tools = this.searchableTools(this.currentTools);
    this.searchIndex ??= new ToolSearchIndex(tools);
    return rankToolPool(tools, rawArguments, this.searchIndex);
  }

  searchDisclosure(rawArguments: unknown): Record<string, unknown>[] {
    if (parseSearchArgs(rawArguments).names === undefined) return [];
    return this.search(rawArguments)
      .map(modelVisibleToolDefinition)
      .filter((definition): definition is Record<string, unknown> => definition !== null);
  }

  /** Model-visible schemas an entry-tool call discloses, or [] for any other tool. */
  familyDisclosure(toolName: string): Record<string, unknown>[] {
    if (!isInteractionEntryToolName(toolName)) return [];
    return interactionEntryCompanions(toolName, this.searchableTools(this.currentTools))
      .map((tool) => modelVisibleToolDefinition(tool))
      .filter((definition): definition is Record<string, unknown> => definition !== null);
  }

  genericSearchOutput(rawArguments: unknown): string {
    const { names, limit } = parseSearchArgs(rawArguments);
    const tools = (
      names === undefined ? this.matches(rawArguments) : this.search(rawArguments)
    ).filter(isFunctionTool);
    const unavailable = names ? unresolvedToolNames(tools, names) : [];
    // A short name several servers share loads one of them; the others stay
    // reachable as unloaded alternatives under their full names.
    const pool = names ? this.searchableTools(this.currentTools).filter(isFunctionTool) : [];
    const suggestions = [
      ...new Set([
        ...(names ?? [])
          .flatMap((name) => shortNameAlternatives(pool, name))
          .filter((tool) => !tools.includes(tool)),
        ...(unavailable.length
          ? this.matches({ query: unavailable.join(" "), limit }).filter(isFunctionTool)
          : []),
      ]),
    ];
    return JSON.stringify({
      tools: tools.map(toolDescriptor),
      schemasLoaded: names !== undefined && tools.length > 0,
      ...(names === undefined ? {} : { unavailable }),
      ...this.unavailableSources(),
      ...(suggestions.length ? { suggestions: suggestions.map(toolDescriptor) } : {}),
    });
  }

  /** One decision and one detached receipt per call; never recompute historical output. */
  async prepareSearch(rawArguments: unknown, signal?: AbortSignal): Promise<GenericSearchMarker> {
    signal?.throwIfAborted();
    const { query, names, limit } = parseSearchArgs(rawArguments);
    if (names !== undefined) {
      const loaded: GenericSearchMarker = {
        version: 2,
        output: this.genericSearchOutput(rawArguments),
        tools: structuredClone(this.searchDisclosure(rawArguments)),
      };
      // Loading one account's tools by exact name (after browsing a group,
      // say) names the person's other accounts once per turn, as a ranked
      // search reaching that account does.
      const accounts = this.connectedAccountsNotice(loaded);
      return accounts ? this.withNotice(loaded, "connectedAccounts", accounts) : loaded;
    }
    const pool = this.searchableTools(this.currentTools);
    this.searchIndex ??= new ToolSearchIndex(pool);
    const named = toolsNamedInQuery(pool.filter(isFunctionTool), query).map((t) => t.name);
    const strong = this.searchIndex
      .strongMatches(query)
      .filter(isFunctionTool)
      .map((t) => t.name);
    const clear = this.decisionModel ? strong : [];
    const strongest = this.searchIndex
      .bestMatches(query)
      .filter(isFunctionTool)
      .map((t) => t.name);
    // Either integration setup tool brings the other. A search no installed
    // tool clearly matches, which names an integration the person can connect,
    // also loads the Connect card tool and names that integration plainly, so
    // the card is the next call. The catalog read runs alongside ranking and
    // any decision model; only the companions wait for it.
    const setup = integrationSetupToolNames(pool);
    const lookup: Promise<ConnectableIntegration[]> =
      named.length || strong.length || setup.length < 2
        ? Promise.resolve([])
        : this.connectableIntegrations(query, signal);
    // Rejects only on cancellation, which the search itself observes.
    lookup.catch(() => undefined);
    const setupFor = async (chosen: readonly string[]) =>
      (chosen.some(isIntegrationSetupToolName)
        ? setup
        : (await lookup).length
          ? [INTEGRATION_CARD_TOOL_NAME]
          : []
      ).filter((name) => !chosen.includes(name));
    const ranked = await this.rankedSearch(
      rawArguments,
      { query, limit, named, clear, strongest },
      setupFor,
      signal,
    );
    const result = this.withRankedCandidates(ranked);
    const connectable = await lookup;
    const withConnectable = connectable.length
      ? this.withNotice(result, "notConnected", connectableIntegrationNotice(connectable))
      : result;
    const accounts = this.connectedAccountsNotice(withConnectable);
    return accounts
      ? this.withNotice(withConnectable, "connectedAccounts", accounts)
      : withConnectable;
  }

  /**
   * The first search this turn whose result shows the model a tool reaching a
   * connected account (loaded, or as a compact candidate where the output
   * carries those) names the person's other accounts that serve the same
   * need: other accounts of that connector, and accounts whose connector has
   * the same kind. A request for "my email" can mean Gmail and Outlook Mail,
   * which ranking cannot tell are alike. An account whose tools failed to
   * load is reported as an unavailable source instead.
   */
  private connectedAccountsNotice(result: GenericSearchMarker): string | undefined {
    if (this.connectedAccountsNamed || !this.connectedAccounts) return undefined;
    const accounts = this.connectedAccounts();
    if (!accounts.size) return undefined;
    // Native search outputs carry only loaded definitions. A native search
    // that loads nothing shows its compact candidates in its notice instead.
    const listed =
      (this.transport === "generic_dispatch" || !result.tools?.length
        ? (JSON.parse(result.output) as { tools?: { name?: unknown }[] }).tools
        : result.tools) ?? [];
    const shown = new Map<string, ConnectedToolAccount>();
    for (const tool of listed) {
      const account = typeof tool.name === "string" ? accounts.get(tool.name) : undefined;
      if (account) shown.set(account.source, account);
    }
    if (!shown.size) return undefined;
    const connectors = new Set([...shown.values()].map((account) => account.connector));
    const kinds = new Set([...shown.values()].flatMap((account) => account.kind ?? []));
    const reached: string[] = [];
    const others: string[] = [];
    const seen = new Set<string>();
    for (const account of accounts.values()) {
      if (seen.has(account.source)) continue;
      seen.add(account.source);
      if (shown.has(account.source)) reached.push(account.label);
      else if (
        connectors.has(account.connector) ||
        (account.kind !== undefined && kinds.has(account.kind))
      )
        others.push(account.label);
    }
    if (!others.length) return undefined;
    this.connectedAccountsNamed = true;
    return connectedAccountsNotice(reached, others);
  }

  /**
   * On a native route a search that loads nothing would read as "no matching
   * tools" even where ranking found candidates the generic output lists. Its
   * notice lists those candidates instead, loading no schemas, so the model
   * can load the right ones by exact name.
   */
  private withRankedCandidates(result: GenericSearchMarker): GenericSearchMarker {
    if (this.transport === "generic_dispatch" || result.tools?.length) return result;
    const candidates =
      (JSON.parse(result.output) as { tools?: { name: string; description: string }[] }).tools ??
      [];
    if (!candidates.length) return result;
    const notice = rankedCandidatesNotice(candidates);
    return {
      ...result,
      notice: result.notice === undefined ? notice : `${result.notice}\n${notice}`,
    };
  }

  private async connectableIntegrations(
    query: string,
    signal?: AbortSignal,
  ): Promise<ConnectableIntegration[]> {
    if (!this.connectableLookup) return [];
    try {
      return connectableIntegrationsNamedIn(query, await this.connectableLookup(query, signal));
    } catch {
      // Cancellation belongs to the owning turn; any other failure only means
      // this result names no connectable integration.
      signal?.throwIfAborted();
      return [];
    }
  }

  /**
   * Plain text about a search result: a field of the JSON output, and on
   * native routes (whose search output cannot carry text) the marker notice.
   */
  private withNotice(
    result: GenericSearchMarker,
    field: string,
    notice: string,
  ): GenericSearchMarker {
    return {
      ...result,
      output: JSON.stringify({ ...JSON.parse(result.output), [field]: notice }),
      ...(this.transport === "generic_dispatch"
        ? {}
        : { notice: result.notice === undefined ? notice : `${result.notice}\n${notice}` }),
    };
  }

  private async rankedSearch(
    rawArguments: unknown,
    search: {
      query: string;
      limit: number;
      named: readonly string[];
      clear: readonly string[];
      strongest: readonly string[];
    },
    setupFor: (chosen: readonly string[]) => Promise<string[]>,
    signal?: AbortSignal,
  ): Promise<GenericSearchMarker> {
    const { query, limit, named, clear, strongest } = search;
    if (named.length || clear.length || !this.decisionModel) {
      const chosen = named.length ? named : clear.length ? clear : strongest;
      const companions = await setupFor(chosen);
      return chosen.length || companions.length
        ? this.selectedSearch(chosen, rawArguments, true, companions)
        : {
            version: 2,
            output: this.genericSearchOutput(rawArguments),
            tools: [],
          };
    }
    // Wider recall than the model-facing result page, not an execution quota.
    const candidates = this.searchIndex!.rank(query, Math.max(40, limit));
    if (!candidates.length) {
      const companions = await setupFor([]);
      return companions.length
        ? this.selectedSearch([], rawArguments, false, companions)
        : {
            version: 2,
            output: JSON.stringify({
              tools: [],
              schemasLoaded: false,
              ...this.unavailableSources(),
            }),
            tools: [],
          };
    }
    signal?.throwIfAborted();
    let chosen: readonly string[];
    try {
      chosen = await this.decisionModel({
        query,
        candidates: candidates.map(decisionCandidate),
        ...(signal ? { signal } : {}),
      });
      const available = new Set(candidates.filter(isFunctionTool).map((t) => t.name));
      if (
        !Array.isArray(chosen) ||
        chosen.some((name) => typeof name !== "string" || !available.has(name)) ||
        new Set(chosen).size !== chosen.length
      )
        throw new Error("Invalid decision model selection");
    } catch {
      // Cancellation belongs to the owning turn, not the recovery path.
      signal?.throwIfAborted();
      const companions = await setupFor(strongest);
      const fallback =
        strongest.length || companions.length
          ? this.selectedSearch(strongest, rawArguments, true, companions)
          : {
              version: 2 as const,
              output: this.genericSearchOutput(rawArguments),
              tools: [],
            };
      return {
        ...fallback,
        output: JSON.stringify({
          ...JSON.parse(fallback.output),
          fallback: "decision_model_unavailable",
        }),
      };
    }
    signal?.throwIfAborted();
    return this.selectedSearch(chosen, rawArguments, false, await setupFor(chosen));
  }

  private selectedSearch(
    chosen: readonly string[],
    rawArguments: unknown,
    alternatives: boolean,
    companions: readonly string[] = [],
  ): GenericSearchMarker {
    const { limit } = parseSearchArgs(rawArguments);
    // Resolve again after inference: revoked identities cannot be disclosed.
    // The existing disclosure byte budgets still apply, but automatic family
    // helpers are not a decision-model selection and do not enter its result.
    // Integration setup companions are explicit: they follow the selection and
    // do not count against its limit.
    const resolved = this.search({ query: "", names: [...chosen, ...companions], limit }).filter(
      isFunctionTool,
    );
    const selected = [
      ...resolved.filter((t) => chosen.includes(t.name)).slice(0, limit),
      ...resolved.filter((t) => companions.includes(t.name) && !chosen.includes(t.name)),
    ];
    return {
      version: 2,
      output: JSON.stringify({
        tools: selected.map(toolDescriptor),
        schemasLoaded: selected.length > 0,
        unavailable: chosen.filter((name) => !selected.some((t) => t.name === name)),
        ...this.unavailableSources(),
        ...(alternatives
          ? {
              suggestions: this.matches(rawArguments)
                .filter(isFunctionTool)
                .filter((t) => !selected.some((s) => s.name === t.name))
                .map(toolDescriptor),
            }
          : {}),
      }),
      tools: structuredClone(
        selected
          .map(modelVisibleToolDefinition)
          .filter((t): t is Record<string, unknown> => t !== null),
      ),
    };
  }

  private buildListTool(): Tool {
    return agentTool({
      name: TOOL_LIST_NAME,
      description:
        "Browse currently authorized deferred tools without ranking. Use view:'groups' for a compact directory with counts and examples, then group with an exact returned key to browse its tools. Default view:'tools' returns names and description previews, not schemas. Follow nextCursor until null with the same view and filters. namePrefix is an optional literal tool-name filter. Use tool_search with chosen exact names to load schemas. An empty page grants no new access and is not proof of capability absence.",
      // The SDK's non-strict schema type requires additionalProperties: true,
      // although a closed object with optional fields is valid non-strict JSON Schema.
      // Keep the wire contract closed, as with search/invoke below.
      parameters: {
        type: "object",
        properties: {
          view: {
            type: "string",
            enum: ["tools", "groups"],
            description:
              "Default tools; groups lists the available tool groups without loading schemas.",
          },
          group: {
            type: "string",
            description:
              "Exact group key returned by view:'groups'; filters only this authorized catalog.",
          },
          cursor: {
            type: "string",
            maxLength: 512,
            description:
              "Exact nextCursor from the previous page with the same view, group and namePrefix.",
          },
          namePrefix: {
            type: "string",
            maxLength: 512,
            description:
              "Optional literal tool-name prefix, not an authorization or connection identifier.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 40,
            description: "Maximum descriptors (default 20).",
          },
        },
        required: [],
        additionalProperties: false,
      } as never,
      strict: false,
      execute: async (input: unknown) => {
        await this.ensurePrepared();
        const args = isRecord(input) ? input : {};
        const prefix = typeof args.namePrefix === "string" ? args.namePrefix : "";
        const group = typeof args.group === "string" ? args.group : undefined;
        const serverIds = this.modelMcpServerIds();
        const cursor = typeof args.cursor === "string" ? args.cursor : undefined;
        const limit =
          typeof args.limit === "number" && Number.isFinite(args.limit)
            ? Math.max(1, Math.min(40, Math.floor(args.limit)))
            : 20;
        const authorizedTools = [...new Set(this.searchableTools(this.currentTools))]
          .filter(isFunctionTool)
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        const tools = authorizedTools.filter(
          (tool) =>
            tool.name.startsWith(prefix) &&
            (group === undefined || toolGroup(tool.name, serverIds) === group),
        );
        if (args.view === "groups") {
          const groups = toolGroups(tools, serverIds);
          const cursorIndex =
            cursor === undefined ? -1 : groups.findIndex((entry) => entry.group === cursor);
          if (cursor !== undefined && cursorIndex === -1)
            return JSON.stringify({
              error: "invalid_cursor",
              message: "Restart listing without a cursor in the current authorized catalog.",
            });
          const page: typeof groups = [];
          let index = cursorIndex + 1;
          for (; index < groups.length && page.length < limit; index++) {
            const entry = groups[index]!;
            if (
              Buffer.byteLength(
                JSON.stringify({
                  groups: [...page, entry],
                  total: groups.length,
                  nextCursor: entry.group,
                }),
              ) >
              16 * 1024
            ) {
              if (!page.length)
                return JSON.stringify({
                  error: "descriptor_too_large",
                  message: "A tool group exceeds the listing budget.",
                });
              break;
            }
            page.push(entry);
          }
          return JSON.stringify({
            groups: page,
            total: groups.length,
            nextCursor: index < groups.length ? page.at(-1)!.group : null,
            ...(cursor === undefined ? this.unavailableSources() : {}),
          });
        }
        const cursorIndex =
          cursor === undefined ? -1 : tools.findIndex((tool) => tool.name === cursor);
        if (cursor !== undefined && cursorIndex === -1) {
          return JSON.stringify({
            error: "invalid_cursor",
            message: "Restart listing without a cursor in the current authorized catalog.",
          });
        }
        const descriptors: { name: string; description: string }[] = [];
        let index = cursorIndex + 1;
        for (; index < tools.length && descriptors.length < limit; index++) {
          const tool = tools[index]!;
          const descriptor = toolDescriptor(tool);
          const candidate = {
            tools: [...descriptors, descriptor],
            total: tools.length,
            nextCursor: tool.name,
          };
          if (Buffer.byteLength(JSON.stringify(candidate)) > 16 * 1024) {
            if (descriptors.length === 0) {
              return JSON.stringify({
                error: "descriptor_too_large",
                message: "A tool name exceeds the listing budget.",
              });
            }
            break;
          }
          descriptors.push(descriptor);
        }
        const result = {
          tools: descriptors,
          total: tools.length,
          nextCursor: index < tools.length ? descriptors.at(-1)!.name : null,
          ...(cursor === undefined ? this.unavailableSources() : {}),
        };
        if (!prefix || tools.length > 0 || group !== undefined) return JSON.stringify(result);

        // Preserve literal-prefix pagination. Recovery hints are descriptors
        // from the same authorized deferred pool, never schemas or new grants.
        const recovery = {
          ...result,
          message:
            "No tool names match this literal prefix. This does not establish capability absence. Load any suggested exact names with tool_search, or retry tool_list without namePrefix to browse the authorized catalog.",
          suggestions: [] as { name: string; description: string }[],
        };
        for (const candidate of authorizedTools) {
          if (!candidate.name.includes(prefix)) continue;
          const suggestion = {
            name: candidate.name,
            description: Array.from(candidate.description).slice(0, 160).join(""),
          };
          const next = { ...recovery, suggestions: [...recovery.suggestions, suggestion] };
          if (Buffer.byteLength(JSON.stringify(next)) > 16 * 1024) continue;
          recovery.suggestions.push(suggestion);
          if (recovery.suggestions.length >= Math.min(limit, 8)) break;
        }
        return JSON.stringify(recovery);
      },
    }) as unknown as Tool;
  }

  private buildGenericSearchTool(): Tool {
    return agentTool({
      name: TOOL_SEARCH_NAME,
      description: SEARCH_DESCRIPTION,
      parameters: SEARCH_PARAMETERS as never,
      strict: false,
      execute: async (input: unknown, _context: unknown, details) => {
        await this.ensurePrepared();
        const marker = details?.toolCall?.providerData?.[SEARCH_MARKER_KEY] as
          | GenericSearchMarker
          | undefined;
        return marker?.output ?? (await this.prepareSearch(input, details?.signal)).output;
      },
    }) as unknown as Tool;
  }

  /** Preserve hosted client search and native function loading on native routes. */
  private buildNativeSearchTool(executionOnly = false): Tool {
    const search = toolSearchTool({
      execution: "client",
      description: NATIVE_SEARCH_DESCRIPTION,
      parameters: SEARCH_PARAMETERS as never,
      execute: (async (args: {
        agent?: object;
        availableTools?: Tool[];
        runContext?: unknown;
        toolCall?: { arguments?: unknown; providerData?: Record<string, unknown> };
      }) => {
        const tools = args.agent
          ? await this.preparedToolsForAgent(args.agent, args.runContext, args.availableTools ?? [])
          : (args.availableTools ?? []);
        const pool = this.searchableTools(tools);
        const marker = args.toolCall?.providerData?.[SEARCH_MARKER_KEY] as
          | GenericSearchMarker
          | undefined;
        if (marker?.version === 2 && marker.tools) {
          // Selection ran once at the model-response boundary with the owning
          // request's cancellation signal. Revalidate identities here and let
          // the SDK serialize the native output from original executable tools.
          const selected = new Set(marker.tools.map((entry) => entry.name));
          return marker.tools.flatMap((entry) => {
            const found = pool.find((tool) => isFunctionTool(tool) && tool.name === entry.name);
            return found && selected.delete(entry.name) ? [found] : [];
          });
        }
        // An interrupted pre-upgrade native call has no frozen selection. Finish
        // it through the original executor contract, never rerun completed history.
        return searchToolPool(pool, args.toolCall?.arguments);
      }) as never,
    }) as Tool;
    if (executionOnly && search.type === "hosted_tool")
      search.providerData = {
        ...search.providerData,
        [INTERNAL_REGISTRATION_TOOL_MARKER_KEY]: true,
      };
    return search;
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
 * Install provider-contained progressive disclosure on an agent.
 * Deferred schemas stay off the first-request tool block. A remembered raw
 * name binds through resolveMissingFunctionTool after the catalog is ready.
 * Classification is origin, not transport: the always-visible base set, eager
 * MCP tools, and the first-party harness control tools (goal lifecycle,
 * command polling, wait_for_input) stay in the first request when listed;
 * everything else is searchable.
 * Native routes retain hosted client search; other routes use stable ordinary
 * search/list/invoke controls. Neither path grows the top-level tool block.
 */
export function installLazyToolRuntime(
  agent: CloneCapableAgent,
  transport: LazyToolTransport,
  mcpServerIds: ReadonlySet<string>,
  toolPreparationReady?: Promise<void>,
  deferredMcpServerIds: ReadonlySet<string> = mcpServerIds,
  preparationIndependentToolNames: ReadonlySet<string> = new Set(),
  modelMcpServerIds?: () => ReadonlyMap<string, string>,
  conditionalRouter = false,
  routerInHistory = false,
  startToolPreparation?: () => void,
  pendingMcpServerIds: ReadonlySet<string> = deferredMcpServerIds,
  firstRequestMcpToolNames?: () => ReadonlySet<string>,
  decisionModel?: ToolSelector,
  unavailableMcpServers?: () => ReadonlyMap<string, string>,
  connectableLookup?: ConnectableIntegrationLookup,
  connectedAccounts?: () => ReadonlyMap<string, ConnectedToolAccount>,
): LazyToolRuntime {
  const runtime = new LazyToolRuntime(
    transport,
    mcpServerIds,
    toolPreparationReady,
    deferredMcpServerIds,
    preparationIndependentToolNames,
    modelMcpServerIds,
    conditionalRouter,
    routerInHistory,
    startToolPreparation,
    pendingMcpServerIds,
    firstRequestMcpToolNames,
    decisionModel,
    unavailableMcpServers,
    connectableLookup,
    connectedAccounts,
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
    await runtime.prepareConditionalRouter();
    if (runtime.hasPendingPreparation()) {
      // Deferred MCP projections return an empty list until their shared
      // preparation fence settles, while required/eager MCP and ordinary agent
      // tools resolve normally through the policy-wrapped SDK path.
      const tools = await originalGetAllTools(runContext);
      runtime.refresh(tools);
      return [...tools, ...runtime.visibleControlTools()];
    }
    const tools = await originalGetAllTools(runContext);
    runtime.refresh(tools);
    return [...runtime.configuredExecutionTools(tools), ...runtime.visibleControlTools()];
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
  delete restored[FAMILY_DISCLOSURE_MARKER_KEY];
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
  if (
    !isRecord(candidate) ||
    (candidate.type !== "function_call" && candidate.type !== "tool_search_call")
  )
    return candidate;
  const providerData = isRecord(candidate.providerData) ? candidate.providerData : undefined;
  const marker = providerData?.[DISPATCH_MARKER_KEY];
  const hasDispatchMarker =
    isRecord(marker) && marker.version === 1 && typeof marker.arguments === "string";
  const searchMarker = providerData?.[SEARCH_MARKER_KEY];
  const hasSearchMarker =
    isRecord(searchMarker) &&
    (searchMarker.version === 1 || searchMarker.version === 2) &&
    typeof searchMarker.output === "string";
  const hasFamilyMarker =
    providerData !== undefined && FAMILY_DISCLOSURE_MARKER_KEY in providerData;
  if (!hasDispatchMarker && !hasSearchMarker && !hasFamilyMarker) {
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
    if (
      id &&
      isRecord(marker) &&
      (marker.version === 1 || marker.version === 2) &&
      typeof marker.output === "string"
    ) {
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

function transformGenericDispatchCall(
  candidate: unknown,
  runtime: LazyToolRuntime,
  preparedSearch?: GenericSearchMarker,
): unknown[] {
  if (!isRecord(candidate) || candidate.type !== "function_call") return [candidate];
  if (candidate.name === TOOL_SEARCH_NAME && typeof candidate.arguments === "string") {
    const providerData = isRecord(candidate.providerData) ? candidate.providerData : {};
    if (SEARCH_MARKER_KEY in providerData) {
      throw new Error("Provider function call collided with lazy-search metadata");
    }
    return [
      {
        ...candidate,
        providerData: {
          ...providerData,
          [SEARCH_MARKER_KEY]:
            preparedSearch ??
            ({
              version: 2,
              output: runtime.genericSearchOutput(candidate.arguments),
              tools: structuredClone(runtime.searchDisclosure(candidate.arguments)),
            } satisfies GenericSearchMarker),
        },
      },
    ];
  }
  if (candidate.name !== TOOL_INVOKE_NAME || typeof candidate.arguments !== "string") {
    return [restoreDirectDeferredCallArgumentTypes(candidate, runtime)];
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
    throw new Error("Provider function call collided with lazy-dispatch metadata");
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

/**
 * A direct call by exact name to a search-disclosed tool reaches the provider
 * without that tool's schema, so its scalar, array and object values can
 * arrive as strings. Restore the declared types before Runner dispatches it.
 */
export function restoreDirectDeferredCallArgumentTypes(
  candidate: Record<string, unknown>,
  runtime: LazyToolRuntime,
): Record<string, unknown> {
  if (typeof candidate.name !== "string" || typeof candidate.arguments !== "string") {
    return candidate;
  }
  if (!runtime.isDeferredFunctionTool(candidate.name)) return candidate;
  const tool = runtime.resolveFunctionTool(candidate.name);
  if (!tool || !isFunctionTool(tool)) return candidate;
  const restored = restoreDeferredToolArgumentTypes(candidate.arguments, tool.parameters);
  return restored === null ? candidate : { ...candidate, arguments: restored };
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

/** Apply the transport's response rewrites to one model output item. */
async function transformResponseItem(
  item: unknown,
  runtime: LazyToolRuntime,
  signal?: AbortSignal,
): Promise<unknown[]> {
  if (isRecord(item) && item.type === "tool_search_call") {
    const providerData = isRecord(item.providerData) ? item.providerData : {};
    if ((item.execution ?? providerData.execution) === "client") {
      if (SEARCH_MARKER_KEY in providerData)
        throw new Error("Provider tool-search call collided with lazy-search metadata");
      await runtime.ensurePrepared();
      return [
        {
          ...item,
          providerData: {
            ...providerData,
            [SEARCH_MARKER_KEY]: await runtime.prepareSearch(item.arguments, signal),
          },
        },
      ];
    }
  }
  if (runtime.transport !== "generic_dispatch") {
    return [
      withFamilyDisclosure(
        isRecord(item) && item.type === "function_call"
          ? restoreDirectDeferredCallArgumentTypes(item, runtime)
          : item,
        runtime,
      ),
    ];
  }
  const search =
    isRecord(item) &&
    item.type === "function_call" &&
    item.name === TOOL_SEARCH_NAME &&
    typeof item.arguments === "string";
  const items = transformGenericDispatchCall(
    item,
    runtime,
    search ? await runtime.prepareSearch(item.arguments, signal) : undefined,
  );
  return items.map((candidate) => withFamilyDisclosure(candidate, runtime));
}

async function transformResponseOutput(
  output: ModelResponse["output"],
  runtime: LazyToolRuntime,
  signal?: AbortSignal,
): Promise<ModelResponse["output"]> {
  const transformed = (
    await Promise.all(output.map((item) => transformResponseItem(item, runtime, signal)))
  ).flat();
  const unchanged =
    transformed.length === output.length &&
    transformed.every((item, index) => item === output[index]);
  return unchanged ? output : (transformed as ModelResponse["output"]);
}

/**
 * Freeze the family an entry-tool call discloses onto the call. The provider
 * sees the disclosure after that step's results (see
 * expandInteractionFamilyDisclosures), so the model's next step can observe
 * and act without first searching for the tools.
 */
function withFamilyDisclosure(candidate: unknown, runtime: LazyToolRuntime): unknown {
  if (!isRecord(candidate) || candidate.type !== "function_call") return candidate;
  if (typeof candidate.name !== "string" || !isInteractionEntryToolName(candidate.name)) {
    return candidate;
  }
  const providerData = isRecord(candidate.providerData) ? candidate.providerData : {};
  if (FAMILY_DISCLOSURE_MARKER_KEY in providerData) return candidate;
  const tools = runtime.familyDisclosure(candidate.name);
  if (tools.length === 0) return candidate;
  return {
    ...candidate,
    providerData: {
      ...providerData,
      [FAMILY_DISCLOSURE_MARKER_KEY]: {
        version: 1,
        tools,
        viaToolInvoke: runtime.transport === "generic_dispatch",
      } satisfies FamilyDisclosureMarker,
    },
  };
}

function familyDisclosure(
  candidate: Record<string, unknown>,
): { tools: Record<string, unknown>[]; viaToolInvoke: boolean } | null {
  const providerData = isRecord(candidate.providerData) ? candidate.providerData : null;
  const marker = providerData?.[FAMILY_DISCLOSURE_MARKER_KEY];
  if (!isRecord(marker) || marker.version !== 1 || !Array.isArray(marker.tools)) return null;
  const tools = marker.tools.filter(
    (tool): tool is Record<string, unknown> => isRecord(tool) && typeof tool.name === "string",
  );
  return tools.length > 0 ? { tools, viaToolInvoke: marker.viaToolInvoke === true } : null;
}

function disclosedToolNames(tools: unknown): string[] {
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool) =>
    isRecord(tool) && typeof tool.name === "string" ? [tool.name] : [],
  );
}

function genericSearchOutputNames(output: string): string[] {
  const parsed = parseJsonObject(output);
  // Legacy search results carried definitions. Compact candidate descriptors
  // are not disclosures and must never suppress a later actual schema load.
  return parsed && parsed.schemasLoaded === undefined ? disclosedToolNames(parsed.tools) : [];
}

/** Items that answer a call of the model's previous step. */
const STEP_RESULT_ITEM_TYPES = new Set([
  "function_call_result",
  "computer_call_result",
  "shell_call_output",
  "apply_patch_call_output",
  "tool_search_output",
]);

/**
 * Declare the tools an entry call (browser_open, computer_open) made available
 * as one tool-disclosure item placed after that step's results, where a
 * developer message would go. Each provider projection renders it in its own
 * standard form (see projectHistoryForProvider). Tools the history already
 * disclosed are not repeated. The item depends only on earlier items, so every
 * later request reproduces the identical prefix.
 */
export function expandInteractionFamilyDisclosures<T>(input: T[]): T[] {
  const pending = new Map<string, { tools: Record<string, unknown>[]; viaToolInvoke: boolean }>();
  const disclosed = new Set<string>();
  // Native search results cannot carry text, so a native search's notice (see
  // GenericSearchMarker.notice) follows that step's results as a developer message.
  const pendingNotices = new Map<string, string>();
  let ready: Record<string, unknown>[] = [];
  let readyNotices: string[] = [];
  let readyViaToolInvoke = false;
  let readyAfter: object | null = null;
  let noticeAfter: object | null = null;
  let expanded = null as T[] | null;
  const flush = (index: number) => {
    if (readyAfter && ready.length > 0) {
      expanded ??= input.slice(0, index);
      expanded.push(cachedToolDisclosureItem(readyAfter, ready, readyViaToolInvoke) as T);
    }
    if (noticeAfter && readyNotices.length > 0) {
      expanded ??= input.slice(0, index);
      expanded.push(cachedNoticeItem(noticeAfter, readyNotices.join("\n")) as T);
    }
    ready = [];
    readyNotices = [];
    readyViaToolInvoke = false;
    readyAfter = null;
    noticeAfter = null;
  };
  for (let index = 0; index < input.length; index += 1) {
    const original = input[index]!;
    const candidate: unknown = original;
    const result = isRecord(candidate) && STEP_RESULT_ITEM_TYPES.has(String(candidate.type));
    if (!result) flush(index);
    expanded?.push(original);
    if (!isRecord(candidate)) continue;
    if (candidate.type === "tool_search_call") {
      const providerData = isRecord(candidate.providerData) ? candidate.providerData : null;
      const searchMarker = providerData?.[SEARCH_MARKER_KEY];
      const id = callId(candidate);
      if (id && isRecord(searchMarker) && typeof searchMarker.notice === "string")
        pendingNotices.set(id, searchMarker.notice);
      continue;
    }
    if (candidate.type === "tool_search_output") {
      for (const name of disclosedToolNames(candidate.tools)) disclosed.add(name);
      const id = callId(candidate);
      const notice = id ? pendingNotices.get(id) : undefined;
      if (id && notice !== undefined) {
        pendingNotices.delete(id);
        readyNotices.push(notice);
        noticeAfter = candidate;
      }
      continue;
    }
    if (candidate.type === "function_call") {
      const providerData = isRecord(candidate.providerData) ? candidate.providerData : null;
      const searchMarker = providerData?.[SEARCH_MARKER_KEY];
      if (isRecord(searchMarker) && typeof searchMarker.output === "string") {
        if (searchMarker.version === 1) {
          for (const name of genericSearchOutputNames(searchMarker.output)) disclosed.add(name);
        } else if (searchMarker.version === 2 && Array.isArray(searchMarker.tools)) {
          const id = callId(candidate);
          if (id)
            pending.set(id, { tools: searchMarker.tools.filter(isRecord), viaToolInvoke: true });
        }
      }
      const id = callId(candidate);
      const disclosure = familyDisclosure(candidate);
      if (id && disclosure) pending.set(id, disclosure);
      continue;
    }
    if (candidate.type !== "function_call_result") continue;
    if (candidate.name === TOOL_SEARCH_NAME && typeof candidate.output === "string") {
      for (const name of genericSearchOutputNames(candidate.output)) disclosed.add(name);
    }
    const id = callId(candidate);
    const disclosure = id ? pending.get(id) : undefined;
    if (!id || !disclosure) continue;
    pending.delete(id);
    for (const tool of disclosure.tools) {
      const name = String(tool.name);
      if (disclosed.has(name)) continue;
      disclosed.add(name);
      ready.push(tool);
      readyViaToolInvoke ||= disclosure.viaToolInvoke;
    }
    readyAfter = candidate;
  }
  flush(input.length);
  return expanded ?? input;
}

/**
 * The SDK reuses item identities between requests. Returning the same item for
 * the same step keeps later identity-memoized projections and their
 * append-only prefix reuse effective.
 */
const toolDisclosureItemCache = new WeakMap<
  object,
  { key: string; item: Record<string, unknown> }
>();

function cachedToolDisclosureItem(
  after: object,
  tools: Record<string, unknown>[],
  viaToolInvoke: boolean,
): Record<string, unknown> {
  const key = `${viaToolInvoke}\u0000${tools.map((tool) => String(tool.name)).join("\u0000")}`;
  const cached = toolDisclosureItemCache.get(after);
  if (cached?.key === key) return cached.item;
  const item = toolDisclosureItem(tools, { viaToolInvoke });
  toolDisclosureItemCache.set(after, { key, item });
  return item;
}

const noticeItemCache = new WeakMap<object, { key: string; item: Record<string, unknown> }>();

/** A plain developer message after a native search result, identical on every replay. */
function cachedNoticeItem(after: object, content: string): Record<string, unknown> {
  const cached = noticeItemCache.get(after);
  if (cached?.key === content) return cached.item;
  const item = { type: "message", role: "developer", content };
  noticeItemCache.set(after, { key: content, item });
  return item;
}

function prepareLazyToolRequest(request: ModelRequest, runtime: LazyToolRuntime): ModelRequest {
  const input = restoreGenericSearchResults(request.input);
  return {
    ...request,
    // Restore the exact recorded dispatcher transcript on every provider route.
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
    await beforeModelRequest("model_entry");
    const prepared = prepareLazyToolRequest(request, this.runtime);
    rememberPreparedModelRequest(prepared);
    void notifyModelRequestCapture(prepared);
    const response = await this.inner.getResponse(prepared);
    this.runtime.startPreparation();
    if (responseRequiresToolPreparation(response, this.runtime)) {
      await this.runtime.ensurePrepared();
    }
    return {
      ...response,
      output: await transformResponseOutput(response.output, this.runtime, request.signal),
    };
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    await beforeModelRequest("model_entry");
    const prepared = prepareLazyToolRequest(request, this.runtime);
    rememberPreparedModelRequest(prepared);
    void notifyModelRequestCapture(prepared);
    let responseStartedPreparation = false;
    for await (const event of streamPreemptibleModelRequest(prepared, (preemptible) =>
      this.inner.getStreamedResponse(preemptible),
    )) {
      // Some transports synthesize response_started before network I/O. A
      // substantive response is the provider-neutral fallback, not that marker.
      if (!responseStartedPreparation && event.type !== "response_started") {
        responseStartedPreparation = true;
        this.runtime.startPreparation();
      }
      if (event.type === "response_done") {
        if (responseRequiresToolPreparation(event.response, this.runtime)) {
          await this.runtime.ensurePrepared();
        }
      }
      const delivered =
        event.type === "response_done"
          ? ({
              ...event,
              response: {
                ...event.response,
                output: (await transformResponseOutput(
                  event.response.output as ModelResponse["output"],
                  this.runtime,
                  request.signal,
                )) as typeof event.response.output,
              },
            } as StreamEvent)
          : event;
      const settlement = modelResponseSettlement(delivered);
      void settlement?.catch(() => undefined);
      yield delivered;
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
