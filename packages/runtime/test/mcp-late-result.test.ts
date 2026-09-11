import { expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { testSettings } from "@opengeni/testing";
import { z } from "zod";
import { prepareAgentTools } from "../src/index";
import { observeMcpOperation } from "../src/mcp-operation-observation";
import { digestCanonicalJson } from "@opengeni/tool-gateway";

test("timed-out mutation can commit later; reconnect observes its receipt without replay", async () => {
  const operationId = "11111111-1111-4111-8111-111111111111";
  const argumentsValue = { operationId, value: "synthetic-value" };
  const argumentDigest = digestCanonicalJson(argumentsValue);
  const binding = {
    operationId,
    serverId: "operations",
    originalTool: "commit_value",
    observerTool: "observe_operation",
    argumentDigest,
  };
  let release!: () => void;
  let started!: () => void;
  let committed!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const executing = new Promise<void>((resolve) => {
    started = resolve;
  });
  const complete = new Promise<void>((resolve) => {
    committed = resolve;
  });
  const receipts = new Map<string, { value: string }>();
  let mutations = 0;
  let observations = 0;
  const transports: WebStandardStreamableHTTPServerTransport[] = [];
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const server = new McpServer({ name: "synthetic-operation-provider", version: "1.0.0" });
      server.registerTool(
        "commit_value",
        {
          inputSchema: { operationId: z.string().uuid(), value: z.string() },
          annotations: { idempotentHint: true },
        },
        async (input) => {
          mutations++;
          started();
          await gate;
          receipts.set(input.operationId, { value: input.value });
          committed();
          return {
            content: [{ type: "text", text: JSON.stringify(receipts.get(input.operationId)) }],
          };
        },
      );
      server.registerTool(
        "observe_operation",
        {
          inputSchema: {
            version: z.literal(1),
            operationRef: z.string().uuid(),
            originalTool: z.literal("commit_value"),
            fingerprint: z.object({
              version: z.literal(1),
              algorithm: z.literal("sha256"),
              value: z.string(),
            }),
          },
          annotations: { readOnlyHint: true },
        },
        async (input) => {
          observations++;
          const result = receipts.get(input.operationRef);
          const identity = {
            version: 1,
            operationRef: input.operationRef,
            fingerprint: input.fingerprint,
          };
          return {
            content: [],
            structuredContent: {
              ...identity,
              ...(input.fingerprint.value !== argumentDigest
                ? { status: "conflict" }
                : result
                  ? {
                      status: "completed",
                      receiptRevision: "committed-1",
                      result: { content: [{ type: "text", text: JSON.stringify(result) }] },
                    }
                  : { status: "unknown" }),
            },
          };
        },
      );
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      transports.push(transport);
      await server.connect(transport);
      return transport.handleRequest(request);
    },
  });
  const prepare = () =>
    prepareAgentTools(
      testSettings({
        mcpServers: [
          {
            id: "operations",
            url: `http://127.0.0.1:${provider.port}/mcp`,
            cacheToolsList: false,
            timeoutMs: 100,
          },
        ],
      }),
      [{ kind: "mcp", id: "operations" }],
    );
  const first = await prepare();
  let second: Awaited<ReturnType<typeof prepare>> | undefined;
  try {
    const remote = first.mcpServers[0]!;
    await remote.listTools();
    const pending = remote.callTool("operations__commit_value", argumentsValue);
    const rejection = expect(pending).rejects.toMatchObject({ code: ErrorCode.RequestTimeout });
    await executing;
    await rejection;
    expect(receipts.size).toBe(0);
    expect(mutations).toBe(1);
    // The transaction-owned receipt is invisible until commit. Its absence
    // cannot distinguish an in-flight operation from one never submitted.
    const observe = (server: typeof remote, ref = operationId) =>
      observeMcpOperation({
        binding: { ...binding, operationId: ref },
        // Synthetic authorization only; production authority integration is
        // tested separately and cannot be established by this fixture.
        authorize: async () => true,
        callObserver: (tool, args) => server.callTool(`operations__${tool}`, args),
      });
    const inFlight = await observe(remote);
    expect(inFlight.status).toBe("unknown");
    const neverSubmitted = await observe(remote, "22222222-2222-4222-8222-222222222222");
    expect(neverSubmitted.status).toBe("unknown");
    expect(receipts.size).toBe(0);
    expect(mutations).toBe(1);
    release();
    await complete;
    await first.close();
    second = await prepare();
    const observer = second.mcpServers[0]!;
    await observer.listTools();
    const result = await observe(observer);
    expect(JSON.stringify(result)).toContain("synthetic-value");
    expect(observations).toBe(3);
    // Re-observation is not a second effect, even on a new connection.
    expect(await observe(observer)).toEqual(result);
    expect(observations).toBe(4);
    expect(mutations).toBe(1);
  } finally {
    release();
    await second?.close();
    await first.close();
    for (const transport of transports) await transport.close();
    provider.stop(true);
  }
}, 10_000);
