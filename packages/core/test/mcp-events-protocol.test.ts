import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  type FakeMcpEventsServer,
  type FakeMcpEventsServerOptions,
  startFakeMcpEventsServer,
} from "@opengeni/testing/mcp-events-server";
import {
  classifyMcpEventsError,
  classifyMcpEventsProtocolError,
  encodeMcpHeaderValue,
  listMcpEventTypes,
  MCP_EVENTS_CLIENT_CAPABILITIES,
  pollMcpEvents,
  readMcpWebhookBody,
  serverOffersMcpEvents,
  subscribeMcpEvents,
  unsubscribeMcpEvents,
  withMcpEventNameHeader,
} from "../src/domain/event-triggers/mcp-events-protocol";
import {
  connectMcpStreamableHttpClient,
  type McpStreamableHttpClient,
} from "../src/domain/mcp-streamable-http-client";

const servers: FakeMcpEventsServer[] = [];
const clients: McpStreamableHttpClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const server of servers.splice(0)) await server.stop();
});

const OPTIONS = { timeout: 5_000 };
const ISSUE_OPENED = {
  name: "issue.opened",
  description: "An issue was opened.",
  delivery: ["poll" as const, "webhook" as const],
  inputSchema: {
    type: "object",
    properties: { project: { type: "string" } },
    additionalProperties: false,
  },
  payloadSchema: { type: "object", properties: { title: { type: "string" } } },
};
const PUSH_ONLY = { name: "deploy.finished", delivery: ["push" as const] };

function start(options: Partial<FakeMcpEventsServerOptions> = {}): FakeMcpEventsServer {
  const server = startFakeMcpEventsServer({ eventTypes: [ISSUE_OPENED, PUSH_ONLY], ...options });
  servers.push(server);
  return server;
}

async function connect(
  server: FakeMcpEventsServer,
  headers: Record<string, string> = {},
): Promise<McpStreamableHttpClient> {
  const client = await connectMcpStreamableHttpClient({
    url: server.url,
    clientName: "events-test",
    clientVersion: "1.0.0",
    timeoutMs: 5_000,
    requestInit: { headers },
    fetch: withMcpEventNameHeader(fetch),
    capabilities: MCP_EVENTS_CLIENT_CAPABILITIES,
  });
  clients.push(client);
  return client;
}

function stream(project = "core") {
  return { name: "issue.opened", arguments: { project } };
}

describe("discovery", () => {
  test("a server that advertises the extension lists its event types", async () => {
    const client = await connect(start());
    expect(serverOffersMcpEvents(client)).toBe(true);
    const types = await listMcpEventTypes(client, OPTIONS);
    expect(types.map((type) => [type.name, type.delivery])).toEqual([
      ["issue.opened", ["poll", "webhook"]],
      ["deploy.finished", ["push"]],
    ]);
    expect(types[0]?.inputSchema).toEqual(ISSUE_OPENED.inputSchema);
  });

  test("a server without the extension is recognized", async () => {
    const client = await connect(start({ advertiseEvents: false }));
    expect(serverOffersMcpEvents(client)).toBe(false);
  });
});

