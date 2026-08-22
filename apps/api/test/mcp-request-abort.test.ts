import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import * as z4 from "zod/v4";
import { handleMcpRequestWithClientAbort } from "../src/mcp/request-abort";

/**
 * Empirical check of the only cancellation path a per-request MCP transport
 * can observe: Bun fires the Hono request's `Request.signal` when the HTTP
 * client disconnects, and closing the transport aborts the in-flight tool
 * handler's `extra.signal`.
 */

type HandlerObservation = {
  started: Promise<void>;
  signalAborted: Promise<boolean>;
};

let server: ReturnType<typeof Bun.serve>;
let origin = "";
let observation: HandlerObservation | null = null;
let announceObservation: () => void = () => undefined;
let aborted = false;

function buildMcp(): McpServer {
  const mcp = new McpServer({ name: "abort-test", version: "1.0.0" });
  mcp.registerTool(
    "blocking_wait",
    { description: "blocks until aborted or 20 s", inputSchema: { ms: z4.number().int() } },
    async ({ ms }, extra) => {
      let markStarted: () => void = () => undefined;
      let markAborted: (value: boolean) => void = () => undefined;
      observation = {
        started: new Promise<void>((resolve) => {
          markStarted = resolve;
        }),
        signalAborted: new Promise<boolean>((resolve) => {
          markAborted = resolve;
        }),
      };
      markStarted();
      announceObservation();
      const outcome = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), ms);
        extra.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve(true);
          },
          { once: true },
        );
      });
      aborted = outcome;
      markAborted(outcome);
      return { content: [{ type: "text" as const, text: JSON.stringify({ aborted: outcome }) }] };
    },
  );
  return mcp;
}

beforeAll(() => {
  const app = new Hono();
  app.all("/mcp", async (c) => {
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    const mcp = buildMcp();
    await mcp.connect(transport);
    return await handleMcpRequestWithClientAbort(transport, c.req.raw, c.req.raw.signal);
  });
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  origin = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
});

async function post(body: unknown, signal?: AbortSignal): Promise<Response> {
  return await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

describe("first-party MCP request abort", () => {
  test("client disconnect aborts the in-flight tool handler's extra.signal", async () => {
    const controller = new AbortController();
    observation = null;
    aborted = false;
    const observed = new Promise<void>((resolve) => {
      announceObservation = resolve;
    });
    const pending = post(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "blocking_wait", arguments: { ms: 20_000 } },
      },
      controller.signal,
    ).catch((error: unknown) => error);
    await Promise.race([
      observed,
      Bun.sleep(5_000).then(() => {
        throw new Error("tool handler never started");
      }),
    ]);
    expect(observation).not.toBeNull();
    await observation!.started;
    const startedAt = Date.now();
    controller.abort();
    const clientResult = await pending;
    expect(clientResult).toBeInstanceOf(Error);
    expect(await observation!.signalAborted).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(aborted).toBe(true);
  }, 30_000);

  test("a completed call still returns its JSON result", async () => {
    const response = await post({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "blocking_wait", arguments: { ms: 10 } },
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      result: { content: Array<{ text: string }> };
    };
    expect(JSON.parse(payload.result.content[0]!.text)).toEqual({ aborted: false });
  });
});
