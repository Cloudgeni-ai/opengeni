import { describe, expect, test } from "bun:test";
import {
  getClientToolSearchExecutor,
  RunContext,
  RunState,
  RunToolSearchCallItem,
  RunToolSearchOutputItem,
  RunToolApprovalItem,
  toolSearchTool,
  type Tool,
} from "@openai/agents";
import { testSettings } from "@opengeni/testing";
import { bm25RankTools, searchToolPool } from "../src/codex-tool-search";
import {
  buildOpenGeniAgent,
  prepareRunInput,
  PrefixedMcpServer,
  restoreInterruptedRunState,
} from "../src";

// Minimal function-tool doubles for shared search ranking.
function connectorTool(name: string, description: string, props: string[] = []): Tool {
  return {
    type: "function",
    name: `codex_apps__${name}`,
    description,
    isEnabled: async () => true,
    parameters: {
      type: "object",
      properties: Object.fromEntries(props.map((p) => [p, { type: "string" }])),
    },
  } as unknown as Tool;
}
const POOL: Tool[] = [
  connectorTool("gmail_send_email", "Send an email message via Gmail to one or more recipients", [
    "to",
    "subject",
    "body",
  ]),
  connectorTool("gmail_search_emails", "Search the Gmail inbox for messages matching a query", [
    "query",
    "label_ids",
  ]),
  connectorTool(
    "calendar_create_event",
    "Create a Google Calendar event with a title, start and end time",
    ["title", "start_time", "end_time"],
  ),
  connectorTool("github_create_issue", "Open a new issue on a GitHub repository", [
    "repo",
    "title",
    "body",
  ]),
  connectorTool("slack_post_message", "Post a message to a Slack channel", ["channel", "text"]),
  connectorTool("drive_upload_file", "Upload a file to Google Drive", ["path", "folder"]),
];

describe("bm25RankTools", () => {
  test("collapses an identical tool reference repeated in the callback pool", () => {
    const repeated = POOL[0]!;
    expect(searchToolPool([repeated, repeated], { query: "send an email" })).toEqual([repeated]);
  });

  test("ranks the capability-relevant tool first", () => {
    const top = bm25RankTools(POOL, "send an email to someone", 3)[0] as { name: string };
    expect(top.name).toBe("codex_apps__gmail_send_email");
  });

  test("matches on capability words, not just exact names", () => {
    const top = bm25RankTools(POOL, "schedule a meeting on my calendar", 3)[0] as { name: string };
    expect(top.name).toBe("codex_apps__calendar_create_event");
  });

  test("stemming: plural/inflected query words match singular tool text", () => {
    // "emails"/"messages" stem to "email"/"message"; "creating" stems to "create".
    const top = bm25RankTools(POOL, "searching emails", 3)[0] as { name: string };
    expect(top.name).toBe("codex_apps__gmail_search_emails");
    const create = bm25RankTools(POOL, "creating calendar events", 3)[0] as { name: string };
    expect(create.name).toBe("codex_apps__calendar_create_event");
  });

  test("respects the limit", () => {
    expect(bm25RankTools(POOL, "email message", 2)).toHaveLength(2);
  });

  test("a no-match query returns [] (codex-rs parity — never disclose arbitrary tools)", () => {
    expect(bm25RankTools(POOL, "zzzz totally unrelated qqqq", 3)).toEqual([]);
  });

  test("an empty / stopword-only query returns []", () => {
    expect(bm25RankTools(POOL, "", 5)).toEqual([]);
    expect(bm25RankTools(POOL, "the a of to", 5)).toEqual([]);
  });

  test("empty pool → empty result", () => {
    expect(bm25RankTools([], "anything", 5)).toEqual([]);
  });
});

describe("searchToolPool disclosure bounds", () => {
  test("keyword search backfills beyond the original rank cutoff", () => {
    const oversized = connectorTool("first", "Find records");
    const small = connectorTool("second", "Find records");
    if (oversized.type !== "function") throw new Error("expected a function tool");
    oversized.parameters = {
      type: "object",
      properties: {},
      description: "x".repeat(130 * 1024),
    } as never;
    expect(bm25RankTools([oversized, small], "Find records", 1)).toEqual([oversized]);
    expect(searchToolPool([oversized, small], { query: "Find records", limit: 1 })).toEqual([
      small,
    ]);
  });

  test("exact disclosure bypasses ranking without admitting unknown tools", () => {
    const wanted = connectorTool("vault_fetch", "Read an item");
    const unrelated = connectorTool("other", "Search legal agreements");
    expect(
      searchToolPool([unrelated, wanted], {
        query: "",
        names: ["codex_apps__vault_fetch", "not_authorized"],
      }),
    ).toEqual([wanted]);
    expect(searchToolPool([unrelated], { query: "legal", names: ["not_authorized"] })).toEqual([]);
  });

  test("backfills rank-limited results after rejecting an oversized definition", () => {
    const oversized = connectorTool("oversized", "x".repeat(130 * 1024));
    const small = connectorTool("small", "Read an item");
    expect(
      searchToolPool([oversized, small], {
        query: "",
        names: ["codex_apps__oversized", "codex_apps__small"],
        limit: 1,
      }),
    ).toEqual([small]);
  });

  test("backfills smaller definitions after aggregate overflow without exceeding the budget", () => {
    const large = Array.from({ length: 3 }, (_, i) =>
      connectorTool(`large_${i}`, "x".repeat(100 * 1024)),
    );
    const small = connectorTool("small", "Read an item");
    const pool = [...large, small];
    const result = searchToolPool(pool, {
      query: "",
      names: pool.map((t) => (t as any).name),
      limit: 4,
    });
    expect(result).toEqual([large[0], large[1], small]);
  });
});