describe("polling", () => {
  test("bootstraps a cursor, then delivers matching events in order", async () => {
    const server = start({ nextPollMs: 12_000 });
    const client = await connect(server);
    await server.emit("issue.opened", { project: "core", title: "before" });

    const first = await pollMcpEvents(
      client,
      { ...stream(), cursor: null, maxEvents: 10, maxAgeMs: 60_000 },
      OPTIONS,
    );
    expect(first.events).toEqual([]);
    expect(first.cursor).toBe("c1");
    expect(first.nextPollMs).toBe(12_000);
    // maxAgeMs is meaningless without a cursor, so it is not sent.
    expect(server.requestsFor("events/poll")[0]?.params).not.toHaveProperty("maxAgeMs");

    await server.emit("issue.opened", { project: "core", title: "one" });
    await server.emit("issue.opened", { project: "web", title: "elsewhere" });
    await server.emit("issue.opened", { project: "core", title: "two" });
    const second = await pollMcpEvents(
      client,
      { ...stream(), cursor: first.cursor, maxEvents: 10, maxAgeMs: 60_000 },
      OPTIONS,
    );
    expect(second.events.map((event) => event.data.title)).toEqual(["one", "two"]);
    expect(second.rawEvents).toHaveLength(2);
    expect(second.skipped).toBe(0);
    expect(second.truncated).toBe(false);
    expect(second.cursor).toBe("c4");
    expect(server.requestsFor("events/poll")[1]?.params.maxAgeMs).toBe(60_000);
  });

  test("pages with hasMore", async () => {
    const server = start();
    const client = await connect(server);
    const { cursor } = await pollMcpEvents(
      client,
      { ...stream(), cursor: null, maxEvents: 1, maxAgeMs: 60_000 },
      OPTIONS,
    );
    await server.emit("issue.opened", { project: "core", title: "one" });
    await server.emit("issue.opened", { project: "core", title: "two" });
    const page = await pollMcpEvents(
      client,
      { ...stream(), cursor, maxEvents: 1, maxAgeMs: 60_000 },
      OPTIONS,
    );
    expect(page.events.map((event) => event.data.title)).toEqual(["one"]);
    expect(page.hasMore).toBe(true);
    const rest = await pollMcpEvents(
      client,
      { ...stream(), cursor: page.cursor, maxEvents: 1, maxAgeMs: 60_000 },
      OPTIONS,
    );
    expect(rest.events.map((event) => event.data.title)).toEqual(["two"]);
    expect(rest.hasMore).toBe(false);
  });

  test("reports truncation when history before the cursor has expired", async () => {
    const server = start();
    const client = await connect(server);
    const { cursor } = await pollMcpEvents(
      client,
      { ...stream(), cursor: null, maxEvents: 10, maxAgeMs: 60_000 },
      OPTIONS,
    );
    await server.emit("issue.opened", { project: "core", title: "lost" });
    server.expireHistory();
    await server.emit("issue.opened", { project: "core", title: "kept" });
    const page = await pollMcpEvents(
      client,
      { ...stream(), cursor, maxEvents: 10, maxAgeMs: 60_000 },
      OPTIONS,
    );
    expect(page.truncated).toBe(true);
    expect(page.events.map((event) => event.data.title)).toEqual(["kept"]);
  });

  test("sends Mcp-Name on named requests, encoding names that are not plain ASCII", async () => {
    const server = start({
      eventTypes: [ISSUE_OPENED, { name: "café.opened", delivery: ["poll"] }],
    });
    const client = await connect(server);
    await listMcpEventTypes(client, OPTIONS);
    await pollMcpEvents(
      client,
      { ...stream(), cursor: null, maxEvents: 1, maxAgeMs: 60_000 },
      OPTIONS,
    );
    await pollMcpEvents(
      client,
      { name: "café.opened", arguments: {}, cursor: null, maxEvents: 1, maxAgeMs: 60_000 },
      OPTIONS,
    );
    expect(server.requestsFor("events/list")[0]?.mcpName).toBeNull();
    expect(server.requestsFor("events/poll").map((request) => request.mcpName)).toEqual([
      "issue.opened",
      `=?base64?${Buffer.from("café.opened").toString("base64")}?=`,
    ]);
  });
});

describe("webhook subscriptions", () => {
  test("subscribe answers verification, delivers events and unsubscribes", async () => {
    const received: Array<{ headers: Headers; body: string }> = [];
    const server = start({
      maxTtlMs: 60_000,
      webhookFetch: async (_url, init) => {
        const body = String(init.body);
        const headers = new Headers(init.headers);
        received.push({ headers, body });
        const message = readMcpWebhookBody(new TextEncoder().encode(body));
        return message.kind === "verification"
          ? Response.json({ challenge: message.challenge })
          : new Response(null, { status: 202 });
      },
    });
    const client = await connect(server);
    const url = "https://receiver.example/hooks/one";
    const secret = `whsec_${randomBytes(24).toString("base64")}`;
    const result = await subscribeMcpEvents(
      client,
      { ...stream(), url, secret, cursor: null, maxAgeMs: 60_000, ttlMs: 86_400_000 },
      OPTIONS,
    );
    expect(result.id).toMatch(/^sub_/u);
    expect(result.refreshBefore!.getTime() - Date.now()).toBeLessThanOrEqual(60_000);
    expect(result.cursor).toBe("c0");
    expect(received.map((post) => readMcpWebhookBody(Buffer.from(post.body)).kind)).toEqual([
      "verification",
    ]);
    expect(server.requestsFor("events/subscribe")[0]?.mcpName).toBe("issue.opened");

    await server.emit("issue.opened", { project: "core", title: "hello" });
    const delivered = readMcpWebhookBody(Buffer.from(received.at(-1)!.body));
    expect(delivered.kind).toBe("event");
    expect(received.at(-1)!.headers.get("x-mcp-subscription-id")).toBe(result.id);

    // Refreshing keeps the same id and does not verify again.
    const again = await subscribeMcpEvents(
      client,
      { ...stream(), url, secret, cursor: result.cursor, maxAgeMs: 60_000, ttlMs: 86_400_000 },
      OPTIONS,
    );
    expect(again.id).toBe(result.id);
    expect(received.filter((post) => post.body.includes("verification"))).toHaveLength(1);

    await unsubscribeMcpEvents(client, { ...stream(), url }, OPTIONS);
    expect(server.subscriptions.size).toBe(0);
  });

  test("a receiver that fails verification is reported as unreachable", async () => {
    const server = start({ webhookFetch: async () => new Response("nope", { status: 404 }) });
    const client = await connect(server);
    const failure = await subscribeMcpEvents(
      client,
      {
        ...stream(),
        url: "https://receiver.example/hooks/two",
        secret: `whsec_${randomBytes(24).toString("base64")}`,
        cursor: null,
        maxAgeMs: 60_000,
        ttlMs: 60_000,
      },
      OPTIONS,
    ).catch((error: unknown) => classifyMcpEventsError(error));
    expect(failure).toEqual({ kind: "callback_unreachable", reason: "http_4xx" });
  });
});

