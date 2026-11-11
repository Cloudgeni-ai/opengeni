import { describe, expect, spyOn, test } from "bun:test";
import { Buffer } from "node:buffer";
import { CODEMODE_ARGUMENTS_MAX_BYTES } from "@opengeni/contracts";
import {
  createObservability,
  parseTraceparent,
  withMcpCallIdentity,
  withMcpTelemetry,
  withTraceContext,
} from "@opengeni/observability";
import {
  MCP_DEFAULT_OUTER_CONNECT_TIMEOUT_MS,
  MCP_MAX_AGGREGATE_TOOL_LIST_ENTRIES,
  MCP_MAX_INBOUND_REQUEST_BYTES,
  MCP_MAX_SELECTED_SERVERS,
  MCP_MAX_TOOL_RESULT_BYTES,
  MCP_MAX_TOOL_DEFINITION_BYTES,
  McpAggregateToolListBudget,
  McpPayloadTooLargeError,
  assertMcpPayloadWithinBytes,
  assertMcpServerSelectionWithinBounds,
  assertMcpToolListWithinBounds,
  boundedMcpRequest,
  boundedParallelMap,
  boundMcpResponseBody,
  describeMcpToolListDrops,
  fitMcpToolListWithinBounds,
  guardedMcpFetch,
  isMcpPayloadTooLargeError,
  mcpJsonRpcErrorPayloadForRequest,
  mcpOuterConnectTimeoutMs,
  mcpRequestReplayInfo,
  mcpTransportRequestFailureDiagnostic,
} from "../src/mcp-network";

const testSettings = {
  environment: "test",
  integrationsAllowPrivateNetworkTargets: false,
};

