import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  hidesCreditUsage,
  noteCreditUsageAudience,
  stripCreditUsageForRelayedBrowsers,
} from "../src/http/credit-usage-audience";

const CHAT_ACCEPT = "application/json; opengeni-session=chat";
const USAGE = {
  creditsMicros: 41_230,
  tokens: { input: 18_200, output: 950 },
  breakdown: { model: 39_100, webSearch: 2_130, imageGeneration: 0, other: 0 },
};
const events = [
  { sequence: 6, type: "agent.message.completed", payload: { text: 'it said "creditsMicros"' } },
  { sequence: 7, type: "turn.completed", payload: { maintenance: "none", usage: USAGE } },
  { sequence: 8, type: "turn.failed", payload: { code: "provider_error", usage: USAGE } },
];
const turns = [{ id: "t1", status: "completed", prompt: [], usage: USAGE }];

function app() {
  const routes = new Hono();
  routes.use("/events", stripCreditUsageForRelayedBrowsers);
  routes.use("/events/stream", stripCreditUsageForRelayedBrowsers);
  routes.use("/turns", stripCreditUsageForRelayedBrowsers);
  const grant = (c: { req: { header: (name: string) => string | undefined } }) => ({
    principalKind: c.req.header("x-test-principal") ?? "api_key",
  });
  routes.get("/events", (c) => {
    noteCreditUsageAudience(c, grant(c));
    return c.json(structuredClone(events));
  });
  routes.get("/turns", (c) => {
    noteCreditUsageAudience(c, grant(c));
    return c.json(structuredClone(turns));
  });
  routes.get("/events/stream", (c) => {
    noteCreditUsageAudience(c, grant(c));
    const text = events
      .map(
        (event) =>
          `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join("");
    const bytes = new TextEncoder().encode(text);
    // Small chunks, so lines span chunk boundaries.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < bytes.length; index += 7) {
          controller.enqueue(bytes.subarray(index, index + 7));
        }
        controller.close();
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  });
  return routes;
}

async function get(path: string, accept: string, principal = "api_key") {
  return await app().request(path, { headers: { accept, "x-test-principal": principal } });
}

describe("credit usage audience", () => {
  test("only a server credential's read of the chat projection is a relayed browser read", () => {
    const context = (accept: string) => {
      const headers: Record<string, string> = {};
      return {
        req: { header: (name: string) => (name === "accept" ? accept : undefined) },
        header: (name: string, value: string) => {
          headers[name] = value;
        },
      } as never;
    };
    expect(
      hidesCreditUsage(context(`text/event-stream, ${CHAT_ACCEPT}`), { principalKind: "api_key" }),
    ).toBe(true);
    expect(hidesCreditUsage(context(CHAT_ACCEPT), { principalKind: "configured_key" })).toBe(true);
    expect(hidesCreditUsage(context(CHAT_ACCEPT), { principalKind: "service" })).toBe(true);
    expect(hidesCreditUsage(context("application/json"), { principalKind: "api_key" })).toBe(false);
    // Opengeni's own app reads the chat projection as a signed-in person.
    expect(hidesCreditUsage(context(CHAT_ACCEPT), { principalKind: "human_session" })).toBe(false);
    expect(hidesCreditUsage(context(CHAT_ACCEPT), {})).toBe(false);
    // A proxy relays as the product's end user (`asUser`): an external actor.
    const endUser = {
      principalKind: "human_session",
      metadata: { externalActor: { source: "product", externalId: "u_42" } },
    };
    expect(hidesCreditUsage(context(CHAT_ACCEPT), endUser)).toBe(true);
    // The product server reading as that user in the full projection keeps it.
    expect(hidesCreditUsage(context("application/json"), endUser)).toBe(false);
  });

  test("relayed event pages and turns lose usage; everything else is unchanged", async () => {
    const page = (await (await get("/events", CHAT_ACCEPT)).json()) as typeof events;
    expect(page.map((event) => event.payload)).toEqual([
      events[0]!.payload,
      { maintenance: "none" },
      { code: "provider_error" },
    ]);
    const relayedTurns = await get("/turns", CHAT_ACCEPT);
    expect(relayedTurns.headers.get("vary")).toContain("Accept");
    expect(await relayedTurns.json()).toEqual([{ id: "t1", status: "completed", prompt: [] }]);
  });

  test("the relayed live stream loses usage, even when lines span chunks", async () => {
    const text = await (await get("/events/stream", `text/event-stream, ${CHAT_ACCEPT}`)).text();
    expect(text).not.toContain('"creditsMicros":');
    expect(text).toContain(
      `data: ${JSON.stringify({ ...events[1], payload: { maintenance: "none" } })}\n`,
    );
    expect(text).toContain(`data: ${JSON.stringify(events[0])}\n`);
  });

  test("server credentials in the full projection and signed-in people keep it", async () => {
    expect(await (await get("/events", "application/json")).json()).toEqual(events);
    expect(await (await get("/turns", CHAT_ACCEPT, "human_session")).json()).toEqual(turns);
    const stream = await (await get("/events/stream", "text/event-stream")).text();
    expect(stream).toContain('"creditsMicros":41230');
  });
});
