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

  test("P2-d: caps a >64-char name to <=64 with a stable hash suffix, reverse-mappable", () => {
    const m = new ToolNameMapper();
    const long = `connector.${"deploy_a_very_long_namespaced_tool_name_that_blows_the_limit".repeat(2)}`;
    expect(long.length).toBeGreaterThan(64);
    const out = m.sanitize(long);
    expect(out.length).toBeLessThanOrEqual(64);
    expect(out).toMatch(/^[a-zA-Z0-9_-]+$/); // still charset-legal
    expect(m.toOriginal(out)).toBe(long); // reverse map keyed on the EMITTED name
  });

  test("P2-d: the 64-char cap is deterministic across repeat listings (idempotent)", () => {
    const m = new ToolNameMapper();
    const long = "ns." + "x".repeat(80);
    expect(m.sanitize(long)).toBe(m.sanitize(long));
  });

  test("P2-d: two distinct long names that truncate alike stay distinct + <=64", () => {
    const m = new ToolNameMapper();
    const base = "ns." + "y".repeat(80);
    const a = m.sanitize(`${base}_alpha`);
    const b = m.sanitize(`${base}_beta`);
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(64);
    expect(b.length).toBeLessThanOrEqual(64);
    expect(m.toOriginal(a)).toBe(`${base}_alpha`);
    expect(m.toOriginal(b)).toBe(`${base}_beta`);
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
  test("drops empty + non-object outputSchemas, keeps valid object ones and all tools", () => {
    const body = JSON.stringify(toolsListMsg([
      { name: "a", inputSchema: { type: "object" }, outputSchema: {} },                       // empty -> drop
      { name: "b", inputSchema: { type: "object" }, outputSchema: { type: "array" } },         // non-object -> drop
      { name: "c", inputSchema: { type: "object" }, outputSchema: { type: "object", properties: {} } }, // valid -> keep
      { name: "d", inputSchema: { type: "object" } },                                          // none -> unchanged
    ]));
    const tools = JSON.parse(sanitizeMcpJsonBody(body)).result.tools;
    expect(tools).toHaveLength(4); // no tool dropped
    expect("outputSchema" in tools[0]).toBe(false);
    expect("outputSchema" in tools[1]).toBe(false);
    expect(tools[2].outputSchema).toEqual({ type: "object", properties: {} });
    expect("outputSchema" in tools[3]).toBe(false);
    expect(tools.map((t: { name: string }) => t.name)).toEqual(["a", "b", "c", "d"]);
  });

  test("leaves non-tools-list messages untouched", () => {
    const other = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "x", capabilities: {} } });
    expect(sanitizeMcpJsonBody(other)).toBe(JSON.stringify(JSON.parse(other)));
  });

  test("returns non-JSON input unchanged", () => {
    expect(sanitizeMcpJsonBody("not json")).toBe("not json");
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
