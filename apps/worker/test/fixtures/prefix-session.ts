/**
 * One chat driven turn by turn through the production worker phases (tool
 * policy, tool runtime, agent build) and the production model clients, with
 * only the network faked. Each turn's agent is built from the chat's state at
 * that turn, so a test can change the state between turns (a goal, a machine,
 * connectors, governance, the model) and read back every request body exactly
 * as it left for the provider.
 */
import { createHash } from "node:crypto";
import { spyOn } from "bun:test";
import type { AgentInputItem } from "@openai/agents";
import {
  CODEX_MODEL_ID_PREFIX,
  canonicalizePersistedHistoryItem,
  codexRequestStorage,
  type CodexRequestContext,
} from "@opengeni/codex";
import {
  resolveTurnExecutionPolicyV1,
  withCodexCatalogProvider,
  withXaiSubscriptionCatalogProvider,
  type Settings,
} from "@opengeni/config";
import {
  FIRST_PARTY_MCP_TOOL_NAMES,
  agentInstructionsContextItem,
  agentInstructionsContextText,
  allAgentCapabilities,
  skillCatalogContextItem,
  workspaceGovernanceContextItem,
  renderUserMessageContentForModel,
  type ResolvedAgentConfig,
  type SessionGoalSnapshot,
} from "@opengeni/contracts";
import * as contracts from "@opengeni/contracts";
import * as db from "@opengeni/db";
import { createObservability } from "@opengeni/observability";
import {
  buildOpenGeniAgent,
  prepareAgentTools,
  prepareRunInput,
  projectHistoryForProvider,
  resolveTurnModel,
  runAgentStream,
  type OpenGeniRuntime,
} from "@opengeni/runtime";
import { startTestMcpServer } from "@opengeni/testing/mcp";
import { testSettings } from "@opengeni/testing/settings";
import {
  XAI_SUBSCRIPTION_MODEL_ID_PREFIX,
  xaiSubscriptionRequestStorage,
  type XaiSubscriptionRequestContext,
} from "@opengeni/xai-subscription";
import { requestBodyText } from "../../../../packages/runtime/src/replayable-json-body";
import { buildTurnAgent, type BuildTurnAgentDeps } from "../../src/activities/agent-turn/agent-build";
import { acceptsPromptCacheKeyForTurn } from "../../src/activities/agent-turn/codex";
import {
  prepareTurnToolPolicy,
  prepareTurnToolRuntime,
  type PrepareTurnToolRuntimeDeps,
} from "../../src/activities/agent-turn/tool-environment";
import { createTurnContext } from "../../src/activities/agent-turn/turn-context";

const SCOPE = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  sessionId: "33333333-3333-4333-8333-333333333333",
};
const GOAL_ID = "77777777-7777-4777-8777-777777777777";

// ---------------------------------------------------------------------------
// Provider wires
// ---------------------------------------------------------------------------

/** What a provider caches by prefix, normalized from one request body. */
export type RequestPrefix = {
  /** The system prompt: Responses `instructions`, Claude `system`, Chat's leading system message. */
  system: string;
  /** The tool definitions, in order. */
  tools: string[];
  /** The conversation, one entry per cacheable unit (item, message or content block). */
  items: string[];
};

export type WireName =
  | "codex-subscription"
  | "openai"
  | "azure-openai"
  | "anthropic"
  | "xai-subscription"
  | "chat-completions";

export type Wire = {
  name: WireName;
  /** Two models of one provider, for a model switch (the same one when it has one). */
  modelIds: readonly [string, string];
  settings: () => Settings;
  subscription?: "codex-subscription" | "xai-subscription";
  /** Answer one captured request in the provider's own streaming format. */
  respond: (body: Record<string, unknown>, ordinal: number) => Response;
  prefix: (body: Record<string, unknown>) => RequestPrefix;
};

const json = (value: unknown) => JSON.stringify(value);
const withoutCacheMarkers = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value ?? null, (key, field) =>
      key === "cache_control" || key === "prompt_cache_breakpoint" ? undefined : field,
    ),
  );

