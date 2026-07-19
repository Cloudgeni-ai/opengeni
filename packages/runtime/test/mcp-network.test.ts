import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import {
  MCP_MAX_INBOUND_REQUEST_BYTES,
  MCP_MAX_SELECTED_SERVERS,
  MCP_MAX_TOOL_RESULT_BYTES,
  McpAggregateToolListBudget,
  McpPayloadTooLargeError,
  assertMcpPayloadWithinBytes,
  assertMcpServerSelectionWithinBounds,
  assertMcpToolListWithinBounds,
  boundedMcpRequest,
  boundedParallelMap,
  boundMcpResponseBody,
  guardedMcpFetch,
} from "../src/mcp-network";

const testSettings = {
  environment: "test",
  integrationsAllowPrivateNetworkTargets: false,
};

describe("MCP network and payload boundary", () => {
  test("pins the final transport, forces manual redirects, and rejects declared oversize", async () => {
    let redirect: RequestRedirect | undefined;
    const guarded = guardedMcpFetch(
      testSettings,
      async (_input, init) => {
        redirect = init?.redirect;
        return new Response("oversized", { headers: { "content-length": "9" } });
      },
      {
        maxResponseBytes: 8,
        dnsLookup: async () => [{ address: "1.1.1.1", family: 4 }],
      },
    );

    await expect(guarded("https://example.test/mcp")).rejects.toBeInstanceOf(
      McpPayloadTooLargeError,
    );
    expect(redirect).toBe("manual");
  });

  test("errors on the first streamed byte past the response ceiling", async () => {
    const response = boundMcpResponseBody(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(5));
            controller.enqueue(new Uint8Array(5));
            controller.close();
          },
        }),
      ),
      8,
    );
    await expect(response.arrayBuffer()).rejects.toBeInstanceOf(McpPayloadTooLargeError);
  });

  test("bounds individual definitions, server lists, and tool results", () => {
    expect(assertMcpToolListWithinBounds([{ name: "small" }])).toHaveLength(1);
    expect(() => assertMcpToolListWithinBounds([{ schema: "x".repeat(128 * 1024) }])).toThrow(
      McpPayloadTooLargeError,
    );
    expect(() =>
      assertMcpPayloadWithinBytes(
        { content: "x".repeat(MCP_MAX_TOOL_RESULT_BYTES) },
        MCP_MAX_TOOL_RESULT_BYTES,
        "MCP tool result",
      ),
    ).toThrow(McpPayloadTooLargeError);
  });

  test("bounds inbound request bodies before SDK parsing", async () => {
    const exact = await boundedMcpRequest(
      new Request("https://example.test/mcp", {
        method: "POST",
        body: "1234",
        headers: { "content-length": "4" },
      }),
      4,
    );
    expect(await exact.text()).toBe("1234");

    await expect(
      boundedMcpRequest(
        new Request("https://example.test/mcp", {
          method: "POST",
          body: "12345",
          headers: { "content-length": "5" },
        }),
        4,
      ),
    ).rejects.toBeInstanceOf(McpPayloadTooLargeError);
    await expect(
      boundedMcpRequest(
        new Request("https://example.test/mcp", {
          method: "POST",
          body: "{}",
          headers: { "content-length": "broken" },
        }),
        MCP_MAX_INBOUND_REQUEST_BYTES,
      ),
    ).rejects.toBeInstanceOf(McpPayloadTooLargeError);
  });

  test("bounds selected servers and atomically replaces aggregate relist contributions", () => {
    expect(
      assertMcpServerSelectionWithinBounds(Array.from({ length: MCP_MAX_SELECTED_SERVERS })),
    ).toHaveLength(MCP_MAX_SELECTED_SERVERS);
    expect(() =>
      assertMcpServerSelectionWithinBounds(Array.from({ length: MCP_MAX_SELECTED_SERVERS + 1 })),
    ).toThrow(McpPayloadTooLargeError);

    const first = { name: "a" };
    const second = { name: "b" };
    const exactBytes = Buffer.byteLength(JSON.stringify([first]));
    const budget = new McpAggregateToolListBudget("test aggregate", 2, exactBytes * 2);
    budget.replace("one", [first]);
    budget.replace("two", [first]);
    expect(budget.snapshot()).toEqual({ entries: 2, bytes: exactBytes * 2 });

    budget.replace("one", [second]);
    expect(budget.snapshot()).toEqual({ entries: 2, bytes: exactBytes * 2 });
    expect(() => budget.replace("three", [first])).toThrow(McpPayloadTooLargeError);
    expect(() => budget.replace("one", [{ name: "too-large" }])).toThrow(McpPayloadTooLargeError);
    expect(budget.snapshot()).toEqual({ entries: 2, bytes: exactBytes * 2 });
    budget.remove("two");
    expect(budget.snapshot()).toEqual({ entries: 1, bytes: exactBytes });
  });

  test("bounded parallel map preserves order and never exceeds its concurrency", async () => {
    let active = 0;
    let maxActive = 0;
    const output = await boundedParallelMap(
      Array.from({ length: 19 }, (_, index) => index),
      3,
      async (value) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Bun.sleep((value % 3) + 1);
        active -= 1;
        return `value-${value}`;
      },
    );
    expect(maxActive).toBe(3);
    expect(output).toEqual(Array.from({ length: 19 }, (_, index) => `value-${index}`));
  });
});
