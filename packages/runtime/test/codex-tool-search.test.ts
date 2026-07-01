import { describe, expect, test } from "bun:test";
import { getClientToolSearchExecutor, type Tool } from "@openai/agents";
import { SandboxAgent } from "@openai/agents/sandbox";
import {
  applyCodexToolSearch,
  bm25RankTools,
  buildCodexToolSearchTool,
  installCodexToolSearch,
  isCodexAppsFunctionTool,
  renderSearchToolDescription,
} from "../src/codex-tool-search";
import { neutralizeToolSearchItemsInSerializedRunState } from "../src/history-sanitizer";

// Minimal function-tool doubles (only the fields the search + transform read).
function connectorTool(name: string, description: string, props: string[] = []): Tool {
  return {
    type: "function",
    name: `codex_apps__${name}`,
    description,
    parameters: { type: "object", properties: Object.fromEntries(props.map((p) => [p, { type: "string" }])) },
  } as unknown as Tool;
}
function plainTool(name: string): Tool {
  return { type: "function", name, description: name, parameters: { type: "object", properties: {} } } as unknown as Tool;
}

const POOL: Tool[] = [
  connectorTool("gmail_send_email", "Send an email message via Gmail to one or more recipients", ["to", "subject", "body"]),
  connectorTool("gmail_search_emails", "Search the Gmail inbox for messages matching a query", ["query", "label_ids"]),
  connectorTool("calendar_create_event", "Create a Google Calendar event with a title, start and end time", ["title", "start_time", "end_time"]),
  connectorTool("github_create_issue", "Open a new issue on a GitHub repository", ["repo", "title", "body"]),
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
    const description = renderSearchToolDescription(new Set(["linear", "gmail", "google_calendar"]));
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
    const tools: Tool[] = [...POOL.map((t) => ({ ...t })) as Tool[], plainTool("opengeni__set_session_title")];
    const out = applyCodexToolSearch(tools);
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
    const once = applyCodexToolSearch(tools);
    const twice = applyCodexToolSearch(once);
    expect(twice.filter((t) => (t as { name?: string }).name === "tool_search")).toHaveLength(1);
  });

  test("the search tool description reflects the passed namespaces", () => {
    const out = applyCodexToolSearch(POOL.map((t) => ({ ...t })) as Tool[], new Set(["gmail"]));
    const search = out.find((t) => (t as { name?: string }).name === "tool_search") as { providerData?: { description?: string } };
    expect(search.providerData?.description).toContain("- gmail");
  });
});