function sse(events: unknown[], done = false): Response {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
      (done ? "data: [DONE]\n\n" : ""),
    { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req_fixture" } },
  );
}

function responsesReply(_body: Record<string, unknown>, n: number): Response {
  const output = [
    { type: "reasoning", id: `rs_${n}`, summary: [], encrypted_content: `enc-${n}` },
    {
      type: "message",
      id: `msg_${n}`,
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: `reply ${n}`, annotations: [], logprobs: [] }],
    },
  ];
  const usage = {
    input_tokens: 100,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 5,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 105,
  };
  return sse([
    { type: "response.created", response: { id: `resp_${n}`, status: "in_progress" } },
    ...output.map((item, index) => ({
      type: "response.output_item.done",
      output_index: index,
      item,
    })),
    {
      type: "response.completed",
      response: { id: `resp_${n}`, status: "completed", output, usage },
    },
  ]);
}

function responsesPrefix(body: Record<string, unknown>): RequestPrefix {
  return {
    system: json(body.instructions ?? null),
    tools: ((body.tools as unknown[] | undefined) ?? []).map(json),
    items: ((body.input as unknown[] | undefined) ?? []).map(json),
  };
}

function anthropicReply(_body: Record<string, unknown>, n: number): Response {
  return sse([
    {
      type: "message_start",
      message: {
        id: `msg_${n}`,
        type: "message",
        role: "assistant",
        content: [],
        stop_reason: null,
        usage: { input_tokens: 100, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: `step ${n}`, signature: `sig-${n}` },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "text", text: `reply ${n}` },
    },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ]);
}

function anthropicPrefix(body: Record<string, unknown>): RequestPrefix {
  // Claude caches the token sequence, so a block appended to the last
  // message extends the prefix: compare block by block.
  const messages = (withoutCacheMarkers(body.messages) as Array<Record<string, unknown>>) ?? [];
  return {
    system: json(withoutCacheMarkers(body.system)),
    tools: ((withoutCacheMarkers(body.tools) as unknown[] | null) ?? []).map(json),
    items: messages.flatMap((message) =>
      typeof message.content === "string"
        ? [json({ role: message.role, text: message.content })]
        : [json({ role: message.role }), ...(message.content as unknown[]).map(json)],
    ),
  };
}

