import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import {
  MCP_DEFAULT_OUTER_CONNECT_TIMEOUT_MS,
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
  mcpOuterConnectTimeoutMs,
} from "../src/mcp-network";

const testSettings = {
  environment: "test",
  integrationsAllowPrivateNetworkTargets: false,
};

describe("MCP network and payload boundary", () => {
  test("keeps the outer Agents SDK connect fence at least as large as configured transports", () => {
    expect(mcpOuterConnectTimeoutMs([])).toBe(MCP_DEFAULT_OUTER_CONNECT_TIMEOUT_MS);
    expect(mcpOuterConnectTimeoutMs([5_000, undefined])).toBe(MCP_DEFAULT_OUTER_CONNECT_TIMEOUT_MS);
    expect(mcpOuterConnectTimeoutMs([30_000, 15_000, undefined])).toBe(30_000);
  });

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

  test("validates before the Bun-native transport without passing an Undici dispatcher", async () => {
    let seenInit: RequestInit | undefined;
    const guarded = guardedMcpFetch(
      testSettings,
      async (_input, init) => {
        seenInit = init;
        return Response.json({ ok: true });
      },
      {
        dnsLookup: async () => [{ address: "1.1.1.1", family: 4 }],
        pinResolvedDestination: false,
      },
    );

    const response = await guarded("https://example.test/mcp", {
      method: "POST",
      headers: { authorization: "Bearer test" },
    });
    expect(await response.json()).toEqual({ ok: true });
    expect(seenInit?.redirect).toBe("manual");
    expect(seenInit?.method).toBe("POST");
    expect("dispatcher" in (seenInit ?? {})).toBe(false);
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

  test("rejects aggregate entry overflow across providers without committing the failed source", () => {
    const budget = new McpAggregateToolListBudget("aggregate test", 4_096, Number.MAX_SAFE_INTEGER);
    for (let provider = 0; provider < 4; provider += 1) {
      budget.replace(
        `provider-${provider}`,
        Array.from({ length: 1_000 }, (_, index) => ({
          name: `provider-${provider}-${index}`,
        })),
      );
    }
    budget.replace(
      "provider-remainder",
      Array.from({ length: 96 }, (_, index) => ({ name: `remainder-${index}` })),
    );

    expect(() => budget.replace("provider-overflow", [{ name: "one-more" }])).toThrow(
      McpPayloadTooLargeError,
    );
    expect(budget.snapshot().entries).toBe(4_096);
  });

  test("rejects aggregate serialized-byte overflow across providers without committing the failed source", () => {
    const budget = new McpAggregateToolListBudget(
      "aggregate test",
      Number.MAX_SAFE_INTEGER,
      16 * 1024 * 1024,
    );
    const providerTools = Array.from({ length: 40 }, (_, index) => ({
      name: `large-tool-${index}`,
      description: "x".repeat(100_000),
    }));
    for (let index = 0; index < 4; index += 1) {
      budget.replace(`provider-${index}`, providerTools);
    }
    const before = budget.snapshot();
    expect(before.bytes).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(() => budget.replace("provider-overflow", providerTools)).toThrow(
      McpPayloadTooLargeError,
    );
    expect(budget.snapshot()).toEqual(before);
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
