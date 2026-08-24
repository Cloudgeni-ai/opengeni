import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { readAutomationWebhookBody } from "../src/routes/automations";

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function startBodyReader(maxBytes: number) {
  const app = new Hono();
  app.use("*", bodyLimit({ maxSize: 1024 * 1024 }));
  app.post("/", async (context) => {
    try {
      const body = await readAutomationWebhookBody(context.req.raw, maxBytes);
      return Response.json({ body: new TextDecoder().decode(body) });
    } catch (error) {
      const status = error instanceof HTTPException ? error.status : 500;
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        {
          status,
        },
      );
    }
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: app.fetch,
  });
  servers.push(server);
  return server;
}

describe("automation webhook body ingestion", () => {
  test("reads a real Bun inbound request without assuming releaseLock exists", async () => {
    const server = startBodyReader(1024);
    const response = await fetch(`http://127.0.0.1:${server.port}`, {
      method: "POST",
      body: JSON.stringify({ action: "reopened" }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ body: '{"action":"reopened"}' });
  });

  test("retains the route-specific streaming size fence", async () => {
    const server = startBodyReader(4);
    const response = await fetch(`http://127.0.0.1:${server.port}`, {
      method: "POST",
      body: "12345",
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "automation webhook payload is too large" });
  });
});
