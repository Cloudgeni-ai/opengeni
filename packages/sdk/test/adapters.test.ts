import { describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { toNodeMiddleware, type NodeRequestLike } from "../src/adapters/express";
import { toHonoHandler } from "../src/adapters/hono";
import { createSessionProxyRoute, toNextRouteHandlers } from "../src/adapters/next";
import { OpenGeniClient } from "../src/index";
import { SESSION_ID, WORKSPACE_ID } from "./helpers";

function echoHandler(seen: Request[]) {
  return async (request: Request) => {
    seen.push(request);
    const body = request.method === "GET" ? "" : await request.text();
    return Response.json(
      { method: request.method, url: request.url, body },
      { headers: { "x-test": "1" } },
    );
  };
}

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("framework adapters", () => {
  test("Next.js: one handler for every method, full URL including basePath", async () => {
    const seen: Request[] = [];
    const routes = toNextRouteHandlers(echoHandler(seen));
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"] as const) {
      const response = await routes[method](
        new Request("https://app.example/base/api/opengeni/v1/config/client", {
          method,
          ...(method === "GET" ? {} : { body: "{}" }),
        }),
      );
      expect((await response.json()).method).toBe(method);
    }
    expect(seen).toHaveLength(5);
  });

  test("Next.js: createSessionProxyRoute proxies under a basePath", async () => {
    const upstream: string[] = [];
    const og = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      apiKey: "k",
      fetch: async (input) => {
        upstream.push(String(input));
        return Response.json({ id: SESSION_ID });
      },
    });
    const { GET } = createSessionProxyRoute(og, {
      resolve: () => ({ workspaceId: WORKSPACE_ID, user: "u_1" }),
    });
    const response = await GET(
      new Request(
        `https://app.example/base/api/opengeni/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}`,
      ),
    );
    expect(response.status).toBe(200);
    expect(upstream).toEqual([
      `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}`,
    ]);
  });

  test("Hono: forwards the raw request", async () => {
    const seen: Request[] = [];
    const handler = toHonoHandler(echoHandler(seen));
    const raw = new Request("https://app.example/api/opengeni/v1/config/client");
    await handler({ req: { raw } });
    expect(seen[0]).toBe(raw);
  });

  test("Express/Connect: original URL, streamed body, headers, and pre-parsed bodies", async () => {
    const seen: Request[] = [];
    const middleware = toNodeMiddleware(echoHandler(seen));
    const server = await listen((request, response) => {
      const req = request as NodeRequestLike;
      // Express strips the mount path from req.url and keeps originalUrl.
      req.originalUrl = req.url;
      req.url = req.url!.replace(/^\/api\/opengeni/, "");
      if (req.headers["x-preparsed"]) {
        let text = "";
        req.on("data", (chunk) => (text += chunk));
        req.on("end", () => {
          req.body = JSON.parse(text);
          middleware(req, response);
        });
        return;
      }
      middleware(req, response);
    });
    try {
      const streamed = await fetch(`${server.origin}/api/opengeni/v1/workspaces/x/steer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hi" }),
      });
      expect(streamed.headers.get("x-test")).toBe("1");
      const streamedBody = await streamed.json();
      expect(new URL(streamedBody.url).pathname).toBe("/api/opengeni/v1/workspaces/x/steer");
      expect(JSON.parse(streamedBody.body)).toEqual({ text: "hi" });

      const parsed = await fetch(`${server.origin}/api/opengeni/v1/x`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-preparsed": "1" },
        body: JSON.stringify({ text: "parsed" }),
      });
      expect(JSON.parse((await parsed.json()).body)).toEqual({ text: "parsed" });
    } finally {
      await server.close();
    }
  });

  test("Express/Connect: SSE streams progressively and a disconnect aborts the request", async () => {
    const state = { aborted: false };
    const middleware = toNodeMiddleware(async (request) => {
      request.signal.addEventListener("abort", () => (state.aborted = true), { once: true });
      const encoder = new TextEncoder();
      let sent = false;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull: async (controller) => {
            if (!sent) {
              sent = true;
              controller.enqueue(encoder.encode("data: first\n\n"));
              return;
            }
            await new Promise(() => {}); // stream stays open
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const server = await listen((request, response) => middleware(request, response));
    try {
      const controller = new AbortController();
      const response = await fetch(`${server.origin}/api/opengeni/v1/stream`, {
        signal: controller.signal,
      });
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toBe("data: first\n\n");
      controller.abort();
      await reader.cancel().catch(() => undefined);
      for (let attempt = 0; attempt < 50 && !state.aborted; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(state.aborted).toBe(true);
    } finally {
      await server.close();
    }
  });
});