function chatReply(body: Record<string, unknown>, n: number): Response {
  const chunk = (delta: Record<string, unknown>, finish: string | null) => ({
    id: `chatcmpl_${n}`,
    object: "chat.completion.chunk",
    created: 0,
    model: body.model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  return sse(
    [
      chunk({ role: "assistant", content: `reply ${n}` }, null),
      chunk({}, "stop"),
      {
        id: `chatcmpl_${n}`,
        object: "chat.completion.chunk",
        created: 0,
        model: body.model,
        choices: [],
        usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
      },
    ],
    true,
  );
}

function chatPrefix(body: Record<string, unknown>): RequestPrefix {
  const messages = (withoutCacheMarkers(body.messages) as Array<Record<string, unknown>>) ?? [];
  const leadingSystem = messages[0]?.role === "system" ? 1 : 0;
  return {
    system: json(leadingSystem ? messages[0] : null),
    tools: ((withoutCacheMarkers(body.tools) as unknown[] | null) ?? []).map(json),
    items: messages.slice(leadingSystem).map(json),
  };
}

/** A registry provider unique to this fixture, so no cached client of another test serves it. */
function registrySettings(provider: Record<string, unknown>, modelIds: readonly string[]) {
  return () =>
    testSettings({
      sandboxBackend: "none",
      webSearchEnabled: false,
      openaiModel: modelIds[0],
      modelProvidersJson: JSON.stringify([
        {
          ...provider,
          models: modelIds.map((id) => ({
            id,
            upstreamModelId: id.split("/").at(-1),
            label: id,
            reasoningEffort: true,
          })),
        },
      ]),
    });
}

const registry = (
  name: WireName,
  provider: Record<string, unknown>,
  models: readonly [string, string],
  respond: Wire["respond"],
  prefix: Wire["prefix"],
): Wire => {
  const modelIds = models.map((model) => `${provider.id}/${model}`) as [string, string];
  return { name, modelIds, settings: registrySettings(provider, modelIds), respond, prefix };
};

export const WIRES: readonly Wire[] = [
  {
    name: "codex-subscription",
    modelIds: [`${CODEX_MODEL_ID_PREFIX}gpt-6-sol`, `${CODEX_MODEL_ID_PREFIX}gpt-6-luna`],
    subscription: "codex-subscription",
    settings: () =>
      withCodexCatalogProvider(testSettings({ sandboxBackend: "none", webSearchEnabled: false })),
    respond: responsesReply,
    prefix: responsesPrefix,
  },
  registry(
    "openai",
    {
      id: "prefix-openai",
      label: "OpenAI",
      api: "responses",
      wireProfile: "openai",
      baseUrl: "https://prefix-invariant-openai.example.test/v1",
      apiKey: "fixture-key",
    },
    ["gpt-6-sol", "gpt-6-luna"],
    responsesReply,
    responsesPrefix,
  ),
  registry(
    "azure-openai",
    {
      id: "prefix-azure",
      label: "Azure OpenAI",
      api: "responses",
      wireProfile: "azure-openai",
      baseUrl: "https://prefix-invariant.openai.azure.com/openai/v1",
      apiKey: "fixture-key",
    },
    ["gpt-6-sol", "gpt-6-luna"],
    responsesReply,
    responsesPrefix,
  ),
  registry(
    "anthropic",
    {
      id: "prefix-claude",
      label: "Claude",
      api: "anthropic-messages",
      baseUrl: "https://prefix-invariant-anthropic.example.test/v1",
      apiKey: "fixture-key",
    },
    ["claude-opus-5-5", "claude-sonnet-5"],
    anthropicReply,
    anthropicPrefix,
  ),
  {
    name: "xai-subscription",
    // SuperGrok exposes one model, so its model switch keeps the same one.
    modelIds: [`${XAI_SUBSCRIPTION_MODEL_ID_PREFIX}grok-4.7`, `${XAI_SUBSCRIPTION_MODEL_ID_PREFIX}grok-4.7`],
    subscription: "xai-subscription",
    settings: () =>
      withXaiSubscriptionCatalogProvider(
        testSettings({ sandboxBackend: "none", webSearchEnabled: false }),
      ),
    respond: responsesReply,
    prefix: responsesPrefix,
  },
  registry(
    "chat-completions",
    {
      id: "prefix-chat",
      label: "Chat Completions",
      api: "chat",
      baseUrl: "https://prefix-invariant-chat.example.test/v1",
      apiKey: "fixture-key",
    },
    ["glm-5", "kimi-k3"],
    chatReply,
    chatPrefix,
  ),
];

// The production clients bind `globalThis.fetch` when they are built. One
// dispatcher is installed before any is built: it fakes every non-loopback
// request (the providers) and passes loopback ones (the test MCP server).
const realFetch = globalThis.fetch;
let providerHandler: ((url: string, init?: RequestInit) => Promise<Response>) | null = null;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url)) return realFetch(input, init);
  if (!providerHandler) throw new Error(`unexpected provider request to ${url}`);
  return await providerHandler(url, init);
}) as typeof fetch;

// ---------------------------------------------------------------------------
// Chat state
// ---------------------------------------------------------------------------

/** Everything about a chat that may change between two of its turns. */
export type SessionState = {
  goal: "none" | "active" | "paused" | "completed";
  /** Which of the wire's two models the turn uses. */
  model: 0 | 1;
  /** The account serving the turn. */
  credential: "first" | "second";
  /** An attached Connected Machine serves the turn's compute. */
  machineAttached: boolean;
  /** Connectors connected to the chat, besides Opengeni's own. */
  connectors: string[];
  /** Installed workspace Skills. */
  skills: string[];
  governance: string;
  agentInstructions: string;
  /** The "Work without me" switch, now. */
  unattendedNow: boolean;
  /** The chat has used tool search before. */
  toolRouterInHistory: boolean;
  /** The chat has a title. */
  titled: boolean;
  /** The workspace lets agents ask people questions. */
  humanInputEnabled: boolean;
  /** Knowledge learning mode; Off drops the save guidance from the prompt. */
  knowledgeLearning: "automatic" | "off";
};

