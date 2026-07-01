import { describe, expect, test } from "bun:test";
import { getClientToolSearchExecutor, type Tool } from "@openai/agents";
import {
  applyCodexToolSearch,
  bm25RankTools,
  buildCodexToolSearchTool,
  isCodexAppsFunctionTool,
} from "../src/codex-tool-search";

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

  test("respects the limit", () => {
    expect(bm25RankTools(POOL, "email message", 2)).toHaveLength(2);
  });

  test("a no-match query still returns something (never strands the model)", () => {
    const out = bm25RankTools(POOL, "zzzz totally unrelated qqqq", 3);
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(3);
  });

  test("empty pool → empty result", () => {
    expect(bm25RankTools([], "anything", 5)).toEqual([]);
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

  test("no codex_apps tools → no-op (same array, no tool_search added)", () => {
    const tools: Tool[] = [plainTool("opengeni__set_session_title"), plainTool("web_search")];
    const out = applyCodexToolSearch(tools);
    expect(out).toBe(tools); // same reference — untouched
    expect(out.some((t) => (t as { name?: string }).name === "tool_search")).toBe(false);
  });

  test("idempotent — re-applying does not double-add the search tool", () => {
    const tools: Tool[] = POOL.map((t) => ({ ...t })) as Tool[];
    const once = applyCodexToolSearch(tools);
    const twice = applyCodexToolSearch(once);
    expect(twice.filter((t) => (t as { name?: string }).name === "tool_search")).toHaveLength(1);
  });
});

describe("tool_search tool wiring", () => {
  test("buildCodexToolSearchTool is a hosted tool_search with an attached client executor that BM25s the deferred pool", async () => {
    const searchTool = buildCodexToolSearchTool();
    expect((searchTool as { name?: string }).name).toBe("tool_search");
    const executor = getClientToolSearchExecutor(searchTool as never);
    expect(typeof executor).toBe("function");
    // drive it exactly as the SDK would: availableTools = the resolved set, toolCall.arguments = the model's query
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
});
