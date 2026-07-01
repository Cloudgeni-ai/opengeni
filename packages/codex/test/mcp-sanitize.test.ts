import { describe, expect, test } from "bun:test";
import {
  ToolNameMapper,
  codexAppsSanitizingFetch,
  remapToolCallRequestBody,
  sanitizeMcpJsonBody,
  sanitizeMcpSseBody,
} from "../src/mcp-sanitize";

const toolsListMsg = (tools: unknown[]) => ({ jsonrpc: "2.0", id: 2, result: { tools } });
const toolCallMsg = (name: string) => JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: {} } });

describe("ToolNameMapper", () => {
  test("sanitizes invalid chars (dots) and reverses them", () => {
    const m = new ToolNameMapper();
    expect(m.sanitize("vercel.deploy_to_vercel")).toBe("vercel_deploy_to_vercel");
    expect(m.toOriginal("vercel_deploy_to_vercel")).toBe("vercel.deploy_to_vercel");
  });

  test("leaves already-valid names untouched (identity)", () => {
    const m = new ToolNameMapper();
    expect(m.sanitize("github_create_issue")).toBe("github_create_issue");
    expect(m.toOriginal("github_create_issue")).toBe("github_create_issue");
  });

  test("is idempotent for the same original across repeat listings", () => {
    const m = new ToolNameMapper();
    const first = m.sanitize("a.b");
    const second = m.sanitize("a.b");
    expect(second).toBe(first);
    expect(m.toOriginal(first)).toBe("a.b");
  });

  test("disambiguates a collision between two distinct originals", () => {
    const m = new ToolNameMapper();
    const a = m.sanitize("x.y"); // -> x_y
    const b = m.sanitize("x_y"); // already valid, but x_y is taken -> x_y_2
    expect(a).toBe("x_y");
    expect(b).not.toBe(a);
    expect(m.toOriginal(a)).toBe("x.y");
    expect(m.toOriginal(b)).toBe("x_y");
  });

  // The runtime PrefixedMcpServer prepends `codex_apps__` (12) to the sanitized
  // name; the Responses-API 64-char limit applies to THAT final name. So the real
  // invariant is `("codex_apps__" + out).length <= 64`, i.e. out <= 52.
  const CODEX_APPS_PREFIX = "codex_apps__";
  const prefixed = (name: string) => `${CODEX_APPS_PREFIX}${name}`;

  test("P2-d: caps a >64-char name so the PREFIXED name stays <=64, with a stable hash suffix, reverse-mappable", () => {
    const m = new ToolNameMapper();
    const long = `connector.${"deploy_a_very_long_namespaced_tool_name_that_blows_the_limit".repeat(2)}`;
    expect(long.length).toBeGreaterThan(64);
    const out = m.sanitize(long);
    expect(prefixed(out).length).toBeLessThanOrEqual(64); // the FINAL name the model sees
    expect(out).toMatch(/^[a-zA-Z0-9_-]+$/); // still charset-legal
    expect(m.toOriginal(out)).toBe(long); // reverse map keyed on the EMITTED name
  });

  test("P2-d: the length cap is deterministic across repeat listings (idempotent)", () => {
    const m = new ToolNameMapper();
    const long = "ns." + "x".repeat(80);
    expect(m.sanitize(long)).toBe(m.sanitize(long));
  });

  test("P2-d: two distinct long names that truncate alike stay distinct + prefixed <=64", () => {
    const m = new ToolNameMapper();
    const base = "ns." + "y".repeat(80);
    const a = m.sanitize(`${base}_alpha`);
    const b = m.sanitize(`${base}_beta`);
    expect(a).not.toBe(b);
    expect(prefixed(a).length).toBeLessThanOrEqual(64);
    expect(prefixed(b).length).toBeLessThanOrEqual(64);
    expect(m.toOriginal(a)).toBe(`${base}_alpha`);
    expect(m.toOriginal(b)).toBe(`${base}_beta`);
  });

  test("reserves the runtime prefix: a 53–64 char name (passes the raw 64 cap) is capped so codex_apps__<name> <= 64", () => {
    const m = new ToolNameMapper();
    // 60 chars, already charset-legal — under the raw 64 cap, but 60 + 12 = 72 > 64
    // would 400 the whole turn once PrefixedMcpServer prepends the namespace.
    const name60 = "a".repeat(60);
    expect(name60.length).toBeGreaterThan(52);
    expect(name60.length).toBeLessThanOrEqual(64);
    const out = m.sanitize(name60);
    expect(prefixed(out).length).toBeLessThanOrEqual(64); // the regression: was 72
    expect(out).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(m.toOriginal(out)).toBe(name60); // reverse mapping intact after the cap
  });
});

describe("remapToolCallRequestBody", () => {
  test("reverses a sanitized tools/call name to the original", () => {
    const m = new ToolNameMapper();
    m.sanitize("vercel.deploy_to_vercel"); // record the mapping (as tools/list would)
    const rewritten = remapToolCallRequestBody(toolCallMsg("vercel_deploy_to_vercel"), m);
    expect(JSON.parse(rewritten!).params.name).toBe("vercel.deploy_to_vercel");
  });

  test("returns null when the name needs no rewrite", () => {
    const m = new ToolNameMapper();
    m.sanitize("plain_name");
    expect(remapToolCallRequestBody(toolCallMsg("plain_name"), m)).toBeNull();
    expect(remapToolCallRequestBody(toolCallMsg("unknown"), m)).toBeNull();
  });

  test("ignores non-tools/call messages", () => {
    expect(remapToolCallRequestBody(JSON.stringify({ method: "tools/list" }), new ToolNameMapper())).toBeNull();
  });
});

