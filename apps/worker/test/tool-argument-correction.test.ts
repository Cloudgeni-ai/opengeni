import { expect, spyOn, test } from "bun:test";
import type { Model, ModelRequest, ModelResponse, StreamEvent } from "@openai/agents";
import { Usage } from "@openai/agents";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Settings } from "@opengeni/config";
import * as db from "@opengeni/db";
import { createObservability } from "@opengeni/observability";
import {
  buildOpenGeniAgent,
  type ConnectorActionPolicyHooks,
  prefixedMcpToolName,
  prepareAgentTools,
  runAgentStream,
} from "@opengeni/runtime";
import { assistantMessage, functionCall, testSettings } from "@opengeni/testing";
import { buildTurnAgent, type BuildTurnAgentDeps } from "../src/activities/agent-turn/agent-build";
import { createTurnContext } from "../src/activities/agent-turn/turn-context";

// A hosted analytics MCP advertises `context` and `llm_model` as required on
// `exec` but does not enforce them. The gateway enforces the advertised schema,
// so a model that omits them must learn which properties to add from the error.
const EXEC_INPUT_SCHEMA = {
  type: "object",
  properties: {
    command: { type: "string", description: "CLI-style command to run." },
    context: { type: "string", description: "Why the command is being run." },
    llm_model: { type: "string", description: "Model issuing the call." },
  },
  required: ["command", "context", "llm_model"],
} as const;

function startLenientAnalyticsMcp() {
  const calls: Record<string, unknown>[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const mcp = new Server(
        { name: "lenient-analytics", version: "1.0.0" },
        { capabilities: { tools: {} } },
      );
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          {
            name: "exec",
            description: "Run an analytics command.",
            inputSchema: EXEC_INPUT_SCHEMA,
          },
        ],
      }));
      // Like the real provider, accept any arguments without schema checks.
      mcp.setRequestHandler(CallToolRequestSchema, async (call) => {
        calls.push({ ...call.params.arguments });
        return { content: [{ type: "text", text: "project id: synthetic-project" }] };
      });
      const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true,
      });
      await mcp.connect(transport);
      return await transport.handleRequest(request);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    calls,
    close: () => server.stop(true),
  };
}

/**
 * Stands in for a model that reads its tool results: it omits the extra
 * arguments on the first call, then adds exactly the properties the error
 * names. If the error names none, it gives up the way the production session did.
 */
class ArgumentCorrectingModel implements Model {
  readonly toolResults: string[] = [];
  private calls = 0;

  constructor(private readonly toolName: string) {}

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    return this.respond(request);
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    const response = this.respond(request);
    yield { type: "response_started" };
    yield {
      type: "response_done",
      response: {
        id: response.responseId ?? `argument-correction-${this.calls}`,
        usage: response.usage,
        output: response.output,
      },
    } as StreamEvent;
  }

  private respond(request: ModelRequest): ModelResponse {
    const turn = this.calls++;
    const latestResult = latestToolResultText(request);
    if (latestResult !== null) this.toolResults.push(latestResult);
    const command = "search project-get";
    let output: ModelResponse["output"];
    if (turn === 0) {
      output = [functionCall(this.toolName, { command }, "call-missing-arguments")];
    } else if (turn === 1) {
      const named = [...(latestResult ?? "").matchAll(/missing required property "([^"]+)"/gu)].map(
        (match) => match[1]!,
      );
      output =
        named.length > 0
          ? [
              functionCall(
                this.toolName,
                {
                  command,
                  ...Object.fromEntries(named.map((name) => [name, `synthetic ${name}`])),
                },
                "call-corrected-arguments",
              ),
            ]
          : [assistantMessage("The connector tools are not callable.")];
    } else {
      output = [assistantMessage(`done: ${latestResult ?? ""}`)];
    }
    return {
      usage: new Usage({ requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
      output,
      responseId: `argument-correction-${turn}`,
    };
  }
}

/** The text of the newest tool result, unwrapped the way a model reads it. */
function latestToolResultText(request: ModelRequest): string | null {
  if (typeof request.input === "string") return null;
  for (const item of [...request.input].reverse()) {
    if (item.type !== "function_call_result") continue;
    return readableText((item as { output?: unknown }).output);
  }
  return null;
}

function readableText(value: unknown): string {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed !== null && typeof parsed === "object") return readableText(parsed);
    } catch {
      // Plain text.
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(readableText).join("\n");
  if (value !== null && typeof value === "object") {
    const record = value as { text?: unknown; content?: unknown };
    if (typeof record.text === "string") return readableText(record.text);
    if (record.content !== undefined) return readableText(record.content);
  }
  return JSON.stringify(value);
}