describe("MCP network and payload boundary", () => {
  test("tool-call transport checks the actual host against the operator private allowlist", async () => {
    const calls: string[] = [];
    const guarded = guardedMcpFetch(
      {
        environment: "production",
        integrationsAllowPrivateNetworkTargets: false,
        integrationsPrivateNetworkAllowedHosts: ["admin-api.example.com:443"],
      },
      async (input: string, init) => {
        calls.push(input);
        expect(init?.redirect).toBe("manual");
        return new Response("tool result");
      },
      { dnsLookup: async () => [{ address: "10.0.0.8", family: 4 }] },
    );
    const init = {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" }),
    };
    expect(await (await guarded("https://admin-api.example.com/mcp", init)).text()).toBe(
      "tool result",
    );
    await expect(guarded("https://other.example.com/mcp", init)).rejects.toMatchObject({
      reason: "private_or_special_use",
    });
    expect(calls).toEqual(["https://admin-api.example.com/mcp"]);
  });

  test("trace propagation preserves Fetch header replacement semantics and never adopts caller identity", async () => {
    const captured: Headers[] = [];
    const guarded = guardedMcpFetch(
      testSettings,
      async (_input: Request, init) => {
        captured.push(new Headers(init?.headers));
        return new Response(null, { status: 204 });
      },
      { dnsLookup: async () => [{ address: "1.1.1.1", family: 4 }], pinResolvedDestination: false },
    );
    const request = new Request("https://example.test/mcp", {
      headers: {
        authorization: "Bearer synthetic",
        traceparent: `00-${"c".repeat(32)}-${"d".repeat(16)}-01`,
        tracestate: "secret",
        baggage: "secret",
      },
    });
    await guarded(request);
    await guarded(request, { headers: { "x-test": "replacement" } });
    expect(captured[0]!.get("authorization")).toBe("Bearer synthetic");
    expect(captured[1]!.get("authorization")).toBeNull();
    expect(captured[1]!.get("x-test")).toBe("replacement");
    for (const headers of captured) {
      expect(headers.has("traceparent")).toBe(false);
      expect(headers.has("tracestate")).toBe(false);
      expect(headers.has("baggage")).toBe(false);
    }
    expect(request.headers.has("traceparent")).toBe(true);
  });

  test("exports header and body consumption separately and closes cancellation/failure without replay", async () => {
    const bodies: any[] = [];
    const observer = createObservability(
      {
        serviceName: "test",
        environment: "test",
        observabilityStructuredLogs: true,
        observabilityMetricsEnabled: false,
        observabilityOtlpHeaders: "",
        observabilityOtlpEndpoint: "http://collector",
      },
      {
        component: "worker",
        exporter: async (_url, body) => {
          bodies.push(body);
        },
      },
    );
    const spans = () =>
      bodies.flatMap((b) => b.resourceSpans.flatMap((r: any) => r.scopeSpans[0].spans));
    const attributes = (span: any) =>
      Object.fromEntries(span.attributes.map((a: any) => [a.key, Object.values(a.value)[0]]));
    let sentParent: string | null = null;
    let calls = 0;
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const guarded = guardedMcpFetch(
      testSettings,
      async (_input: string, init) => {
        calls++;
        sentParent = new Headers(init?.headers).get("traceparent");
        return new Response(
          new ReadableStream({
            start(controller) {
              stream = controller;
            },
          }),
        );
      },
      { dnsLookup: async () => [{ address: "1.1.1.1", family: 4 }], pinResolvedDestination: false },
    );
    await withTraceContext(parseTraceparent(`00-${"a".repeat(32)}-${"b".repeat(16)}-00`), () =>
      withMcpTelemetry(observer, "attempt", () =>
        withMcpCallIdentity("call", async () => {
          const response = await guarded("https://example.test/mcp");
          await observer.flush();
          const header = spans().find((s) => s.name === "mcp.phase.network_headers");
          expect(sentParent).toBe(`00-${header.traceId}-${header.spanId}-00`);
          expect(spans().some((s) => s.name === "mcp.phase.network_body")).toBe(false);
          stream.enqueue(new TextEncoder().encode("result-secret"));
          stream.close();
          expect(await response.text()).toBe("result-secret");
          const cancelled = await guarded("https://example.test/mcp");
          await cancelled.body!.cancel("secret-reason");
          const failed = await guarded("https://example.test/mcp");
          const error = new Error("secret-stream-error");
          stream.error(error);
          await expect(failed.text()).rejects.toBe(error);
        }),
      ),
    );
    await observer.flush();
    const bodySpans = spans().filter((s) => s.name === "mcp.phase.network_body");
    expect(bodySpans.map((s) => attributes(s).outcome)).toEqual([
      "completed",
      "cancelled",
      "failed",
    ]);
    expect(new Set(spans().map((s) => attributes(s).mcpCallKey)).size).toBe(1);
    expect(JSON.stringify(spans())).not.toContain("secret");
    expect(calls).toBe(3);
  });

  test("propagates host trace identity without trusting caller trace headers", async () => {
    let seen: Headers | undefined;
    const guarded = guardedMcpFetch(
      testSettings,
      async (_input, init) => {
        seen = new Headers(init?.headers);
        return new Response("ok");
      },
      { dnsLookup: async () => [{ address: "1.1.1.1", family: 4 }], pinResolvedDestination: false },
    );
    await withTraceContext({ traceId: "a".repeat(32), spanId: "b".repeat(16) }, async () => {
      const response = await guarded("https://example.test/mcp", {
        headers: {
          authorization: "Bearer synthetic",
          traceparent: "untrusted",
          baggage: "private=value",
        },
      });
      await response.text();
    });
    expect(seen?.get("traceparent")).toBe(`00-${"a".repeat(32)}-${"b".repeat(16)}-01`);
    expect(seen?.get("authorization")).toBe("Bearer synthetic");
    expect(seen?.has("baggage")).toBe(false);
  });
  test("keeps the outer Agents SDK connect fence at least as large as configured transports", () => {
    expect(mcpOuterConnectTimeoutMs([])).toBe(MCP_DEFAULT_OUTER_CONNECT_TIMEOUT_MS);
    expect(mcpOuterConnectTimeoutMs([5_000, undefined])).toBe(MCP_DEFAULT_OUTER_CONNECT_TIMEOUT_MS);
    expect(mcpOuterConnectTimeoutMs([30_000, 15_000, undefined])).toBe(30_000);
  });

  test("classifies post-401 replay with an explicit fail-closed handshake/list allowlist", async () => {
    const classify = async (body: BodyInit | null) =>
      await mcpRequestReplayInfo("https://example.test/mcp", {
        method: "POST",
        ...(body !== null ? { body } : {}),
      });

    for (const method of ["initialize", "notifications/initialized", "tools/list"]) {
      const request = await classify(JSON.stringify({ jsonrpc: "2.0", id: 1, method }));
      expect(request.replaySafeAfter401).toBe(true);
      expect(request.method).toBe(method);
    }

    const safeBatch = await classify(
      JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "initialize" },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: "list", method: "tools/list" },
      ]),
    );
    expect(safeBatch).toMatchObject({
      replaySafeAfter401: true,
      batch: true,
      responseIds: [1, "list"],
    });

    const malformed = await classify("{");
    const unreadable = await classify(new URLSearchParams({ method: "tools/list" }));
    const unknown = await classify(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "provider/create" }),
    );
    const nonList = await classify(
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "resources/read" }),
    );
    const toolCall = await classify(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "create_issue",
          _meta: { opengeniOperationId: "11111111-1111-4111-8111-111111111111" },
        },
      }),
    );
    const toolCallBatch = await classify(
      JSON.stringify([
        {
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: { name: "create_issue" },
        },
      ]),
    );
    const mixedBatch = await classify(
      JSON.stringify([
        { jsonrpc: "2.0", id: 6, method: "tools/list" },
        {
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: { name: "create_issue" },
        },
      ]),
    );
    for (const request of [
      malformed,
      unreadable,
      unknown,
      nonList,
      toolCall,
      toolCallBatch,
      mixedBatch,
    ]) {
      expect(request.replaySafeAfter401).toBe(false);
    }
    expect(toolCall).toMatchObject({
      batch: false,
      method: "tools/call",
      responseIds: [4],
      toolName: "create_issue",
      operationId: "11111111-1111-4111-8111-111111111111",
    });
    expect(toolCallBatch).toMatchObject({
      batch: true,
      responseIds: [5],
      toolName: "create_issue",
    });
    expect(toolCallBatch.method).toBeUndefined();
    expect(mixedBatch).toMatchObject({
      batch: true,
      responseIds: [6, 7],
      toolName: "create_issue",
    });

    const error = { code: 40_102, message: "outcome uncertain" };
    expect(mcpJsonRpcErrorPayloadForRequest(malformed, error)).toEqual({
      jsonrpc: "2.0",
      id: null,
      error,
    });
    expect(mcpJsonRpcErrorPayloadForRequest(mixedBatch, error)).toEqual([
      { jsonrpc: "2.0", id: 6, error },
      { jsonrpc: "2.0", id: 7, error },
    ]);
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

  test("retains the failed JSON-RPC request phase and exact cause chain without wrapping", async () => {
    const socketFailure = Object.assign(new Error("connect ECONNREFUSED 10.0.0.8:443"), {
      code: "ECONNREFUSED",
    });
    const source = new TypeError("Unable to connect. Is the computer able to access the url?", {
      cause: socketFailure,
    });
    const guarded = guardedMcpFetch(
      testSettings,
      async () => {
        throw source;
      },
      {
        dnsLookup: async () => [{ address: "1.1.1.1", family: 4 }],
        pinResolvedDestination: false,
      },
    );

    let observed: unknown;
    try {
      await guarded("https://example.test/mcp", {
        method: "POST",
        headers: { authorization: "Bearer transport-secret" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    } catch (error) {
      observed = error;
    }

    expect(observed).toBe(source);
    const diagnostic = mcpTransportRequestFailureDiagnostic(observed);
    expect(diagnostic).toEqual({
      httpMethod: "POST",
      rpcMethod: "tools/list",
      causeChain: [
        {
          kind: "error",
          name: "TypeError",
          message: "Unable to connect. Is the computer able to access the url?",
        },
        {
          kind: "error",
          name: "Error",
          message: "connect ECONNREFUSED 10.0.0.8:443",
          code: "ECONNREFUSED",
        },
      ],
      causeChainComplete: true,
    });
    expect(
      mcpTransportRequestFailureDiagnostic(new Error("SDK wrapper", { cause: observed })),
    ).toEqual(diagnostic);
    expect(JSON.stringify(diagnostic)).not.toContain("transport-secret");
    expect(JSON.stringify(diagnostic)).not.toContain("example.test");
  });

  test("records a failed GET transport without inventing a JSON-RPC method", async () => {
    const source = Object.assign(new Error("temporary DNS failure"), { code: "EAI_AGAIN" });
    const guarded = guardedMcpFetch(
      testSettings,
      async () => {
        throw source;
      },
      {
        dnsLookup: async () => [{ address: "1.1.1.1", family: 4 }],
        pinResolvedDestination: false,
      },
    );

    await expect(guarded("https://example.test/mcp")).rejects.toBe(source);
    expect(mcpTransportRequestFailureDiagnostic(source)).toEqual({
      httpMethod: "GET",
      causeChain: [
        {
          kind: "error",
          name: "Error",
          message: "temporary DNS failure",
          code: "EAI_AGAIN",
        },
      ],
      causeChainComplete: true,
    });
  });

  test("bounds cyclic transport cause chains and reports the incomplete snapshot", async () => {
    const source = new Error("cyclic transport failure");
    source.cause = source;
    const guarded = guardedMcpFetch(
      testSettings,
      async () => {
        throw source;
      },
      {
        dnsLookup: async () => [{ address: "1.1.1.1", family: 4 }],
        pinResolvedDestination: false,
      },
    );

    await expect(guarded("https://example.test/mcp")).rejects.toBe(source);
    expect(mcpTransportRequestFailureDiagnostic(source)).toEqual({
      httpMethod: "GET",
      causeChain: [
        {
          kind: "error",
          name: "Error",
          message: "cyclic transport failure",
        },
      ],
      causeChainComplete: false,
    });
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
    const rich = {
      name: "nested_schema",
      inputSchema: { type: "object", description: "x".repeat(300 * 1024) },
    };
    expect(assertMcpToolListWithinBounds([rich])).toEqual([rich]);
    expect(() =>
      assertMcpToolListWithinBounds([{ schema: "x".repeat(MCP_MAX_TOOL_DEFINITION_BYTES) }]),
    ).toThrow(McpPayloadTooLargeError);
    expect(() =>
      assertMcpPayloadWithinBytes(
        { content: "x".repeat(MCP_MAX_TOOL_RESULT_BYTES) },
        MCP_MAX_TOOL_RESULT_BYTES,
        "MCP tool result",
      ),
    ).toThrow(McpPayloadTooLargeError);
  });

  test("bounds inbound request bodies before SDK parsing", async () => {
    expect(MCP_MAX_INBOUND_REQUEST_BYTES).toBeGreaterThan(CODEMODE_ARGUMENTS_MAX_BYTES);

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

  test("one provider can use the existing aggregate entry allowance without truncation", () => {
    const tools = Array.from({ length: MCP_MAX_AGGREGATE_TOOL_LIST_ENTRIES }, (_, index) => ({
      name: `tool_${index}`,
    }));
    expect(assertMcpToolListWithinBounds(tools)).toBe(tools);
    const budget = new McpAggregateToolListBudget();
    expect(budget.replace("large-provider", tools)).toBe(tools);
    expect(budget.snapshot().entries).toBe(tools.length);
    expect(budget.replace("large-provider", tools)).toBe(tools);
    expect(() => budget.replace("another-provider", [{ name: "extra" }])).toThrow(
      McpPayloadTooLargeError,
    );
    expect(budget.snapshot().entries).toBe(tools.length);
    expect(() => assertMcpToolListWithinBounds([...tools, { name: "extra" }])).toThrow(
      "4096-entry safety limit",
    );
    expect(() =>
      assertMcpToolListWithinBounds(
        Array.from({ length: 50 }, (_, index) => ({
          name: `large_${index}`,
          description: "x".repeat(100_000),
        })),
      ),
    ).toThrow(McpPayloadTooLargeError);
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

describe("tool lists over a limit are trimmed, never fatal", () => {
  const tools = (count: number, prefix = "tool") =>
    Array.from({ length: count }, (_, index) => ({
      name: `${prefix}_${String(index).padStart(4, "0")}`,
    }));

  test("a list over the entry limit keeps tools by name, with keepFirst tools ahead", () => {
    const listed = tools(MCP_MAX_AGGREGATE_TOOL_LIST_ENTRIES + 2);
    const pinned = listed.at(-1)!.name;
    const fitted = fitMcpToolListWithinBounds(listed, {
      keepFirst: (tool) => tool.name === pinned,
    });
    expect(fitted.tools).toHaveLength(MCP_MAX_AGGREGATE_TOOL_LIST_ENTRIES);
    // Listing order is kept; the pinned tool is in, the last unpinned names are out.
    expect(fitted.tools.at(-1)!.name).toBe(pinned);
    expect(fitted.dropped).toEqual([
      { name: "tool_4095", reason: "list_entry_limit" },
      { name: "tool_4096", reason: "list_entry_limit" },
    ]);
  });

  test("the kept set does not depend on the order a provider lists its tools in", () => {
    const listed = tools(MCP_MAX_AGGREGATE_TOOL_LIST_ENTRIES + 50);
    const shuffled = [...listed].sort(() => Math.random() - 0.5);
    const kept = (list: typeof listed) =>
      fitMcpToolListWithinBounds(list)
        .tools.map((tool) => tool.name)
        .sort();
    expect(kept(shuffled)).toEqual(kept(listed));
    expect(kept([...listed].reverse())).toEqual(kept(listed));
  });

  test("an oversized definition is dropped alone and the byte limit is exact", () => {
    const huge = { name: "huge", description: "x".repeat(MCP_MAX_TOOL_DEFINITION_BYTES) };
    const small = tools(3);
    const exact = Buffer.byteLength(JSON.stringify(small.slice(0, 2)));
    const fitted = fitMcpToolListWithinBounds([small[0]!, huge, small[1]!, small[2]!], {
      maxBytes: exact,
    });
    expect(fitted.tools).toEqual(small.slice(0, 2));
    expect(Buffer.byteLength(JSON.stringify(fitted.tools))).toBe(exact);
    expect(fitted.dropped).toEqual([
      { name: "huge", reason: "definition_too_large" },
      { name: "tool_0002", reason: "list_byte_limit" },
    ]);
    expect(describeMcpToolListDrops(fitted.dropped)).toBe(
      "connected, but 2 of its tools are unavailable this turn (1 because their definitions are too large or unreadable; 1 because the integration lists more tools than one turn can hold), for example huge, tool_0002. Its other tools work.",
    );
  });

  test("the aggregate budget gives a later server what is left instead of throwing", () => {
    const budget = new McpAggregateToolListBudget("test aggregate", 5, Number.MAX_SAFE_INTEGER);
    expect(budget.admit("one", tools(3, "one")).dropped).toEqual([]);
    const second = budget.admit("two", tools(4, "two"));
    expect(second.tools.map((tool) => tool.name)).toEqual(["two_0000", "two_0001"]);
    expect(second.dropped.map((drop) => drop.reason)).toEqual([
      "aggregate_entry_limit",
      "aggregate_entry_limit",
    ]);
    expect(budget.snapshot().entries).toBe(5);
    // A relist replaces the source's own contribution rather than ratcheting.
    expect(budget.admit("two", tools(4, "two")).tools).toHaveLength(2);
    budget.remove("one");
    expect(budget.admit("two", tools(4, "two")).tools).toHaveLength(4);
  });

  test("a model name another server already lists is left out; first listing wins", () => {
    const budget = new McpAggregateToolListBudget();
    budget.admit("local", [{ name: "a__b__c" }, { name: "local_only" }]);
    const later = budget.admit("connector", [{ name: "a__b__c" }, { name: "connector_only" }]);
    expect(later.tools).toEqual([{ name: "connector_only" }]);
    expect(later.dropped).toEqual([{ name: "a__b__c", reason: "model_name_taken" }]);
    // The same source relisting keeps its own names.
    expect(budget.admit("local", [{ name: "a__b__c" }]).tools).toEqual([{ name: "a__b__c" }]);
    // Removing the owner releases its names.
    budget.remove("local");
    expect(budget.admit("connector", [{ name: "a__b__c" }]).tools).toEqual([{ name: "a__b__c" }]);
  });

  test("ordered admission keeps the same tools whichever server finishes listing first", async () => {
    const run = async (lateFirst: boolean) => {
      const budget = new McpAggregateToolListBudget("ordered", 3, Number.MAX_SAFE_INTEGER);
      budget.sequence(["early", "late"]);
      const early = async () => {
        if (lateFirst) await new Promise((resolve) => setTimeout(resolve, 20));
        return budget.admitInOrder("early", [{ name: "shared" }, { name: "e1" }]);
      };
      const late = () =>
        budget.admitInOrder("late", [{ name: "shared" }, { name: "l1" }, { name: "l2" }]);
      const [first, second] = await Promise.all([early(), late()]);
      return { early: first.tools, late: second.tools, dropped: second.dropped };
    };
    const expected = {
      early: [{ name: "shared" }, { name: "e1" }],
      late: [{ name: "l1" }],
      dropped: [
        { name: "shared", reason: "model_name_taken" },
        { name: "l2", reason: "aggregate_entry_limit" },
      ],
    };
    expect(await run(false)).toEqual(expected);
    expect(await run(true)).toEqual(expected);
  });

  test("a waiting server starts an earlier server's listing instead of waiting idle", async () => {
    const budget = new McpAggregateToolListBudget();
    let started = 0;
    budget.sequence([
      {
        sourceId: "earlier",
        start: () => {
          started += 1;
          budget.admit("earlier", [{ name: "e" }]);
        },
      },
      "later",
    ]);
    const fitted = await budget.admitInOrder("later", [{ name: "l" }], {}, 60_000);
    expect(fitted.tools).toEqual([{ name: "l" }]);
    expect(started).toBe(1);
    // A settled predecessor is not started again.
    await budget.admitInOrder("later", [{ name: "l" }], {}, 60_000);
    expect(started).toBe(1);
  });

  test("ordered admission stops waiting on a predecessor that is removed or never settles", async () => {
    const budget = new McpAggregateToolListBudget();
    budget.sequence(["gone", "stuck", "next"]);
    budget.remove("gone");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fitted = await budget.admitInOrder("next", [{ name: "x" }], {}, 10);
      expect(fitted.tools).toEqual([{ name: "x" }]);
      expect(warn.mock.calls[0]![1]).toMatchObject({ code: "admission_order_timeout" });
    } finally {
      warn.mockRestore();
    }
  });

  test("size refusals are recognised through wrapped causes", () => {
    const refusal = new McpPayloadTooLargeError("MCP response", 9, 8);
    expect(isMcpPayloadTooLargeError(refusal)).toBe(true);
    expect(isMcpPayloadTooLargeError(new Error("wrapped", { cause: refusal }))).toBe(true);
    expect(isMcpPayloadTooLargeError(new Error("other"))).toBe(false);
  });
});