describe("tool_search tool wiring", () => {
  test("buildCodexToolSearchTool carries a client executor that BM25s the deferred pool by reference", async () => {
    const searchTool = buildCodexToolSearchTool(new Set(["gmail", "github"]));
    expect((searchTool as { name?: string }).name).toBe("tool_search");
    const executor = getClientToolSearchExecutor(searchTool as never);
    expect(typeof executor).toBe("function");
    const result = await executor!({
      agent: {} as never,
      availableTools: [...POOL, plainTool("web_search")] as never,
      loadDefault: (() => []) as never,
      runContext: {} as never,
      toolCall: { type: "tool_search_call", arguments: JSON.stringify({ query: "open a github issue", limit: 2 }) } as never,
    });
    const matched = (Array.isArray(result) ? result : result ? [result] : []) as Array<{ name: string }>;
    expect(matched.length).toBeGreaterThan(0);
    expect(matched.length).toBeLessThanOrEqual(2);
    expect(matched[0]!.name).toBe("codex_apps__github_create_issue");
    // returns tools BY REFERENCE from availableTools (required for correct disclosure)
    expect(POOL).toContain(matched[0] as unknown as Tool);
  });

  test("the executor accepts OBJECT arguments (the live wire shape) as well as a string", async () => {
    const executor = getClientToolSearchExecutor(buildCodexToolSearchTool() as never)!;
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
      model: "gpt-5.5",
      tools: POOL.map((t) => ({ ...t })) as never,
    } as never);
  }

  test("a clone's getAllTools still defers codex_apps tools + appends the search tool", async () => {
    const agent = buildSandboxAgent();
    installCodexToolSearch(agent as never, new Set(["gmail"]));
    const cloned = (agent as unknown as { clone: (c: unknown) => { getAllTools: (rc: unknown) => Promise<Tool[]> } }).clone({});
    const tools = await cloned.getAllTools({} as never);
    const connectors = tools.filter(isCodexAppsFunctionTool);
    expect(connectors.length).toBe(POOL.length);
    for (const c of connectors) expect((c as { deferLoading?: boolean }).deferLoading).toBe(true);
    expect(tools.filter((t) => (t as { name?: string }).name === "tool_search")).toHaveLength(1);
  });

  test("clone-of-clone still carries the transform (recursive re-install)", async () => {
    const agent = buildSandboxAgent();
    installCodexToolSearch(agent as never);
    const c1 = (agent as unknown as { clone: (c: unknown) => any }).clone({});
    const c2 = c1.clone({});
    const tools: Tool[] = await c2.getAllTools({} as never);
    expect(tools.some((t) => (t as { name?: string }).name === "tool_search")).toBe(true);
    expect(tools.filter(isCodexAppsFunctionTool).every((t) => (t as { deferLoading?: boolean }).deferLoading === true)).toBe(true);
  });

  test("an uninstalled SandboxAgent clone is untouched (flag-off baseline)", async () => {
    const agent = buildSandboxAgent();
    const cloned = (agent as unknown as { clone: (c: unknown) => { getAllTools: (rc: unknown) => Promise<Tool[]> } }).clone({});
    const tools = await cloned.getAllTools({} as never);
    expect(tools.some((t) => (t as { name?: string }).name === "tool_search")).toBe(false);
    expect(tools.filter(isCodexAppsFunctionTool).some((t) => (t as { deferLoading?: boolean }).deferLoading === true)).toBe(false);
  });
});

describe("neutralizeToolSearchItemsInSerializedRunState", () => {
  test("flips frozen tool_search pairs to execution:server in place — counts preserved", () => {
    const blob = JSON.stringify({
      originalInput: [
        { type: "message", role: "user", content: "hi" },
        { type: "tool_search_call", call_id: "c1", execution: "client", arguments: { query: "x" } },
        { type: "tool_search_output", call_id: "c1", execution: "client", tools: [{ type: "function", name: "codex_apps__gmail_send_email" }] },
      ],
      generatedItems: [
        { type: "tool_search_call_item", rawItem: { type: "tool_search_call", call_id: "c2", execution: "client", arguments: {} } },
      ],
      modelResponses: [{ output: [{ type: "tool_search_call", call_id: "c3", execution: "client", arguments: {} }] }],
      lastModelResponse: { output: [{ type: "tool_search_output", call_id: "c3", execution: "client", tools: [] }] },
    });
    const out = JSON.parse(neutralizeToolSearchItemsInSerializedRunState(blob));
    // counts preserved everywhere (HOLE E)
    expect(out.originalInput).toHaveLength(3);
    expect(out.generatedItems).toHaveLength(1);
    // every tool_search item flipped to server execution
    expect(out.originalInput[1].execution).toBe("server");
    expect(out.originalInput[2].execution).toBe("server");
    expect(out.generatedItems[0].rawItem.execution).toBe("server");
    expect(out.modelResponses[0].output[0].execution).toBe("server");
    expect(out.lastModelResponse.output[0].execution).toBe("server");
    // pairing keys + disclosure content untouched
    expect(out.originalInput[1].call_id).toBe("c1");
    expect(out.originalInput[2].tools).toHaveLength(1);
    // non-tool_search items untouched
    expect(out.originalInput[0]).toEqual({ type: "message", role: "user", content: "hi" });
  });

  test("a blob with no tool_search items comes back by reference (unchanged)", () => {
    const blob = JSON.stringify({ originalInput: [{ type: "message", role: "user", content: "hi" }], generatedItems: [] });
    expect(neutralizeToolSearchItemsInSerializedRunState(blob)).toBe(blob);
  });

  test("non-JSON input is forwarded untouched", () => {
    expect(neutralizeToolSearchItemsInSerializedRunState("not json")).toBe("not json");
  });
});