describe("tool_search RunState replay", () => {
  test("uses recorded output as history without re-executing the search", async () => {
    const deferred = connectorTool("gmail_send_email", "Send mail", ["to"]);
    let executions = 0;
    const search = toolSearchTool({
      execution: "client",
      description: "Search available tools",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
      execute: async () => {
        executions += 1;
        return [deferred];
      },
    }) as unknown as Tool;
    const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), []);
    agent.getAllTools = async () => [deferred, search];
    const state = new RunState(new RunContext(), "hello", agent, null);
    const call = {
      type: "tool_search_call" as const,
      call_id: "search-1",
      status: "completed" as const,
      execution: "client" as const,
      arguments: { query: "send mail" },
    };
    const output = {
      type: "tool_search_output" as const,
      call_id: "search-1",
      status: "completed" as const,
      execution: "client" as const,
      tools: [
        {
          type: "function" as const,
          name: deferred.name,
          description: deferred.description,
          parameters: deferred.parameters,
        },
      ],
    };
    (state as unknown as { _generatedItems: unknown[] })._generatedItems = [
      new RunToolSearchCallItem(call, agent),
      new RunToolSearchOutputItem(output, agent),
    ];

    const serialized = state.toString();
    // The tool disclosed in the saved turn is no longer in today's catalogue.
    // The historical output remains a fact and must not execute today's search
    // callback or reject the resume because that callback now returns nothing.
    agent.getAllTools = async () => [search];
    const resumed = await restoreInterruptedRunState(agent, serialized);

    expect(executions).toBe(0);
    expect(resumed.toString()).toContain('"execution":"client"');
    expect(resumed.toString()).toContain("codex_apps__gmail_send_email");
  });

  test("approval resume never reruns or compares a historical search", async () => {
    const deferred = connectorTool("gmail_send_email", "Send mail", ["to"]);
    let executions = 0;
    const search = toolSearchTool({
      execution: "client",
      description: "Search available tools",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
      execute: async () => {
        executions += 1;
        return [];
      },
    }) as unknown as Tool;
    const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), []);
    agent.getAllTools = async () => [search];
    const state = new RunState(new RunContext(), "hello", agent, null);
    const call = {
      type: "tool_search_call" as const,
      call_id: "search-approval",
      status: "completed" as const,
      execution: "client" as const,
      arguments: { query: "send mail" },
    };
    const output = {
      type: "tool_search_output" as const,
      call_id: "search-approval",
      status: "completed" as const,
      execution: "client" as const,
      tools: [
        {
          type: "function" as const,
          name: deferred.name,
          description: deferred.description,
          parameters: deferred.parameters,
        },
      ],
    };
    const approval = new RunToolApprovalItem(
      {
        type: "function_call",
        callId: "approval-1",
        name: "write_file",
        arguments: "{}",
        status: "completed",
      },
      agent,
    );
    (state as unknown as { _generatedItems: unknown[] })._generatedItems = [
      new RunToolSearchCallItem(call, agent),
      new RunToolSearchOutputItem(output, agent),
      approval,
    ];
    (state as unknown as { _currentStep: unknown })._currentStep = {
      type: "next_step_interruption",
      data: { interruptions: [approval] },
    };

    const resumed = await prepareRunInput(agent, {
      kind: "approval",
      serializedRunState: state.toString(),
      approvalId: "approval-1",
      decision: "approve",
    });

    expect(executions).toBe(0);
    expect((resumed.input as RunState<any, any>).toString()).toContain('"execution":"client"');
    expect((resumed.input as RunState<any, any>).toString()).toContain(
      "codex_apps__gmail_send_email",
    );
  });

  test("accepts a still-authorized historical tool from the current catalog", async () => {
    const deferred = connectorTool("gmail_send_email", "Send mail", ["to"]);
    let executions = 0;
    const search = toolSearchTool({
      execution: "client",
      execute: async () => {
        executions += 1;
        return [deferred];
      },
    }) as unknown as Tool;
    const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), []);
    agent.getAllTools = async () => [deferred, search];
    const state = new RunState(new RunContext(), "hello", agent, null);
    const call = {
      type: "tool_search_call" as const,
      call_id: "search-rebind",
      status: "completed" as const,
      execution: "client" as const,
      arguments: { query: "send mail" },
    };
    const output = {
      type: "tool_search_output" as const,
      call_id: "search-rebind",
      status: "completed" as const,
      execution: "client" as const,
      tools: [
        {
          type: "function" as const,
          name: deferred.name,
          description: deferred.description,
          parameters: deferred.parameters,
        },
      ],
    };
    (state as unknown as { _generatedItems: unknown[] })._generatedItems = [
      new RunToolSearchCallItem(call, agent),
      new RunToolSearchOutputItem(output, agent),
    ];

    const resumed = await restoreInterruptedRunState(agent, state.toString());

    expect(executions).toBe(0);
    expect(resumed.toString()).toContain(deferred.name);
  });

  test("keeps the SDK default execute-and-validate behavior opt-in", async () => {
    const deferred = connectorTool("gmail_send_email", "Send mail", ["to"]);
    let executions = 0;
    const search = toolSearchTool({
      execution: "client",
      execute: async () => {
        executions += 1;
        return [deferred];
      },
    }) as unknown as Tool;
    const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), []);
    agent.getAllTools = async () => [deferred, search];
    const state = new RunState(new RunContext(), "hello", agent, null);
    const call = {
      type: "tool_search_call" as const,
      call_id: "search-default",
      status: "completed" as const,
      execution: "client" as const,
      arguments: { query: "send mail" },
    };
    const output = {
      type: "tool_search_output" as const,
      call_id: "search-default",
      status: "completed" as const,
      execution: "client" as const,
      tools: [
        {
          type: "function" as const,
          name: deferred.name,
          description: deferred.description,
          parameters: deferred.parameters,
        },
      ],
    };
    (state as unknown as { _generatedItems: unknown[] })._generatedItems = [
      new RunToolSearchCallItem(call, agent),
      new RunToolSearchOutputItem(output, agent),
    ];

    await RunState.fromString(agent, state.toString());

    expect(executions).toBe(1);
  });
});