export const INITIAL_STATE: SessionState = {
  goal: "none",
  model: 0,
  credential: "first",
  machineAttached: false,
  connectors: [],
  skills: ["release-notes"],
  governance: "Write in plain English.",
  agentInstructions: "You help the team ship.",
  unattendedNow: false,
  toolRouterInHistory: false,
  titled: true,
  humanInputEnabled: true,
  knowledgeLearning: "automatic",
};

/** What starts a turn. */
export type TurnTrigger =
  | { kind: "message"; text: string; attachment?: boolean }
  | { kind: "scheduled"; text: string }
  | { kind: "goal_continuation" }
  | { kind: "child_result"; text: string };

function goalSnapshot(state: SessionState["goal"]): SessionGoalSnapshot {
  if (state === "none") return { state: "none", capturedAt: "2026-01-01T00:00:00.000Z" };
  return {
    state,
    goalId: GOAL_ID,
    objectiveRevision: 1,
    text: "Finish the migration",
    successCriteria: null,
    rootConstraints: [],
    mutationPolicy: "preserve_intent",
    capturedAt: "2026-01-01T00:00:00.000Z",
  };
}

/** The configured agent every fixture chat runs as. */
export function agentConfig(): ResolvedAgentConfig {
  return {
    version: 1,
    from: "all",
    capabilities: allAgentCapabilities(),
    unavailable: [],
    identity: null,
    renderer: "opengeni",
    source: "request",
  };
}

/** A connector's one tool, named as the worker names a non-slug server's tools. */
export const connectorToolName = (id: string) =>
  `${id.replaceAll("-", "_")}_${createHash("sha256")
    .update(JSON.stringify([id, ""]))
    .digest("hex")
    .slice(0, 6)}__search_documents`;

// ---------------------------------------------------------------------------
// The chat
// ---------------------------------------------------------------------------

export type CapturedRequest = {
  turn: number;
  /** The transition applied before this request's turn ("start" for the first). */
  transition: string;
  body: Record<string, unknown>;
  prefix: RequestPrefix;
};

/**
 * A chat on one wire. `turn` runs one logical turn from the given state, and
 * the chat keeps durable history between turns the way the worker does: the
 * session context channels (Skill catalog, governance, agent instructions)
 * write an item before the first turn that sees a new value, then the turn's
 * message, then the run's own items as the history sink stores them.
 */
