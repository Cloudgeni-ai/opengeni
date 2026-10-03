import { describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { toNodeMiddleware, type NodeRequestLike } from "../src/adapters/express";
import { toHonoHandler } from "../src/adapters/hono";
import { createSessionProxyRoute, toNextRouteHandlers } from "../src/adapters/next";
import {
  OpenGeniClient,
  createSessionProxyHandler,
  type SessionProxyHandlerOptions,
  type SessionProxyMessageInput,
} from "../src/index";
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

  for (const adapter of ["Next.js", "Express/Connect", "Hono"] as const) {
    for (const action of [
      {
        label: "approval",
        event: {
          type: "user.approvalDecision",
          clientEventId: "approval-retry",
          payload: { approvalId: "tool-call-1", decision: "approve", message: "Proceed" },
        },
      },
      {
        label: "human-input",
        event: {
          type: "user.humanInputResponse",
          clientEventId: "human-input-retry",
          payload: { requestId: "request-1", response: { outcome: "skipped" } },
        },
      },
    ] as const) {
      test(`${adapter}: ${action.label} refresh, browser rejection, and hook refusal`, async () => {
        const upstream: Array<{ path: string; body: unknown; headers: Headers }> = [];
        const inputs: SessionProxyMessageInput[] = [];
        const updates = [{ id: "crm", headers: { Authorization: "test-rotation" } }];
        let refuse = false;
        const og = new OpenGeniClient({
          baseUrl: "https://api.example.test",
          apiKey: "k",
          fetch: async (input, init) => {
            const request = new Request(input, init);
            upstream.push({
              path: new URL(request.url).pathname,
              body: await request.json(),
              headers: request.headers,
            });
            return Response.json({ id: SESSION_ID });
          },
        });
        const options: SessionProxyHandlerOptions = {
          resolve: () => ({ workspaceId: WORKSPACE_ID, user: "u_1", source: "product" }),
          beforeForwardMessage: async (input, context) => {
            inputs.push(input);
            if (input.delivery !== "send") return;
            expect(context.user).toBe("u_1");
            expect(context.workspaceId).toBe(WORKSPACE_ID);
            expect(context.source).toBe("product");
            return refuse
              ? new Response("Reauthenticate", {
                  status: 401,
                  headers: { "x-host-auth": "required" },
                })
              : { mcpCredentialUpdates: updates, modelContext: "Messages only" };
          },
        };
        let origin = "https://app.example";
        let close: (() => Promise<void>) | undefined;
        let dispatch: (request: Request) => Promise<Response>;
        if (adapter === "Next.js") {
          dispatch = createSessionProxyRoute(og, options).POST;
        } else if (adapter === "Hono") {
          const handler = toHonoHandler(createSessionProxyHandler(og, options));
          dispatch = (raw) => handler({ req: { raw } });
        } else {
          const middleware = toNodeMiddleware(createSessionProxyHandler(og, options));
          const server = await listen((request, response) => {
            const req = request as NodeRequestLike;
            req.originalUrl = req.url;
            req.url = req.url!.replace(/^\/base\/api\/opengeni/, "");
            if (req.headers["x-preparsed"]) {
              let text = "";
              req.on("data", (chunk) => (text += chunk));
              req.on("end", () => {
                req.body = JSON.parse(text);
                middleware(req, response);
              });
            } else {
              middleware(req, response);
            }
          });
          origin = server.origin;
          close = server.close;
          dispatch = (request) => fetch(request);
        }
        const post = (body: unknown, preparsed = false) =>
          dispatch(
            new Request(
              `${origin}/base/api/opengeni/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/events`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  ...(preparsed ? { "x-preparsed": "1" } : {}),
                },
                body: JSON.stringify(body),
              },
            ),
          );
        try {
          for (const preparsed of adapter === "Express/Connect" ? [false, true] : [false]) {
            const response = await post(action.event, preparsed);
            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({ id: SESSION_ID });
            expect(upstream.at(-1)!.path).toBe(
              `/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/events`,
            );
            expect(upstream.at(-1)!.headers.get("x-opengeni-external-actor")).not.toBeNull();
            expect(upstream.at(-1)!.body).toEqual({
              ...action.event,
              payload: { ...action.event.payload, mcpCredentialUpdates: updates },
            });
          }
          const forwarded = upstream.length;
          expect(inputs).toEqual(
            Array.from({ length: forwarded }, () => ({
              sessionId: SESSION_ID,
              delivery: "send",
            })),
          );

          const rejected = await post({
            ...action.event,
            payload: { ...action.event.payload, mcpCredentialUpdates: [] },
          });
          expect(rejected.status).toBe(403);
          expect((await rejected.json()).error.code).toBe("credential_update_not_allowed");
          expect(inputs).toHaveLength(forwarded);
          expect(upstream).toHaveLength(forwarded);

          refuse = true;
          const refused = await post(action.event);
          expect(refused.status).toBe(401);
          expect(refused.headers.get("x-host-auth")).toBe("required");
          expect(await refused.text()).toBe("Reauthenticate");
          expect(inputs).toHaveLength(forwarded + 1);
          expect(upstream).toHaveLength(forwarded);
        } finally {
          await close?.();
        }
      });
    }
  }
});