// Execute the production builder; only unrelated persistence is stubbed. MCP
// preparation, the attempt tool gateway, agent construction and the SDK run loop
// are real.
async function buildWorkerAgent(
  settings: Settings,
  prepared: Awaited<ReturnType<typeof prepareAgentTools>>,
  hooks: ConnectorActionPolicyHooks,
  model: Model,
) {
  const context = createTurnContext({ settings, cancellationRequestedAt: null });
  context.eventing.preparedTools = prepared;
  const persistence = [
    spyOn(db, "getSandboxRecoveryDiscontinuity").mockResolvedValue(null),
    spyOn(db, "getWorkspaceVideoGenerationPolicy").mockResolvedValue({
      schemaVersion: 1,
      revision: 0,
      fundingSource: "workspace_gateway",
      enabledModelIds: [],
      defaultModelId: null,
    }),
    spyOn(db, "ensureSessionSkillCatalog").mockImplementation(async (_db, input) => input.catalog),
    spyOn(db, "getExternalLinkTurnAuthorization").mockResolvedValue(null),
  ];
  try {
    const deps: Partial<BuildTurnAgentDeps> = {
      ...context,
      input: {
        accountId: "account",
        workspaceId: "workspace",
        sessionId: "session",
        attemptId: "attempt",
        workflowId: "workflow",
        workflowRunId: "workflow-run",
        trigger: { kind: "next" },
      },
      db: {} as BuildTurnAgentDeps["db"],
      runtime: {
        buildAgent: (buildSettings: Settings, resources, options) =>
          buildOpenGeniAgent(buildSettings, resources, { ...options, model }),
      } as BuildTurnAgentDeps["runtime"],
      observability: createObservability(settings, { component: "worker" }),
      objectStorage: null,
      media: {} as BuildTurnAgentDeps["media"],
      turn: {
        id: "turn",
        executionGeneration: 1,
        reasoningEffort: "low",
      } as BuildTurnAgentDeps["turn"],
      session: { id: "session" } as BuildTurnAgentDeps["session"],
      runSettings: settings,
      mcpServers: settings.mcpServers,
      skillCatalog: [],
      turnExecutionPolicy: {
        providerId: "openai",
        latencyMode: "standard",
      } as BuildTurnAgentDeps["turnExecutionPolicy"],
      runtimeResources: [],
      sandboxEnvironment: {},
      sandboxArtifactRuntime: { available: false, environment: {} },
      fileResourceDownloads: [],
      attemptConnectorActionBindings: [],
      connectorActionPolicy: hooks,
      modelInputPolicy: { inputFileMediaTypes: [], supportsImageInput: true },
      preparationIndependentToolNames: [],
      groupBoxBackend: "none",
      postToolPreparationStartedAt: performance.now(),
      trigger: { type: "user.message", payload: {} } as BuildTurnAgentDeps["trigger"],
    };
    return (await buildTurnAgent(deps as BuildTurnAgentDeps)).agent;
  } finally {
    for (const spy of persistence) spy.mockRestore();
  }
}

test("a model that omits advertised-required arguments corrects them from the error", async () => {
  const provider = startLenientAnalyticsMcp();
  const serverId = "analytics";
  const settings = testSettings({
    sandboxBackend: "none",
    webSearchEnabled: false,
    mcpServers: [
      {
        id: serverId,
        url: provider.url,
        cacheToolsList: false,
        connectionRef: { connectionId: "connection-1", providerDomain: "analytics.example.test" },
      },
    ],
  });
  const connectorActions: string[] = [];
  const hooks: ConnectorActionPolicyHooks = {
    prepare: async () => ({ managed: true as const, decision: "allow" as const }),
    begin: async (call) => {
      connectorActions.push(call.approvalId);
      return { allowed: true as const, managed: true as const, requestId: call.approvalId };
    },
    complete: async () => {},
  };
  const prepared = await prepareAgentTools(
    settings,
    [{ kind: "mcp", id: serverId, optional: true }],
    {
      accountId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      sessionId: "33333333-3333-4333-8333-333333333333",
      turnId: "44444444-4444-4444-8444-444444444444",
      attemptId: "55555555-5555-4555-8555-555555555555",
      executionGeneration: 1,
      credentialSubjectId: "subject-a",
      resolveCredential: async () => ({
        status: "ok" as const,
        connectionId: "connection-1",
        headers: { authorization: "Bearer synthetic-token" },
      }),
      connectorActionPolicy: hooks,
    },
  );
  try {
    const model = new ArgumentCorrectingModel(prefixedMcpToolName(serverId, "exec"));
    const agent = await buildWorkerAgent(settings, prepared, hooks, model);
    const result = await runAgentStream(agent, "Which project are we in?", settings);
    for await (const _event of result.toStream()) {
      /* consume the whole turn */
    }
    await result.completed;

    // The first call is rejected by the gateway before it reaches the provider,
    // and the model-visible error names both omitted properties.
    const [rejection, success] = model.toolResults;
    expect(rejection).toBe(
      "The tool was not called because its arguments do not match the tool's input schema: " +
        'missing required property "context"; missing required property "llm_model". ' +
        "Correct the named properties and call the tool again.",
    );
    // The corrected second call is the only one that reaches the provider.
    expect(provider.calls).toEqual([
      {
        command: "search project-get",
        context: "synthetic context",
        llm_model: "synthetic llm_model",
      },
    ]);
    expect(connectorActions).toEqual(["call-corrected-arguments"]);
    expect(success).toContain("synthetic-project");
    expect(result.finalOutput).toContain("synthetic-project");
  } finally {
    await prepared.close();
    provider.close();
  }
});