describe("tool_search tool wiring", () => {
  test("session-eager MCP schemas stay visible while non-eager schemas defer", async () => {
    const makeServer = (registryId: string) =>
      new PrefixedMcpServer(
        {
          name: `inner-${registryId}`,
          cacheToolsList: false,
          connect: async () => undefined,
          close: async () => undefined,
          listTools: async () =>
            [
              {
                name: "search_documents",
                description: "Search documents",
                inputSchema: { type: "object", properties: {} },
              },
            ] as never,
          callTool: async () => ({ content: [] }),
          invalidateToolsCache: async () => undefined,
        } as never,
        registryId,
      );
    const opengeni = makeServer("opengeni");
    const apps = makeServer("codex_apps");
    apps.deferModelToolSchemaAccounting();
    const agent = buildOpenGeniAgent(testSettings({ codexToolSearchEnabled: true }), [], {
      structuredToolTransport: false,
      lazyToolTransport: "codex_native",
      mcpServers: [opengeni, apps],
    });

    await agent.getAllTools(new RunContext());
    expect(opengeni.modelToolSchemaTokens()).toBeGreaterThan(0);
    expect(apps.modelToolSchemaTokens()).toBe(0);
  });

  test("buildAgent passes prepared MCP registry ids to the live tool_search executor", async () => {
    const apps = new PrefixedMcpServer(
      {
        name: "inner-codex-apps",
        cacheToolsList: false,
        connect: async () => undefined,
        close: async () => undefined,
        listTools: async () =>
          [
            {
              name: "search_documents",
              description: "Search connected app documents",
              inputSchema: {
                type: "object",
                properties: { query: { type: "string" } },
              },
            },
          ] as never,
        callTool: async () => ({ content: [] }),
        invalidateToolsCache: async () => undefined,
      } as never,
      "codex_apps",
    );
    apps.deferModelToolSchemaAccounting();
    const agent = buildOpenGeniAgent(testSettings({ codexToolSearchEnabled: true }), [], {
      structuredToolTransport: false,
      lazyToolTransport: "codex_native",
      mcpServers: [apps],
    });

    const tools = await agent.getAllTools(new RunContext());
    const searchTool = tools.find((tool) => (tool as { name?: string }).name === "tool_search");
    expect(searchTool).toBeDefined();
    const executor = getClientToolSearchExecutor(searchTool as never);
    const result = await executor!({
      agent: agent as never,
      availableTools: tools as never,
      loadDefault: (() => []) as never,
      runContext: {} as never,
      toolCall: {
        type: "tool_search_call",
        arguments: { query: "search documents" },
      } as never,
    });
    const matched = (Array.isArray(result) ? result : result ? [result] : []) as Tool[];
    expect(matched.map((tool) => (tool as { name: string }).name)).toContain(
      "codex_apps__search_documents",
    );
  });
});