export function prefixChat(wire: Wire) {
  const requests: CapturedRequest[] = [];
  let history: AgentInputItem[] = [];
  const channels = new Map<string, string>();
  let turns = 0;
  let transition = "start";
  let builtAgentInstructions: string | undefined;
  /** The history and channels as the latest turn found them, for an attempt restart. */
  let turnStart = { history: [] as AgentInputItem[], channels: new Map<string, string>() };

  async function turn(state: SessionState, trigger: TurnTrigger) {
    turnStart = { history: [...history], channels: new Map(channels) };
    builtAgentInstructions ??= state.agentInstructions;
    const turnNumber = ++turns;
    const suffix = String(turnNumber).padStart(12, "0");
    const turnId = `44444444-4444-4444-8444-${suffix}`;
    const attemptId = `55555555-5555-4555-8555-${suffix}`;
    const mcp = startTestMcpServer({
      toolsForAuthorization: () => [...FIRST_PARTY_MCP_TOOL_NAMES],
    });
    const modelId = wire.modelIds[state.model];
    const serverIds = ["opengeni", ...state.connectors];
    const settings: Settings = {
      ...wire.settings(),
      openaiModel: modelId,
      lazyToolSearchEnabled: true,
      allowedFirstPartyMcpTools: [...FIRST_PARTY_MCP_TOOL_NAMES],
      mcpServers: serverIds.map((id) => ({
        id,
        url: mcp.url,
        cacheToolsList: false,
        allowedTools: id === "opengeni" ? [...FIRST_PARTY_MCP_TOOL_NAMES] : ["search_documents"],
      })),
    };
    const resolvedModel = resolveTurnModel(settings, modelId);
    if (!resolvedModel) throw new Error(`${wire.name}: ${modelId} did not resolve`);
    const context = createTurnContext({ settings, cancellationRequestedAt: null });
    context.attempt.turnId = turnId;
    context.attempt.executionGeneration = 1;
    context.eventing.publish = async () => {};
    const channelWrites = new Map<string, string>();
    const persistence = [
      spyOn(db, "requireWorkspace").mockResolvedValue({
        id: SCOPE.workspaceId,
        settings: {},
      } as Awaited<ReturnType<typeof db.requireWorkspace>>),
      spyOn(db, "getSandboxRecoveryDiscontinuity").mockResolvedValue(null),
      spyOn(db, "getWorkspaceVideoGenerationPolicy").mockResolvedValue({
        schemaVersion: 1,
        revision: 0,
        fundingSource: "workspace_gateway",
        enabledModelIds: [],
        defaultModelId: null,
      } as Awaited<ReturnType<typeof db.getWorkspaceVideoGenerationPolicy>>),
      spyOn(db, "listSkillDescriptors").mockResolvedValue(
        state.skills.map(
          (title, index) =>
            ({
              id: `66666666-6666-4666-8666-${String(index).padStart(12, "0")}`,
              title,
              description: `${title} guidance`,
              activationMode: "workspace_managed",
            }) as Awaited<ReturnType<typeof db.listSkillDescriptors>>[number],
        ),
      ),
      spyOn(db, "ensureSessionSkillCatalog").mockImplementation(async (_db, input) => {
        if (input.catalog || channels.has("skills")) channelWrites.set("skills", input.catalog);
        return input.catalog;
      }),
      spyOn(db, "ensureSessionWorkspaceGovernance").mockImplementation(async (_db, input) => {
        if (input.governance) channelWrites.set("governance", input.governance);
        return input.governance;
      }),
      // The chat's system prompt keeps the agent revision it was built with
      // (sessions.agent_prompt_revision); the database compares it with the
      // agent's current instructions and stores an edit as a history item.
      spyOn(db, "ensureSessionAgentInstructions").mockImplementation(async () => {
        if (state.agentInstructions !== builtAgentInstructions)
          channelWrites.set(
            "agent",
            agentInstructionsContextText({
              kind: "revision",
              revision: 2,
              instructions: state.agentInstructions,
            } as never),
          );
        return null;
      }),
      spyOn(db, "ensureSessionReasoningConfiguration").mockImplementation(
        async (_db, input) => (input as { reasoningEffort: string }).reasoningEffort as never,
      ),
      // The workspace layout channel, where the database has one.
      ...(typeof (db as Record<string, unknown>).ensureSessionWorkspaceFilesystem === "function"
        ? [
            spyOn(db as never, "ensureSessionWorkspaceFilesystem" as never).mockImplementation(
              (async (_db: unknown, input: { layout: string | null }) => {
                if (input.layout) channelWrites.set("filesystem", input.layout);
                return input.layout;
              }) as never,
            ),
          ]
        : []),
      spyOn(db, "getExternalLinkTurnAuthorization").mockResolvedValue(null),
      ...(typeof db.sessionHasToolRouterHistory === "function"
        ? [spyOn(db, "sessionHasToolRouterHistory").mockResolvedValue(state.toolRouterInHistory)]
        : []),
      spyOn(db, "persistAttemptToolCatalog").mockImplementation(async (_db, catalog) => catalog),
      spyOn(db, "cancelQueuedCodemodeOperationsForAttempt").mockResolvedValue(0),
    ];
    const runtime = {
      // Model the first-party API's token-scoped tools/list, as the
      // configuration enforcement suite does.
      prepareTools: async (runSettings: Settings, tools, prepareOptions) =>
        await prepareAgentTools(
          {
            ...runSettings,
            mcpServers: runSettings.mcpServers.map((server) =>
              server.id === "opengeni"
                ? { ...server, allowedTools: [...(prepareOptions?.firstPartyTools ?? [])] }
                : server,
            ),
          },
          tools,
          prepareOptions,
        ),
      buildAgent: (runSettings: Settings, resources, agentOptions) =>
        buildOpenGeniAgent(runSettings, resources, agentOptions),
      // Production titles a chat beside its first turn; this fixture never
      // runs the stream that would call it.
      generateSessionTitle: (async () => {
        throw new Error("the fixture does not title chats");
      }) as NonNullable<OpenGeniRuntime["generateSessionTitle"]>,
    } satisfies Pick<OpenGeniRuntime, "prepareTools" | "buildAgent" | "generateSessionTitle">;
    const session = {
      id: SCOPE.sessionId,
      accountId: SCOPE.accountId,
      workspaceId: SCOPE.workspaceId,
      activeSandboxId: null,
      rootSessionId: SCOPE.sessionId,
      title: state.titled ? "Migration chat" : null,
      titleSource: state.titled ? "human" : null,
      metadata: {},
      ...(state.unattendedNow ? { unattended: true } : {}),
      agent: agentConfig(),
      instructions: null,
      resources: [],
      // Connectors stay behind tool search unless a product lists them
      // eagerly (an embedding's opening tools), as a chat's connectors do.
      tools: serverIds.map((id) => ({ kind: "mcp" as const, id })),
      toolPolicy: { mode: "explicit", inheritedFromSessionId: null },
      bundledSkillIds: [],
      skills: [],
      firstPartyMcpTools: [...FIRST_PARTY_MCP_TOOL_NAMES],
      firstPartyMcpPermissions: null,
      model: modelId,
      sandboxBackend: "none",
      mcpServers: state.connectors.map((id) => ({ id })),
      nestedAgentDepth: 0,
      effectiveMaxNestedAgentDepth: 3,
    } as unknown as BuildTurnAgentDeps["session"];
    const human = trigger.kind === "message";
    const turnRow = {
      id: turnId,
      executionGeneration: 1,
      reasoningEffort: "medium",
      sandboxBackend: "none",
      initiator: human
        ? { kind: "subject", subjectId: "user:fixture-human" }
        : { kind: "system", subjectId: "system:fixture" },
      resources: [],
      tools: session.tools,
      goalSnapshot: goalSnapshot(state.goal),
      personalConnectionDelegations: [],
      mcpAccountBindings: [],
    } as unknown as BuildTurnAgentDeps["turn"];
    const input = {
      ...SCOPE,
      turnId,
      attemptId,
      workflowId: "workflow",
      workflowRunId: "workflow-run",
      trigger: { kind: "next" as const },
    };
    const triggerEvent = { type: "user.message", payload: {} } as BuildTurnAgentDeps["trigger"];
    const turnExecutionPolicy = resolveTurnExecutionPolicyV1(settings, {
      modelId,
      requestedModelId: null,
      modelSource: "session",
      reasoningEffort: "medium",
      reasoningSource: "session",
    });
    const credentialId = `fixture-${state.credential}-credential`;
    try {
      const policy = await prepareTurnToolPolicy({
        input,
        db: {} as BuildTurnAgentDeps["db"],
        cancellationSignal: undefined,
        connectionCredentials: undefined,
        turn: turnRow,
        session,
        fileAuthoritySubjectId: null,
        capabilitySettings: settings,
        runSettings: settings,
        rigVersion: null,
        workspaceRefs: context.workspaceRefs,
      });
      const observability = createObservability(settings, { component: "worker" });
      const toolRuntime = await prepareTurnToolRuntime({
        ...context,
        input,
        catalogSourceSettings: settings,
        db: {} as BuildTurnAgentDeps["db"],
        bus: { subscribeRequests: () => () => {} } as PrepareTurnToolRuntimeDeps["bus"],
        runtime: runtime as OpenGeniRuntime,
        objectStorage: null,
        observability,
        media: {} as BuildTurnAgentDeps["media"],
        turn: turnRow,
        session,
        fileAuthoritySubjectId: null,
        capabilitySettings: settings,
        installedApiIntegrations: [],
        codexAppsCredentialId: null,
        turnExecutionPolicy,
        trigger: triggerEvent,
        runSettings: settings,
        resolvedModel,
        lazyToolTransport: "generic_dispatch",
        ...policy,
        learningModes: {
          knowledge: state.knowledgeLearning,
          instructions: "automatic",
          skills: "automatic",
        },
        sandboxArtifactRuntime: { available: false, environment: {} },
        groupBoxBackend: "none",
        ...(state.machineAttached ? { activeSandboxBackend: "selfhosted" as const } : {}),
        routingOn: false,
        credentialSubjectId: null,
        interactionInterventionResume: null,
        codeSearchEnabled: false,
        throwIfWorkerShuttingDown: () => {},
        throwIfTurnCancelled: () => {},
      } as PrepareTurnToolRuntimeDeps);
      const built = await buildTurnAgent({
        ...context,
        ...toolRuntime,
        workspaceGovernance: state.governance,
        agentPrompt: {
          agentId: "88888888-8888-4888-8888-888888888888",
          revisionId: "99999999-9999-4999-8999-999999999999",
          instructions: builtAgentInstructions,
        } as unknown as NonNullable<BuildTurnAgentDeps["agentPrompt"]>,
        input,
        db: {} as BuildTurnAgentDeps["db"],
        runtime: runtime as OpenGeniRuntime,
        observability,
        objectStorage: {} as NonNullable<BuildTurnAgentDeps["objectStorage"]>,
        media: {} as BuildTurnAgentDeps["media"],
        turn: turnRow,
        session,
        runSettings: settings,
        capabilitySettings: settings,
        nativeImageProviderBinding: null,
        resolvedModel,
        ...(acceptsPromptCacheKeyForTurn(resolvedModel)
          ? { promptCacheKey: SCOPE.sessionId }
          : {}),
        ...(wire.subscription
          ? {
              codexContext: wire.subscription === "codex-subscription" ? {} : undefined,
              providerTurn: {
                ...context.providerTurn,
                effectiveCodexCredentialId:
                  wire.subscription === "codex-subscription" ? credentialId : null,
                effectiveXaiCredentialId:
                  wire.subscription === "xai-subscription" ? credentialId : null,
                xaiRequestContext: null,
                xaiSubscriptionCore: null,
              },
              leases: {
                codex: { generation: null },
                xai: { generation: 1, assertCurrentForDispatch: async () => {} },
              },
            }
          : {}),
        turnExecutionPolicy,
        trigger: triggerEvent,
        agentHumanInputEnabled: state.humanInputEnabled,
        runtimeResources: [],
        sandboxEnvironment: {},
        sandboxArtifactRuntime: { available: false, environment: {} },
        fileResourceDownloads: [],
        modelInputPolicy: { inputFileMediaTypes: ["application/pdf"], supportsImageInput: true },
        groupBoxBackend: "none",
        lazyToolTransport: "generic_dispatch",
        ...(state.machineAttached ? { activeSandboxBackend: "selfhosted" as const } : {}),
      } as unknown as BuildTurnAgentDeps);

      // Context channels this turn changed are stored before its message.
      for (const [channel, value] of channelWrites) {
        if (channels.get(channel) === value) continue;
        channels.set(channel, value);
        history.push(channelItem(channel, value));
      }
      history.push(triggerItem(trigger, state));

      const api =
        resolvedModel.provider.api === "anthropic-messages"
          ? "anthropic-messages"
          : resolvedModel.provider.api === "chat"
            ? "chat"
            : "responses";
      const prepared = await prepareRunInput(built.agent, {
        kind: "message",
        historyItems: projectHistoryForProvider(
          history as Array<Record<string, unknown>>,
          api,
        ) as AgentInputItem[],
        modelInputAlreadyProjected: true,
      });
      const first = requests.length;
      const transitionOfTurn = transition;
      providerHandler = async (_url, init) => {
        const body = JSON.parse(await requestBodyText(init?.body)) as Record<string, unknown>;
        requests.push({
          turn: turnNumber,
          transition: transitionOfTurn,
          body,
          prefix: wire.prefix(body),
        });
        return wire.respond(body, requests.length);
      };
      const result = await withProviderContext(wire, credentialId, turnId, async () => {
        const run = await runAgentStream(
          built.agent,
          {
            input: prepared.input as AgentInputItem[],
            persistedHistoryCount: prepared.persistedHistoryCount,
          },
          settings,
        );
        for await (const _event of run.toStream()) void _event;
        await run.completed;
        return run;
      });
      if (requests.length === first)
        throw new Error(`${wire.name}: turn ${turnNumber} sent no request`);
      for (const item of result.history.slice(prepared.persistedHistoryCount))
        history.push(
          JSON.parse(
            JSON.stringify(canonicalizePersistedHistoryItem(item as never)),
          ) as AgentInputItem,
        );
      transition = "next turn";
    } finally {
      providerHandler = null;
      await context.eventing.codemodeDispatcher?.close();
      await context.eventing.preparedTools?.close();
      for (const spy of persistence) spy.mockRestore();
      mcp.close();
    }
  }

  return {
    requests,
    turn,
    /** Name the transition applied before the next turn. */
    transition(name: string) {
      transition = name;
    },
    /**
     * The latest turn's attempt restarts: its items are dropped and the next
     * `turn` runs the same logical turn again from freshly built state.
     */
    restartAttempt() {
      history = [...turnStart.history];
      channels.clear();
      for (const [key, value] of turnStart.channels) channels.set(key, value);
      turns -= 1;
    },
    /** Compaction replaces the history with its summary and the latest context channels. */
    compact() {
      history = [
        ...[...channels.entries()]
          .filter(([channel]) => !channel.includes(":"))
          .map(([channel, value]) => channelItem(channel, value)),
        {
          type: "message",
          role: "user",
          content: "Summary of the conversation so far: the team is migrating the database.",
        } as AgentInputItem,
      ];
    },
  };
}

