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
import { SandboxAgent } from "@openai/agents/sandbox";
import { testSettings } from "@opengeni/testing";
import {
  applyCodexToolSearch,
  bm25RankTools,
  buildCodexToolSearchTool,
  installCodexToolSearch,
  isCodexAppsFunctionTool,
  isSearchableMcpFunctionTool,
  renderSearchToolDescription,
} from "../src/codex-tool-search";
import {
  buildOpenGeniAgent,
  prepareRunInput,
  PrefixedMcpServer,
  restoreInterruptedRunState,
} from "../src";

// Minimal function-tool doubles (only the fields the search + transform read).
function connectorTool(name: string, description: string, props: string[] = []): Tool {
  return {
    type: "function",
    name: `codex_apps__${name}`,
    description,
    parameters: {
      type: "object",
      properties: Object.fromEntries(props.map((p) => [p, { type: "string" }])),
    },
  } as unknown as Tool;
}
function plainTool(name: string): Tool {
  return {
    type: "function",
    name,
    description: name,
    parameters: { type: "object", properties: {} },
  } as unknown as Tool;
}

const SLACK_SERVER_ID = "cap_integrations_sh_slack_com_5a15dccc0dc0_17qniox";
const CODEX_APPS_SERVER_IDS = new Set(["codex_apps"]);
const SLACK_TOOLS: Tool[] = [
  {
    type: "function",
    name: `${SLACK_SERVER_ID}__slack_search_users`,
    description: "Search Slack users by name or email address",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
    },
  },
  {
    type: "function",
    name: `${SLACK_SERVER_ID}__slack_send_message`,
    description: "Send a message to a Slack channel or user",
    parameters: {
      type: "object",
      properties: { channel_id: { type: "string" }, message: { type: "string" } },
    },
  },
] as unknown as Tool[];

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

describe("renderSearchToolDescription", () => {
  test("lists the account's live connector sources, sorted (codex-rs parity)", () => {
    const description = renderSearchToolDescription(
      new Set(["linear", "gmail", "google_calendar"]),
    );
    expect(description).toContain("You have access to tools from the following sources:");
    const gmailAt = description.indexOf("- gmail");
    const calendarAt = description.indexOf("- google_calendar");
    const linearAt = description.indexOf("- linear");
    expect(gmailAt).toBeGreaterThan(-1);
    expect(calendarAt).toBeGreaterThan(gmailAt);
    expect(linearAt).toBeGreaterThan(calendarAt);
    // never a hardcoded connector that isn't connected
    expect(description).not.toContain("Slack");
    expect(description).not.toContain("GitHub");
  });

  test("no namespaces → honest 'none currently available'", () => {
    expect(renderSearchToolDescription(new Set())).toContain("none currently available");
  });
});