describe("sanitizeMcpJsonBody", () => {
  test("drops EVERY outputSchema (incl. valid object ones) but keeps all tools", () => {
    // Dropping every outputSchema stops the MCP SDK from validating each tool
    // CALL's structuredContent against it — the connectors return results that
    // don't match their own declared schemas, which otherwise -32602s the call.
    const body = JSON.stringify(toolsListMsg([
      { name: "a", inputSchema: { type: "object" }, outputSchema: {} },                       // empty -> drop
      { name: "b", inputSchema: { type: "object" }, outputSchema: { type: "array" } },         // non-object -> drop
      { name: "c", inputSchema: { type: "object" }, outputSchema: { type: "object", properties: {} } }, // valid -> drop too
      { name: "d", inputSchema: { type: "object" }, outputSchema: { type: "object", required: ["result"] } }, // the live failure shape -> drop
      { name: "e", inputSchema: { type: "object" } },                                          // none -> unchanged
    ]));
    const tools = JSON.parse(sanitizeMcpJsonBody(body)).result.tools;
    expect(tools).toHaveLength(5); // no tool dropped
    for (const tool of tools) {
      expect("outputSchema" in tool).toBe(false); // every outputSchema gone
    }
    // inputSchema (needed by the model) and the tool itself are untouched.
    expect(tools[0].inputSchema).toEqual({ type: "object" });
    expect(tools.map((t: { name: string }) => t.name)).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("leaves non-tools-list messages untouched", () => {
    const other = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "x", capabilities: {} } });
    expect(sanitizeMcpJsonBody(other)).toBe(JSON.stringify(JSON.parse(other)));
  });

  test("returns non-JSON input unchanged", () => {
    expect(sanitizeMcpJsonBody("not json")).toBe("not json");
  });

  // P4 (Part B.1): the connector-namespace sink captures the ORIGINAL dotted
  // namespace before the dot is sanitized away.
  test("namespace sink accumulates the original connector namespace (before dot rewrite)", () => {
    const sink = new Set<string>();
    const body = JSON.stringify(toolsListMsg([
      { name: "github.create_issue", inputSchema: { type: "object" } },
      { name: "github.list_repos", inputSchema: { type: "object" } },   // dedup → still one "github"
      { name: "gmail.send", inputSchema: { type: "object" } },
      { name: "set_session_title", inputSchema: { type: "object" } },   // un-dotted → not a connector namespace
    ]));
    const tools = JSON.parse(sanitizeMcpJsonBody(body, new ToolNameMapper(), sink)).result.tools;
    // The wire names were sanitized (dot → underscore) for the model.
    expect(tools[0].name).toBe("github_create_issue");
    // The sink kept the ORIGINAL namespaces, deduped, excluding the un-dotted tool.
    expect([...sink].sort()).toEqual(["github", "gmail"]);
  });
});

describe("sanitizeMcpSseBody", () => {
  test("rewrites the data: line and preserves event framing", () => {
    const sse = `event: message\ndata: ${JSON.stringify(toolsListMsg([{ name: "a", outputSchema: {} }]))}\n\n`;
    const out = sanitizeMcpSseBody(sse);
    expect(out).toContain("event: message");
    const dataLine = out.split("\n").find((l) => l.startsWith("data:"))!;
    const tool = JSON.parse(dataLine.slice("data:".length).trim()).result.tools[0];
    expect("outputSchema" in tool).toBe(false);
  });
});

describe("codexAppsSanitizingFetch", () => {
  test("sanitizes a POST application/json tools/list response", async () => {
    const base = async () => new Response(JSON.stringify(toolsListMsg([{ name: "a", outputSchema: {} }])), {
      status: 200, headers: { "content-type": "application/json" },
    });
    const res = await codexAppsSanitizingFetch(base)("https://x/ps/mcp", { method: "POST" });
    const tool = (await res.json()).result.tools[0];
    expect("outputSchema" in tool).toBe(false);
  });

  test("round-trip: list sanitizes the dotted name, call reverses it (same fetch instance)", async () => {
    const sent: string[] = [];
    const base = async (_input: unknown, init?: RequestInit) => {
      const body = init?.body as string | undefined;
      if (body) sent.push(body);
      const isList = body?.includes("tools/list") ?? true;
      const payload = isList
        ? toolsListMsg([{ name: "vercel.deploy_to_vercel", inputSchema: { type: "object" } }])
        : { jsonrpc: "2.0", id: 3, result: { content: [] } };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    };
    const fetchImpl = codexAppsSanitizingFetch(base as never);
    // 1. tools/list -> model sees the sanitized name
    const listRes = await fetchImpl("https://x/ps/mcp", { method: "POST", body: JSON.stringify({ method: "tools/list" }) });
    expect((await listRes.json()).result.tools[0].name).toBe("vercel_deploy_to_vercel");
    // 2. tools/call with the sanitized name -> the server receives the ORIGINAL
    await fetchImpl("https://x/ps/mcp", { method: "POST", body: toolCallMsg("vercel_deploy_to_vercel") });
    const forwardedCall = JSON.parse(sent[sent.length - 1]!);
    expect(forwardedCall.params.name).toBe("vercel.deploy_to_vercel");
  });

  test("passes through a GET (long-lived notification SSE) untouched", async () => {
    const body = `data: ${JSON.stringify(toolsListMsg([{ name: "a", outputSchema: {} }]))}\n\n`;
    const base = async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    const res = await codexAppsSanitizingFetch(base)("https://x/ps/mcp", { method: "GET" });
    expect(await res.text()).toBe(body); // not buffered/rewritten
  });

  test("passes non-OK responses through untouched", async () => {
    const base = async () => new Response("nope", { status: 401, headers: { "content-type": "application/json" } });
    const res = await codexAppsSanitizingFetch(base)("https://x/ps/mcp", { method: "POST" });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("nope");
  });
});