/** A session context channel's stored history item, as the database writes it. */
function channelItem(channel: string, value: string): AgentInputItem {
  const filesystemItem = (contracts as Record<string, unknown>).workspaceFilesystemContextItem as
    | ((text: string) => Record<string, unknown>)
    | undefined;
  const item =
    channel === "skills"
      ? skillCatalogContextItem(value)
      : channel === "governance"
        ? workspaceGovernanceContextItem(value)
        : channel === "filesystem" && filesystemItem
          ? filesystemItem(value)
          : agentInstructionsContextItem(value);
  return item as unknown as AgentInputItem;
}

function triggerItem(trigger: TurnTrigger, state: SessionState): AgentInputItem {
  const text =
    trigger.kind === "goal_continuation"
      ? "Continue working toward the session goal."
      : trigger.kind === "child_result"
        ? `A child session finished: ${trigger.text}`
        : trigger.kind === "scheduled"
          ? `Scheduled run: ${trigger.text}`
          : trigger.text;
  const content = renderUserMessageContentForModel(
    text,
    [],
    trigger.kind === "message" && trigger.attachment
      ? "Attached file: report.pdf (application/pdf)."
      : null,
    goalSnapshot(state.goal),
    "2026-01-01T12:00:00.000Z",
  );
  return { type: "message", role: "user", content } as AgentInputItem;
}

async function withProviderContext<T>(
  wire: Wire,
  credentialId: string,
  turnId: string,
  run: () => Promise<T>,
): Promise<T> {
  if (wire.subscription === "codex-subscription") {
    const token = {
      accessToken: `token-${credentialId}`,
      chatgptAccountId: credentialId,
      isFedramp: false,
    };
    const context: CodexRequestContext = {
      clientVersion: "prefix-invariant",
      getToken: async () => token,
      refresh: async () => token,
      resolveModel: (model) => model,
    };
    return await codexRequestStorage.run(context, run);
  }
  if (wire.subscription === "xai-subscription") {
    const token = { accessToken: `token-${credentialId}`, userId: credentialId };
    const context = {
      clientVersion: "prefix-invariant",
      sessionId: SCOPE.sessionId,
      turnId,
      getToken: async () => token,
      refresh: async () => token,
      resolveModel: (slug: string) => slug,
    } as unknown as XaiSubscriptionRequestContext;
    return await xaiSubscriptionRequestStorage.run(context, run);
  }
  return await run();
}
