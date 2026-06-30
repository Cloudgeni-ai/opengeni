import { describe, expect, test } from "bun:test";
import { codexAppsSanitizingFetch, sanitizeMcpJsonBody, sanitizeMcpSseBody } from "../src/mcp-sanitize";

const toolsListMsg = (tools: unknown[]) => ({ jsonrpc: "2.0", id: 2, result: { tools } });

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