describe("errors", () => {
  test("server errors are classified into what the subscription loop acts on", async () => {
    const server = start();
    const client = await connect(server);
    const poll = (name: string) =>
      pollMcpEvents(
        client,
        { name, arguments: {}, cursor: null, maxEvents: 1, maxAgeMs: 60_000 },
        OPTIONS,
      ).catch((error: unknown) => classifyMcpEventsError(error));

    expect(await poll("missing.type")).toEqual({ kind: "event_type_gone" });
    expect(await poll("deploy.finished")).toEqual({ kind: "delivery_mode_unsupported" });
    server.failNext("events/poll", { code: -32_024, message: "Forbidden", data: {} });
    expect(await poll("issue.opened")).toEqual({ kind: "forbidden", detail: "Forbidden" });
    server.failNext("events/poll", {
      code: -32_026,
      message: "Unsupported",
      data: { reason: "schema_changed" },
    });
    expect(await poll("issue.opened")).toEqual({ kind: "schema_changed" });
    server.failNext("events/poll", { code: -32_025, message: "Slow down" });
    expect(await poll("issue.opened")).toMatchObject({ kind: "transient" });
  });

  test("an HTTP 401 is unauthorized", async () => {
    const server = start({ bearerToken: "right" });
    const failure = await connect(server, { authorization: "Bearer wrong" }).catch(
      (error: unknown) => classifyMcpEventsError(error),
    );
    expect(failure).toEqual({ kind: "unauthorized" });
    const client = await connect(server, { authorization: "Bearer right" });
    expect(serverOffersMcpEvents(client)).toBe(true);
  });

  test("terminated envelopes classify like protocol errors", () => {
    expect(classifyMcpEventsProtocolError({ code: -32_601, message: "Method not found" })).toEqual({
      kind: "events_unsupported",
    });
    expect(
      classifyMcpEventsProtocolError({
        code: -32_027,
        message: "Callback endpoint error",
        data: { reason: "tls" },
      }),
    ).toEqual({ kind: "callback_unreachable", reason: "tls" });
  });
});

describe("webhook bodies and headers", () => {
  const read = (value: unknown) =>
    readMcpWebhookBody(
      new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)),
    );

  test("tells events from control envelopes", () => {
    expect(
      read({ eventId: "e1", name: "issue.opened", timestamp: "2026-10-01T00:00:00Z", data: {} }),
    ).toMatchObject({ kind: "event", occurrence: { eventId: "e1" } });
    expect(read({ type: "verification", challenge: "abc" })).toEqual({
      kind: "verification",
      challenge: "abc",
    });
    expect(read({ type: "gap", cursor: "c9" })).toEqual({ kind: "gap", cursor: "c9" });
    expect(read({ type: "terminated", error: { code: -32_024, message: "Forbidden" } })).toEqual({
      kind: "terminated",
      error: { code: -32_024, message: "Forbidden" },
    });
    expect(read("not json").kind).toBe("ignored");
    expect(read([1]).kind).toBe("ignored");
    expect(read({ type: "future-thing" }).kind).toBe("ignored");
    expect(read({ eventId: 5 }).kind).toBe("ignored");
  });

  test("header values are plain when safe and base64 otherwise", () => {
    expect(encodeMcpHeaderValue("issue.opened")).toBe("issue.opened");
    expect(encodeMcpHeaderValue(" padded")).toBe(
      `=?base64?${Buffer.from(" padded").toString("base64")}?=`,
    );
    expect(encodeMcpHeaderValue("=?base64?abc?=")).toMatch(/^=\?base64\?/u);
    expect(encodeMcpHeaderValue("")).toBe("=?base64??=");
  });
});