describe("applyCodexToolSearch", () => {
  test("tags codex_apps tools deferLoading + appends exactly one tool_search tool", () => {
    const tools: Tool[] = [
      ...(POOL.map((t) => ({ ...t })) as Tool[]),
      plainTool("opengeni__set_session_title"),
    ];
    const out = applyCodexToolSearch(tools, new Set(), undefined, CODEX_APPS_SERVER_IDS);
    const connectors = out.filter(isCodexAppsFunctionTool);
    expect(connectors.length).toBe(POOL.length);
    for (const c of connectors) expect((c as { deferLoading?: boolean }).deferLoading).toBe(true);
    const searchTools = out.filter((t) => (t as { name?: string }).name === "tool_search");
    expect(searchTools).toHaveLength(1);
    // the non-connector tool is untouched (not deferred)
    const title = out.find((t) => (t as { name?: string }).name === "opengeni__set_session_title");
    expect((title as { deferLoading?: boolean }).deferLoading).toBeUndefined();
  });

  test("no codex_apps tools → the search tool is STILL appended (a prior turn's tool_search history must never replay without it)", () => {
    const tools: Tool[] = [plainTool("opengeni__set_session_title")];
    const out = applyCodexToolSearch(tools);
    expect(out.filter((t) => (t as { name?: string }).name === "tool_search")).toHaveLength(1);
    // nothing got deferred
    expect((out[0] as { deferLoading?: boolean }).deferLoading).toBeUndefined();
  });

  test("idempotent — re-applying does not double-add the search tool", () => {
    const tools: Tool[] = POOL.map((t) => ({ ...t })) as Tool[];
    const once = applyCodexToolSearch(tools, new Set(), undefined, CODEX_APPS_SERVER_IDS);
    const twice = applyCodexToolSearch(once);
    expect(twice.filter((t) => (t as { name?: string }).name === "tool_search")).toHaveLength(1);
  });

  test("the search tool description reflects the passed namespaces", () => {
    const out = applyCodexToolSearch(
      POOL.map((t) => ({ ...t })) as Tool[],
      new Set(["gmail"]),
      undefined,
      CODEX_APPS_SERVER_IDS,
    );
    const search = out.find((t) => (t as { name?: string }).name === "tool_search") as {
      providerData?: { description?: string };
    };
    expect(search.providerData?.description).toContain("- gmail");
  });

  test("selected Slack MCP tools are deferred and add their source to discovery", () => {
    const tools = [
      ...(SLACK_TOOLS.map((tool) => ({ ...tool })) as Tool[]),
      plainTool("opengeni__set_session_title"),
    ];
    const out = applyCodexToolSearch(tools, new Set(), undefined, new Set([SLACK_SERVER_ID]));
    expect(
      out.filter((tool) => isSearchableMcpFunctionTool(tool, new Set([SLACK_SERVER_ID]))),
    ).toHaveLength(2);
    expect(
      out
        .filter((tool) => isSearchableMcpFunctionTool(tool, new Set([SLACK_SERVER_ID])))
        .every((tool) => (tool as { deferLoading?: boolean }).deferLoading === true),
    ).toBe(true);
    const search = out.find((tool) => (tool as { name?: string }).name === "tool_search") as {
      providerData?: { description?: string };
    };
    expect(search.providerData?.description).toContain(SLACK_SERVER_ID);
    expect(
      (
        out.find((tool) => (tool as { name?: string }).name === "opengeni__set_session_title") as {
          deferLoading?: boolean;
        }
      ).deferLoading,
    ).toBeUndefined();
  });

  test("uses authoritative MCP identities for mandatory, underscore, and non-MCP names", () => {
    const mcpServerIds = new Set(["opengeni", "opengeni_", "my", "my_", "my__"]);
    const tools = [
      plainTool("opengeni__set_session_title"),
      plainTool("opengeni___selected_tool"),
      plainTool("my__selected_tool"),
      plainTool("my___selected_tool"),
      plainTool("my____selected_tool"),
      plainTool("ordinary__function"),
    ];
    const out = applyCodexToolSearch(tools, new Set(), undefined, mcpServerIds);
    const deferredNames = new Set(
      out
        .filter((tool) => (tool as { deferLoading?: boolean }).deferLoading === true)
        .map((tool) => (tool as { name: string }).name),
    );

    expect(deferredNames).toEqual(
      new Set([
        "opengeni___selected_tool",
        "my__selected_tool",
        "my___selected_tool",
        "my____selected_tool",
      ]),
    );
    expect(deferredNames.has("opengeni__set_session_title")).toBe(false);
    expect(deferredNames.has("ordinary__function")).toBe(false);
    expect(isSearchableMcpFunctionTool(tools[0], mcpServerIds)).toBe(false);
    expect(isSearchableMcpFunctionTool(tools[1], mcpServerIds)).toBe(true);
    expect(isSearchableMcpFunctionTool(tools[5], mcpServerIds)).toBe(false);
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
});

describe("tool_search tool wiring", () => {
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
    const agent = buildOpenGeniAgent(testSettings({ codexToolSearchEnabled: true }), [], {
      structuredToolTransport: false,
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

  test("buildCodexToolSearchTool carries a client executor that BM25s the deferred pool by reference", async () => {
    const searchTool = buildCodexToolSearchTool(
      new Set(["gmail", "github"]),
      CODEX_APPS_SERVER_IDS,
    );
    expect((searchTool as { name?: string }).name).toBe("tool_search");
    const executor = getClientToolSearchExecutor(searchTool as never);
    expect(typeof executor).toBe("function");
    const result = await executor!({
      agent: {} as never,
      availableTools: [...POOL, plainTool("web_search")] as never,
      loadDefault: (() => []) as never,
      runContext: {} as never,
      toolCall: {
        type: "tool_search_call",
        arguments: JSON.stringify({ query: "open a github issue", limit: 2 }),
      } as never,
    });
    const matched = (Array.isArray(result) ? result : result ? [result] : []) as Array<{
      name: string;
    }>;
    expect(matched.length).toBeGreaterThan(0);
    expect(matched.length).toBeLessThanOrEqual(2);
    expect(matched[0]!.name).toBe("codex_apps__github_create_issue");
    // returns tools BY REFERENCE from availableTools (required for correct disclosure)
    expect(POOL).toContain(matched[0] as unknown as Tool);
  });

  test("the executor accepts OBJECT arguments (the live wire shape) as well as a string", async () => {
    const executor = getClientToolSearchExecutor(
      buildCodexToolSearchTool(new Set(), CODEX_APPS_SERVER_IDS) as never,
    )!;
    const result = await executor({
      agent: {} as never,
      availableTools: POOL as never,
      loadDefault: (() => []) as never,
      runContext: {} as never,
      toolCall: { type: "tool_search_call", arguments: { query: "send an email" } } as never,
    });
    const matched = (Array.isArray(result) ? result : [result]) as Array<{ name: string }>;
    expect(matched[0]!.name).toBe("codex_apps__gmail_send_email");
  });

  test("finds selected, directly callable Slack tools through the same search surface", async () => {
    const executor = getClientToolSearchExecutor(
      buildCodexToolSearchTool(new Set(), new Set([SLACK_SERVER_ID])) as never,
    )!;
    const search = async (query: string) => {
      const result = await executor({
        agent: {} as never,
        availableTools: SLACK_TOOLS as never,
        loadDefault: (() => []) as never,
        runContext: {} as never,
        toolCall: { type: "tool_search_call", arguments: { query, limit: 2 } } as never,
      });
      return (Array.isArray(result) ? result : result ? [result] : []) as Tool[];
    };

    const userMatches = await search("find a Slack user");
    const messageMatches = await search("send a Slack message");
    expect(userMatches[0]).toBe(SLACK_TOOLS[0]);
    expect(messageMatches[0]).toBe(SLACK_TOOLS[1]);
  });

  test("never discloses an oversized schema and caps aggregate lazy schema bytes", async () => {
    const oversized = connectorTool(
      "oversized_calendar",
      `Create a calendar meeting ${"x".repeat(130 * 1024)}`,
    );
    const boundedMatches = Array.from({ length: 20 }, (_, index) =>
      connectorTool(`calendar_${index}`, `Create a calendar meeting ${"y".repeat(40 * 1024)}`),
    );
    const executor = getClientToolSearchExecutor(
      buildCodexToolSearchTool(new Set(), CODEX_APPS_SERVER_IDS) as never,
    )!;
    const result = await executor({
      agent: {} as never,
      availableTools: [oversized, ...boundedMatches] as never,
      loadDefault: (() => []) as never,
      runContext: {} as never,
      toolCall: {
        type: "tool_search_call",
        arguments: { query: "create calendar meeting", limit: 20 },
      } as never,
    });
    const matched = (Array.isArray(result) ? result : result ? [result] : []) as Tool[];
    expect(matched).not.toContain(oversized);
    expect(matched.length).toBeGreaterThan(0);
    expect(matched.length).toBeLessThan(20);
  });
});

describe("clone survival (the SandboxAgent path — the REAL staging path)", () => {
  // The SDK's sandbox runtime routes EVERY model call through
  // prepareSandboxAgent → agent.clone(...), and SandboxAgent.clone constructs a
  // FRESH agent from a fixed field list — an instance-own getAllTools override
  // is NOT copied. Without clone survival the whole feature silently no-ops on
  // sandbox turns (the audit's blocker). This exercises the REAL SandboxAgent.
  function buildSandboxAgent(): SandboxAgent<any, any> {
    return new SandboxAgent({
      name: "test-agent",
      model: "gpt-5.6-sol",
      tools: POOL.map((t) => ({ ...t })) as never,
    } as never);
  }

  test("a clone's getAllTools still defers codex_apps tools + appends the search tool", async () => {
    const agent = buildSandboxAgent();
    installCodexToolSearch(agent as never, new Set(["gmail"]), CODEX_APPS_SERVER_IDS);
    const cloned = (
      agent as unknown as {
        clone: (c: unknown) => { getAllTools: (rc: unknown) => Promise<Tool[]> };
      }
    ).clone({});
    const tools = await cloned.getAllTools({} as never);
    const connectors = tools.filter(isCodexAppsFunctionTool);
    expect(connectors.length).toBe(POOL.length);
    for (const c of connectors) expect((c as { deferLoading?: boolean }).deferLoading).toBe(true);
    expect(tools.filter((t) => (t as { name?: string }).name === "tool_search")).toHaveLength(1);
  });

  test("clone-of-clone still carries the transform (recursive re-install)", async () => {
    const agent = buildSandboxAgent();
    installCodexToolSearch(agent as never, new Set(), CODEX_APPS_SERVER_IDS);
    const c1 = (agent as unknown as { clone: (c: unknown) => any }).clone({});
    const c2 = c1.clone({});
    const tools: Tool[] = await c2.getAllTools({} as never);
    expect(tools.some((t) => (t as { name?: string }).name === "tool_search")).toBe(true);
    expect(
      tools
        .filter(isCodexAppsFunctionTool)
        .every((t) => (t as { deferLoading?: boolean }).deferLoading === true),
    ).toBe(true);
  });

  test("an uninstalled SandboxAgent clone is untouched (flag-off baseline)", async () => {
    const agent = buildSandboxAgent();
    const cloned = (
      agent as unknown as {
        clone: (c: unknown) => { getAllTools: (rc: unknown) => Promise<Tool[]> };
      }
    ).clone({});
    const tools = await cloned.getAllTools({} as never);
    expect(tools.some((t) => (t as { name?: string }).name === "tool_search")).toBe(false);
    expect(
      tools
        .filter(isCodexAppsFunctionTool)
        .some((t) => (t as { deferLoading?: boolean }).deferLoading === true),
    ).toBe(false);
  });
});

describe("per-turn description freeze (AM-8 — prefix cache stability)", () => {
  function buildSandboxAgent(): SandboxAgent<any, any> {
    return new SandboxAgent({
      name: "test-agent",
      model: "gpt-5.6-sol",
      tools: POOL.map((t) => ({ ...t })) as never,
    } as never);
  }
  function toolSearchDescriptionOf(tools: Tool[]): string {
    const search = tools.find((t) => (t as { name?: string }).name === "tool_search") as
      | { providerData?: { description?: string } }
      | undefined;
    return search?.providerData?.description ?? "";
  }

  test("connectors discovered before the first call → description is FROZEN byte-stable across calls, even as the live Set mutates mid-turn", async () => {
    const agent = buildSandboxAgent();
    // The LIVE, by-reference Set (as prepareAgentTools threads it), populated
    // before the first model call — the AM-8 happy path.
    const namespaces = new Set(["gmail"]);
    installCodexToolSearch(agent as never, namespaces);

    const call1 = toolSearchDescriptionOf(await agent.getAllTools({} as never));
    // Capability parity: a connector discovered pre-first-call IS in the frozen description.
    expect(call1).toContain("- gmail");

    // A codex_apps tools/list resolving LATER in the same turn adds a namespace.
    namespaces.add("github");
    const call2 = toolSearchDescriptionOf(await agent.getAllTools({} as never));
    const call3 = toolSearchDescriptionOf(await agent.getAllTools({} as never));

    // Frozen: byte-identical across every call, and the late arrival is NOT reflected
    // (a slightly staler connector list is the deliberate trade for a stable prefix).
    expect(call2).toBe(call1);
    expect(call3).toBe(call1);
    expect(call2).not.toContain("- github");
  });

  test("empty Set at the first call → falls back to a LIVE render (never freezes 'none'), then freezes the real list once connectors resolve", async () => {
    const agent = buildSandboxAgent();
    // Discovery has NOT populated the Set by the first model call (slow/best-effort).
    const namespaces = new Set<string>();
    installCodexToolSearch(agent as never, namespaces);

    // Fallback: honest "none", and critically NOT frozen — freezing it would
    // silently disable the turn's connectors for the whole turn (capability loss).
    const call1 = toolSearchDescriptionOf(await agent.getAllTools({} as never));
    expect(call1).toContain("none currently available");

    // codex_apps tools/list resolves → the Set fills. The NEXT call renders the real
    // list and freezes it (at most one prefix transition, versus per-call churn).
    namespaces.add("gmail");
    const call2 = toolSearchDescriptionOf(await agent.getAllTools({} as never));
    expect(call2).toContain("- gmail");

    // A further same-turn change is now ignored (frozen on first non-empty render).
    namespaces.add("linear");
    const call3 = toolSearchDescriptionOf(await agent.getAllTools({} as never));
    expect(call3).toBe(call2);
    expect(call3).not.toContain("- linear");
  });

  test("connector-less account → 'none' is byte-stable across calls (empty render is a constant; nothing to freeze)", async () => {
    const agent = buildSandboxAgent();
    const namespaces = new Set<string>();
    installCodexToolSearch(agent as never, namespaces);
    const call1 = toolSearchDescriptionOf(await agent.getAllTools({} as never));
    const call2 = toolSearchDescriptionOf(await agent.getAllTools({} as never));
    expect(call1).toContain("none currently available");
    expect(call2).toBe(call1);
  });

  test("the freeze cell is SHARED across clones — a clone's frozen description binds the parent (the sandbox runtime resolves tools on clones)", async () => {
    const agent = buildSandboxAgent();
    const namespaces = new Set(["gmail"]);
    installCodexToolSearch(agent as never, namespaces);

    // The sandbox runtime resolves tools on a CLONE. Freeze happens there first.
    const cloned = (agent as unknown as { clone: (c: unknown) => any }).clone({});
    const cloneCall = toolSearchDescriptionOf(await cloned.getAllTools({} as never));
    expect(cloneCall).toContain("- gmail");

    // Mutate the live Set, then read the PARENT: it must return the SAME frozen
    // string the clone locked in (one shared cell across the turn's agents).
    namespaces.add("github");
    const parentCall = toolSearchDescriptionOf(await (agent as any).getAllTools({} as never));
    expect(parentCall).toBe(cloneCall);
    expect(parentCall).not.toContain("- github");
  });

  test("applyCodexToolSearch without a freeze cell live-renders (byte-for-byte pre-AM-8 behavior for direct callers)", () => {
    const first = applyCodexToolSearch(
      POOL.map((t) => ({ ...t })) as Tool[],
      new Set(["gmail"]),
      undefined,
      CODEX_APPS_SERVER_IDS,
    );
    const search = first.find((t) => (t as { name?: string }).name === "tool_search") as {
      providerData?: { description?: string };
    };
    expect(search.providerData?.description).toContain("- gmail");
    // A second call with a DIFFERENT set live-renders the new set (no freeze without a cell).
    const second = applyCodexToolSearch(
      POOL.map((t) => ({ ...t })) as Tool[],
      new Set(["linear"]),
      undefined,
      CODEX_APPS_SERVER_IDS,
    );
    const search2 = second.find((t) => (t as { name?: string }).name === "tool_search") as {
      providerData?: { description?: string };
    };
    expect(search2.providerData?.description).toContain("- linear");
  });
});
